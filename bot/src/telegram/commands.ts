/** /endtime commands and the Endtime submenu. Returns replies; never sends Telegram or writes Firestore directly. */
import {BoundaryError,FirestoreRepository,type ParentIdentity} from '../repository.js';
import type {Instant} from '../contracts.js';
import {isEndtimeLocalTime,kyivDate} from '../clock.js';
import type {CallbackGuard,SettingsChange,SettingsService,SettingsUpdateResult} from '../settings.js';
import {transitionEndtimeMenu,encodeCallback,decodeCallback,inputFor,type EndtimeMenuState,type MenuInput,type CallbackAction} from './menus.js';
import {MenuSessions,type MenuSession} from './sessions.js';
import {laptopOffline} from './reports.js';
import {text as copy,type Button,type Catalogue,type Reply} from './i18n/index.js';

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
const stale = (t: Catalogue): Reply => ({text: t.STALE_MENU, buttons: [], toast: true});
const unauthorized = (error: unknown): boolean => error instanceof BoundaryError && error.status === 401;

export class EndtimeController {
  private readonly sessions: MenuSessions;
  constructor(private readonly repository: FirestoreRepository, private readonly settings: SettingsService, private readonly clock: () => Instant = () => new Date().toISOString()) {
    this.sessions = new MenuSessions(repository, clock);
  }

  /** updateId is Telegram's update_id, so a redelivered update replays the same operation. */
  async command(identity: ParentIdentity, text: string, updateId: number): Promise<Reply> {
    const command = parseEndtimeCommand(text), t = copy(identity.lang);
    if (command.kind === 'invalid') return {text: command.reason === 'time' ? t.TIME_FORMAT : t.ENDTIME_USAGE, buttons: []};
    if (command.kind === 'status') return this.openMenu(identity);
    const change: SettingsChange = command.kind === 'set' ? {kind: 'setEndtime', localTime: command.localTime} :
      {kind: 'setEndtimeEnabled', enabled: command.kind === 'on'};
    return {text: await this.saved(identity, await this.settings.updateSettings(identity, change, `tg:${updateId}`)), buttons: []};
  }

  /** Status view; opening it again invalidates earlier Endtime buttons. */
  async openMenu(identity: ParentIdentity): Promise<Reply> {
    return this.render(identity, await this.sessions.open(identity, 'endtime', STATUS), STATUS);
  }

  async callback(identity: ParentIdentity, data: unknown): Promise<Reply> {
    const parsed = decodeCallback(data);
    if (!parsed) return stale(copy(identity.lang));
    try {
      return await this.apply(identity, await this.sessions.read<EndtimeMenuState>(identity, parsed, 'endtime'), inputFor(parsed.action));
    } catch (error) {
      if (unauthorized(error)) return stale(copy(identity.lang));
      throw error;
    }
  }

  /** Plain text belongs to the menu only while it is waiting for a time. */
  async text(identity: ParentIdentity, text: string): Promise<Reply | null> {
    const session = await this.sessions.current<EndtimeMenuState>(identity, 'endtime');
    if (session?.state.step !== 'enterTime') return null;
    try {
      return await this.apply(identity, session, {kind: 'text', text});
    } catch (error) {
      if (unauthorized(error)) return stale(copy(identity.lang));
      throw error;
    }
  }

  private async apply(identity: ParentIdentity, session: MenuSession<EndtimeMenuState>, input: MenuInput): Promise<Reply> {
    const result = transitionEndtimeMenu(session.state, input), t = copy(identity.lang);
    if (result.error === 'stale') return stale(t);
    let prefix: string | undefined;
    if (result.change) {
      // The session version names the operation: duplicate taps replay it, and a moved session is rejected.
      const saved = await this.settings.updateSettings(identity, result.change, `menu:${session.nonce}:${session.version}`, session);
      prefix = await this.saved(identity, saved);
    } else if (result.notice === 'canceled') prefix = t.CANCELED;
    const guard = await this.sessions.advance(identity, session, 'endtime', result.state);
    if (!result.state) return {text: '', buttons: [], navigate: 'settings'};
    if (result.error === 'time') return {text: t.TIME_FORMAT, buttons: [[this.button(t, guard, 'cancel')]]};
    return this.render(identity, guard, result.state, prefix);
  }

  private async saved(identity: ParentIdentity, result: SettingsUpdateResult): Promise<string> {
    const changed = result.changed !== false;
    return copy(identity.lang).endtimeSaved(result.settings, changed, changed && await laptopOffline(this.repository, identity, this.clock()));
  }

  private button(t: Catalogue, guard: CallbackGuard, action: CallbackAction): Button {
    return {text: t.LABELS[action], data: encodeCallback(guard.nonce, guard.version, action)};
  }

  private async render(identity: ParentIdentity, guard: CallbackGuard, state: EndtimeMenuState, prefix?: string): Promise<Reply> {
    const t = copy(identity.lang), button = (action: CallbackAction) => this.button(t, guard, action);
    let reply: Reply;
    if (state.step === 'enterTime') reply = {text: t.ENTER_TIME, buttons: [[button('cancel')]]};
    else if (state.step === 'review') reply = {text: t.endtimeReview(state.draft!), buttons: [[button('confirm')], [button('cancel')], [button('back')]]};
    else {
      const {settings, acknowledgedRevision} = await this.settings.status(identity);
      reply = {text: t.endtimeStatus(settings, acknowledgedRevision, kyivDate(this.clock())),
        buttons: [[button(settings.endtimeEnabled ? 'off' : 'on')], [button('time')], [button('back')]]};
    }
    return prefix ? {...reply, text: prefix + '\n\n' + reply.text} : reply;
  }
}
