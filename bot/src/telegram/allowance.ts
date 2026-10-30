/** /limit, categories, free use and restore. Menu changes are reviewed before mutation; commands apply directly.
 *
 * Mutations go only through SettingsService. Category picks store their options in the session as
 * {segments} objects, because Firestore cannot hold nested arrays, and are applied as atomic
 * addCategory/removeCategory changes against the settings current at confirmation.
 */
import {BoundaryError,FirestoreRepository,type ParentIdentity} from '../repository.js';
import {projectDay,type CategoryPath,type CategoryRef,type Instant,type Settings} from '../contracts.js';
import {kyivDate} from '../clock.js';
import {effectiveLimitMs} from '../alerts.js';
import {categoryLabel,duration,selectionLabel} from '../format.js';
import type {CallbackGuard,SettingsChange,SettingsService,SettingsUpdateResult} from '../settings.js';
import {MenuSessions,type MenuSession} from './sessions.js';
import {loadReport,laptopOffline,type ReportData} from './reports.js';
import {LABELS,LIMIT_LABELS,REVIEW,STALE_LIMIT,LIMIT_USAGE,DURATION_FORMAT,FREE_USAGE,ADD_CATEGORY_USAGE,REMOVE_CATEGORY_USAGE,
  ENTER_TODAY_LIMIT,ENTER_DAILY_LIMIT,NO_CATALOG,PICK_ADD,PICK_REMOVE,NOTHING_TO_ADD,NOTHING_TO_REMOVE,FREE_STILL_ON,CANCELED,savedText,
  type Button,type Reply} from './uk.js';

export const PAGE_SIZE = 8;
const MAX_MINUTES = 24 * 60;

/** Exact minutes from `H:MM`, `90`, `90 хв`, `2 год 30 хв`, `2h30m` and similar; 0..24 hours. */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase();
  let minutes: number | null = null, match: RegExpExecArray | null;
  if ((match = /^(\d{1,2}):([0-5]\d)$/.exec(value))) minutes = Number(match[1]) * 60 + Number(match[2]);
  else if ((match = /^(\d{1,4})\s*(?:хв|m|min)?$/.exec(value))) minutes = Number(match[1]);
  else if ((match = /^(\d{1,2})\s*(?:год|h)(?:\s*(\d{1,2})\s*(?:хв|m|min))?$/.exec(value))) {
    const extra = Number(match[2] ?? 0);
    if (extra < 60) minutes = Number(match[1]) * 60 + extra;
  }
  return minutes !== null && minutes <= MAX_MINUTES ? minutes * 60000 : null;
}

type Pick = {segments: string[]} | {uncategorized: true};
type Intent = {kind: 'setTodayLimit' | 'setDefaultLimit'; ms: number} | {kind: 'setFreeUse' | 'setSuppression'; enabled: boolean} |
  {kind: 'addCategory'; pick: Pick} | {kind: 'removeCategory'; pick: Pick};
type Back = 'status' | 'categories';
export type LimitState = {step: 'status'} | {step: 'input'; scope: 'today' | 'daily'} | {step: 'categories'} |
  {step: 'pick'; mode: 'add' | 'remove'; page: number; options: Pick[]} | {step: 'confirm'; intent: Intent; back: Back};
type Action = 'today' | 'daily' | 'cats' | 'free' | 'restore' | 'add' | 'remove' | 'prev' | 'next' | 'pick' | 'confirm' | 'cancel' | 'back';
const ACTIONS: readonly Action[] = ['today', 'daily', 'cats', 'free', 'restore', 'add', 'remove', 'prev', 'next', 'pick', 'confirm', 'cancel', 'back'];
const CALLBACK = /^lm:([A-Za-z0-9_-]{1,43}):(0|[1-9][0-9]{0,15}):([a-z]+)(?::([0-7]))?$/;

