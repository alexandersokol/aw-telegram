/** Explicit Cloud Tasks REST/OIDC adapters and durable scheduling repair. */
import { randomUUID } from 'node:crypto';
import { GoogleAuth, OAuth2Client, type Certificates } from 'google-auth-library';
import { BoundaryError, FirestoreRepository, digest } from './repository.js';
import { parseJson, MAX_BODY_BYTES } from './contracts.js';
import type { HttpTransport } from './outbox.js';
import { fetchTransport, OutboxService } from './outbox.js';
import { ActionService } from './actions.js';
import { retentionStart } from './clock.js';
export interface TaskConfiguration {
    project: string;
    location: string;
    queue: string;
    targetUrl: string;
    audience: string;
    serviceAccountEmail: string;
}
export interface TaskPayload {
    kind: 'deadline' | 'outbox' | 'sweep';
    resourceId: string;
    generation: number;
}
export interface ScheduleRow {
    id: string;
    kind: 'deadline' | 'outbox';
    resourceId: string;
    dueAt: string;
    dispatchGeneration: number;
}
export interface TaskAdapter {
    create(row: ScheduleRow): Promise<void>;
}
function configure(c: TaskConfiguration): void {
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(c.project) || !/^[a-z]+-[a-z]+[0-9]$/.test(c.location) || !/^[A-Za-z0-9_-]{1,100}$/.test(c.queue) ||
        !/^[A-Za-z0-9_-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(c.serviceAccountEmail))
        throw new Error('Invalid task configuration');
    const url = new URL(c.targetUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || c.audience !== c.targetUrl)
        throw new Error('Invalid task URL/audience');
}
export class GoogleOidcVerifier {
    private readonly client = new OAuth2Client();
    constructor(private readonly config: TaskConfiguration, private readonly certificates?: () => Promise<Certificates>, private readonly clock: () => string = () => new Date().toISOString()) { configure(config); }
    async verify(token: string): Promise<void> {
        try {
            if (token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
                throw new Error();
            const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
            if (header.alg !== 'RS256' || typeof header.kid !== 'string')
                throw new Error();
            const certs = this.certificates ? await this.certificates() : (await this.client.getFederatedSignonCertsAsync()).certs;
            const ticket = await this.client.verifySignedJwtWithCertsAsync(token, certs, this.config.audience, ['https://accounts.google.com', 'accounts.google.com'], 3600);
            const p = ticket.getPayload(), now = Math.floor(Date.parse(this.clock()) / 1000);
            if (!p || p.email !== this.config.serviceAccountEmail || p.email_verified !== true || !Number.isSafeInteger(p.exp) || !Number.isSafeInteger(p.iat) || p.exp <= now || p.iat > now || p.exp - p.iat > 3600)
                throw new Error();
        }
        catch {
            throw new BoundaryError('Unauthorized task', 401);
        }
    }
}
export class CloudTasksRestAdapter implements TaskAdapter {
    constructor(private readonly config: TaskConfiguration, private readonly http: HttpTransport, private readonly accessToken: () => Promise<string>) { configure(config); }
    async create(row: ScheduleRow): Promise<void> {
        if (!/^[0-9a-f]{64}$/.test(row.id) || !Number.isSafeInteger(row.dispatchGeneration) || row.dispatchGeneration < 0)
            throw new Error('Invalid schedule intent');
        const parent = `projects/${this.config.project}/locations/${this.config.location}/queues/${this.config.queue}`;
        const payload: TaskPayload = { kind: row.kind, resourceId: row.resourceId, generation: row.dispatchGeneration };
        const task = { name: parent + '/tasks/' + row.id + '-' + row.dispatchGeneration, scheduleTime: row.dueAt, httpRequest: { httpMethod: 'POST', url: this.config.targetUrl, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(payload)).toString('base64'), oidcToken: { serviceAccountEmail: this.config.serviceAccountEmail, audience: this.config.audience } } };
        const response = await this.http.request('https://cloudtasks.googleapis.com/v2/' + parent + '/tasks', { method: 'POST', headers: { Authorization: 'Bearer ' + await this.accessToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ task }), timeoutMs: 10000 });
        if (response.status !== 200 && response.status !== 201 && response.status !== 409)
            throw new Error('Task dispatch failed');
    }
}
/** Construct only in the trusted deployment factory; never obtains ADC on import. */
export function productionTasksAdapter(config: TaskConfiguration, http: HttpTransport = fetchTransport): CloudTasksRestAdapter {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    return new CloudTasksRestAdapter(config, http, async () => { const token = await auth.getAccessToken(); if (!token)
        throw new Error('No task access token'); return token; });
}
export class TaskService {
    constructor(private readonly repo: FirestoreRepository, private readonly adapter: TaskAdapter, private readonly outbox: OutboxService, private readonly clock: () => string = () => new Date().toISOString()) { }
    async repair(limit = 25): Promise<void> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 50)
            throw new Error('Invalid repair bound');
        const now = this.clock();
        const candidates = await this.repo.db.runTransaction(async (tx) => {
            const pending = await tx.get(this.repo.db.collection('taskIntents').where('state', '==', 'pending').limit(limit));
            const lost = await tx.get(this.repo.db.collection('taskIntents').where('state', '==', 'enqueued').where('dueAt', '<=', now).limit(limit));
            return [...pending.docs, ...lost.docs].slice(0, limit * 2).map(d => d.id);
        });
        for (const id of candidates) {
            const token = randomUUID(), ref = this.repo.db.doc('taskIntents/' + id);
            const row: any = await this.repo.db.runTransaction(async (tx) => {
                const r = (await tx.get(ref)).data();
                if (!r || r.state === 'completed' || r.leaseUntil && r.leaseUntil > now || r.nextAttemptAt && r.nextAttemptAt > now)
                    return null;
                const recovery = r.state === 'enqueued';
                if (recovery && Date.parse(now) - Date.parse(r.lastEnqueuedAt) < 60000)
                    return null;
                const dispatchGeneration = r.dispatchGeneration + (recovery ? 1 : 0);
                if (!Number.isSafeInteger(dispatchGeneration))
                    throw new Error('Dispatch generation exhausted');
                tx.update(ref, { leaseToken: token, leaseUntil: new Date(Date.parse(now) + 30000).toISOString(), dispatchGeneration, attempts: r.attempts + 1 });
                return { ...r, dispatchGeneration };
            });
            if (!row)
                continue;
            let success = false;
            try {
                await this.adapter.create(row);
                success = true;
            }
            catch { /* Persist retry state; provider details are deliberately not logged. */ }
            await this.repo.db.runTransaction(async (tx) => {
                const current = (await tx.get(ref)).data();
                if (current?.leaseToken !== token || current.state === 'completed')
                    return;
                tx.update(ref, { state: success ? 'enqueued' : 'pending', leaseToken: null, leaseUntil: null, ...(success ? { lastEnqueuedAt: this.clock() } : { nextAttemptAt: new Date(Date.parse(this.clock()) + Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6))).toISOString() }) });
            });
        }
    }
    async execute(payload: TaskPayload): Promise<void> {
        if (payload.kind === 'sweep') {
            await this.sweep();
            return;
        }
        const now = this.clock();
        const candidate = await this.repo.db.runTransaction(async (tx) => {
            const intents = await tx.get(this.repo.db.collection('taskIntents').where('kind', '==', payload.kind).where('resourceId', '==', payload.resourceId).limit(50));
            return intents.docs.filter(d => { const r = d.data(); return r.state !== 'completed' && r.dispatchGeneration === payload.generation && r.dueAt <= now; }).sort((a, b) => a.data().dueAt.localeCompare(b.data().dueAt))[0] ?? null;
        });
        if (!candidate)
            return;
        if (payload.kind === 'deadline') {
            const [deviceId, actionId] = payload.resourceId.split(':');
            if (!deviceId || !actionId)
                throw new BoundaryError('Invalid task resource');
            // ActionService rechecks original deadline, fences and evidence in its domain transaction.
            await new ActionService(this.repo, this.clock).expireAction(actionId);
        }
        else
            await this.outbox.deliverOutbox(payload.resourceId);
        await this.repo.db.runTransaction(async (tx) => {
            const current = (await tx.get(candidate.ref)).data();
            if (current?.dispatchGeneration !== payload.generation)
                return;
            if (payload.kind === 'outbox') {
                const row = (await tx.get(this.repo.db.doc('outbox/' + payload.resourceId))).data();
                // A duplicate task that found an active send must leave its durable recovery intent alive.
                if (row?.state === 'sending')
                    return;
            }
            tx.update(candidate.ref, { state: 'completed', completedAt: this.clock() });
        });
    }
    /** Protected Task6 repair only; Task10 owns deployed Scheduler and broader repository cleanup. */
    async sweep(): Promise<void> {
        await this.repair(50);
        const now = this.clock(), cutoff = retentionStart(now), dayAgo = new Date(Date.parse(now) - 86400000).toISOString();
        await this.repo.db.runTransaction(async (tx) => {
            const oldEvents = await tx.get(this.repo.db.collection('events').where('at', '<', cutoff).limit(20));
            const oldOutbox = await tx.get(this.repo.db.collection('outbox').where('createdAt', '<', cutoff).limit(20));
            const messages = await tx.get(this.repo.db.collection('outbox').where('state', 'in', ['delivered', 'undeliverable', 'canceled', 'exhausted']).where('createdAt', '<', dayAgo).limit(20));
            const eventMessages = await tx.get(this.repo.db.collection('events').where('at', '<', dayAgo).limit(20));
            const completed = await tx.get(this.repo.db.collection('taskIntents').where('state', '==', 'completed').where('dueAt', '<', cutoff).limit(20));
            // Telegram stops redelivering an update well within a day; markers exist only to skip redelivery.
            const updates = await tx.get(this.repo.db.collection('telegramUpdates').where('at', '<', dayAgo).limit(100));
            // This product has one laptop. Bound the device scan as well as each evidence page.
            const devices = await tx.get(this.repo.db.collection('devices').limit(1));
            const deletions = [...oldEvents.docs, ...oldOutbox.docs, ...completed.docs, ...updates.docs];
            const patches: {
                ref: any;
                value: Record<string, any>;
            }[] = [];
            for (const device of devices.docs) {
                const root = device.ref;
                const operations = await tx.get(root.collection('operations').where('expired', '==', false).where('at', '<', cutoff).limit(20));
                const receipts = await tx.get(root.collection('receipts').where('receivedAt', '<', cutoff).limit(20));
                const alertStates = await tx.get(root.collection('alertStates').where('date', '<', cutoff.slice(0, 10)).limit(10));
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
                        patches.push({ ref: this.repo.db.doc('actionLocations/' + action.id), value: { deviceId: device.id, expired: true } });
                    }
                }
            }
            const deleted = new Set(deletions.map(doc => doc.ref.path));
            for (const doc of messages.docs)
                if (doc.data().text !== null && !deleted.has(doc.ref.path))
                    patches.push({ ref: doc.ref, value: { ...doc.data(), text: null } });
            for (const doc of eventMessages.docs)
                if (doc.data().text !== null && !deleted.has(doc.ref.path))
                    patches.push({ ref: doc.ref, value: { ...doc.data(), text: null, actions: null } });
            // Every query and snapshot is complete before any mutation begins.
            for (const doc of deletions)
                tx.delete(doc.ref);
            for (const patch of patches)
                tx.set(patch.ref, patch.value);
        });
    }
}
export function createTaskHandler(verifier: {
    verify(token: string): Promise<void>;
}, tasks: Pick<TaskService, 'execute'>) {
    return async (headers: Record<string, string | string[] | undefined>, body: string | Uint8Array): Promise<{
        status: number;
    }> => {
        try {
            const authorization = headers.authorization;
            if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization))
                throw new BoundaryError('Unauthorized task', 401);
            await verifier.verify(authorization.slice(7));
            if (Buffer.byteLength(body) > MAX_BODY_BYTES)
                throw new BoundaryError('Invalid task body', 413);
            let payload: any;
            try {
                payload = parseJson(body);
            }
            catch {
                throw new BoundaryError('Invalid task body');
            }
            if (!payload || Object.keys(payload).sort().join(',') !== 'generation,kind,resourceId' || !['deadline', 'outbox', 'sweep'].includes(payload.kind) || typeof payload.resourceId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(payload.resourceId) || !Number.isSafeInteger(payload.generation) || payload.generation < 0 || payload.kind === 'sweep' && (payload.resourceId !== 'all' || payload.generation !== 0))
                throw new BoundaryError('Invalid task body');
            await tasks.execute(payload);
            return { status: 204 };
        }
        catch (error) {
            return { status: error instanceof BoundaryError ? error.status : 500 };
        }
    };
}
