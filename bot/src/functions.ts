/** Firebase Functions v2 entry points (Task 10b): `api` serves every HTTP route, `sweep` runs the daily cleanup.
 * Importing this module connects to nothing and reads no secret; each instance builds its backend on first use.
 * Logs carry a fixed route label and an error type or refusal reason only, never a request, message text or provider detail. */
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { Api } from 'grammy';
import { createBackend, routeLabel, type HttpRequest, type Refusal } from './index.js';
import { BoundaryError, FirestoreRepository } from './repository.js';
import { TelegramHttpAdapter, fetchTransport } from './outbox.js';
import { GoogleOidcVerifier, productionTasksAdapter, type TaskConfiguration } from './tasks.js';
import { grammyClient } from './telegram/webhook.js';

export const REGION = 'europe-central2';
// The full email: the Firebase CLI expands an 'aw-backend@' shorthand for the function itself but copies it raw into
// the Scheduler job's OIDC identity and the secrets' IAM grants. Another project must change this (setup.md).
export const RUNTIME_ACCOUNT = 'aw-backend@aw-telegram.iam.gserviceaccount.com';
const botToken = defineSecret('TELEGRAM_BOT_TOKEN');
const webhookSecret = defineSecret('TELEGRAM_WEBHOOK_SECRET');
// The api function's HTTPS origin, known after the first deploy (bot/.env.<project>). Until it is set, Cloud
// Tasks are not created: their intents stay pending and the next repair or sweep enqueues them.
const backendUrl = defineString('BACKEND_URL', { default: '', description: 'HTTPS origin of the api function' });

export function taskConfiguration(project: string, origin: string): TaskConfiguration | null {
    if (!origin)
        return null;
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.username || url.password)
        throw new Error('BACKEND_URL must be an HTTPS origin');
    const target = url.origin + '/internal/tasks';
    return { project, location: REGION, queue: 'delivery', targetUrl: target, audience: target,
        serviceAccountEmail: `aw-tasks-invoker@${project}.iam.gserviceaccount.com` };
}

/** Cloud Run's front end appends the connecting client to X-Forwarded-For; earlier entries are caller-supplied. */
export function clientAddress(forwarded: string | string[] | undefined, socket: string): string {
    const value = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
    return value?.split(',').map(s => s.trim()).filter(Boolean).at(-1) ?? socket;
}

interface FunctionsRequest {
    method: string; originalUrl: string; headers: Record<string, string | string[] | undefined>; rawHeaders: string[];
    rawBody?: Buffer; socket?: { remoteAddress?: string };
}

export function toHttpRequest(req: FunctionsRequest): HttpRequest {
    const credentials = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === 'authorization').length;
    const headers = { ...req.headers };
    if (credentials > 1)
        headers.authorization = '';
    return { method: req.method, path: req.originalUrl, headers, body: req.rawBody ?? Buffer.alloc(0),
        remoteAddress: clientAddress(req.headers['x-forwarded-for'], req.socket?.remoteAddress ?? '') };
}

const report = (route: string, error: unknown): void => {
    logger.error('request failed', { route, type: error instanceof Error ? error.constructor.name : typeof error });
};
/** One line per refused sync (troubleshooting a laptop that never syncs, operations.md): reason and clock skew. */
const refused = (route: string, refusal: Refusal): void => {
    logger.warn('sync refused', { route, ...refusal });
};

let built: ReturnType<typeof createBackend> | undefined;
function backend(): ReturnType<typeof createBackend> {
    if (built)
        return built;
    if (!getApps().length)
        initializeApp();
    const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
    const config = taskConfiguration(project, backendUrl.value());
    // Secret versions written from a shell may end in a newline; webhookAdmin trims the same way.
    const token = botToken.value().trim(), secret = webhookSecret.value().trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret))
        throw new Error('TELEGRAM_WEBHOOK_SECRET has an invalid format');
    built = createBackend(new FirestoreRepository(getFirestore()), {
        telegram: new TelegramHttpAdapter(token, fetchTransport),
        taskAdapter: config ? productionTasksAdapter(config) : { create: async () => { throw new Error('Cloud Tasks target not configured'); } },
        oidc: config ? new GoogleOidcVerifier(config) : { verify: async () => { throw new BoundaryError('Unauthorized task', 401); } },
        webhook: { secret, client: grammyClient(new Api(token)) },
        report,
        refused,
    });
    return built;
}

export const api = onRequest({
    region: REGION, serviceAccount: RUNTIME_ACCOUNT, secrets: [botToken, webhookSecret],
    // Cost bound: no idle instance, at most two (matching the delivery queue's two concurrent dispatches).
    minInstances: 0, maxInstances: 2, concurrency: 20, cpu: 1, memory: '512MiB', timeoutSeconds: 60, invoker: 'public',
}, async (req, res) => {
    let result;
    try {
        result = await backend().router(toHttpRequest(req as unknown as FunctionsRequest));
    }
    catch (error) {
        report(routeLabel(req.method, req.originalUrl), error);
        res.status(500).set({ 'Cache-Control': 'no-store' }).end();
        return;
    }
    res.status(result.status).set(result.headers);
    if (result.body === undefined)
        res.end();
    else
        res.send(JSON.stringify(result.body));
});

export const sweep = onSchedule({
    schedule: '30 0 * * *', timeZone: 'Europe/Kyiv', region: REGION, serviceAccount: RUNTIME_ACCOUNT,
    secrets: [botToken, webhookSecret], maxInstances: 1, timeoutSeconds: 540, memory: '512MiB', retryCount: 1,
}, async () => {
    try {
        const result = await backend().tasks.sweep();
        logger.info('sweep finished', result);
    }
    catch (error) {
        report('SCHEDULE sweep', error);
        throw new Error('Sweep failed');  // Cloud Scheduler retries once
    }
});