const pathOf = (pick: Pick): CategoryPath | null => 'segments' in pick ? pick.segments : null;
const pickOf = (path: CategoryPath | null): Pick => path === null ? {uncategorized: true} : {segments: path};
function changeOf(intent: Intent): SettingsChange {
  if (intent.kind === 'addCategory' || intent.kind === 'removeCategory') return {kind: intent.kind, path: pathOf(intent.pick)};
  return intent;
}
/** A path is already counted when it, or one of its ancestors, is selected. */
function counted(settings: Settings, path: CategoryPath | null): boolean {
  if (path === null) return settings.selectedUncategorized;
  return settings.selectedPaths.some(s => s.length <= path.length && s.every((segment, i) => segment === path[i]));
}
function selected(settings: Settings): (CategoryPath | null)[] {
  return [...settings.selectedPaths, ...(settings.selectedUncategorized ? [null] : [])];
}
/** Case-insensitive match of a typed name; `›`, `>` and `/` separate levels. */
function matches(text: string, path: CategoryPath | null): boolean {
  const typed = text.trim().toLowerCase().split(/\s*(?:›|>|\/)\s*/);
  const label = path === null ? [categoryLabel(null).toLowerCase()] : path.map(s => s.toLowerCase());
  return typed.length === label.length && typed.every((segment, i) => segment === label[i]);
}

function review(intent: Intent): string {
  const tail = 'Інших батьків буде повідомлено.';
  switch (intent.kind) {
    case 'setTodayLimit': return `${REVIEW}\n\nЛіміт лише на сьогодні: ${duration(intent.ms)}\nЩоденний ліміт не зміниться. Зміна діє до опівночі. ${tail}`;
    case 'setDefaultLimit': return `${REVIEW}\n\nНовий щоденний ліміт: ${duration(intent.ms)}\nДіє з сьогодні й надалі та замінює зміну лише на сьогодні. ${tail}`;
    case 'setFreeUse': return intent.enabled ?
      `${REVIEW}\n\nУвімкнути вільний режим до опівночі?\nНагадування й попередження про ліміт буде пропущено, облік часу продовжиться. ${tail}` :
      `${REVIEW}\n\nВимкнути вільний режим?\nНагадування про ліміт відновляться з урахуванням усього часу за сьогодні. ${tail}`;
    case 'setSuppression': return `${REVIEW}\n\nВідновити автоматичні нагадування на сьогодні?\nСкасовані ручні нагадування не повернуться. ${tail}`;
    default: {
      const verb = intent.kind === 'addCategory' ? 'Додати до обліку' : 'Прибрати з обліку';
      return `${REVIEW}\n\n${verb}: ${categoryLabel(pathOf(intent.pick))}\nСьогоднішній облік буде перераховано з усіх даних за день. ${tail}`;
    }
  }
}

/** The issuer's confirmation: saved state, or an explicit no-op. */
function outcome(intent: Intent, result: SettingsUpdateResult, today: string, offline: boolean): string {
  const s = result.settings, changed = result.changed !== false;
  switch (intent.kind) {
    case 'setTodayLimit':
      return changed ? savedText(`ліміт на сьогодні ${duration(intent.ms)}.`, offline) : `Без змін: ліміт на сьогодні вже ${duration(intent.ms)}.`;
    case 'setDefaultLimit':
      return changed ? savedText(`щоденний ліміт ${duration(intent.ms)}.`, offline) : `Без змін: щоденний ліміт уже ${duration(intent.ms)}.`;
    case 'setFreeUse':
      if (!changed) return `Без змін: вільний режим уже ${intent.enabled ? 'увімкнено' : 'вимкнено'}.`;
      return savedText(intent.enabled ? 'вільний режим увімкнено до опівночі.' : 'вільний режим вимкнено.', offline);
    case 'setSuppression':
      if (!changed) return 'Без змін: автоматичні нагадування не вимкнено.';
      return savedText('автоматичні нагадування відновлено.', offline, s.freeUseDate === today ? FREE_STILL_ON : undefined);
    default:
      if (!changed) return `Без змін: «${categoryLabel(pathOf(intent.pick))}» ${intent.kind === 'addCategory' ? 'уже враховується' : 'не враховується'}.`;
      return savedText(`категорії для обліку — ${selectionLabel(s.selectedPaths, s.selectedUncategorized)}.`, offline);
  }
}

const stale = (): Reply => ({text: STALE_LIMIT, buttons: [], toast: true});
const plain = (text: string): Reply => ({text, buttons: []});
const unauthorized = (error: unknown) => error instanceof BoundaryError && error.status === 401;

export class AllowanceController {
  private readonly sessions: MenuSessions;
  constructor(private readonly repository: FirestoreRepository, private readonly settings: SettingsService,
              private readonly clock: () => Instant) {
    this.sessions = new MenuSessions(repository, clock);
  }

