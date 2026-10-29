/** /endtime commands and the Endtime submenu. Returns replies; never sends Telegram or writes Firestore directly. */
import {BoundaryError,FirestoreRepository,type ParentIdentity} from '../repository.js';
import type {Instant} from '../contracts.js';
import {isEndtimeLocalTime,kyivDate} from '../clock.js';
import type {CallbackGuard,SettingsChange,SettingsService} from '../settings.js';
import {transitionEndtimeMenu,encodeCallback,decodeCallback,inputFor,type EndtimeMenuState,type MenuInput,type CallbackAction} from './menus.js';
import {MenuSessions,type MenuSession} from './sessions.js';
import {LABELS,STALE_MENU,TIME_FORMAT,ENDTIME_USAGE,ENTER_TIME,CANCELED,endtimeStatus,endtimeSaved,endtimeReview,type Button,type Reply} from './uk.js';

export type EndtimeCommand = {kind: 'status' | 'on' | 'off'} | {kind: 'set'; localTime: string} | {kind: 'invalid'; reason: 'time' | 'usage'};

export function parseEndtimeCommand(text: string): EndtimeCommand {
  const [head, ...args] = String(text).trim().split(/\s+/);
  if (!/^\/endtime(?:@[A-Za-z0-9_]{1,64})?$/.test(head ?? '')) return {kind: 'invalid', reason: 'usage'};
  if (!args.length || args.length === 1 && args[0] === 'status') return {kind: 'status'};
  if (args[0] === 'set') {
    if (args.length > 2) return {kind: 'invalid', reason: 'usage'};
    return isEndtimeLocalTime(args[1]) ? {kind: 'set', localTime: args[1]} : {kind: 'invalid', reason: 'time'};
  }
  if (args.length === 1 && (args[0] === 'on' || args[0] === 'off')) return {kind: args[0]};
  return {kind: 'invalid', reason: 'usage'};
}

const STATUS: EndtimeMenuState = {step: 'status', draft: null};
const stale = (): Reply => ({text: STALE_MENU, buttons: []});
const unauthorized = (error: unknown): boolean => error instanceof BoundaryError && error.status === 401;

export class EndtimeController {
  private readonly sessions: MenuSessions;
  constructor(repository: FirestoreRepository, private readonly settings: SettingsService, private readonly clock: () => Instant = () => new Date().toISOString()) {
    this.sessions = new MenuSessions(repository, clock);
  }

  /** updateId is Telegram's update_id, so a redelivered update replays the same operation. */
  async command(identity: ParentIdentity, text: string, updateId: number): Promise<Reply> {
    const command = parseEndtimeCommand(text);
    if (command.kind === 'invalid') return {text: command.reason === 'time' ? TIME_FORMAT : ENDTIME_USAGE, buttons: []};
    if (command.kind === 'status') return this.openMenu(identity);
    const change: SettingsChange = command.kind === 'set' ? {kind: 'setEndtime', localTime: command.localTime} :
      {kind: 'setEndtimeEnabled', enabled: command.kind === 'on'};
    const result = await this.settings.updateSettings(identity, change, `tg:${updateId}`);
    return {text: endtimeSaved(result.settings, result.acknowledgedRevision, result.changed !== false), buttons: []};
  }

  /** Status view; opening it again invalidates earlier Endtime buttons. */
  async openMenu(identity: ParentIdentity): Promise<Reply> {
    return this.render(identity, await this.sessions.open(identity, STATUS), STATUS);
  }

  async callback(identity: ParentIdentity, data: unknown): Promise<Reply> {
    const parsed = decodeCallback(data);
    if (!parsed) return stale();
    try {
      return await this.apply(identity, await this.sessions.read(identity, parsed), inputFor(parsed.action));
    } catch (error) {
      if (unauthorized(error)) return stale();
      throw error;
    }
  }

  /** Plain text belongs to the menu only while it is waiting for a time. */
  async text(identity: ParentIdentity, text: string): Promise<Reply | null> {
    const session = await this.sessions.current(identity);
    if (session?.state.step !== 'enterTime') return null;
    try {
      return await this.apply(identity, session, {kind: 'text', text});
    } catch (error) {
      if (unauthorized(error)) return stale();
      throw error;
    }
  }

  private async apply(identity: ParentIdentity, session: MenuSession, input: MenuInput): Promise<Reply> {
    const result = transitionEndtimeMenu(session.state, input);
    if (result.error === 'stale') return stale();
    let prefix: string | undefined;
    if (result.change) {
      // The session version names the operation: duplicate taps replay it, and a moved session is rejected.
      const saved = await this.settings.updateSettings(identity, result.change, `menu:${session.nonce}:${session.version}`, session);
      prefix = endtimeSaved(saved.settings, saved.acknowledgedRevision, saved.changed !== false);
    } else if (result.notice === 'canceled') prefix = CANCELED;
    const guard = await this.sessions.advance(identity, session, result.state);
    if (!result.state) return {text: '', buttons: [], navigate: 'settings'};
    if (result.error === 'time') return {text: TIME_FORMAT, buttons: [[this.button(guard, 'cancel')]]};
    return this.render(identity, guard, result.state, prefix);
  }

  private button(guard: CallbackGuard, action: CallbackAction): Button {
    return {text: LABELS[action], data: encodeCallback(guard.nonce, guard.version, action)};
  }

  private async render(identity: ParentIdentity, guard: CallbackGuard, state: EndtimeMenuState, prefix?: string): Promise<Reply> {
    let reply: Reply;
    if (state.step === 'enterTime') reply = {text: ENTER_TIME, buttons: [[this.button(guard, 'cancel')]]};
    else if (state.step === 'review') reply = {text: endtimeReview(state.draft!),
      buttons: [[this.button(guard, 'confirm')], [this.button(guard, 'cancel')], [this.button(guard, 'back')]]};
    else {
      const {settings, acknowledgedRevision} = await this.settings.status(identity);
      reply = {text: endtimeStatus(settings, acknowledgedRevision, kyivDate(this.clock())),
        buttons: [[this.button(guard, settings.endtimeEnabled ? 'off' : 'on')], [this.button(guard, 'time')], [this.button(guard, 'back')]]};
    }
    return prefix ? {...reply, text: prefix + '\n\n' + reply.text} : reply;
  }
}
