/** Shared read/plan hooks for current-day aggregate evidence and settings coordination. */
import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import { FirestoreRepository, digest, type Parent } from './repository.js';
import type { Settings } from './contracts.js';
import { evaluateAlerts, advanceMilestone, type Measurement, type MilestoneState } from './alerts.js';
import { planParentEvent, type PlannedWrite, type ParentEvent } from './outbox.js';
import { kyivDate } from './clock.js';
export interface AlertSnapshot {
    ref: DocumentReference;
    value: {
        parents: Record<string, MilestoneState>;
        lastWarning: string | null;
    };
}
export async function readAlerts(repo: FirestoreRepository, tx: Transaction, deviceId: string, now: string): Promise<AlertSnapshot> {
    const ref = repo.db.doc(`devices/${deviceId}/alertStates/${kyivDate(now)}`), data = (await tx.get(ref)).data();
    return { ref, value: { parents: data?.parents ?? {}, lastWarning: data?.lastWarning ?? null } };
}
export function measurement(evidence: any): Measurement | null {
    return evidence?.source?.availableThrough == null ? null : { selectedTotalMs: evidence.projection.selectedTotalMs, partial: evidence.source.partial, availableThrough: evidence.source.availableThrough };
}
export async function planAlerts(repo: FirestoreRepository, tx: Transaction, deviceId: string, now: string, settings: Settings, parents: Parent[], snapshot: AlertSnapshot, m: Measurement | null, coordination?: {
    id: string;
    text: string;
    category: boolean;
}): Promise<PlannedWrite[]> {
    const date = kyivDate(now), state = structuredClone(snapshot.value), events: ParentEvent[] = [], writes: PlannedWrite[] = [];
    for (const parent of parents) {
        const old = state.parents[parent.pairingId];
        if (parent.hourlyEnabled && old?.pendingBaseline && m)
            state.parents[parent.pairingId] = advanceMilestone(old, m.selectedTotalMs, 'enable');
        if (coordination?.category && parent.hourlyEnabled)
            state.parents[parent.pairingId] = advanceMilestone(state.parents[parent.pairingId], m?.selectedTotalMs ?? null, 'category');
    }
    const evaluated = evaluateAlerts({ now, date, settings, parents, states: state.parents, measurement: m, lastWarning: state.lastWarning });
    let coordinationText = coordination?.text ?? '';
    if (coordination && m)
        coordinationText += ` Поточний час: ${Math.floor(m.selectedTotalMs / 60000)} хв; ${m.partial ? 'неповні дані' : 'виміряні дані'}, станом на ${m.availableThrough}.`;
    for (const alert of evaluated) {
        if (alert.kind === 'hourly') {
            const recipient = alert.recipient!;
            state.parents[recipient.pairingId] = advanceMilestone(state.parents[recipient.pairingId], alert.totalMs, 'reserve');
            events.push({ id: digest(`hourly:${deviceId}:${date}:${recipient.pairingId}:${alert.hour}`), deviceId, at: now, kind: 'hourly', recipients: [recipient],
                text: `Використано ${Math.floor(alert.totalMs / 60000)} хв; ${alert.partial ? 'неповні дані' : 'виміряні дані'}, станом на ${alert.availableThrough}.`, milestone: { date, hour: alert.hour! } });
        }
        else {
            state.lastWarning = alert.severity!;
            const text = alert.severity === 'expired' ? 'Денний час вичерпано.' : `Залишилося ${alert.severity!.replace('m', '')} хв або менше.`;
            if (coordination)
                coordinationText += ' ' + text;
            else
                events.push({ id: digest(`warning:${deviceId}:${date}:${alert.severity}:${settings.revision}`), deviceId, at: now, kind: 'warning', recipients: parents, text: `${text} Використано ${Math.floor(alert.totalMs / 60000)} хв; ${alert.partial ? 'неповні дані' : 'виміряні дані'}, станом на ${alert.availableThrough}.` });
        }
    }
    if (coordination)
        events.push({ id: digest(coordination.id), deviceId, at: now, kind: 'coordination', text: coordinationText, recipients: parents, ...(coordination.category && m ? { milestone: { date, hour: Math.floor(m.selectedTotalMs / 3600000) } } : {}) });
    for (const event of events)
        writes.push(...await planParentEvent(repo, tx, event));
    writes.push({ ref: snapshot.ref, value: { ...state, date } });
    return writes;
}
