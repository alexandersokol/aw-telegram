/** Main and Settings menus. Pure transitions plus a controller that persists sessions and renders replies. */
import {BoundaryError,FirestoreRepository,type ParentIdentity} from '../repository.js';
import type {Instant} from '../contracts.js';
import type {CallbackGuard,SettingsService} from '../settings.js';
import type {EndtimeController} from './commands.js';
import type {AllowanceController} from './allowance.js';
import type {RemindersController} from './reminders.js';
import {MenuSessions} from './sessions.js';
import {text as copy,type Button,type Catalogue,type Lang,type Reply} from './i18n/index.js';
import {loadReport,renderStatus,renderUsage,type UsagePeriod} from './reports.js';

/** Limit and Reminders are separate menus that the main menu hands over to. */
export type NavScreen = 'main' | 'settings' | 'help' | 'usage' | 'status' | 'leave' | 'language';
export interface NavState {screen: NavScreen; period?: UsagePeriod}
export type NavAction = 'usage' | 'status' | 'reminders' | 'limit' | 'settings' | 'hourlyon' | 'hourlyoff' | 'endtime' | 'help' | 'back' |
  UsagePeriod | 'refresh' | 'leave' | 'leaveyes' | 'leaveno' | 'language' | 'languk' | 'langen';
/** A null state leaves this menu: openEndtime hands over to the Endtime submenu; leave ends the caregiver's access. */
export interface NavResult {state: NavState | null; effect?: 'hourlyOn' | 'hourlyOff' | 'openEndtime' | 'openLimit' | 'openReminders' | 'leave' |
  'langUk' | 'langEn'; error?: 'stale'}

const SECTIONS: readonly NavScreen[] = ['usage', 'status'];
const PERIODS: readonly UsagePeriod[] = ['today', 'yesterday', 'week'];
const ACTIONS: readonly NavAction[] = ['usage', 'status', 'reminders', 'limit', 'settings', 'hourlyon', 'hourlyoff', 'endtime', 'help', 'back', ...PERIODS, 'refresh',
  'leave', 'leaveyes', 'leaveno', 'language', 'languk', 'langen'];

export function transitionNav(state: NavState, action: NavAction): NavResult {
  const to = (screen: NavScreen): NavResult => ({state: {screen}});
  if (state.screen === 'main') {
    if (action === 'limit') return {state: null, effect: 'openLimit'};
    if (action === 'reminders') return {state: null, effect: 'openReminders'};
    if (action === 'settings' || SECTIONS.includes(action as NavScreen)) return to(action as NavScreen);
  } else if (state.screen === 'settings') {
    // The button carries its target, so a duplicate or retried tap replays the same operation.
    if (action === 'hourlyon' || action === 'hourlyoff') return {state, effect: action === 'hourlyon' ? 'hourlyOn' : 'hourlyOff'};
    if (action === 'endtime') return {state: null, effect: 'openEndtime'};
    if (action === 'help') return to('help');
    if (action === 'leave') return to('leave');
    if (action === 'language') return to('language');
    if (action === 'back') return to('main');
  } else if (state.screen === 'language') {
    // The choice returns to Settings, rendered in the chosen language.
    if (action === 'languk' || action === 'langen') return {state: {screen: 'settings'}, effect: action === 'languk' ? 'langUk' : 'langEn'};
    if (action === 'back') return to('settings');
  } else if (state.screen === 'help') {
    if (action === 'back') return to('settings');
  } else if (state.screen === 'leave') {
    if (action === 'leaveno') return to('settings');
    if (action === 'leaveyes') return {state: null, effect: 'leave'};
  } else if (state.screen === 'usage' && PERIODS.includes(action as UsagePeriod)) {
    return {state: {screen: 'usage', period: action as UsagePeriod}};
  } else if (state.screen === 'status' && action === 'refresh') {
    return {state};
  } else if (action === 'back') return to('main');
  return {state, error: 'stale'};
}

/** The main-menu button on plain replies (UX-02): no session, since opening the main menu changes nothing. */
export const HOME = 'nv:home';
const CALLBACK = /^nv:([A-Za-z0-9_-]{1,43}):(0|[1-9][0-9]{0,15}):([a-z]+)$/;
export const encodeNav = (guard: CallbackGuard, action: NavAction): string => `nv:${guard.nonce}:${guard.version}:${action}`;
export function decodeNav(data: unknown): (CallbackGuard & {action: NavAction}) | null {
  const match = typeof data === 'string' ? CALLBACK.exec(data) : null;
  if (!match || !ACTIONS.includes(match[3] as NavAction)) return null;
  const version = Number(match[2]);
  return Number.isSafeInteger(version) ? {nonce: match[1]!, version, action: match[3] as NavAction} : null;
}

