/** Daily retention and delivery repair (Task 10). Each round runs bounded transactions that finish every
 * read before any write; rounds repeat until nothing changes, so a backlog clears without one huge write. */
import { FirestoreRepository } from './repository.js';
import { taskIntent } from './outbox.js';
import { retainedDates, retentionStart } from './clock.js';

export interface CleanupResult { rounds: number; deleted: number; scrubbed: number; repaired: number; }
const DAY_MS = 86400000;
// Old keys and unused enrollments stay listed for a week after expiry, then go.
const KEY_RETENTION_MS = 7 * DAY_MS;
// Operation IDs come from Telegram updates (never redelivered after a day) or menu nonces (30-minute sessions),
// so a tombstone older than this can no longer meet a replay.
const TOMBSTONE_RETENTION_MS = 30 * DAY_MS;
const PAGE = 100;

export async function cleanup(repo: FirestoreRepository, now: string, maxRounds = 10): Promise<CleanupResult> {
    const result: CleanupResult = { rounds: 0, deleted: 0, scrubbed: 0, repaired: 0 };
    while (result.rounds < maxRounds) {
        result.rounds++;
        const changes = [await evidenceRound(repo, now), await retentionRound(repo, now), await outboxRound(repo, now)];
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

type Round = { deleted: number; scrubbed: number; repaired: number; };

/** Task 6 evidence retention: events, messages, task intents, update markers, receipts, alert states, actions. */
async function evidenceRound(repo: FirestoreRepository, now: string): Promise<Round> {
    const cutoff = retentionStart(now), dayAgo = new Date(Date.parse(now) - DAY_MS).toISOString();
    return repo.db.runTransaction(async (tx) => {
        const oldEvents = await tx.get(repo.db.collection('events').where('at', '<', cutoff).limit(20));
        const oldOutbox = await tx.get(repo.db.collection('outbox').where('createdAt', '<', cutoff).limit(20));
        const messages = await tx.get(repo.db.collection('outbox').where('state', 'in', ['delivered', 'undeliverable', 'canceled', 'exhausted']).where('createdAt', '<', dayAgo).limit(20));
        const eventMessages = await tx.get(repo.db.collection('events').where('at', '<', dayAgo).limit(20));
        const completed = await tx.get(repo.db.collection('taskIntents').where('state', '==', 'completed').where('dueAt', '<', cutoff).limit(20));
        // Telegram stops redelivering an update well within a day; markers exist only to skip redelivery.
        const updates = await tx.get(repo.db.collection('telegramUpdates').where('at', '<', dayAgo).limit(PAGE));
        // This product has one laptop. Bound the device scan as well as each evidence page.
        const devices = await tx.get(repo.db.collection('devices').limit(1));
        const deletions = [...oldEvents.docs, ...oldOutbox.docs, ...completed.docs, ...updates.docs];
        const patches: { ref: any; value: Record<string, any>; }[] = [];
        for (const device of devices.docs) {
            const root = device.ref;
            const operations = await tx.get(root.collection('operations').where('expired', '==', false).where('at', '<', cutoff).limit(20));
            const receipts = await tx.get(root.collection('receipts').where('receivedAt', '<', cutoff).limit(20));
            // Kyiv dates, not the UTC date of the retention start (one day earlier east of UTC).
            const alertStates = await tx.get(root.collection('alertStates').where('date', '<', retainedDates(now)[6]!).limit(10));
            const actions = await tx.get(root.collection('actions').where('action.createdAt', '<', cutoff).limit(1));
            deletions.push(...receipts.docs, ...alertStates.docs);
            for (const op of operations.docs)
                patches.push({ ref: op.ref, value: { digest: op.data().digest, at: op.data().at, expired: true } });
            for (const action of actions.docs) {
                const evidence = await tx.get(action.ref.collection('evidence').limit(50));
                const occurrences = await tx.get(action.ref.collection('occurrences').limit(50));
                deletions.push(...evidence.docs, ...occurrences.docs);
                if (evidence.size < 50 && occurrences.size < 50) {
                    deletions.push(action);
                    patches.push({ ref: repo.db.doc('actionLocations/' + action.id), value: { deviceId: device.id, expired: true } });
                }
            }
        }
        const deleted = new Set(deletions.map(doc => doc.ref.path));

        for (const doc of messages.docs)
            if (doc.data().text !== null && !deleted.has(doc.ref.path)) {
                patches.push({ ref: doc.ref, value: { ...doc.data(), text: null } });

            }
        for (const doc of eventMessages.docs)
            if (doc.data().text !== null && !deleted.has(doc.ref.path)) {
                patches.push({ ref: doc.ref, value: { ...doc.data(), text: null, actions: null } });

            }
        // Every query and snapshot is complete before any mutation begins.
        for (const doc of deletions)
            tx.delete(doc.ref);
        for (const patch of patches)
            tx.set(patch.ref, patch.value);
        return { deleted: deletions.length, scrubbed: patches.length, repaired: 0 };
    });
}

/** Everything else that ages out: days and the last title of an inactive laptop, sessions, throttles, keys,
 * unused enrollments and old operation tombstones. */
async function retentionRound(repo: FirestoreRepository, now: string): Promise<Round> {
    const nowMs = Date.parse(now), cutoff = retentionStart(now), retained = new Set(retainedDates(now));
    const tombstoneCutoff = new Date(nowMs - TOMBSTONE_RETENTION_MS).toISOString();
    return repo.db.runTransaction(async (tx) => {
        const throttles = await tx.get(repo.db.collection('throttles').where('expiresAt', '<', nowMs).limit(PAGE));
        const keys = await tx.get(repo.db.collection('pairKeys').where('expiresAt', '<', nowMs - KEY_RETENTION_MS).limit(PAGE));
        // A consumed enrollment stays: owner recovery revokes the device it created through it.
        const enrollments = (await tx.get(repo.db.collection('enrollments').where('consumedAt', '==', null).limit(PAGE)))
            .docs.filter(d => d.data().expiresAt < nowMs - KEY_RETENTION_MS);
        const devices = await tx.get(repo.db.collection('devices').limit(1));
        const deletions: { ref: any; }[] = [...throttles.docs, ...keys.docs, ...enrollments];
        for (const device of devices.docs) {
            const root = device.ref;
            // Sync prunes days, but an inactive laptop never syncs: cleanup keeps the same seven Kyiv dates.
            const days = await tx.get(root.collection('days').limit(20));
            deletions.push(...days.docs.filter(d => !retained.has(d.id)));
            const sessions = await tx.get(root.collection('sessions').where('expiresAt', '<', nowMs).limit(PAGE));
            const tombstones = await tx.get(root.collection('operations').where('expired', '==', true).where('at', '<', tombstoneCutoff).limit(PAGE));
            deletions.push(...sessions.docs, ...tombstones.docs);
            // PRIVACY-01 keeps one latest title; a laptop silent past retention keeps none.
            const live = await tx.get(root.collection('live').doc('current'));
            if (live.exists && !(live.data()?.value?.observedAt >= cutoff))
                deletions.push(live);
        }
        for (const doc of deletions)
            tx.delete(doc.ref);
        return { deleted: deletions.length, scrubbed: 0, repaired: 0 };
    });
}

/** A pending or uncertain message whose task intent was lost (or never written) gets a fresh one at its next attempt. */
async function outboxRound(repo: FirestoreRepository, now: string): Promise<Round> {
    return repo.db.runTransaction(async (tx) => {
        const pending = await tx.get(repo.db.collection('outbox').where('state', 'in', ['pending', 'uncertain']).limit(50));
        const stranded = [];
        for (const row of pending.docs) {
            const intents = await tx.get(repo.db.collection('taskIntents').where('kind', '==', 'outbox').where('resourceId', '==', row.id).limit(10));
            if (!intents.docs.some(d => d.data().state !== 'completed'))
                stranded.push(row);
        }
        for (const row of stranded) {
            const due = row.data().nextAttemptAt > now ? row.data().nextAttemptAt : now;
            const intent = taskIntent(repo, 'outbox', row.id, due);
            tx.set(intent.ref, intent.value);
        }
        return { deleted: 0, scrubbed: 0, repaired: stranded.length };
    });
}
