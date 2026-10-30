/** Telegram update dispatch. Call only after the webhook secret is verified; replies are sent outside transactions.
 *
 * Every update is authorized afresh from its private sender. A redelivered update that already
 * completed is skipped; one that failed part-way is processed again, and its mutations replay
 * through deterministic operation IDs, so only the reply may repeat (at-least-once).
 */
import {GrammyError,type Api} from 'grammy';
import {BoundaryError,FirestoreRepository,type ParentIdentity,type PrivateActor} from '../repository.js';
import type {Instant} from '../contracts.js';
import type {ActionService} from '../actions.js';
import type {SettingsService} from '../settings.js';
import {privateActor} from '../pairing.js';
import {EndtimeController} from './commands.js';
import {NavigationController} from './navigation.js';
import {AllowanceController} from './allowance.js';
import {ClearController} from './clear.js';
import {RemindersController} from './reminders.js';
import {PAIRING,PAIRED,PAIR_FAILED,PAIR_THROTTLED,ALREADY_PAIRED,STALE_NAV,HINT,UNKNOWN_COMMAND,HOURLY_USAGE,USAGE_USAGE,HELP,
  hourlySaved,ACTION_CAPACITY,DATA_CAPACITY,OPERATION_CONFLICT,TOO_MANY,REQUEST_FAILED,type Reply} from './uk.js';

export interface TelegramClient {
  send(chatId: string, reply: Reply): Promise<void>;
  edit(chatId: string, messageId: number, reply: Reply): Promise<void>;
  /** text shows as a short toast; Telegram allows up to 200 characters. */
  answer(callbackId: string, text?: string): Promise<void>;
  delete(chatId: string, messageId: number): Promise<void>;
}

/** grammY Bot API client; tests and the deployed function inject the same interface. */
export function grammyClient(api: Api): TelegramClient {
  const markup = (reply: Reply) => reply.buttons.length ?
    {reply_markup: {inline_keyboard: reply.buttons.map(row => row.map(b => ({text: b.text, callback_data: b.data})))}} : {};
  return {
    async send(chatId, reply) {await api.sendMessage(Number(chatId), reply.text, {...markup(reply), link_preview_options: {is_disabled: true}});},
    async edit(chatId, messageId, reply) {
      try {await api.editMessageText(Number(chatId), messageId, reply.text, {...markup(reply), link_preview_options: {is_disabled: true}});}
      catch (error) {if (!(error instanceof GrammyError && error.description.includes('message is not modified'))) throw error;}
    },
    async answer(callbackId, text) {await api.answerCallbackQuery(callbackId, text ? {text} : undefined);},
    async delete(chatId, messageId) {await api.deleteMessage(Number(chatId), messageId);},
  };
}

const KEY = /^[A-Za-z0-9_-]{22}$/;
/** Telegram stops redelivering an update well within this. */
const MARKER_TTL_MS = 2 * 86400000;
/** Telegram 4xx other than 429 (blocked bot, unknown chat, bad request) will fail the same way again. */
const permanentTelegramError = (error: unknown): boolean =>
  error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500 && error.error_code !== 429;
