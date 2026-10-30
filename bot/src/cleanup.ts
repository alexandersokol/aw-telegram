/** Daily retention and delivery repair (Task 10). Each round runs bounded transactions that finish every
 * read before any write and stay under Firestore's 500 writes; rounds repeat until nothing changes or the time
 * budget ends, so a backlog clears without one huge write. Every device is cleaned, not only the first. */
import type { DocumentReference } from 'firebase-admin/firestore';
import { FirestoreRepository } from './repository.js';
import { taskIntent } from './outbox.js';
import { retainedDates, retentionStart } from './clock.js';

export interface CleanupResult { rounds: number; deleted: number; scrubbed: number; repaired: number; }
export interface CleanupOptions { maxRounds?: number; budgetMs?: number; monotonic?: () => number; }
const DAY_MS = 86400000;
// Old keys and unused enrollments stay listed for a week after expiry, then go.
const KEY_RETENTION_MS = 7 * DAY_MS;
// Operation IDs come from Telegram updates (never redelivered after a day) or menu nonces (30-minute sessions),
// so a tombstone older than this can no longer meet a replay.
const TOMBSTONE_RETENTION_MS = 30 * DAY_MS;
// A message whose next attempt is this overdue has no live task; younger ones may still be in the queue.
const STRANDED_AFTER_MS = 10 * 60000;
const TERMINAL = ['delivered', 'undeliverable', 'canceled', 'exhausted'];

type Round = { deleted: number; scrubbed: number; repaired: number; };
const none: Round = { deleted: 0, scrubbed: 0, repaired: 0 };

export async function cleanup(repo: FirestoreRepository, now: string, options: CleanupOptions = {}): Promise<CleanupResult> {
    const maxRounds = options.maxRounds ?? 1000, budget = options.budgetMs ?? 300000, monotonic = options.monotonic ?? Date.now;
    const started = monotonic(), result: CleanupResult = { rounds: 0, deleted: 0, scrubbed: 0, repaired: 0 };
    while (result.rounds < maxRounds && monotonic() - started < budget) {
        result.rounds++;
        const devices = await repo.db.runTransaction(async (tx) => (await tx.get(repo.db.collection('devices').limit(50))).docs.map(d => d.ref));
        const changes = [await evidenceRound(repo, now), await retentionRound(repo, now), await scrubRound(repo, now)];
        for (const device of devices)
            changes.push(await deviceRound(repo, device, now));
        changes.push(await outboxRound(repo, now));
        for (const c of changes) {
            result.deleted += c.deleted;
            result.scrubbed += c.scrubbed;
            result.repaired += c.repaired;
        }
        if (changes.every(c => c.deleted + c.scrubbed + c.repaired === 0))
            break;
    }
    return result;
}

/** Evidence older than the seven retained Kyiv dates: events, messages, completed task intents, update markers. */
async function evidenceRound(repo: FirestoreRepository, now: string): Promise<Round> {
    const cutoff = retentionStart(now), dayAgo = new Date(Date.parse(now) - DAY_MS).toISOString();
    return repo.db.runTransaction(async (tx) => {
        const deletions = [
            ...(await tx.get(repo.db.collection('events').where('at', '<', cutoff).limit(100))).docs,
            ...(await tx.get(repo.db.collection('outbox').where('createdAt', '<', cutoff).limit(100))).docs,
            ...(await tx.get(repo.db.collection('taskIntents').where('state', '==', 'completed').where('dueAt', '<', cutoff).limit(100))).docs,
            // Telegram stops redelivering an update well within a day; markers exist only to skip redelivery.
            ...(await tx.get(repo.db.collection('telegramUpdates').where('at', '<', dayAgo).limit(100))).docs,
        ];
        for (const doc of deletions)
            tx.delete(doc.ref);
        return { ...none, deleted: deletions.length };
    });
}

/** Records that age out: throttle windows, keys a week past expiry, unused enrollments a week past expiry. */
async function retentionRound(repo: FirestoreRepository, now: string): Promise<Round> {
    const nowMs = Date.parse(now);
    return repo.db.runTransaction(async (tx) => {
        const deletions = [
            ...(await tx.get(repo.db.collection('throttles').where('expiresAt', '<', nowMs).limit(100))).docs,
            ...(await tx.get(repo.db.collection('pairKeys').where('expiresAt', '<', nowMs - KEY_RETENTION_MS).limit(100))).docs,
            // A consumed enrollment stays: owner recovery revokes the device it created through it.
            ...(await tx.get(repo.db.collection('enrollments').where('consumedAt', '==', null).limit(100)))
                .docs.filter(d => d.data().expiresAt < nowMs - KEY_RETENTION_MS),
        ];
        for (const doc of deletions)
            tx.delete(doc.ref);
        return { ...none, deleted: deletions.length };
    });
}

