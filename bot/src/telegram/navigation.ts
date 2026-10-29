/** Main and Settings menus. Pure transitions plus a controller that persists sessions and renders replies. */
import {BoundaryError,FirestoreRepository,type ParentIdentity} from '../repository.js';
import type {Instant} from '../contracts.js';
import type {CallbackGuard,SettingsService} from '../settings.js';
import type {EndtimeController} from './commands.js';
import type {AllowanceController} from './allowance.js';
import type {RemindersController} from './reminders.js';
import {MenuSessions} from './sessions.js';
import {NAV_LABELS,MAIN_MENU,SETTINGS_MENU,HELP,STALE_NAV,CHOOSE_PERIOD,hourlyLabel,hourlySaved,endtimeLabel,type Button,type Reply} from './uk.js';
import {loadReport,renderStatus,renderUsage,type UsagePeriod} from './reports.js';

/** Limit and Reminders are separate menus that the main menu hands over to. */
export type NavScreen = 'main' | 'settings' | 'help' | 'usage' | 'status';
export interface NavState {screen: NavScreen; period?: UsagePeriod}
export type NavAction = 'usage' | 'status' | 'reminders' | 'limit' | 'settings' | 'hourly' | 'endtime' | 'help' | 'back' |
  UsagePeriod | 'refresh';
/** A null state leaves this menu: openEndtime hands over to the Endtime submenu. */
export interface NavResult {state: NavState | null; effect?: 'toggleHourly' | 'openEndtime' | 'openLimit' | 'openReminders'; error?: 'stale'}

const SECTIONS: readonly NavScreen[] = ['usage', 'status'];
const PERIODS: readonly UsagePeriod[] = ['today', 'yesterday', 'week'];
const ACTIONS: readonly NavAction[] = ['usage', 'status', 'reminders', 'limit', 'settings', 'hourly', 'endtime', 'help', 'back', ...PERIODS, 'refresh'];

export function transitionNav(state: NavState, action: NavAction): NavResult {
  const to = (screen: NavScreen): NavResult => ({state: {screen}});
  if (state.screen === 'main') {
    if (action === 'limit') return {state: null, effect: 'openLimit'};
    if (action === 'reminders') return {state: null, effect: 'openReminders'};
    if (action === 'settings' || SECTIONS.includes(action as NavScreen)) return to(action as NavScreen);
  } else if (state.screen === 'settings') {
    if (action === 'hourly') return {state, effect: 'toggleHourly'};
    if (action === 'endtime') return {state: null, effect: 'openEndtime'};
    if (action === 'help') return to('help');
    if (action === 'back') return to('main');
  } else if (state.screen === 'help') {
    if (action === 'back') return to('settings');
  } else if (state.screen === 'usage' && PERIODS.includes(action as UsagePeriod)) {
    return {state: {screen: 'usage', period: action as UsagePeriod}};
  } else if (state.screen === 'status' && action === 'refresh') {
    return {state};
  } else if (action === 'back') return to('main');
  return {state, error: 'stale'};
}

const CALLBACK = /^nv:([A-Za-z0-9_-]{1,43}):(0|[1-9][0-9]{0,15}):([a-z]+)$/;
export const encodeNav = (guard: CallbackGuard, action: NavAction): string => `nv:${guard.nonce}:${guard.version}:${action}`;
export function decodeNav(data: unknown): (CallbackGuard & {action: NavAction}) | null {
  const match = typeof data === 'string' ? CALLBACK.exec(data) : null;
  if (!match || !ACTIONS.includes(match[3] as NavAction)) return null;
  const version = Number(match[2]);
  return Number.isSafeInteger(version) ? {nonce: match[1]!, version, action: match[3] as NavAction} : null;
}

const stale = (): Reply => ({text: STALE_NAV, buttons: []});

export class NavigationController {
  private readonly sessions: MenuSessions;
  constructor(private readonly repository: FirestoreRepository, private readonly settings: SettingsService,
              private readonly endtime: EndtimeController, private readonly allowance: AllowanceController,
              private readonly reminders: RemindersController, private readonly clock: () => Instant) {
    this.sessions = new MenuSessions(repository, clock);
  }