function failureText(error: BoundaryError): string {
  if (error.status === 401) return STALE_NAV;
  if (error.status === 429) return TOO_MANY;
  if (/action capacity/i.test(error.message)) return ACTION_CAPACITY;
  if (/capacity|exhausted/i.test(error.message)) return DATA_CAPACITY;
  if (/operation identity/i.test(error.message)) return OPERATION_CONFLICT;
  return REQUEST_FAILED;
}
const command = (text: string) => /^\/([a-z_]+)(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/.exec(text.trim());
const unauthorized = (error: unknown) => error instanceof BoundaryError && error.status === 401;

export class TelegramBot {
  private readonly endtime: EndtimeController;
  private readonly navigation: NavigationController;
  private readonly allowance: AllowanceController;
  private readonly clear: ClearController;
  private readonly reminders: RemindersController;
  constructor(private readonly repository: FirestoreRepository, private readonly settings: SettingsService,
              actions: ActionService, private readonly client: TelegramClient,
              private readonly clock: () => Instant = () => new Date().toISOString()) {
    this.endtime = new EndtimeController(repository, settings, clock);
    this.allowance = new AllowanceController(repository, settings, clock);
    this.clear = new ClearController(repository, actions, clock);
    this.reminders = new RemindersController(repository, actions, clock);
    this.navigation = new NavigationController(repository, settings, this.endtime, this.allowance, this.reminders, clock);
  }

  async handleUpdate(update: unknown): Promise<void> {
    let actor: PrivateActor;
    try {actor = privateActor(update);} catch {return;} // groups, channels, bots, forwards: silently ignored
    const updateId = (update as {update_id?: unknown}).update_id;
    if (!Number.isSafeInteger(updateId) || (updateId as number) < 0) return;
    const marker = this.repository.db.doc(`telegramUpdates/${updateId}`);
    if (await this.repository.db.runTransaction(async tx => (await tx.get(marker)).exists)) return;
    const identity = await this.identity(actor);
    const callback = (update as any).callback_query, message = (update as any).message;
    // An unpaired user's chatter changes nothing and has nothing to protect from replay.
    const durable = identity !== null || !!callback || KEY.test(command(message?.text ?? '')?.[2]?.trim() ?? '');
    try {
      if (callback) await this.onCallback(actor, identity, callback);
      else await this.onMessage(actor, identity, message, updateId as number);
    } catch (error) {
      // Retrying cannot help a refused request or a permanently refused Telegram call; anything else is retried.
      if (permanentTelegramError(error)) {/* nothing more can be delivered */}
      else if (error instanceof BoundaryError && error.status < 500) await this.reportFailure(actor, callback, error);
      else throw error;
    }
    if (!durable) return;
    const at = this.clock();
    // expireAt drives the telegramUpdates TTL policy (applied 2026-10-29); the daily sweep is a bounded fallback.
    await this.repository.db.runTransaction(async tx => {tx.set(marker, {at, expireAt: new Date(Date.parse(at) + MARKER_TTL_MS)});});
  }

  private async reportFailure(actor: PrivateActor, callback: any, error: BoundaryError): Promise<void> {
    const text = failureText(error);
    try {
      if (callback) await this.client.answer(String(callback.id), text);
      else await this.client.send(actor.chatId, {text, buttons: []});
    } catch (sendError) {
      if (!permanentTelegramError(sendError)) throw sendError;
    }
  }

  private async identity(actor: PrivateActor): Promise<ParentIdentity | null> {
    try {return await this.repository.authorizeParent(actor);}
    catch (error) {if (unauthorized(error)) return null; throw error;}
  }

  private async onCallback(actor: PrivateActor, identity: ParentIdentity | null, callback: any): Promise<void> {
    const data = callback.data;
    let reply: Reply;
    if (!identity) reply = {text: PAIRING, buttons: []};
    else if (typeof data === 'string' && data.startsWith('et:')) {
      reply = await this.endtime.callback(identity, data);
      if (reply.navigate === 'settings') reply = await this.navigation.openSettings(identity);
    } else if (typeof data === 'string' && data.startsWith('nv:')) reply = await this.navigation.callback(identity, data);
    else if (typeof data === 'string' && data.startsWith('lm:')) reply = await this.allowance.callback(identity, data);
    else if (typeof data === 'string' && data.startsWith('cl:')) reply = await this.clear.callback(identity, data);
    else if (typeof data === 'string' && data.startsWith('rm:')) reply = await this.reminders.callback(identity, data);
    else reply = {text: STALE_NAV, buttons: []};
    if (identity && reply.navigate) reply = await this.handOver(identity, reply);
    // A refused tap (stale or double) must not overwrite the live menu or a confirmation.
    if (reply.toast) {await this.answer(callback, reply.text); return;}
    await this.answer(callback);
    await this.deliver(actor.chatId, reply, callback.message?.message_id);
  }

  private async answer(callback: any, text?: string): Promise<void> {
    try {await this.client.answer(String(callback.id), text);} catch {/* an expired query must not block the reply */}
  }

  /** Open the menu a reply hands over to. */
  private handOver(identity: ParentIdentity, reply: Reply): Promise<Reply> {
    switch (reply.navigate) {
      case 'main': return this.navigation.openMain(identity);
      case 'limit': return this.allowance.openStatus(identity);
      case 'clear': return this.clear.openFromReminders(identity);
      case 'reminders': return this.reminders.openHome(identity);
      default: return Promise.resolve(reply);
    }
  }

  /** Edit the menu message in place when possible, then send any further report pages. */
  private async deliver(chatId: string, reply: Reply, messageId?: unknown): Promise<void> {
    let edited = false;
    if (Number.isSafeInteger(messageId)) {
      try {await this.client.edit(chatId, messageId as number, reply); edited = true;} catch {/* fall back to a new message */}
    }
    if (!edited) await this.client.send(chatId, reply);
    for (const page of reply.extra ?? []) await this.client.send(chatId, {text: page, buttons: []});
  }

  private async onMessage(actor: PrivateActor, identity: ParentIdentity | null, message: any, updateId: number): Promise<void> {
    const text = typeof message?.text === 'string' ? message.text : '';
    const parsed = command(text);
    if (!identity) return this.onUnpaired(actor, parsed, message);
    await this.deliver(actor.chatId, await this.reply(identity, text, parsed, updateId));
  }

  private async onUnpaired(actor: PrivateActor, parsed: RegExpExecArray | null, message: any): Promise<void> {
    const key = parsed && (parsed[1] === 'pair' || parsed[1] === 'start') ? (parsed[2] ?? '').trim() : '';
    if (!KEY.test(key)) return this.client.send(actor.chatId, {text: PAIRING, buttons: []});
    try {
      await this.repository.pairParent(key, actor.userId, actor.chatId);
    } catch (error) {
      if (!(error instanceof BoundaryError)) throw error;
      return this.client.send(actor.chatId, {text: error.status === 429 ? PAIR_THROTTLED : PAIR_FAILED, buttons: []});
    }
    let removed = false;
    try {await this.client.delete(actor.chatId, message.message_id); removed = true;} catch {/* the key is single-use anyway */}
    const identity = await this.repository.authorizeParent(actor);
    await this.client.send(actor.chatId, await this.navigation.openMain(identity,
      PAIRED + (removed ? ' Повідомлення з ключем видалено.' : ' Видаліть повідомлення з ключем із чату.')));
  }

  private async reply(identity: ParentIdentity, text: string, parsed: RegExpExecArray | null, updateId: number): Promise<Reply> {
    const plain = (value: string): Reply => ({text: value, buttons: []});
    if (!parsed) return (await this.endtime.text(identity, text)) ?? (await this.allowance.text(identity, text)) ??
      (await this.reminders.text(identity, text)) ?? plain(HINT);
    const args = (parsed[2] ?? '').trim();
    switch (parsed[1]) {
      case 'start': return this.navigation.openMain(identity);
      case 'status': return this.navigation.openStatus(identity);
      case 'usage': {
        const period = args || 'today';
        if (period !== 'today' && period !== 'yesterday' && period !== 'week') return plain(USAGE_USAGE);
        return this.navigation.openUsage(identity, period);
      }
      case 'settings': return this.navigation.openSettings(identity);
      case 'unpair': return this.navigation.openLeave(identity);
      case 'help': return plain(HELP);
      case 'pair': return plain(ALREADY_PAIRED);
      case 'endtime': return this.endtime.command(identity, text, updateId);
      case 'limit': return this.allowance.limitCommand(identity, args, updateId);
      case 'categories': return this.allowance.openCategories(identity);
      case 'add_category': return this.allowance.categoryCommand(identity, 'add', args, updateId);
      case 'remove_category': return this.allowance.categoryCommand(identity, 'remove', args, updateId);
      case 'free': return this.allowance.freeCommand(identity, args, updateId);
      case 'restore': return this.allowance.restoreCommand(identity, updateId);
      case 'clear': return this.clear.command(identity, args, updateId);
      case 'notify': case 'overlay': return this.reminders.command(identity, parsed[1], args, updateId);
      case 'pending': return this.reminders.openPending(identity);
      case 'hourly':
        if (args !== 'on' && args !== 'off') return plain(HOURLY_USAGE);
        await this.settings.setHourly(identity, args === 'on', `tg:${updateId}`);
        return plain(hourlySaved(args === 'on'));
      default: return plain(UNKNOWN_COMMAND);
    }
  }
}