/** Parent message text clears 24 hours after a message ends. Only unscrubbed rows are read, so no page repeats. */
async function scrubRound(repo: FirestoreRepository, now: string): Promise<Round> {
    const dayAgo = new Date(Date.parse(now) - DAY_MS).toISOString();
    return repo.db.runTransaction(async (tx) => {
        const messages = await tx.get(repo.db.collection('outbox').where('scrubbed', '==', false).where('state', 'in', TERMINAL).where('createdAt', '<', dayAgo).limit(100));
        const events = await tx.get(repo.db.collection('events').where('scrubbed', '==', false).where('at', '<', dayAgo).limit(100));
        for (const doc of messages.docs)
            tx.set(doc.ref, { ...doc.data(), text: null, scrubbed: true });
        for (const doc of events.docs)
            tx.set(doc.ref, { ...doc.data(), text: null, actions: null, scrubbed: true });
        return { ...none, scrubbed: messages.size + events.size };
    });
}

/** One device's tree: operations, receipts, alert states, old actions, days and the last title of an inactive
 * laptop, and expired sessions. At most about 440 writes. */
async function deviceRound(repo: FirestoreRepository, root: DocumentReference, now: string): Promise<Round> {
    const nowMs = Date.parse(now), cutoff = retentionStart(now), retained = retainedDates(now);
    const tombstoneCutoff = new Date(nowMs - TOMBSTONE_RETENTION_MS).toISOString();
    return repo.db.runTransaction(async (tx) => {
        const operations = await tx.get(root.collection('operations').where('expired', '==', false).where('at', '<', cutoff).limit(50));
        const tombstones = await tx.get(root.collection('operations').where('expired', '==', true).where('at', '<', tombstoneCutoff).limit(50));
        const receipts = await tx.get(root.collection('receipts').where('receivedAt', '<', cutoff).limit(50));
        // Kyiv dates, not the UTC date of the retention start (one day earlier east of UTC).
        const alertStates = await tx.get(root.collection('alertStates').where('date', '<', retained[6]!).limit(10));
        const actions = await tx.get(root.collection('actions').where('action.createdAt', '<', cutoff).limit(2));
        // Sync reads only the dates it is sent, so cleanup alone keeps every device to the seven Kyiv dates.
        const days = (await tx.get(root.collection('days').limit(20))).docs.filter(d => !retained.includes(d.id));
        const sessions = await tx.get(root.collection('sessions').where('expiresAt', '<', nowMs).limit(50));
        const live = await tx.get(root.collection('live').doc('current'));
        const deletions: { ref: any; }[] = [...tombstones.docs, ...receipts.docs, ...alertStates.docs, ...days, ...sessions.docs];
        const patches: { ref: any; value: Record<string, any>; }[] = [];
        for (const op of operations.docs)
            patches.push({ ref: op.ref, value: { digest: op.data().digest, at: op.data().at, expired: true } });
        for (const action of actions.docs) {
            const evidence = await tx.get(action.ref.collection('evidence').limit(50));
            const occurrences = await tx.get(action.ref.collection('occurrences').limit(50));
            deletions.push(...evidence.docs, ...occurrences.docs);
            if (evidence.size < 50 && occurrences.size < 50) {
                deletions.push(action);
                patches.push({ ref: repo.db.doc('actionLocations/' + action.id), value: { deviceId: root.id, expired: true } });
            }
        }
        // PRIVACY-01 keeps one latest title; a laptop silent past retention keeps none.
        if (live.exists && !(live.data()?.value?.observedAt >= cutoff))
            deletions.push(live);
        // Every query and snapshot is complete before any mutation begins.
        for (const doc of deletions)
            tx.delete(doc.ref);
        for (const patch of patches)
            tx.set(patch.ref, patch.value);
        return { deleted: deletions.length, scrubbed: patches.length, repaired: 0 };
    });
}

/** A pending or uncertain message long overdue whose task intent was lost (or never written) gets a fresh one. */
async function outboxRound(repo: FirestoreRepository, now: string): Promise<Round> {
    const overdue = new Date(Date.parse(now) - STRANDED_AFTER_MS).toISOString();
    return repo.db.runTransaction(async (tx) => {
        const pending = await tx.get(repo.db.collection('outbox').where('state', 'in', ['pending', 'uncertain']).where('nextAttemptAt', '<', overdue).limit(50));
        const stranded = [];
        for (const row of pending.docs) {
            const intents = await tx.get(repo.db.collection('taskIntents').where('kind', '==', 'outbox').where('resourceId', '==', row.id).limit(10));
            if (!intents.docs.some(d => d.data().state !== 'completed'))
                stranded.push(row);
        }
        for (const row of stranded) {
            const intent = taskIntent(repo, 'outbox', row.id, now);
            tx.set(intent.ref, intent.value);
        }
        return { ...none, repaired: stranded.length };
    });
}