  openStatus(identity: ParentIdentity): Promise<Reply> {return this.open(identity, {step: 'status'});}
  openCategories(identity: ParentIdentity): Promise<Reply> {return this.open(identity, {step: 'categories'});}
  private async open(identity: ParentIdentity, state: LimitState): Promise<Reply> {
    return this.render(await this.sessions.open(identity, 'limit', state), state, await this.data(identity));
  }
  private data(identity: ParentIdentity): Promise<ReportData> {return loadReport(this.repository, identity, this.clock());}

  // Direct commands carry Telegram's update_id as their operation identity.
  async limitCommand(identity: ParentIdentity, args: string, updateId: number): Promise<Reply> {
    if (!args) return this.openStatus(identity);
    const words = args.split(/\s+/), scope = words.at(-1), rest = words.slice(0, -1).join(' ');
    if ((scope !== 'today' && scope !== 'daily') || !rest) return plain(LIMIT_USAGE);
    const ms = parseDuration(rest);
    if (ms === null) return plain(DURATION_FORMAT);
    return plain(await this.apply(identity, {kind: scope === 'today' ? 'setTodayLimit' : 'setDefaultLimit', ms}, `tg:${updateId}`));
  }
  async freeCommand(identity: ParentIdentity, args: string, updateId: number): Promise<Reply> {
    if (args !== 'on' && args !== 'off') return plain(FREE_USAGE);
    return plain(await this.apply(identity, {kind: 'setFreeUse', enabled: args === 'on'}, `tg:${updateId}`));
  }
  async restoreCommand(identity: ParentIdentity, updateId: number): Promise<Reply> {
    return plain(await this.apply(identity, {kind: 'setSuppression', enabled: false}, `tg:${updateId}`));
  }
  async categoryCommand(identity: ParentIdentity, mode: 'add' | 'remove', args: string, updateId: number): Promise<Reply> {
    if (!args) return plain(mode === 'add' ? ADD_CATEGORY_USAGE : REMOVE_CATEGORY_USAGE);
    const data = await this.data(identity);
    if (mode === 'remove') {
      const path = selected(data.settings).find(p => matches(args, p));
      if (path === undefined) {
        const typed = args.trim().split(/\s*(?:›|>|\/)\s*/);
        const parent = data.settings.selectedPaths.find(p => p.length < typed.length && p.every((s, i) => s.toLowerCase() === typed[i]!.toLowerCase()));
        if (parent) return plain(`«${typed.join(' › ')}» враховується через «${categoryLabel(parent)}». Щоб її не враховувати, приберіть «${categoryLabel(parent)}».`);
        return plain(`Без змін: «${args}» не враховується.`);
      }
      return plain(await this.apply(identity, {kind: 'removeCategory', pick: pickOf(path)}, `tg:${updateId}`));
    }
    const entry = (data.live?.categoryCatalog ?? []).find(c => matches(args, c.path));
    if (!entry) return plain(`Категорію «${args}» не знайдено. Перелік: /categories`);
    if (counted(data.settings, entry.path)) return plain(`Без змін: «${categoryLabel(entry.path)}» уже враховується.`);
    return plain(await this.apply(identity, {kind: 'addCategory', pick: pickOf(entry.path)}, `tg:${updateId}`));
  }

  private async apply(identity: ParentIdentity, intent: Intent, operationId: string, guard?: CallbackGuard): Promise<string> {
    const result = await this.settings.updateSettings(identity, changeOf(intent), operationId, guard), now = this.clock();
    return outcome(intent, result, kyivDate(now), result.changed !== false && await laptopOffline(this.repository, identity, now));
  }

  async callback(identity: ParentIdentity, data: unknown): Promise<Reply> {
    const match = typeof data === 'string' ? CALLBACK.exec(data) : null;
    if (!match || !ACTIONS.includes(match[3] as Action) || (match[3] === 'pick') !== (match[4] !== undefined)) return stale();
    try {
      const guard = {nonce: match[1]!, version: Number(match[2])};
      const session = await this.sessions.read<LimitState>(identity, guard, 'limit');
      return await this.step(identity, session, match[3] as Action, match[4] === undefined ? null : Number(match[4]));
    } catch (error) {
      if (unauthorized(error)) return stale();
      throw error;
    }
  }

