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
import type {CallbackGuard,SettingsChange,SettingsService,SettingsUpdateResult} from '../settings.js';
import {MenuSessions,type MenuSession} from './sessions.js';
import {loadReport,laptopOffline,type ReportData} from './reports.js';
import {text as copy,type Button,type Catalogue,type Reply} from './i18n/index.js';

export const PAGE_SIZE = 8;
const MAX_MINUTES = 24 * 60;

/** Exact minutes from `H:MM`, `90`, `90 хв`, `90 min`, `2 год 30 хв`, `2 h 30 min`, `2h30m` and similar, in either
 * language whatever the caregiver's; 0..24 hours. */
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
/** Case-insensitive match of a typed name; `›`, `>` and `/` separate levels. Uncategorized goes by its name in either language. */
function matches(text: string, path: CategoryPath | null): boolean {
  const typed = text.trim().toLowerCase().split(/\s*(?:›|>|\/)\s*/);
  if (path === null) return typed.length === 1 && [copy('uk'), copy('en')].some(t => t.categoryLabel(null).toLowerCase() === typed[0]);
  return typed.length === path.length && typed.every((segment, i) => segment === path[i]!.toLowerCase());
}

function review(intent: Intent, t: Catalogue): string {
  switch (intent.kind) {
    case 'setTodayLimit': return t.reviewToday(t.duration(intent.ms));
    case 'setDefaultLimit': return t.reviewDaily(t.duration(intent.ms));
    case 'setFreeUse': return t.reviewFree(intent.enabled);
    case 'setSuppression': return t.REVIEW_RESTORE;
    default: return t.reviewCategory(intent.kind === 'addCategory', t.categoryLabel(pathOf(intent.pick)));
  }
}

/** The issuer's confirmation: saved state, or an explicit no-op. */
function outcome(intent: Intent, result: SettingsUpdateResult, today: string, offline: boolean, t: Catalogue): string {
  const s = result.settings, changed = result.changed !== false;
  switch (intent.kind) {
    case 'setTodayLimit': return changed ? t.savedText(t.savedToday(t.duration(intent.ms)), offline) : t.sameToday(t.duration(intent.ms));
    case 'setDefaultLimit': return changed ? t.savedText(t.savedDaily(t.duration(intent.ms)), offline) : t.sameDaily(t.duration(intent.ms));
    case 'setFreeUse': return changed ? t.savedText(t.savedFree(intent.enabled), offline) : t.sameFree(intent.enabled);
    case 'setSuppression':
      if (!changed) return t.SAME_RESTORE;
      return t.savedText(t.SAVED_RESTORE, offline, s.freeUseDate === today ? t.FREE_STILL_ON : undefined);
    default:
      if (!changed) return t.sameCategory(intent.kind === 'addCategory', t.categoryLabel(pathOf(intent.pick)));
      return t.savedText(t.savedCategories(t.selectionLabel(s.selectedPaths, s.selectedUncategorized)), offline);
  }
}