const stale = (t: Catalogue): Reply => ({text: t.STALE_NAV, buttons: [], toast: true});

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
  openLeave(identity: ParentIdentity): Promise<Reply> {return this.open(identity, 'leave');}
  openLanguage(identity: ParentIdentity): Promise<Reply> {return this.open(identity, 'language');}
  async openUsage(identity: ParentIdentity, period: UsagePeriod): Promise<Reply> {
    const state = {screen: 'usage' as const, period};
    return this.render(identity, await this.sessions.open(identity, 'nav', state), state);
  }

  private async open(identity: ParentIdentity, screen: NavScreen, prefix?: string): Promise<Reply> {
    const state = {screen};
    return this.render(identity, await this.sessions.open(identity, 'nav', state), state, prefix);
  }

  async callback(identity: ParentIdentity, data: unknown): Promise<Reply> {
    if (data === HOME) return this.openMain(identity);
    const parsed = decodeNav(data), t = copy(identity.lang);
    if (!parsed) return stale(t);
    try {
      const session = await this.sessions.read<NavState>(identity, parsed, 'nav');
      const result = transitionNav(session.state, parsed.action);
      if (result.error) return stale(t);
      if (result.effect === 'openEndtime') return this.endtime.openMenu(identity);
      if (result.effect === 'openLimit') return this.allowance.openStatus(identity);
      if (result.effect === 'openReminders') return this.reminders.openHome(identity);
      // The removal deletes the menu session, so nothing is advanced afterwards.
      if (result.effect === 'leave') {
        await this.repository.leaveDevice(identity);
        return {text: t.LEFT + '\n\n' + t.PAIRING, buttons: [], bare: true};
      }
      let prefix: string | undefined, shown = identity;
      if (result.effect === 'hourlyOn' || result.effect === 'hourlyOff') {
        const enabled = result.effect === 'hourlyOn';
        await this.settings.setHourly(identity, enabled, `menu:${session.nonce}:${session.version}`, session);
        prefix = t.hourlySaved(enabled);
      }
      if (result.effect === 'langUk' || result.effect === 'langEn') {
        const lang: Lang = result.effect === 'langUk' ? 'uk' : 'en';
        await this.settings.setLanguage(identity, lang, session);
        shown = {...identity, lang};
        prefix = copy(lang).LANGUAGE_SAVED;
      }
      return this.render(shown, await this.sessions.advance(identity, session, 'nav', result.state), result.state!, prefix);
    } catch (error) {
      if (error instanceof BoundaryError && error.status === 401) return stale(t);
      throw error;
    }
  }

  private hourlyEnabled(identity: ParentIdentity): Promise<boolean> {
    return this.repository.db.runTransaction(async tx => (await this.repository.requireParent(tx, identity)).hourlyEnabled);
  }

  private lastCaregiver(identity: ParentIdentity): Promise<boolean> {
    return this.repository.db.runTransaction(async tx => {
      await this.repository.requireParent(tx, identity);
      return (await tx.get(this.repository.db.doc(`devices/${identity.deviceId}`))).data()!.activeParentIds.length === 1;
    });
  }

  private async render(identity: ParentIdentity, guard: CallbackGuard, state: NavState, prefix?: string): Promise<Reply> {
    const t = copy(identity.lang);
    const button = (action: NavAction, text: string = t.NAV_LABELS[action as keyof Catalogue['NAV_LABELS']]): Button => ({text, data: encodeNav(guard, action)});
    let reply: Reply;
    if (state.screen === 'main') {
      reply = {text: t.MAIN_MENU, buttons: [[button('usage'), button('status')], [button('reminders'), button('limit')], [button('settings')]]};
    } else if (state.screen === 'settings') {
      const [hourly, {settings}] = await Promise.all([this.hourlyEnabled(identity), this.settings.status(identity)]);
      reply = {text: t.SETTINGS_MENU, buttons: [[button(hourly ? 'hourlyoff' : 'hourlyon', t.hourlyLabel(hourly))], [button('endtime', t.endtimeLabel(settings))],
        [button('language', t.LANGUAGE_LABEL)], [button('help')], [button('leave')], [button('back')]]};
    } else if (state.screen === 'language') {
      reply = {text: t.CHOOSE_LANGUAGE, buttons: [[button('languk', t.LANGUAGE_NAMES.uk)], [button('langen', t.LANGUAGE_NAMES.en)], [button('back')]]};
    } else if (state.screen === 'leave') {
      reply = {text: (await this.lastCaregiver(identity)) ? t.LEAVE_CONFIRM + '\n\n' + t.LEAVE_LAST : t.LEAVE_CONFIRM,
        buttons: [[button('leaveyes')], [button('leaveno')]]};
    } else if (state.screen === 'help') {
      reply = {text: t.HELP, buttons: [[button('back')]]};
    } else if (state.screen === 'usage') {
      const periods = [[button('today'), button('yesterday'), button('week')], [button('back')]];
      if (!state.period) reply = {text: t.CHOOSE_PERIOD, buttons: periods};
      else {
        const [first, ...extra] = renderUsage(state.period, await loadReport(this.repository, identity, this.clock()), t);
        reply = {text: first!, buttons: periods, ...(extra.length ? {extra} : {})};
      }
    } else {
      reply = {text: renderStatus(await loadReport(this.repository, identity, this.clock()), t), buttons: [[button('refresh'), button('back')]]};
    }
    return prefix ? {...reply, text: prefix + '\n\n' + reply.text} : reply;
  }
}

