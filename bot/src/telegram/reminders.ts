/** Reminder menu, /notify, /overlay and /pending. Menu creation ends in a review; a command with text submits
 * directly, like the other direct commands. ActionService owns delivery.
 *
 * The submitted text is the parent's own plain text and is never interpreted as markup. During free
 * use, creation explains the skip at once; a request that still arrives is recorded by ActionService
 * as skipped, which also tells every caregiver, and is never queued for later.
 */
import {BoundaryError,FirestoreRepository,type ParentIdentity} from '../repository.js';
import type {Action,Instant} from '../contracts.js';
import {kyivDate,kyivTime} from '../clock.js';
import {readActionSnapshot,type ActionDraft,type ActionService} from '../actions.js';
import {decodeSettings} from '../settingsCodec.js';
import type {CallbackGuard} from '../settings.js';
import {MenuSessions,type MenuSession} from './sessions.js';
import {paginate} from './reports.js';
import {LABELS,CANCELED,STALE_NAV,type Button,type Reply} from './uk.js';

export const MAX_DELAY_MINUTES = 1439;
export const MAX_BUTTONLESS_SECONDS = 3600;
const MAX_MESSAGE = 1000;

interface Draft {
  kind: 'notify' | 'overlay'; message: string; delayMinutes: number; countdown: boolean;
  mode: 'once' | 'repeat' | 'buttonless'; repeatMinutes: number | null; durationSeconds: number | null;
}
type Step = 'home' | 'text' | 'when' | 'delay' | 'delayInput' | 'countdown' | 'review' | 'options' | 'repeatInput' | 'durationInput' | 'pending' | 'free';
export interface RemindState {step: Step; draft?: Draft}
const INPUTS: readonly Step[] = ['text', 'delayInput', 'repeatInput', 'durationInput'];
const PRESETS = [5, 10, 15, 30] as const;

const T = {
  home: '💬 Нагадування\n\nНадішліть повідомлення на ноутбук або\nперегляньте активні й заплановані нагадування.',
  text: 'Введіть текст повідомлення:', when: 'Коли показати повідомлення?', delay: 'Через скільки показати повідомлення?',
  delayInput: 'Введіть затримку в хвилинах, від 1 до 1439.', minutes: 'Вкажіть ціле число хвилин від 1 до 1439.',
  countdown: 'Показувати зворотний відлік у верхньому лівому куті?', options: 'Додаткові параметри',
  repeatInput: 'Через скільки хвилин повторювати після закриття? Від 1 до 1439.',
  durationInput: 'Скільки секунд показувати без кнопки закриття? Від 1 до 3600.', seconds: 'Вкажіть ціле число секунд від 1 до 3600.',
  message: 'Текст має містити від 1 до 1000 символів.',
  queued: '⏳ Запит збережено. Очікуємо підтвердження від ноутбука.',
  free: 'ℹ️ Увімкнено вільний режим до опівночі.\nЦе нагадування буде пропущено.',
  pending: '📋 Активні та заплановані', none: 'Немає активних або запланованих нагадувань.',
  notifyUsage: 'Використання: /notify [+ХВИЛИНИ] [countdown] ТЕКСТ, наприклад /notify +15 countdown Час на перерву.',
  overlayUsage: 'Використання: /overlay [+ХВИЛИНИ] [countdown] [repeat=ХВИЛИНИ | nodismiss=СЕКУНДИ] ТЕКСТ.',
  conflict: 'Повторення не поєднується з показом без кнопки закриття.',
  countdownDelay: 'Зворотний відлік можливий лише для відкладеного нагадування.',
};
const TITLE = {notify: '🔔 Сповіщення', overlay: '🖥 Повідомлення на екрані'} as const;
const ICON = {notify: '🔔', overlay: '🖥'} as const;

const scalars = (text: string) => [...text].length;
const validMessage = (text: string) => scalars(text) >= 1 && scalars(text) <= MAX_MESSAGE;
const whole = (text: string, max: number): number | null => /^[1-9]\d{0,3}$/.test(text.trim()) && Number(text) <= max ? Number(text) : null;
/** Ukrainian plural of «хвилина» after a number. */
function minutesWord(n: number): string {
  const ten = n % 10, hundred = n % 100;
  if (ten === 1 && hundred !== 11) return 'хвилину';
  return ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? 'хвилини' : 'хвилин';
}

