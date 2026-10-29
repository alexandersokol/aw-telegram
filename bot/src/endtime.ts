/** Confirmed endtime presentation receipts and their retroactive suppression. */
import type {Transaction} from 'firebase-admin/firestore';
import {BoundaryError,FirestoreRepository,digest,type EndtimePolicyGeneration,type Parent} from './repository.js';
import type {EndtimeAck,Settings,Instant,LocalDate} from './contracts.js';
import {retainedDates} from './clock.js';
import {freeAt} from './actions.js';
import {planParentEvent,endtimeSuppressed,type PlannedWrite} from './outbox.js';

/** Bulk cancellation is best effort; the delivery worker rechecks suppression before every send. */
export const SUPPRESSION_BATCH = 100;
export const endtimeEventId = (deviceId: string, date: LocalDate, generation: number): string =>
  digest(`endtime:${deviceId}:${date}:${generation}`);

/** The ack must match one retained enabled generation and a settings revision that generation governed. */
function matchGeneration(history: EndtimePolicyGeneration[], ack: EndtimeAck, settings: Settings, now: Instant): void {
  const index = history.findIndex(entry => entry.generation === ack.endtimeGeneration);
  const entry = history[index], next = history[index + 1];
  if (!entry || !entry.enabled || entry.localTime !== ack.endtimeLocalTime || ack.presentedAt > now ||
      ack.settingsRevision > settings.revision || ack.settingsRevision < entry.settingsRevision ||
      (next && ack.settingsRevision >= next.settingsRevision))
    throw new BoundaryError('Invalid endtime receipt');
}

export async function planEndtimeAck(repo: FirestoreRepository, tx: Transaction, deviceId: string, ack: EndtimeAck,
  policy: any, parents: Parent[], settings: Settings, now: Instant): Promise<PlannedWrite[]> {
  // History for an unretained date may be pruned; such late proof can no longer earn an alert.
  if (!retainedDates(now).includes(ack.date)) return [];
  matchGeneration(policy.endtimeGenerations ?? [], ack, settings, now);
  if (endtimeSuppressed(settings, ack.date) || freeAt(policy, settings, ack.presentedAt) || !parents.length) return [];
  return planParentEvent(repo, tx, {
    id: endtimeEventId(deviceId, ack.date, ack.endtimeGeneration), deviceId, at: now, kind: 'endtime', recipients: parents,
    text: `Настав час завершення ${ack.endtimeLocalTime} (${ack.date}); нагадування показано на ноутбуці.`,
    policy: {kind: 'endtime', deviceId, endtimeDate: ack.date, endtimeGeneration: ack.endtimeGeneration},
  });
}

/** Cancel unsent endtime alerts for a newly suppressed date. Leased sends are stopped by the worker. */
export async function planEndtimeSuppression(repo: FirestoreRepository, tx: Transaction, deviceId: string, date: LocalDate): Promise<PlannedWrite[]> {
  const rows = await tx.get(repo.db.collection('outbox').where('policy.deviceId', '==', deviceId)
    .where('policy.endtimeDate', '==', date).where('state', 'in', ['pending', 'uncertain']).limit(SUPPRESSION_BATCH));
  return rows.docs.map(doc => ({ref: doc.ref, value: {...doc.data(), state: 'canceled', text: null}}));
}