  openMain(identity: ParentIdentity, prefix?: string): Promise<Reply> {return this.open(identity, 'main', prefix);}
  openSettings(identity: ParentIdentity, prefix?: string): Promise<Reply> {return this.open(identity, 'settings', prefix);}
  openStatus(identity: ParentIdentity): Promise<Reply> {return this.open(identity, 'status');}
  async openUsage(identity: ParentIdentity, period: UsagePeriod): Promise<Reply> {
    const state = {screen: 'usage' as const, period};
    return this.render(identity, await this.sessions.open(identity, 'nav', state), state);
  }

  private async open(identity: ParentIdentity, screen: NavScreen, prefix?: string): Promise<Reply> {
    const state = {screen};
    return this.render(identity, await this.sessions.open(identity, 'nav', state), state, prefix);
  }

  async callback(identity: ParentIdentity, data: unknown): Promise<Reply> {
    const parsed = decodeNav(data);
    if (!parsed) return stale();
    try {
      const session = await this.sessions.read<NavState>(identity, parsed, 'nav');
      const result = transitionNav(session.state, parsed.action);
      if (result.error) return stale();
      if (result.effect === 'openEndtime') return this.endtime.openMenu(identity);
      if (result.effect === 'openLimit') return this.allowance.openStatus(identity);
      if (result.effect === 'openReminders') return this.reminders.openHome(identity);
      let prefix: string | undefined;
      if (result.effect === 'toggleHourly') {
        const enabled = !(await this.hourlyEnabled(identity));
        // The session version names the operation, so a duplicate tap replays rather than toggling back.
        await this.settings.setHourly(identity, enabled, `menu:${session.nonce}:${session.version}`, session);
        prefix = hourlySaved(enabled);
      }
      return this.render(identity, await this.sessions.advance(identity, session, 'nav', result.state), result.state!, prefix);
    } catch (error) {
      if (error instanceof BoundaryError && error.status === 401) return stale();
      throw error;
    }
  }

  private hourlyEnabled(identity: ParentIdentity): Promise<boolean> {
    return this.repository.db.runTransaction(async tx => (await this.repository.requireParent(tx, identity)).hourlyEnabled);
  }

  private async render(identity: ParentIdentity, guard: CallbackGuard, state: NavState, prefix?: string): Promise<Reply> {
    const button = (action: NavAction, text: string = NAV_LABELS[action as keyof typeof NAV_LABELS]): Button => ({text, data: encodeNav(guard, action)});
    let reply: Reply;
    if (state.screen === 'main') {
      reply = {text: MAIN_MENU, buttons: [[button('usage'), button('status')], [button('reminders'), button('limit')], [button('settings')]]};
    } else if (state.screen === 'settings') {
      const [hourly, {settings}] = await Promise.all([this.hourlyEnabled(identity), this.settings.status(identity)]);
      reply = {text: SETTINGS_MENU, buttons: [[button('hourly', hourlyLabel(hourly))], [button('endtime', endtimeLabel(settings))],
        [button('help')], [button('back')]]};
    } else if (state.screen === 'help') {
      reply = {text: HELP, buttons: [[button('back')]]};
    } else if (state.screen === 'usage') {
      const periods = [[button('today', 'Сьогодні'), button('yesterday', 'Учора'), button('week', 'Останні 7 днів')], [button('back')]];
      if (!state.period) reply = {text: CHOOSE_PERIOD, buttons: periods};
      else {
        const [first, ...extra] = renderUsage(state.period, await loadReport(this.repository, identity, this.clock()));
        reply = {text: first!, buttons: periods, ...(extra.length ? {extra} : {})};
      }
    } else {
      reply = {text: renderStatus(await loadReport(this.repository, identity, this.clock())), buttons: [[button('refresh', '🔄 Оновити'), button('back')]]};
    }
    return prefix ? {...reply, text: prefix + '\n\n' + reply.text} : reply;
  }
}