export function toActionDraft(d: Draft): ActionDraft {
  const base = {message: d.message, countdown: d.countdown};
  if (d.kind === 'notify') return {kind: 'notify', delayMinutes: d.delayMinutes, options: base};
  const options = d.mode === 'buttonless' ? {...base, dismissible: false as const, durationSeconds: d.durationSeconds!} :
    {...base, dismissible: true as const, repeatEveryMinutes: d.mode === 'repeat' ? d.repeatMinutes : null};
  return {kind: 'overlay', delayMinutes: d.delayMinutes, options};
}

/** Options precede the text: `+ХВИЛИНИ`, `countdown`, and for overlays `repeat=ХВ` or `nodismiss=С`. */
export function parseReminder(kind: 'notify' | 'overlay', args: string): Draft | string {
  const usage = kind === 'notify' ? T.notifyUsage : T.overlayUsage;
  const draft: Draft = {kind, message: '', delayMinutes: 0, countdown: false, mode: 'once', repeatMinutes: null, durationSeconds: null};
  let rest = args.replace(/^\s+/, ''), match: RegExpExecArray | null;
  for (let token = /^(\S+)(\s+|$)/.exec(rest); token; token = /^(\S+)(\s+|$)/.exec(rest)) {
    const word = token[1]!;
    if ((match = /^\+(\d+)$/.exec(word))) {
      const n = whole(match[1]!, MAX_DELAY_MINUTES); if (n === null) return usage; draft.delayMinutes = n;
    } else if (word === 'countdown') draft.countdown = true;
    else if (kind === 'overlay' && (match = /^repeat=(\d+)$/.exec(word))) {
      const n = whole(match[1]!, MAX_DELAY_MINUTES); if (n === null) return usage;
      if (draft.mode === 'buttonless') return T.conflict; draft.mode = 'repeat'; draft.repeatMinutes = n;
    } else if (kind === 'overlay' && (match = /^nodismiss=(\d+)$/.exec(word))) {
      const n = whole(match[1]!, MAX_BUTTONLESS_SECONDS); if (n === null) return usage;
      if (draft.mode === 'repeat') return T.conflict; draft.mode = 'buttonless'; draft.durationSeconds = n;
    } else if (/^(?:\+|repeat=|nodismiss=)/.test(word)) return usage;
    else break;
    rest = rest.slice(token[0].length);
  }
  draft.message = rest.trim();
  if (!draft.message) return usage;
  if (!validMessage(draft.message)) return T.message;
  if (draft.countdown && !draft.delayMinutes) return T.countdownDelay;
  return draft;
}

function review(d: Draft, now: Instant): string {
  const lines = [TITLE[d.kind], '', `Текст: ${d.message}`];
  lines.push(d.delayMinutes ? `Показати: через ${d.delayMinutes} ${minutesWord(d.delayMinutes)}, о ${kyivTime(new Date(Date.parse(now) + d.delayMinutes * 60000).toISOString())}` : 'Показати: зараз');
  if (d.delayMinutes) lines.push(`Зворотний відлік: ${d.countdown ? 'увімкнено' : 'вимкнено'}`);
  if (d.kind === 'overlay') {
    lines.push(d.mode === 'buttonless' ? `Кнопка закриття: немає, показ ${d.durationSeconds} с` : 'Кнопка закриття: є');
    lines.push(d.mode === 'repeat' ? `Повторення: через ${d.repeatMinutes} хв після закриття, до опівночі` : 'Повторення: немає');
  }
  return lines.join('\n');
}

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return scalars(flat) > 80 ? [...flat].slice(0, 79).join('') + '…' : flat;
};
/** One open action per entry: what it is, its schedule or delivery state, and repeat boundaries. */
function pendingEntry(index: number, action: Action, state: string): string[] {
  const delayed = action.targetAt !== action.createdAt, options = action.options as Record<string, unknown>;
  let status = delayed ? `Заплановано на ${kyivTime(action.targetAt)}` :
    state === 'pending' ? 'Очікує доставки на ноутбук' : state === 'presented' ? 'Показано на ноутбуці' : 'Ноутбук отримав запит';
  if (action.options.countdown) status += ' · відлік увімкнено';
  if (options.dismissible === false) status += ` · без кнопки закриття, ${options.durationSeconds} с`;
  const lines = [`${index}. ${ICON[action.kind]} ${preview(action.options.message)}`, `   ${status}`];
  if (typeof options.repeatEveryMinutes === 'number') lines.push(`   Повторення через ${options.repeatEveryMinutes} хв після закриття`, '   Діє до опівночі');
  return lines;
}

