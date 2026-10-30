/** Durable at-least-once parent delivery. A provider acceptance cannot be rolled back. */
import { randomUUID } from 'node:crypto';
import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import { BoundaryError, FirestoreRepository, digest, MAX_ACTIVE_CAREGIVERS, type RecipientRef } from './repository.js';
import { retainedDates, kyivDate } from './clock.js';
import { decodeSettings } from './settingsCodec.js';
import type { Settings } from './contracts.js';
import { LANGS, storedLang, type Lang, type Localized } from './telegram/i18n/index.js';
/** Free use and Clear all both silence endtime work for their active local date. */
export const endtimeSuppressed = (settings: Settings, date: string): boolean => settings.freeUseDate === date || settings.suppressedDate === date;
export interface PlannedWrite {
    ref: DocumentReference;
    value: Record<string, any>;
}
export const applyPlan = (tx: Transaction, writes: PlannedWrite[]): void => { for (const write of writes)
    tx.set(write.ref, write.value); };
export interface ParentEvent {
    id: string;
    deviceId: string;
    at: string;
    kind: string;
    /** Every language; each recipient's row stores theirs. */
    text: Localized;
    /** lang is the recipient's stored choice (Parent.lang); without one the row is Ukrainian. */
    recipients: (RecipientRef & { lang?: Lang })[];
    milestone?: {
        date: string;
        hour: number;
    };
    actions?: {
        id: string;
        status: string;
        eventSequence: number;
        occurrence: number;
        presentedAt: string | null;
    }[];
    policy?: EndtimeRowPolicy;
}
/** Identity an automatic policy alert needs for suppression rechecks before delivery. */
export interface EndtimeRowPolicy {
    kind: 'endtime';
    deviceId: string;
    endtimeDate: string;
    endtimeGeneration: number;
}
export type SendOutcome = {
    kind: 'sent';
    messageId: number;
} | {
    kind: 'forbidden';
} | {
    kind: 'retry';
    retryAfter: number;
} | {
    kind: 'transient';
} | {
    kind: 'uncertain';
};
export interface TelegramSender {
    send(chatId: string, text: string): Promise<SendOutcome>;
}
export interface HttpTransport {
    request(url: string, init: {
        method: string;
        headers: Record<string, string>;
        body?: string;
        timeoutMs: number;
    }): Promise<{
        status: number;
        body: unknown;
    }>;
}
export function taskIntent(repo: FirestoreRepository, kind: 'deadline' | 'outbox', resourceId: string, dueAt: string): PlannedWrite {
    const id = digest(kind + ':' + resourceId + ':' + dueAt);
    return { ref: repo.db.doc('taskIntents/' + id), value: { id, kind, resourceId, dueAt, generation: 0, dispatchGeneration: 0, state: 'pending', attempts: 0, leaseToken: null, leaseUntil: null, lastEnqueuedAt: null } };
}
/** Ensuring a family end must retain an in-flight dispatch generation or rearm a completed future intent. */
export async function ensureTaskIntent(repo: FirestoreRepository, tx: Transaction, kind: 'deadline' | 'outbox', resourceId: string, dueAt: string, now: string): Promise<PlannedWrite[]> {
    const planned = taskIntent(repo, kind, resourceId, dueAt);
    const existing = (await tx.get(planned.ref)).data();
    if (!existing)
        return [planned];
    if (existing.state === 'completed' && dueAt > now) {
        if (!Number.isSafeInteger(existing.dispatchGeneration + 1))
            throw new BoundaryError('Dispatch generation exhausted', 409);
        return [{ ref: planned.ref, value: { ...existing, state: 'pending', dispatchGeneration: existing.dispatchGeneration + 1, leaseToken: null, leaseUntil: null } }];
    }
    return [];
}
export async function planParentEvent(repo: FirestoreRepository, tx: Transaction, event: ParentEvent): Promise<PlannedWrite[]> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(event.id) || event.recipients.length > MAX_ACTIVE_CAREGIVERS || new Set(event.recipients.map(r => r.pairingId)).size !== event.recipients.length ||
        LANGS.some(lang => typeof event.text?.[lang] !== 'string' || !event.text[lang] || event.text[lang].length > 3500) || event.recipients.some(r => r.deviceId !== event.deviceId) || event.policy && event.policy.deviceId !== event.deviceId)
        throw new BoundaryError('Invalid event');
    const ref = repo.db.doc('events/' + event.id);
    if ((await tx.get(ref)).exists)
        return [];
    const recipients = event.recipients.map(({ deviceId, userId, pairingId }) => ({ deviceId, userId, pairingId }));
    // Rows keep their own text, so delivery never reads the event: rows queued before 11f (one string) send as they are.
    // scrubbed: cleanup clears text 24 hours later and reads only rows not yet cleared.
    const writes: PlannedWrite[] = [{ ref, value: { id: event.id, deviceId: event.deviceId, at: event.at, kind: event.kind, text: event.text, recipients, scrubbed: false, ...(event.actions ? { actions: event.actions } : {}) } }];
    for (const [i, recipient] of recipients.entries()) {
        const id = digest(event.id + ':' + recipient.pairingId);
        writes.push({ ref: repo.db.doc('outbox/' + id), value: { id, eventId: event.id, recipient, text: event.text[storedLang(event.recipients[i]!.lang) ?? 'uk'], createdAt: event.at, state: 'pending', attempts: 0, nextAttemptAt: event.at, leaseToken: null, leaseUntil: null, scrubbed: false, ...(event.milestone ? { milestone: event.milestone } : {}), ...(event.policy ? { policy: event.policy } : {}) } }, taskIntent(repo, 'outbox', id, event.at));
    }
    return writes;
}
export class OutboxService {
    constructor(private readonly repo: FirestoreRepository, private readonly telegram: TelegramSender, private readonly clock: () => string = () => new Date().toISOString()) { }
    async enqueueParentEvent(event: ParentEvent): Promise<void> {
        await this.repo.db.runTransaction(async (tx) => { const writes = await planParentEvent(this.repo, tx, event); applyPlan(tx, writes); });
    }
    async deliverOutbox(id: string): Promise<void> {
        const token = randomUUID(), now = this.clock(), ref = this.repo.db.doc('outbox/' + id);
        const row: any = await this.repo.db.runTransaction(async (tx) => {
            const r = (await tx.get(ref)).data();
            if (!r || ['delivered', 'undeliverable', 'canceled', 'exhausted'].includes(r.state) || r.nextAttemptAt > now || r.leaseUntil && r.leaseUntil > now)
                return null;
            if (!retainedDates(now).includes(kyivDate(r.createdAt)) || r.policy && await this.policyCanceled(tx, r.policy)) {
                tx.update(ref, { state: 'canceled', text: null });
                return null;
            }
            tx.update(ref, { leaseToken: token, leaseUntil: new Date(Date.parse(now) + 30000).toISOString(), attempts: r.attempts + 1, state: 'sending' });
            return { ...r, attempts: r.attempts + 1 };
        });
        if (!row)
            return;
        let result: SendOutcome;
        try {
            const recipient = await this.repo.authorizeRecipient(row.recipient);
            if (row.policy && !await this.policySendable(ref, token, row.policy))
                return;
            result = await this.telegram.send(recipient.chatId, row.text);
        }
        catch (error) {
            if (error instanceof BoundaryError && error.status === 401) {
                await this.finalize(ref, token, { state: 'canceled', text: null });
                return;
            }
            result = { kind: 'uncertain' };
        }
        const finish = this.clock();
        await this.repo.db.runTransaction(async (tx) => {
            const current = (await tx.get(ref)).data();
            if (current?.leaseToken !== token)
                return;
            let state: string = result.kind, extra: Record<string, any> = {};
            let milestoneRef: DocumentReference | undefined, milestone: any;
            if (result.kind === 'sent') {
                state = 'delivered';
                extra = { messageId: result.messageId, deliveredAt: finish };
                if (row.milestone) {
                    milestoneRef = this.repo.db.doc(`devices/${row.recipient.deviceId}/alertStates/${row.milestone.date}`);
                    milestone = (await tx.get(milestoneRef)).data();
                }
            }
            else if (result.kind === 'forbidden')
                state = 'undeliverable';
            else {
                const delay = result.kind === 'retry' ? Math.max(1, Math.min(result.retryAfter, 604800)) * 1000 : Math.min(3600000, 1000 * 2 ** Math.min(row.attempts, 10));
                state = row.attempts >= 8 || result.kind === 'retry' && result.retryAfter > 604800 ? 'exhausted' : result.kind === 'uncertain' ? 'uncertain' : 'pending';
                extra.nextAttemptAt = new Date(Date.parse(finish) + delay).toISOString();
            }
            tx.update(ref, { ...extra, state, leaseToken: null, leaseUntil: null });
            if (milestoneRef && milestone) {
                const s = milestone.parents?.[row.recipient.pairingId];
                if (s)
                    tx.set(milestoneRef, { ...milestone, parents: { ...milestone.parents, [row.recipient.pairingId]: { ...s, deliveredHighWater: Math.max(s.deliveredHighWater, row.milestone.hour) } } });
            }
            if (['pending', 'uncertain'].includes(state))
                applyPlan(tx, [taskIntent(this.repo, 'outbox', id, extra.nextAttemptAt)]);
        });
    }
    /** A suppression may commit after the lease; recheck immediately before the provider call.
     *  A request Telegram already accepted remains subject to the documented crash-after-send uncertainty. */
    private async policySendable(ref: DocumentReference, token: string, policy: EndtimeRowPolicy): Promise<boolean> {
        return this.repo.db.runTransaction(async (tx) => {
            if ((await tx.get(ref)).data()?.leaseToken !== token)
                return false;
            if (!await this.policyCanceled(tx, policy))
                return true;
            tx.update(ref, { state: 'canceled', text: null, leaseToken: null, leaseUntil: null });
            return false;
        });
    }
    private async policyCanceled(tx: Transaction, policy: EndtimeRowPolicy): Promise<boolean> {
        const stored = (await tx.get(this.repo.db.doc(`devices/${policy.deviceId}/settings/current`))).data();
        return !stored || endtimeSuppressed(decodeSettings(stored), policy.endtimeDate);
    }
    private async finalize(ref: DocumentReference, token: string, patch: Record<string, any>): Promise<void> {
        await this.repo.db.runTransaction(async (tx) => { if ((await tx.get(ref)).data()?.leaseToken === token)
            tx.update(ref, { ...patch, leaseToken: null, leaseUntil: null }); });
    }
}
export class TelegramHttpAdapter implements TelegramSender {
    private readonly url: string;
    constructor(token: string, private readonly http: HttpTransport) { if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token))
        throw new Error('Invalid Telegram configuration'); this.url = 'https://api.telegram.org/bot' + token + '/sendMessage'; }
    async send(chatId: string, text: string): Promise<SendOutcome> {
        try {
            const r = await this.http.request(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), timeoutMs: 10000 });
            const b = r.body as any;
            if (r.status === 200 && b?.ok === true && Number.isSafeInteger(b.result?.message_id))
                return { kind: 'sent', messageId: b.result.message_id };
            if (r.status === 403)
                return { kind: 'forbidden' };
            if (r.status === 429 && Number.isSafeInteger(b?.parameters?.retry_after) && b.parameters.retry_after > 0)
                return { kind: 'retry', retryAfter: b.parameters.retry_after };
            return { kind: r.status >= 500 ? 'uncertain' : 'transient' };
        }
        catch {
            return { kind: 'uncertain' };
        }
    }
}
/** Explicit construction only. No network or credential lookup on import. */
export const fetchTransport: HttpTransport = { async request(url, init) {
        const response = await fetch(url, { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }), signal: AbortSignal.timeout(init.timeoutMs) });
        const text = await response.text();
        if (text.length > 65536)
            throw new Error('Provider response exceeds bound');
        let body: unknown;
        try {
            body = JSON.parse(text);
        }
        catch {
            body = null;
        }
        return { status: response.status, body };
    } };