  /** Plain text belongs to this menu only while it waits for a duration. */
  async text(identity: ParentIdentity, text: string): Promise<Reply | null> {
    const session = await this.sessions.current<LimitState>(identity, 'limit');
    if (session?.state.step !== 'input') return null;
    try {
      const ms = parseDuration(text);
      if (ms === null) {
        const guard = await this.sessions.advance(identity, session, 'limit', session.state);
        return {text: DURATION_FORMAT, buttons: [[this.button(guard, 'cancel', LABELS.cancel)]]};
      }
      const intent: Intent = {kind: session.state.scope === 'today' ? 'setTodayLimit' : 'setDefaultLimit', ms};
      return await this.go(identity, session, {step: 'confirm', intent, back: 'status'});
    } catch (error) {
      if (unauthorized(error)) return stale();
      throw error;
    }
  }

  private async go(identity: ParentIdentity, session: MenuSession<LimitState>, next: LimitState | null, prefix?: string, data?: ReportData): Promise<Reply> {
    const guard = await this.sessions.advance(identity, session, 'limit', next);
    if (!next) return {text: '', buttons: [], navigate: 'main'};
    return this.render(guard, next, data ?? await this.data(identity), prefix);
  }

  private async step(identity: ParentIdentity, session: MenuSession<LimitState>, action: Action, index: number | null): Promise<Reply> {
    const state = session.state, data = await this.data(identity), s = data.settings, today = kyivDate(this.clock());
    switch (`${state.step}:${action}`) {
      case 'status:today': return this.go(identity, session, {step: 'input', scope: 'today'}, undefined, data);
      case 'status:daily': return this.go(identity, session, {step: 'input', scope: 'daily'}, undefined, data);
      case 'status:cats': case 'pick:back': return this.go(identity, session, {step: 'categories'}, undefined, data);
      case 'status:free': return this.go(identity, session, {step: 'confirm', intent: {kind: 'setFreeUse', enabled: s.freeUseDate !== today}, back: 'status'}, undefined, data);
      case 'status:restore': return this.go(identity, session, {step: 'confirm', intent: {kind: 'setSuppression', enabled: false}, back: 'status'}, undefined, data);
      case 'status:back': return this.go(identity, session, null);
      case 'input:cancel': return this.go(identity, session, {step: 'status'}, CANCELED, data);
      case 'categories:add': case 'categories:remove':
        return this.go(identity, session, this.pickPage(action as 'add' | 'remove', 0, data), undefined, data);
      case 'categories:back': return this.go(identity, session, {step: 'status'}, undefined, data);
      case 'pick:prev': case 'pick:next': {
        if (state.step !== 'pick') break;
        return this.go(identity, session, this.pickPage(state.mode, state.page + (action === 'next' ? 1 : -1), data), undefined, data);
      }
      case 'pick:pick': {
        if (state.step !== 'pick' || index === null || index >= state.options.length) break;
        const intent: Intent = {kind: state.mode === 'add' ? 'addCategory' : 'removeCategory', pick: state.options[index]!};
        return this.go(identity, session, {step: 'confirm', intent, back: 'categories'}, undefined, data);
      }
      case 'confirm:confirm': {
        if (state.step !== 'confirm') break;
        // The session version names the operation: a duplicate tap replays, a moved session is rejected.
        const text = await this.apply(identity, state.intent, `menu:${session.nonce}:${session.version}`, session);
        return this.go(identity, session, {step: state.back}, text);
      }
      case 'confirm:cancel': {
        if (state.step !== 'confirm') break;
        return this.go(identity, session, {step: state.back}, CANCELED, data);
      }
    }
    return stale();
  }

  private pickPage(mode: 'add' | 'remove', page: number, data: ReportData): LimitState {
    const paths: (CategoryPath | null)[] = mode === 'remove' ? selected(data.settings) :
      (data.live?.categoryCatalog ?? []).map((c: CategoryRef) => c.path).filter(path => !counted(data.settings, path));
    const last = Math.max(0, Math.ceil(paths.length / PAGE_SIZE) - 1), clamped = Math.min(Math.max(page, 0), last);
    return {step: 'pick', mode, page: clamped, options: paths.slice(clamped * PAGE_SIZE, (clamped + 1) * PAGE_SIZE).map(pickOf)};
  }
  private pageCount(mode: 'add' | 'remove', data: ReportData): number {
    const all = mode === 'remove' ? selected(data.settings).length :
      (data.live?.categoryCatalog ?? []).filter((c: CategoryRef) => !counted(data.settings, c.path)).length;
    return Math.ceil(all / PAGE_SIZE);
  }