const stale = (): Reply => ({text: STALE_NAV, buttons: [], toast: true});
const plain = (text: string): Reply => ({text, buttons: []});
const unauthorized = (error: unknown) => error instanceof BoundaryError && error.status === 401;

export class RemindersController {
  private readonly sessions: MenuSessions;
  constructor(private readonly repository: FirestoreRepository, private readonly actions: ActionService,
              private readonly clock: () => Instant) {
    this.sessions = new MenuSessions(repository, clock);
  }

  openHome(identity: ParentIdentity, prefix?: string): Promise<Reply> {return this.open(identity, {step: 'home'}, prefix);}
  openPending(identity: ParentIdentity): Promise<Reply> {return this.open(identity, {step: 'pending'});}
  private async open(identity: ParentIdentity, state: RemindState, prefix?: string): Promise<Reply> {
    return this.render(identity, await this.sessions.open(identity, 'remind', state), state, prefix);
  }

  /** A bare command opens the creation flow; otherwise options are parsed and the action submitted directly. */
  async command(identity: ParentIdentity, kind: 'notify' | 'overlay', args: string, updateId: number): Promise<Reply> {
    if (!args) return this.start(identity, kind);
    const draft = parseReminder(kind, args);
    if (typeof draft === 'string') return plain(draft);
    return plain(await this.submit(identity, draft, `tg:${updateId}`));
  }

  private async start(identity: ParentIdentity, kind: 'notify' | 'overlay', session?: MenuSession<RemindState>): Promise<Reply> {
    const state: RemindState = await this.freeUse(identity) ? {step: 'free'} :
      {step: 'text', draft: {kind, message: '', delayMinutes: 0, countdown: false, mode: 'once', repeatMinutes: null, durationSeconds: null}};
    if (!session) return this.open(identity, state);
    return this.render(identity, await this.sessions.advance(identity, session, 'remind', state), state);
  }
  private async freeUse(identity: ParentIdentity): Promise<boolean> {
    const settings = await this.repository.db.runTransaction(async tx => {
      await this.repository.requireParent(tx, identity);
      return decodeSettings((await tx.get(this.repository.db.doc(`devices/${identity.deviceId}/settings/current`))).data());
    });
    return settings.freeUseDate === kyivDate(this.clock());
  }

  private async submit(identity: ParentIdentity, draft: Draft, operationId: string, guard?: CallbackGuard): Promise<string> {
    const result = await this.actions.createAction(identity, toActionDraft(draft), operationId, guard);
    if (result.state === 'skipped') return T.free;
    return draft.delayMinutes ? `${T.queued}\nЗаплановано на ${kyivTime(result.action.targetAt)}.` : T.queued;
  }

  async callback(identity: ParentIdentity, data: unknown): Promise<Reply> {
    const match = typeof data === 'string' ? /^rm:([A-Za-z0-9_-]{1,43}):(0|[1-9][0-9]{0,15}):([a-z0-9]+)$/.exec(data) : null;
    if (!match) return stale();
    try {
      const session = await this.sessions.read<RemindState>(identity, {nonce: match[1]!, version: Number(match[2])}, 'remind');
      return await this.step(identity, session, match[3]!);
    } catch (error) {
      if (unauthorized(error)) return stale();
      throw error;
    }
  }

