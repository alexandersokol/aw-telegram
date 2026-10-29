/** Transaction plans for durable action identity, evidence and cancellation fences. */
import { randomUUID } from 'node:crypto';
import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import { BoundaryError, FirestoreRepository, digest, MAX_ACTIVE_CAREGIVERS, type ParentIdentity, type Parent, type DeviceIdentity } from './repository.js';
import { validateContract, validateActionReceipt, actionCanceled, type Action, type ActionAck, type Cancellations, type Settings, type SyncResponse } from './contracts.js';
import { dayBounds, kyivDate, kyivTime, parseInstant, retainedDates, retentionStart } from './clock.js';
import { canonical, checkSettingsCapacity, emptyCancellations, boundedResponse } from './deviceApi.js';
import { decodeSettings, encodeSettings, needsSettingsMigration } from './settingsCodec.js';
import type { CallbackGuard } from './settings.js';
import { applyPlan, planParentEvent, taskIntent, ensureTaskIntent, type PlannedWrite, type ParentEvent } from './outbox.js';
import { planEndtimeSuppression } from './endtime.js';
export type ActionDraft = ({
    kind: 'notify';
    options: Extract<Action, {
        kind: 'notify';
    }>['options'];
} | {
    kind: 'overlay';
    options: Extract<Action, {
        kind: 'overlay';
    }>['options'];
}) & {
    delayMinutes: number;
};
export function repeatFamilyEnd(action: Action): string | null {
    return action.kind === 'overlay' && action.options.dismissible && action.options.repeatEveryMinutes !== null ? dayBounds(kyivDate(action.targetAt)).end : null;
}
export function deliveryClosureAt(action: Action): string {
    const original = new Date(Date.parse(action.expiresAt) + (action.targetAt === action.createdAt ? 0 : 1)).toISOString();
    const familyEnd = repeatFamilyEnd(action);
    return familyEnd && familyEnd < original ? familyEnd : original;
}
export interface ActionResult {
    action: Action;
    state: string;
}
export interface OccurrenceEvidence {
    sequence: number;
    status: ActionAck['status'];
    presentedAt: string | null;
    dismissedAt: string | null;
    terminal: boolean;
}
export interface ActionRow {
    deviceId: string;
    action: Action;
    creatorPairingId: string;
    operationId: string;
    version: number;
    state: string;
    open: boolean;
    offerCount: number;
    lastOfferedAt: string | null;
    firstOfferedAt: string | null;
    acceptedAt: string | null;
    latestSequence: number;
    latestAt: string | null;
    presentedAt: string | null;
    initialOccurrence?: OccurrenceEvidence;
}
export interface ActionSnapshot {
    rows: Map<string, {
        ref: DocumentReference;
        row: ActionRow;
    }>;
    parents: Parent[];
    policy: any;
    counter: number;
}
export async function readParents(repo: FirestoreRepository, tx: Transaction, deviceId: string): Promise<Parent[]> {
    const root = repo.db.doc('devices/' + deviceId), device = (await tx.get(root)).data();
    const ids = device?.activeParentIds ?? [];
    if (ids.length > MAX_ACTIVE_CAREGIVERS)
        throw new BoundaryError('Invalid recipient set');
    const docs = ids.length ? await tx.getAll(...ids.map((id: string) => root.collection('parents').doc(id))) : [];
    return docs.map(d => d.data() as Parent).filter(p => p && p.revokedAt === null);
}
export async function readActionSnapshot(repo: FirestoreRepository, tx: Transaction, deviceId: string, ackIds: string[] = []): Promise<ActionSnapshot> {
    const root = repo.db.doc('devices/' + deviceId);
    const [active, controls] = await Promise.all([tx.get(root.collection('actions').where('open', '==', true).limit(201)), tx.getAll(root.collection('actionControls').doc('current'), root.collection('policy').doc('current'))]);
    if (active.size > 200)
        throw new BoundaryError('Active action capacity exceeded', 409);
    const rows = new Map<string, {
        ref: DocumentReference;
        row: ActionRow;
    }>(active.docs.map(d => [d.id, { ref: d.ref, row: d.data() as ActionRow }]));
    const missing = [...new Set(ackIds)].filter(id => !rows.has(id));
    if (missing.length) {
        for (const doc of await tx.getAll(...missing.map(id => root.collection('actions').doc(id))))
            if (doc.exists)
                rows.set(doc.id, { ref: doc.ref, row: doc.data() as ActionRow });
    }
    return { rows, parents: await readParents(repo, tx, deviceId), counter: controls[0]!.data()?.sequence ?? 0, policy: controls[1]!.data() ?? { transitions: [] } };
}
export function operationRef(repo: FirestoreRepository, identity: ParentIdentity, id: string) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(id))
        throw new BoundaryError('Trusted operation ID required');
    return repo.db.doc(`devices/${identity.deviceId}/operations/${digest(identity.pairingId + ':' + id)}`);
}
export async function readOperation(repo: FirestoreRepository, tx: Transaction, identity: ParentIdentity, id: string, intent: unknown) {
    const ref = operationRef(repo, identity, id), hash = digest(canonical(intent)), previous = (await tx.get(ref)).data();
    if (previous && previous.digest !== hash)
        throw new BoundaryError('Operation identity conflict', 409);
    if (previous?.expired)
        throw new BoundaryError('Operation identity expired', 409);
    return { ref, hash, previous };
}
export function eventFor(deviceId: string, id: string, at: string, text: string, parents: Parent[]): ParentEvent { return { id: digest(id), deviceId, at, kind: 'status', text, recipients: parents }; }
/** The caregiver's pairing name, chosen when their key was created in the companion. */
const issuerName = (parents: Parent[], identity: ParentIdentity): string => parents.find(p => p.pairingId === identity.pairingId)?.name ?? identity.userId;
/** Who asked for what and when; the parent's own text is plain and never interpreted as markup. */
function createdText(action: Action, name: string, skipped: boolean): string {
    const what = `${action.kind === 'overlay' ? 'повідомлення на екрані' : 'сповіщення'} «${action.options.message}»`;
    if (skipped)
        return `Нагадування від «${name}» пропущено, бо ввімкнено вільний режим: ${what}.`;
    const when = action.targetAt === action.createdAt ? 'зараз' : `о ${kyivTime(action.targetAt)}`;
    return `Нове нагадування від «${name}»: ${what}. Показати: ${when}. Очікуємо підтвердження ноутбука.`;
}
const clearText = (scope: 'manual' | 'all', name: string): string => scope === 'all' ?
    `«${name}» очищує всі нагадування та вимикає попередження про ліміт до опівночі. Очікуємо підтвердження ноутбука.` :
    `«${name}» очищує ручні нагадування. Очікуємо підтвердження ноутбука.`;