const stale = (t: Catalogue): Reply => ({text: t.STALE_LIMIT, buttons: [], toast: true});
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
    return this.render(copy(identity.lang), await this.sessions.open(identity, 'limit', state), state, await this.data(identity));
  }
  private data(identity: ParentIdentity): Promise<ReportData> {return loadReport(this.repository, identity, this.clock());}

  // Direct commands carry Telegram's update_id as their operation identity.
  async limitCommand(identity: ParentIdentity, args: string, updateId: number): Promise<Reply> {
    if (!args) return this.openStatus(identity);
    const words = args.split(/\s+/), scope = words.at(-1), rest = words.slice(0, -1).join(' '), t = copy(identity.lang);
    if ((scope !== 'today' && scope !== 'daily') || !rest) return plain(t.LIMIT_USAGE);
    const ms = parseDuration(rest);
    if (ms === null) return plain(t.DURATION_FORMAT);
    return plain(await this.apply(identity, {kind: scope === 'today' ? 'setTodayLimit' : 'setDefaultLimit', ms}, `tg:${updateId}`));
  }
  async freeCommand(identity: ParentIdentity, args: string, updateId: number): Promise<Reply> {
    if (args !== 'on' && args !== 'off') return plain(copy(identity.lang).FREE_USAGE);
    return plain(await this.apply(identity, {kind: 'setFreeUse', enabled: args === 'on'}, `tg:${updateId}`));
  }
  async restoreCommand(identity: ParentIdentity, updateId: number): Promise<Reply> {
    return plain(await this.apply(identity, {kind: 'setSuppression', enabled: false}, `tg:${updateId}`));
  }
  async categoryCommand(identity: ParentIdentity, mode: 'add' | 'remove', args: string, updateId: number): Promise<Reply> {
    const t = copy(identity.lang);
    if (!args) return plain(mode === 'add' ? t.ADD_CATEGORY_USAGE : t.REMOVE_CATEGORY_USAGE);
    const data = await this.data(identity);
    if (mode === 'remove') {
      const path = selected(data.settings).find(p => matches(args, p));
      if (path === undefined) {
        const typed = args.trim().split(/\s*(?:›|>|\/)\s*/);
        const parent = data.settings.selectedPaths.find(p => p.length < typed.length && p.every((s, i) => s.toLowerCase() === typed[i]!.toLowerCase()));
        if (parent) return plain(t.countedVia(typed.join(' › '), t.categoryLabel(parent)));
        return plain(t.notCounted(args));
      }
      return plain(await this.apply(identity, {kind: 'removeCategory', pick: pickOf(path)}, `tg:${updateId}`));
    }
    const entry = (data.live?.categoryCatalog ?? []).find(c => matches(args, c.path));
    if (!entry) return plain(t.categoryNotFound(args));
    if (counted(data.settings, entry.path)) return plain(t.sameCategory(true, t.categoryLabel(entry.path)));
    return plain(await this.apply(identity, {kind: 'addCategory', pick: pickOf(entry.path)}, `tg:${updateId}`));
  }

  private async apply(identity: ParentIdentity, intent: Intent, operationId: string, guard?: CallbackGuard): Promise<string> {
    const result = await this.settings.updateSettings(identity, changeOf(intent), operationId, guard), now = this.clock();
    return outcome(intent, result, kyivDate(now), result.changed !== false && await laptopOffline(this.repository, identity, now), copy(identity.lang));
  }

  async callback(identity: ParentIdentity, data: unknown): Promise<Reply> {
    const match = typeof data === 'string' ? CALLBACK.exec(data) : null;
    if (!match || !ACTIONS.includes(match[3] as Action) || (match[3] === 'pick') !== (match[4] !== undefined)) return stale(copy(identity.lang));
    try {
      const guard = {nonce: match[1]!, version: Number(match[2])};
      const session = await this.sessions.read<LimitState>(identity, guard, 'limit');
      return await this.step(identity, session, match[3] as Action, match[4] === undefined ? null : Number(match[4]));
    } catch (error) {
      if (unauthorized(error)) return stale(copy(identity.lang));
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
        const guard = await this.sessions.advance(identity, session, 'limit', session.state), t = copy(identity.lang);
        return {text: t.DURATION_FORMAT, buttons: [[this.button(guard, 'cancel', t.LABELS.cancel)]]};
      }
      const intent: Intent = {kind: session.state.scope === 'today' ? 'setTodayLimit' : 'setDefaultLimit', ms};
      return await this.go(identity, session, {step: 'confirm', intent, back: 'status'});
    } catch (error) {
      if (unauthorized(error)) return stale(copy(identity.lang));
      throw error;
    }
  }

  private async go(identity: ParentIdentity, session: MenuSession<LimitState>, next: LimitState | null, prefix?: string, data?: ReportData): Promise<Reply> {
    const guard = await this.sessions.advance(identity, session, 'limit', next);
    if (!next) return {text: '', buttons: [], navigate: 'main'};
    return this.render(copy(identity.lang), guard, next, data ?? await this.data(identity), prefix);
  }

  private async step(identity: ParentIdentity, session: MenuSession<LimitState>, action: Action, index: number | null): Promise<Reply> {
    const state = session.state, data = await this.data(identity), s = data.settings, today = kyivDate(this.clock()), t = copy(identity.lang);
    switch (`${state.step}:${action}`) {
      case 'status:today': return this.go(identity, session, {step: 'input', scope: 'today'}, undefined, data);
      case 'status:daily': return this.go(identity, session, {step: 'input', scope: 'daily'}, undefined, data);
      case 'status:cats': case 'pick:back': return this.go(identity, session, {step: 'categories'}, undefined, data);
      case 'status:free': return this.go(identity, session, {step: 'confirm', intent: {kind: 'setFreeUse', enabled: s.freeUseDate !== today}, back: 'status'}, undefined, data);
      case 'status:restore': return this.go(identity, session, {step: 'confirm', intent: {kind: 'setSuppression', enabled: false}, back: 'status'}, undefined, data);
      case 'status:back': return this.go(identity, session, null);
      case 'input:cancel': return this.go(identity, session, {step: 'status'}, t.CANCELED, data);
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
        return this.go(identity, session, {step: state.back}, t.CANCELED, data);
      }
    }
    return stale(t);
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

  private render(t: Catalogue, guard: CallbackGuard, state: LimitState, data: ReportData, prefix?: string): Reply {
    const s = data.settings, today = kyivDate(data.now), back = [this.button(guard, 'back', t.LABELS.back)], labels = t.LIMIT_LABELS;
    let reply: Reply;
    if (state.step === 'status') {
      const day = data.days.get(today);
      const text = t.limitStatus({today: t.duration(effectiveLimitMs(s, today)), override: s.todayOverride?.date === today, daily: t.duration(s.defaultLimitMs),
        usage: day ? t.duration(projectDay(day, s).selectedTotalMs) : null, partial: !!day?.partial,
        categories: s.selectedPaths.length || s.selectedUncategorized ? t.selectionLabel(s.selectedPaths, s.selectedUncategorized) : null,
        free: s.freeUseDate === today, suppressed: s.suppressedDate === today});
      reply = {text, buttons: [[this.button(guard, 'today', labels.today)], [this.button(guard, 'daily', labels.daily)],
        [this.button(guard, 'cats', labels.categories)],
        [this.button(guard, 'free', s.freeUseDate === today ? labels.freeOff : labels.freeOn)],
        ...(s.suppressedDate === today ? [[this.button(guard, 'restore', labels.restore)]] : []), back]};
    } else if (state.step === 'input') {
      reply = {text: state.scope === 'today' ? t.ENTER_TODAY_LIMIT : t.ENTER_DAILY_LIMIT, buttons: [[this.button(guard, 'cancel', t.LABELS.cancel)]]};
    } else if (state.step === 'categories') {
      const chosen = selected(s);
      reply = {text: t.categoriesScreen(chosen.map(t.categoryLabel)),
        buttons: [[this.button(guard, 'add', labels.add)], ...(chosen.length ? [[this.button(guard, 'remove', labels.remove)]] : []), back]};
    } else if (state.step === 'pick') {
      if (!state.options.length) {
        const empty = state.mode === 'remove' ? t.NOTHING_TO_REMOVE : !data.live?.categoryCatalog?.length ? t.NO_CATALOG : t.NOTHING_TO_ADD;
        reply = {text: empty, buttons: [back]};
      } else {
        const pages = this.pageCount(state.mode, data), arrows: Button[] = [];
        if (state.page > 0) arrows.push(this.button(guard, 'prev', labels.prev));
        if (state.page < pages - 1) arrows.push(this.button(guard, 'next', labels.next));
        reply = {text: state.mode === 'add' ? t.PICK_ADD : t.PICK_REMOVE,
          buttons: [...state.options.map((pick, i) => [this.button(guard, 'pick', t.categoryLabel(pathOf(pick)), i)]), ...(arrows.length ? [arrows] : []), back]};
      }
    } else {
      reply = {text: review(state.intent, t), buttons: [[this.button(guard, 'confirm', t.LABELS.confirm)], [this.button(guard, 'cancel', t.LABELS.cancel)]]};
    }
    return prefix ? {...reply, text: prefix + '\n\n' + reply.text} : reply;
  }
}