  /** Plain text belongs to this menu only while one of its input steps is waiting. */
  async text(identity: ParentIdentity, text: string): Promise<Reply | null> {
    const session = await this.sessions.current<RemindState>(identity, 'remind');
    if (!session || !INPUTS.includes(session.state.step)) return null;
    try {
      const {step, draft} = session.state, d = draft!;
      if (step === 'text') {
        const message = text.trim();
        if (!validMessage(message)) return await this.again(identity, session, T.message);
        return await this.go(identity, session, {step: 'when', draft: {...d, message}});
      }
      const max = step === 'durationInput' ? MAX_BUTTONLESS_SECONDS : MAX_DELAY_MINUTES, n = whole(text, max);
      if (n === null) return await this.again(identity, session, step === 'durationInput' ? T.seconds : T.minutes);
      if (step === 'delayInput') return await this.go(identity, session, {step: 'countdown', draft: {...d, delayMinutes: n}});
      if (step === 'repeatInput') return await this.go(identity, session, {step: 'review', draft: {...d, mode: 'repeat', repeatMinutes: n, durationSeconds: null}});
      return await this.go(identity, session, {step: 'review', draft: {...d, mode: 'buttonless', durationSeconds: n, repeatMinutes: null}});
    } catch (error) {
      if (unauthorized(error)) return stale();
      throw error;
    }
  }

  private async again(identity: ParentIdentity, session: MenuSession<RemindState>, error: string): Promise<Reply> {
    const guard = await this.sessions.advance(identity, session, 'remind', session.state);
    return {text: error, buttons: [[this.button(guard, 'cancel', LABELS.cancel)]]};
  }
  private async go(identity: ParentIdentity, session: MenuSession<RemindState>, next: RemindState, prefix?: string): Promise<Reply> {
    return this.render(identity, await this.sessions.advance(identity, session, 'remind', next), next, prefix);
  }
  private async leave(identity: ParentIdentity, session: MenuSession<RemindState>, navigate: 'main' | 'limit' | 'clear'): Promise<Reply> {
    await this.sessions.advance(identity, session, 'remind', null);
    return {text: '', buttons: [], navigate};
  }

  private async step(identity: ParentIdentity, session: MenuSession<RemindState>, action: string): Promise<Reply> {
    const {step, draft} = session.state, d = draft!;
    if (action === 'cancel' && step !== 'home' && step !== 'pending' && step !== 'free') return this.go(identity, session, {step: 'home'}, CANCELED);
    switch (`${step}:${action}`) {
      case 'home:notify': case 'home:overlay': return this.start(identity, action as 'notify' | 'overlay', session);
      case 'home:pending': return this.go(identity, session, {step: 'pending'});
      case 'pending:refresh': return this.go(identity, session, {step: 'pending'});
      case 'home:clear': case 'pending:clear': return this.leave(identity, session, 'clear');
      case 'home:back': return this.leave(identity, session, 'main');
      case 'pending:back': case 'free:back': return this.go(identity, session, {step: 'home'});
      case 'free:limit': return this.leave(identity, session, 'limit');
      case 'when:now': return this.go(identity, session, {step: 'review', draft: {...d, delayMinutes: 0, countdown: false}});
      case 'when:later': return this.go(identity, session, {step: 'delay', draft: d});
      case 'delay:custom': return this.go(identity, session, {step: 'delayInput', draft: d});
      case 'countdown:yes': case 'countdown:no': return this.go(identity, session, {step: 'review', draft: {...d, countdown: action === 'yes'}});
      case 'review:options': if (d.kind === 'overlay') return this.go(identity, session, {step: 'options', draft: d}); break;
      case 'review:submit': {
        // The session version names the operation: a duplicate tap replays, a moved session is rejected.
        const text = await this.submit(identity, d, `menu:${session.nonce}:${session.version}`, session);
        if (text === T.free) return this.go(identity, session, {step: 'free'});
        await this.sessions.advance(identity, session, 'remind', null);
        return plain(text);
      }
      case 'options:once': return this.go(identity, session, {step: 'review', draft: {...d, mode: 'once', repeatMinutes: null, durationSeconds: null}});
      case 'options:repeat': return this.go(identity, session, {step: 'repeatInput', draft: d});
      case 'options:buttonless': return this.go(identity, session, {step: 'durationInput', draft: d});
      case 'options:back': return this.go(identity, session, {step: 'review', draft: d});
    }
    const preset = /^d(\d+)$/.exec(action);
    if (step === 'delay' && preset && PRESETS.includes(Number(preset[1]) as typeof PRESETS[number]))
      return this.go(identity, session, {step: 'countdown', draft: {...d, delayMinutes: Number(preset[1])}});
    return stale();
  }