export function freeAt(policy: any, settings: Settings, instant: string): boolean {
    const transitions = (policy.transitions ?? []).filter((x: any) => x.at <= instant);
    const last = transitions.at(-1);
    if (last)
        return last.freeUseDate === kyivDate(instant);
    if (policy.transitions?.length)
        return policy.transitions[0].beforeFreeUseDate === kyivDate(instant);
    return settings.freeUseDate === kyivDate(instant);
}
const terminal = new Set(['canceled', 'skipped', 'failed', 'expired', 'completed', 'replaced']);
export function planCancellation(snapshot: ActionSnapshot, current: Cancellations, now: string, mode: 'clear' | 'free'): Cancellations {
    if (current.revision === Number.MAX_SAFE_INTEGER)
        throw new BoundaryError('Cancellation revision exhausted', 409);
    const next = { ...current, revision: current.revision + 1, canceledIds: [...current.canceledIds] };
    if (mode === 'clear') {
        next.throughActionSequence = snapshot.counter;
        next.canceledIds = [];
        return next;
    }
    const byId = new Map([...snapshot.rows.values()].map(r => [r.row.action.id, r.row.action.sequence]));
    next.canceledIds = next.canceledIds.filter(id => (byId.get(id) ?? Infinity) > next.throughActionSequence);
    for (const { row } of snapshot.rows.values()) {
        const a = row.action;
        if (!terminal.has(row.state) && (a.targetAt <= now || row.acceptedAt !== null && row.presentedAt !== null || a.targetAt === a.createdAt) && a.sequence > next.throughActionSequence && !next.canceledIds.includes(a.id))
            next.canceledIds.push(a.id);
    }
    if (next.canceledIds.length > 100)
        throw new BoundaryError('Cancellation capacity exceeded', 409);
    return validateContract('cancellations', next);
}
export class ActionService {
    constructor(readonly repo: FirestoreRepository, readonly clock: () => string = () => new Date().toISOString()) { }
    async createAction(identity: ParentIdentity, draft: ActionDraft, operationId: string, callback?: CallbackGuard): Promise<ActionResult> {
        const id = randomUUID(), now = this.clock();
        parseInstant(now);
        if (!draft || Object.keys(draft).sort().join(',') !== 'delayMinutes,kind,options' || !Number.isInteger(draft.delayMinutes) || draft.delayMinutes < 0 || draft.delayMinutes > 1439)
            throw new BoundaryError('Invalid action draft');
        return this.repo.db.runTransaction(async (tx) => {
            if (callback)
                await this.repo.requireCallback(tx, identity, callback.nonce, callback.version);
            else
                await this.repo.requireParent(tx, identity);
            const operation = await readOperation(this.repo, tx, identity, operationId, draft);
            if (operation.previous)
                return operation.previous.result;
            const root = this.repo.db.doc('devices/' + identity.deviceId), [settingsDoc, cancel, device] = await tx.getAll(root.collection('settings').doc('current'), root.collection('cancellations').doc('current'), root);
            const settings = decodeSettings(settingsDoc!.data()), snapshot = await readActionSnapshot(this.repo, tx, identity.deviceId);
            if (snapshot.counter >= Number.MAX_SAFE_INTEGER || snapshot.rows.size >= 200)
                throw new BoundaryError('Action capacity exceeded', 409);
            const targetAt = new Date(Date.parse(now) + draft.delayMinutes * 60000).toISOString();
            let action: Action;
            try {
                action = validateContract('action', { id, actorId: identity.userId, createdAt: now, targetAt, expiresAt: new Date(Date.parse(targetAt) + (draft.delayMinutes ? 5000 : 60000)).toISOString(), sequence: snapshot.counter + 1, settingsRevision: settings.revision, kind: draft.kind, options: draft.options });
            }
            catch {
                throw new BoundaryError('Invalid action draft');
            }
            const state = settings.freeUseDate === kyivDate(now) ? 'skipped' : 'pending';
            const row: ActionRow = { deviceId: identity.deviceId, action, creatorPairingId: identity.pairingId, operationId, version: 1, state, open: state === 'pending', offerCount: 0, lastOfferedAt: null, firstOfferedAt: null, acceptedAt: null, latestSequence: 0, latestAt: null, presentedAt: null };
            const events = await planParentEvent(this.repo, tx, eventFor(identity.deviceId, 'create:' + id, now, createdText(action, issuerName(snapshot.parents, identity), state === 'skipped'), snapshot.parents));
            checkSettingsCapacity(settings, validateContract('cancellations', cancel!.data() ?? emptyCancellations()), now, device!.data()!.collectionStartedAt === null ? null : new Date(device!.data()!.collectionStartedAt).toISOString());
            const result = { action, state };
            if (needsSettingsMigration(settingsDoc!.data()))
                tx.set(settingsDoc!.ref, encodeSettings(settings));
            tx.set(root.collection('actions').doc(id), row);
            tx.set(this.repo.db.doc('actionLocations/' + id), { deviceId: identity.deviceId, createdAt: now });
            tx.set(root.collection('actionControls').doc('current'), { sequence: action.sequence });
            tx.set(operation.ref, { digest: operation.hash, result, at: now, expired: false });
            applyPlan(tx, events);
            if (row.open)
                applyPlan(tx, [taskIntent(this.repo, 'deadline', identity.deviceId + ':' + id, deliveryClosureAt(action))]);
            return result;
        });
    }
    async clearActions(identity: ParentIdentity, scope: 'manual' | 'all', operationId: string, callback?: CallbackGuard): Promise<Cancellations> {
        if (scope !== 'manual' && scope !== 'all')
            throw new BoundaryError('Invalid clear scope');
        const now = this.clock();
        return this.repo.db.runTransaction(async (tx) => {
            if (callback)
                await this.repo.requireCallback(tx, identity, callback.nonce, callback.version);
            else
                await this.repo.requireParent(tx, identity);
            const op = await readOperation(this.repo, tx, identity, operationId, { kind: 'clear', scope });
            if (op.previous)
                return op.previous.result;
            const root = this.repo.db.doc('devices/' + identity.deviceId), [s, c, d] = await tx.getAll(root.collection('settings').doc('current'), root.collection('cancellations').doc('current'), root);
            const snapshot = await readActionSnapshot(this.repo, tx, identity.deviceId), settings = decodeSettings(s!.data());
            const cancellations = planCancellation(snapshot, validateContract('cancellations', c!.data() ?? emptyCancellations()), now, 'clear');
            if (scope === 'all') {
                if (settings.revision === Number.MAX_SAFE_INTEGER)
                    throw new BoundaryError('Settings revision exhausted', 409);
                settings.suppressedDate = kyivDate(now);
                settings.revision++;
            }
            const fences = (snapshot.policy.fences ?? []).filter((f: any) => retainedDates(now).includes(kyivDate(f.at)));
            if (fences.length >= 256)
                throw new BoundaryError('Policy transition capacity exceeded', 409);
            fences.push({ at: now, throughActionSequence: cancellations.throughActionSequence, canceledIds: [] });
            const events = await planParentEvent(this.repo, tx, eventFor(identity.deviceId, 'clear:' + identity.pairingId + ':' + operationId, now, clearText(scope, issuerName(snapshot.parents, identity)), snapshot.parents));
            if (scope === 'all')
                events.push(...await planEndtimeSuppression(this.repo, tx, identity.deviceId, kyivDate(now)));
            checkSettingsCapacity(settings, cancellations, now, d!.data()!.collectionStartedAt === null ? null : new Date(d!.data()!.collectionStartedAt).toISOString());
            tx.set(root.collection('policy').doc('current'), { ...snapshot.policy, fences });
            tx.set(root.collection('cancellations').doc('current'), cancellations);
            if (scope === 'all' || needsSettingsMigration(s!.data()))
                tx.set(root.collection('settings').doc('current'), encodeSettings(settings));
            tx.set(op.ref, { digest: op.hash, result: cancellations, at: now, expired: false });
            applyPlan(tx, events);
            return cancellations;
        });
    }
    async offerActions(identity: DeviceIdentity): Promise<Action[]> { const { DeviceApi } = await import('./deviceApi.js'); return (await new DeviceApi(this.repo, this.clock).syncDevice(identity, { schemaVersion: 2, sequence: 0, acks: [], health: { observedAt: this.clock(), awState: 'unknown', lastSuccessAt: null, reportError: null } })).deliveryOffers; }
    async recordAck(identity: DeviceIdentity, ack: ActionAck): Promise<void> { const { DeviceApi } = await import('./deviceApi.js'); await new DeviceApi(this.repo, this.clock).syncDevice(identity, { schemaVersion: 2, sequence: 0, acks: [ack], health: { observedAt: this.clock(), awState: 'unknown', lastSuccessAt: null, reportError: null } }); }
    async expireAction(actionId: string): Promise<void> {
        const now = this.clock();
        await this.repo.db.runTransaction(async (tx) => {
            const location = (await tx.get(this.repo.db.doc('actionLocations/' + actionId))).data();
            if (!location)
                return;
            const root = this.repo.db.doc('devices/' + location.deviceId), ref = root.collection('actions').doc(actionId);
            const [a, c, s, p] = await tx.getAll(ref, root.collection('cancellations').doc('current'), root.collection('settings').doc('current'), root.collection('policy').doc('current'));
            const row = a!.data() as ActionRow | undefined;
            if (!row || !row.open)
                return;
            if (row.action.targetAt < retentionStart(now)) {
                tx.set(ref, { ...row, open: false, state: 'completed', version: row.version + 1 });
                return;
            }
            const action = row.action, delayed = action.targetAt !== action.createdAt, end = dayBounds(kyivDate(action.targetAt)).end;
            if (now < deliveryClosureAt(action))
                return;
            const cancellations = validateContract('cancellations', c!.data() ?? emptyCancellations()), settings = decodeSettings(s!.data());
            let state = row.state, open = false;
            if (actionCanceled(action, cancellations))
                state = 'canceled';
            else if (freeAt(p!.data() ?? { transitions: [] }, settings, action.targetAt))
                state = 'skipped';
            else if (row.presentedAt || repeatFamilyEnd(action) && row.state === 'dismissed') {
                state = row.state;
                open = action.kind === 'overlay' && action.options.dismissible && action.options.repeatEveryMinutes !== null && now < end;
            }
            else
                state = row.acceptedAt ? 'execution_unconfirmed' : 'delivery_unconfirmed';
            const parents = await readParents(this.repo, tx, location.deviceId);
            const text = state === 'execution_unconfirmed' ? 'Очікуємо підтвердження виконання' : state === 'delivery_unconfirmed' ? 'Не вдалося підтвердити доставку' : state === 'skipped' ? 'Таймер пропущено: вільне користування' : 'Команду завершено';
            const events = state === row.state ? [] : await planParentEvent(this.repo, tx, eventFor(location.deviceId, 'deadline:' + action.id, now, text, parents));
            const familyIntent = open ? await ensureTaskIntent(this.repo, tx, 'deadline', location.deviceId + ':' + action.id, end, now) : [];
            if (needsSettingsMigration(s!.data()))
                tx.set(s!.ref, encodeSettings(settings));
            tx.set(ref, { ...row, state, open, version: row.version + 1 });
            applyPlan(tx, [...events, ...familyIntent]);
        });
    }
}
/** All evidence reads and validations complete before this plan is applied by sync. */
export async function planActionSync(repo: FirestoreRepository, tx: Transaction, snapshot: ActionSnapshot, acks: ActionAck[], settings: Settings, cancellations: Cancellations, now: string, response: SyncResponse, writeBudget = 450): Promise<PlannedWrite[]> {
    const writes: PlannedWrite[] = [], events: ParentEvent[] = [], rows = new Map([...snapshot.rows].map(([id, v]) => [id, { ref: v.ref, row: structuredClone(v.row) }]));
    const offerCandidates: {ref: DocumentReference; row: ActionRow}[] = [];
    const cached = new Map<string, any>();
    const read = async (ref: DocumentReference) => { if (!cached.has(ref.path))
        cached.set(ref.path, (await tx.get(ref)).data() ?? null); return cached.get(ref.path); };
    for (const ack of acks) {
        const item = rows.get(ack.actionId);
        if (!item)
            throw new BoundaryError('Unknown action receipt', 409);
        const { row, ref } = item, a = row.action;
        try {
            validateActionReceipt(a, ack);
        }
        catch {
            throw new BoundaryError('Invalid action receipt');
        }
        if (ack.at > now || !retainedDates(now).includes(kyivDate(ack.at)))
            throw new BoundaryError('Invalid receipt time');
        const evidence = { ...ack } as Partial<ActionAck>;
        delete evidence.id;
        const hash = digest(canonical(evidence)), eventRef = ref.collection('evidence').doc(String(ack.eventSequence)), previous = await read(eventRef);
        if (previous) {
            if (previous.digest !== hash)
                throw new BoundaryError('Receipt event sequence conflict', 409);
            continue;
        }
        if (ack.eventSequence < 1 || ack.acceptedAt !== null && (!row.firstOfferedAt || ack.acceptedAt < row.firstOfferedAt))
            throw new BoundaryError('Receipt lacks committed offer');
        if (row.acceptedAt !== null && ack.acceptedAt !== row.acceptedAt)
            throw new BoundaryError('Conflicting acceptance evidence', 409);
        const occRef = ref.collection('occurrences').doc(String(ack.occurrence));
        // Occurrence zero travels with the action row already written for every receipt.
        // Existing separate zero documents remain readable; later occurrences stay separate.
        const occ = ack.occurrence === 0 ? row.initialOccurrence ?? await read(occRef) : await read(occRef);
        if (ack.occurrence > 0) {
            const priorRef = ref.collection('occurrences').doc(String(ack.occurrence - 1));
            const prior = ack.occurrence === 1 ? row.initialOccurrence ?? await read(priorRef) : await read(priorRef);
            const interval = a.kind === 'overlay' && a.options.dismissible ? a.options.repeatEveryMinutes : null;
            const effective = ack.presentedAt ?? ack.at;
            if (!prior?.dismissedAt || !interval || effective < new Date(Date.parse(prior.dismissedAt) + interval * 60000).toISOString() || effective >= dayBounds(kyivDate(a.targetAt)).end)
                throw new BoundaryError('Invalid repeated occurrence');
        }
        const fence = (snapshot.policy.fences ?? []).find((f: any) => a.sequence <= f.throughActionSequence || f.canceledIds.includes(a.id));
        if (fence && (ack.presentedAt !== null && ack.presentedAt >= fence.at || ack.acceptedAt !== null && ack.acceptedAt >= fence.at))
            throw new BoundaryError('Receipt contradicts cancellation fence');
        const ranks: Record<string, number> = { accepted: 0, presenting: 1, unconfirmed: 1, presented: 2, dismissed: 3, completed: 3, replaced: 3 };
        if (occ && ack.eventSequence > occ.sequence && (ranks[ack.status] ?? 3) < (ranks[occ.status] ?? 3))
            throw new BoundaryError('Receipt status regression');
        if (ack.presentedAt !== null && a.kind === 'overlay' && a.options.dismissible && a.options.repeatEveryMinutes !== null && ack.presentedAt >= dayBounds(kyivDate(a.targetAt)).end)
            throw new BoundaryError('Repeat family ended at Kyiv midnight');
        if (occ?.presentedAt && ack.presentedAt !== null && occ.presentedAt !== ack.presentedAt)
            throw new BoundaryError('Conflicting occurrence evidence', 409);
        if (ack.status === 'dismissed' && (a.kind !== 'overlay' || !a.options.dismissible))
            throw new BoundaryError('Action is not dismissible');
        if (occ?.terminal && ack.eventSequence > occ.sequence && ack.status !== occ.status)
            throw new BoundaryError('Contradictory terminal receipt');
        if (row.latestSequence && ((ack.eventSequence > row.latestSequence && ack.at < row.latestAt!) || (ack.eventSequence < row.latestSequence && ack.at > row.latestAt!)))
            throw new BoundaryError('Receipt ordering conflict', 409);
        if (terminal.has(row.state) && !['canceled', 'skipped'].includes(row.state) && ack.eventSequence > row.latestSequence)
            throw new BoundaryError('Action is terminal');
        if (ack.acceptedAt !== null && freeAt(snapshot.policy, settings, a.targetAt) && ack.presentedAt !== null)
            throw new BoundaryError('Presentation during free use');
        const nextOcc = { ...occ, sequence: Math.max(occ?.sequence ?? 0, ack.eventSequence), status: ack.eventSequence > (occ?.sequence ?? 0) ? ack.status : occ.status,
            presentedAt: occ?.presentedAt ?? ack.presentedAt, dismissedAt: ack.status === 'dismissed' ? ack.at : occ?.dismissedAt ?? null, terminal: !!occ?.terminal || ['dismissed', 'completed', 'replaced', 'failed', 'expired', 'canceled', 'skipped'].includes(ack.status) };
        cached.set(occRef.path, nextOcc);
        cached.set(eventRef.path, { digest: hash });
        if (ack.occurrence === 0) row.initialOccurrence = nextOcc;
        else writes.push({ref: occRef, value: nextOcc});
        writes.push({ ref: eventRef, value: { digest: hash, at: ack.at } });
        const uncertain = ['delivery_unconfirmed', 'execution_unconfirmed'].includes(row.state);
        const presentationConfirmed = nextOcc.presentedAt !== null;
        if (ack.acceptedAt !== null)
            row.acceptedAt = ack.acceptedAt;
        if (ack.presentedAt !== null)
            row.presentedAt = ack.presentedAt;
        const fenced = actionCanceled(a, cancellations) || ['canceled', 'skipped'].includes(row.state);
        if (ack.eventSequence > row.latestSequence) {
            row.latestSequence = ack.eventSequence;
            row.latestAt = ack.at;
            if (!fenced)
                row.state = ack.status;
        }
        if (fenced)
            row.state = row.state === 'skipped' ? 'skipped' : 'canceled';
        const familyEnd = repeatFamilyEnd(a);
        const lifecycleClosed = terminal.has(row.state) || !familyEnd && row.state === 'dismissed';
        row.open = !fenced && !lifecycleClosed && !(row.presentedAt && !familyEnd) && (!familyEnd || now < familyEnd);
        row.version++;
        const correction = uncertain && presentationConfirmed;
        const statusText = presentationConfirmed ? 'Показ підтверджено (це не означає прочитання)' : ack.status === 'accepted' ? 'Розклад прийнято ноутбуком' : 'Оновлено стан команди; показ не підтверджено';
        events.push({
            ...eventFor(row.deviceId, (correction ? 'correction:' : 'receipt:') + a.id + ':' + (correction ? 'presented:' + ack.occurrence : ack.eventSequence), now, statusText, snapshot.parents),
            actions: [{id:a.id,status:row.state,eventSequence:ack.eventSequence,occurrence:ack.occurrence,presentedAt:nextOcc.presentedAt}]
        });
    }
    for (const { ref, row } of rows.values()) {
        const a = row.action;
        if (actionCanceled(a, cancellations)) {
            row.state = 'canceled';
            row.open = false;
        }
        if (row.open && now >= a.targetAt && freeAt(snapshot.policy, settings, a.targetAt)) {
            row.state = 'skipped';
            row.open = false;
            events.push(eventFor(row.deviceId, 'due-free:' + a.id, now, 'Таймер пропущено: вільне користування', snapshot.parents));
        }
        if (a.targetAt < retentionStart(now)) {
            row.open = false;
            row.state = 'completed';
        }
        const immediate = a.targetAt === a.createdAt;
        const eligible = row.open && row.acceptedAt === null && row.state === 'pending' && now < a.expiresAt && (!repeatFamilyEnd(a) || now < repeatFamilyEnd(a)!) && (!immediate || row.offerCount < 3) && (!row.lastOfferedAt || Date.parse(now) - Date.parse(row.lastOfferedAt) >= 20000);
        if (eligible) offerCandidates.push({ref,row});
        const original = snapshot.rows.get(a.id)!.row;
        if (row.open && (row.presentedAt || row.state === 'dismissed') && repeatFamilyEnd(a) && (original.presentedAt === null || !original.open))
            writes.push(...await ensureTaskIntent(repo, tx, 'deadline', row.deviceId + ':' + a.id, repeatFamilyEnd(a)!, now));
        if (canonical(original) !== canonical(row))
            writes.push({ ref, value: row });
    }
    // One bounded parent status message per sync preserves every action's durable evidence while
    // keeping 100 accepted receipts inside the transaction's document-write budget.
    if (events.length > 1) {
        const ids = events.map(e => e.id).sort();
        const actionEvidence = events.flatMap(e => e.actions ?? []);
        const confirmedOccurrences = new Set(actionEvidence.filter(a => a.presentedAt !== null).map(a => a.id + ':' + a.occurrence));
        const changedActions = new Set(actionEvidence.map(a => a.id));
        const combined: ParentEvent = { id: digest('receipt-batch:' + ids.join(':')), deviceId: events[0]!.deviceId, at: now, kind: 'status', recipients: snapshot.parents,
            text: `Оновлено стан ${changedActions.size} команд. Підтверджено показ: ${confirmedOccurrences.size}. Показ не означає прочитання.`, actions: actionEvidence };
        writes.push(...await planParentEvent(repo, tx, combined));
    }
    else
        for (const event of events)
            writes.push(...await planParentEvent(repo, tx, event));
    if (writes.length > writeBudget) throw new BoundaryError('Sync transaction capacity exceeded',413);
    // Mandatory evidence, family deadlines and events have been planned. Offers are optional,
    // so reserve their writes only after both byte capacity and document budget are known.
    for (const {ref,row} of offerCandidates) {
        if (response.deliveryOffers.length >= 100) break;
        const existingWrite = writes.find(write => write.ref.path === ref.path);
        if (!existingWrite && writes.length >= writeBudget) break;
        try {
            boundedResponse({...response,deliveryOffers:[...response.deliveryOffers,row.action]});
        } catch (error) {
            if (error instanceof BoundaryError && error.status === 413) continue;
            throw error;
        }
        response.deliveryOffers.push(row.action);
        row.offerCount++;
        row.firstOfferedAt ??= now;
        row.lastOfferedAt = now;
        row.version++;
        if (existingWrite) existingWrite.value = row;
        else writes.push({ref,value:row});
    }
    return writes;
}
