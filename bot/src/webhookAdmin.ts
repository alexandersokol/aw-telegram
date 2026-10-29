/** Owner webhook administration (scripts/webhook.ts). The bot token and webhook secret come from Secret Manager
 * with the owner's credentials; neither appears in arguments, environment, output or errors. */
import type { HttpTransport } from './outbox.js';

const UPDATES = ['message', 'callback_query'];

export class WebhookAdmin {
    constructor(private readonly secret: (name: string) => Promise<string>, private readonly http: HttpTransport) {}

    private async call(method: string, payload: unknown): Promise<any> {
        const token = await this.secret('TELEGRAM_BOT_TOKEN');
        let response;
        try {
            response = await this.http.request(`https://api.telegram.org/bot${token}/${method}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 10000 });
        }
        catch {
            throw new Error('Telegram is not reachable');  // a transport error message could carry the URL and token
        }
        const body = response.body as any;
        if (response.status !== 200 || body?.ok !== true)
            throw new Error('Telegram refused: ' + String(body?.description ?? response.status).replaceAll(token, '[token]').slice(0, 200));
        return body.result;
    }

    /** One connection serializes redeliveries of an update; only message and callback updates are sent. */
    async set(url: string): Promise<string> {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.pathname !== '/telegram/webhook' || parsed.search || parsed.hash || parsed.username || parsed.password)
            throw new Error('The webhook URL must be https://HOST/telegram/webhook');
        const secret = await this.secret('TELEGRAM_WEBHOOK_SECRET');
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret))
            throw new Error('Secret TELEGRAM_WEBHOOK_SECRET has an invalid format');  // the runtime refuses it too
        await this.call('setWebhook', { url: parsed.toString(), secret_token: secret,
            allowed_updates: UPDATES, max_connections: 1, drop_pending_updates: false });
        return 'Webhook set';
    }

    async info(): Promise<string> {
        const r = await this.call('getWebhookInfo', {});
        const lines = [`url: ${r.url || '(none)'}`, `pending updates: ${r.pending_update_count ?? 0}`,
            `max connections: ${r.max_connections ?? '-'}`, `allowed updates: ${(r.allowed_updates ?? []).join(', ') || '(all)'}`];
        if (r.last_error_date)
            lines.push(`last error: ${new Date(r.last_error_date * 1000).toISOString()} ${String(r.last_error_message ?? '').slice(0, 200)}`);
        return lines.join('\n');
    }

    /** Rollback: Telegram keeps undelivered updates for 24 hours while no webhook is set. */
    async remove(): Promise<string> {
        await this.call('deleteWebhook', { drop_pending_updates: false });
        return 'Webhook removed';
    }
}

export function secretManagerReader(project: string, accessToken: () => Promise<string>, http: HttpTransport) {
    return async (name: string): Promise<string> => {
        const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}/versions/latest:access`;
        let response;
        try {
            response = await http.request(url, { method: 'GET', headers: { Authorization: 'Bearer ' + await accessToken() }, timeoutMs: 10000 });
        }
        catch {
            throw new Error(`Secret ${name} is not readable`);
        }
        const data = (response.body as any)?.payload?.data;
        if (response.status !== 200 || typeof data !== 'string')
            throw new Error(`Secret ${name} is not readable`);
        return Buffer.from(data, 'base64').toString('utf8').trim();
    };
}