  private button(guard: CallbackGuard, action: string, text: string): Button {
    return {text, data: `rm:${guard.nonce}:${guard.version}:${action}`};
  }

  private async render(identity: ParentIdentity, guard: CallbackGuard, state: RemindState, prefix?: string): Promise<Reply> {
    const b = (action: string, text: string) => [this.button(guard, action, text)], cancel = b('cancel', LABELS.cancel), d = state.draft;
    let reply: Reply;
    switch (state.step) {
      case 'home': reply = {text: T.home, buttons: [b('notify', '🔔 Сповіщення'), b('overlay', '🖥 Повідомлення на екрані'),
        b('pending', '📋 Активні та заплановані'), b('clear', '🧹 Очистити…'), b('back', LABELS.back)]}; break;
      case 'text': reply = {text: T.text, buttons: [cancel]}; break;
      case 'when': reply = {text: T.when, buttons: [b('now', 'Зараз'), b('later', 'Через…'), cancel]}; break;
      case 'delay': reply = {text: T.delay, buttons: [PRESETS.map(n => this.button(guard, `d${n}`, `${n} хв`)), b('custom', 'Інший час'), cancel]}; break;
      case 'delayInput': reply = {text: T.delayInput, buttons: [cancel]}; break;
      case 'countdown': reply = {text: T.countdown, buttons: [[this.button(guard, 'yes', 'Так'), this.button(guard, 'no', 'Ні')], cancel]}; break;
      case 'review': reply = {text: review(d!, this.clock()), buttons: [b('submit', d!.delayMinutes ? '✅ Запланувати' : '✅ Надіслати'),
        ...(d!.kind === 'overlay' ? [b('options', '⚙️ Додаткові параметри')] : []), cancel]}; break;
      case 'options': reply = {text: T.options, buttons: [
        b('once', 'Показати один раз' + (d!.mode === 'once' ? ' ✓' : '')),
        b('repeat', 'Повторювати після закриття' + (d!.mode === 'repeat' ? ` ✓ (${d!.repeatMinutes} хв)` : '')),
        b('buttonless', 'Без кнопки закриття' + (d!.mode === 'buttonless' ? ` ✓ (${d!.durationSeconds} с)` : '')), b('back', LABELS.back)]}; break;
      case 'repeatInput': reply = {text: T.repeatInput, buttons: [cancel]}; break;
      case 'durationInput': reply = {text: T.durationInput, buttons: [cancel]}; break;
      case 'free': reply = {text: T.free, buttons: [b('limit', 'Перейти до ліміту часу'), b('back', LABELS.back)]}; break;
      case 'pending': {
        const [first, ...extra] = await this.pendingPages(identity);
        reply = {text: first!, buttons: [b('refresh', '🔄 Оновити'), b('clear', '🧹 Очистити…'), b('back', LABELS.back)], ...(extra.length ? {extra} : {})};
        break;
      }
    }
    return prefix ? {...reply, text: prefix + '\n\n' + reply.text} : reply;
  }

  private async pendingPages(identity: ParentIdentity): Promise<string[]> {
    const rows = await this.repository.db.runTransaction(async tx => {
      await this.repository.requireParent(tx, identity);
      return [...(await readActionSnapshot(this.repository, tx, identity.deviceId)).rows.values()].map(r => r.row);
    });
    const open = rows.filter(r => r.open).sort((a, b) => a.action.targetAt.localeCompare(b.action.targetAt) || a.action.sequence - b.action.sequence);
    if (!open.length) return [`${T.pending}\n\n${T.none}`];
    return paginate(T.pending, [T.pending, '', ...open.flatMap((r, i) => pendingEntry(i + 1, r.action, r.state))]);
  }
}