  private button(guard: CallbackGuard, action: Action, text: string, index?: number): Button {
    return {text, data: `lm:${guard.nonce}:${guard.version}:${action}${index === undefined ? '' : ':' + index}`};
  }

  private render(guard: CallbackGuard, state: LimitState, data: ReportData, prefix?: string): Reply {
    const s = data.settings, today = kyivDate(data.now), back = [this.button(guard, 'back', LABELS.back)];
    let reply: Reply;
    if (state.step === 'status') {
      const day = data.days.get(today), override = s.todayOverride?.date === today;
      const usage = day ? `${duration(projectDay(day, s).selectedTotalMs)}${day.partial ? ' (неповні дані)' : ''}` : 'даних немає';
      const lines = ['⏱ Ліміт часу', '', `Сьогодні: ${duration(effectiveLimitMs(s, today))} (${override ? 'лише сьогодні' : 'щоденний ліміт'})`,
        `Щоденний ліміт: ${duration(s.defaultLimitMs)}`, `Враховано сьогодні: ${usage}`,
        `Категорії: ${s.selectedPaths.length || s.selectedUncategorized ? selectionLabel(s.selectedPaths, s.selectedUncategorized) : 'не вибрано'}`,
        `Вільний режим: ${s.freeUseDate === today ? 'увімкнено до опівночі' : 'вимкнено'}`];
      if (s.suppressedDate === today) lines.push('Автоматичні нагадування: вимкнено до опівночі');
      reply = {text: lines.join('\n'), buttons: [[this.button(guard, 'today', LIMIT_LABELS.today)], [this.button(guard, 'daily', LIMIT_LABELS.daily)],
        [this.button(guard, 'cats', LIMIT_LABELS.categories)],
        [this.button(guard, 'free', s.freeUseDate === today ? LIMIT_LABELS.freeOff : LIMIT_LABELS.freeOn)],
        ...(s.suppressedDate === today ? [[this.button(guard, 'restore', LIMIT_LABELS.restore)]] : []), back]};
    } else if (state.step === 'input') {
      reply = {text: state.scope === 'today' ? ENTER_TODAY_LIMIT : ENTER_DAILY_LIMIT, buttons: [[this.button(guard, 'cancel', LABELS.cancel)]]};
    } else if (state.step === 'categories') {
      const chosen = selected(s);
      reply = {text: chosen.length ? `Категорії для обліку\n\nВибрано:\n${chosen.map(p => '• ' + categoryLabel(p)).join('\n')}` :
        'Категорії для обліку\n\nВибрано: нічого, тому нічого не враховується.',
        buttons: [[this.button(guard, 'add', LIMIT_LABELS.add)], ...(chosen.length ? [[this.button(guard, 'remove', LIMIT_LABELS.remove)]] : []), back]};
    } else if (state.step === 'pick') {
      if (!state.options.length) {
        const empty = state.mode === 'remove' ? NOTHING_TO_REMOVE : !data.live?.categoryCatalog?.length ? NO_CATALOG : NOTHING_TO_ADD;
        reply = {text: empty, buttons: [back]};
      } else {
        const pages = this.pageCount(state.mode, data), arrows: Button[] = [];
        if (state.page > 0) arrows.push(this.button(guard, 'prev', LIMIT_LABELS.prev));
        if (state.page < pages - 1) arrows.push(this.button(guard, 'next', LIMIT_LABELS.next));
        reply = {text: state.mode === 'add' ? PICK_ADD : PICK_REMOVE,
          buttons: [...state.options.map((pick, i) => [this.button(guard, 'pick', categoryLabel(pathOf(pick)), i)]), ...(arrows.length ? [arrows] : []), back]};
      }
    } else {
      reply = {text: review(state.intent), buttons: [[this.button(guard, 'confirm', LABELS.confirm)], [this.button(guard, 'cancel', LABELS.cancel)]]};
    }
    return prefix ? {...reply, text: prefix + '\n\n' + reply.text} : reply;
  }
}
