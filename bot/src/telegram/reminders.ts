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
import {text as copy,type Button,type Catalogue,type Reply} from './i18n/index.js';

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

const ICON = {notify: '🔔', overlay: '🖥'} as const;

const scalars = (text: string) => [...text].length;
const validMessage = (text: string) => scalars(text) >= 1 && scalars(text) <= MAX_MESSAGE;
const whole = (text: string, max: number): number | null => /^[1-9]\d{0,3}$/.test(text.trim()) && Number(text) <= max ? Number(text) : null;

export function toActionDraft(d: Draft): ActionDraft {
  const base = {message: d.message, countdown: d.countdown};
  if (d.kind === 'notify') return {kind: 'notify', delayMinutes: d.delayMinutes, options: base};
  const options = d.mode === 'buttonless' ? {...base, dismissible: false as const, durationSeconds: d.durationSeconds!} :
    {...base, dismissible: true as const, repeatEveryMinutes: d.mode === 'repeat' ? d.repeatMinutes : null};
  return {kind: 'overlay', delayMinutes: d.delayMinutes, options};
}

/** Options precede the text: `+ХВИЛИНИ`, `countdown`, and for overlays `repeat=ХВ` or `nodismiss=С`. Errors are
 * Ukrainian unless the reader's catalogue is given. */
export function parseReminder(kind: 'notify' | 'overlay', args: string, t: Catalogue = copy('uk')): Draft | string {
  const T = t.REMIND, usage = kind === 'notify' ? T.notifyUsage : T.overlayUsage;
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

function review(d: Draft, now: Instant, t: Catalogue): string {
  return t.reminderReview({kind: d.kind, message: d.message, countdown: d.countdown,
    delay: d.delayMinutes ? {minutes: d.delayMinutes, at: kyivTime(new Date(Date.parse(now) + d.delayMinutes * 60000).toISOString())} : null,
    buttonless: d.mode === 'buttonless' ? d.durationSeconds : null, repeat: d.mode === 'repeat' ? d.repeatMinutes : null});
}

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return scalars(flat) > 80 ? [...flat].slice(0, 79).join('') + '…' : flat;
};
/** One open action per entry: what it is, its schedule or delivery state, and repeat boundaries. */
function pendingEntry(index: number, action: Action, state: string, t: Catalogue): string[] {
  const delayed = action.targetAt !== action.createdAt, options = action.options as Record<string, unknown>;
  let status = delayed ? t.scheduledAt(kyivTime(action.targetAt)) :
    state === 'pending' ? t.PENDING_STATE.pending : state === 'presented' ? t.PENDING_STATE.presented : t.PENDING_STATE.other;
  if (action.options.countdown) status += t.PENDING_COUNTDOWN;
  if (options.dismissible === false) status += t.pendingButtonless(options.durationSeconds as number);
  const lines = [`${index}. ${ICON[action.kind]} ${preview(action.options.message)}`, `   ${status}`];
  if (typeof options.repeatEveryMinutes === 'number') lines.push(...t.pendingRepeat(options.repeatEveryMinutes));
  return lines;
}

const stale = (t: Catalogue): Reply => ({text: t.STALE_NAV, buttons: [], toast: true});
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
    const draft = parseReminder(kind, args, copy(identity.lang));
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
    const result = await this.actions.createAction(identity, toActionDraft(draft), operationId, guard), t = copy(identity.lang);
    if (result.state === 'skipped') return t.REMIND.free;
    return draft.delayMinutes ? `${t.REMIND.queued}\n${t.scheduledAt(kyivTime(result.action.targetAt))}.` : t.REMIND.queued;
  }

  async callback(identity: ParentIdentity, data: unknown): Promise<Reply> {
    const match = typeof data === 'string' ? /^rm:([A-Za-z0-9_-]{1,43}):(0|[1-9][0-9]{0,15}):([a-z0-9]+)$/.exec(data) : null;
    if (!match) return stale(copy(identity.lang));
    try {
      const session = await this.sessions.read<RemindState>(identity, {nonce: match[1]!, version: Number(match[2])}, 'remind');
      return await this.step(identity, session, match[3]!);
    } catch (error) {
      if (unauthorized(error)) return stale(copy(identity.lang));
      throw error;
    }
  }

  /** Plain text belongs to this menu only while one of its input steps is waiting. */
  async text(identity: ParentIdentity, text: string): Promise<Reply | null> {
    const session = await this.sessions.current<RemindState>(identity, 'remind');
    if (!session || !INPUTS.includes(session.state.step)) return null;
    try {
      const {step, draft} = session.state, d = draft!, T = copy(identity.lang).REMIND;
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
      if (unauthorized(error)) return stale(copy(identity.lang));
      throw error;
    }
  }

  private async again(identity: ParentIdentity, session: MenuSession<RemindState>, error: string): Promise<Reply> {
    const guard = await this.sessions.advance(identity, session, 'remind', session.state);
    return {text: error, buttons: [[this.button(guard, 'cancel', copy(identity.lang).LABELS.cancel)]]};
  }
  private async go(identity: ParentIdentity, session: MenuSession<RemindState>, next: RemindState, prefix?: string): Promise<Reply> {
    return this.render(identity, await this.sessions.advance(identity, session, 'remind', next), next, prefix);
  }
  private async leave(identity: ParentIdentity, session: MenuSession<RemindState>, navigate: 'main' | 'limit' | 'clear'): Promise<Reply> {
    await this.sessions.advance(identity, session, 'remind', null);
    return {text: '', buttons: [], navigate};
  }

  private async step(identity: ParentIdentity, session: MenuSession<RemindState>, action: string): Promise<Reply> {
    const {step, draft} = session.state, d = draft!, t = copy(identity.lang);
    if (action === 'cancel' && step !== 'home' && step !== 'pending' && step !== 'free') return this.go(identity, session, {step: 'home'}, t.CANCELED);
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
        if (text === t.REMIND.free) return this.go(identity, session, {step: 'free'});
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
    return stale(t);
  }

  private button(guard: CallbackGuard, action: string, text: string): Button {
    return {text, data: `rm:${guard.nonce}:${guard.version}:${action}`};
  }

  private async render(identity: ParentIdentity, guard: CallbackGuard, state: RemindState, prefix?: string): Promise<Reply> {
    const t = copy(identity.lang), T = t.REMIND, L = t.REMIND_LABELS, back = t.LABELS.back;
    const b = (action: string, text: string) => [this.button(guard, action, text)], cancel = b('cancel', t.LABELS.cancel), d = state.draft;
    let reply: Reply;
    switch (state.step) {
      case 'home': reply = {text: T.home, buttons: [b('notify', L.notify), b('overlay', L.overlay),
        b('pending', L.pending), b('clear', L.clear), b('back', back)]}; break;
      case 'text': reply = {text: T.text, buttons: [cancel]}; break;
      case 'when': reply = {text: T.when, buttons: [b('now', L.now), b('later', L.later), cancel]}; break;
      case 'delay': reply = {text: T.delay, buttons: [PRESETS.map(n => this.button(guard, `d${n}`, t.minutesShort(n))), b('custom', L.custom), cancel]}; break;
      case 'delayInput': reply = {text: T.delayInput, buttons: [cancel]}; break;
      case 'countdown': reply = {text: T.countdown, buttons: [[this.button(guard, 'yes', L.yes), this.button(guard, 'no', L.no)], cancel]}; break;
      case 'review': reply = {text: review(d!, this.clock(), t), buttons: [b('submit', d!.delayMinutes ? L.schedule : L.send),
        ...(d!.kind === 'overlay' ? [b('options', L.options)] : []), cancel]}; break;
      case 'options': reply = {text: T.options, buttons: [
        b('once', L.once + (d!.mode === 'once' ? ' ✓' : '')),
        b('repeat', L.repeat + (d!.mode === 'repeat' ? ` ✓ (${t.minutesShort(d!.repeatMinutes!)})` : '')),
        b('buttonless', L.buttonless + (d!.mode === 'buttonless' ? ` ✓ (${t.secondsShort(d!.durationSeconds!)})` : '')), b('back', back)]}; break;
      case 'repeatInput': reply = {text: T.repeatInput, buttons: [cancel]}; break;
      case 'durationInput': reply = {text: T.durationInput, buttons: [cancel]}; break;
      case 'free': reply = {text: T.free, buttons: [b('limit', L.limit), b('back', back)]}; break;
      case 'pending': {
        const [first, ...extra] = await this.pendingPages(identity, t);
        reply = {text: first!, buttons: [b('refresh', L.refresh), b('clear', L.clear), b('back', back)], ...(extra.length ? {extra} : {})};
        break;
      }
    }
    return prefix ? {...reply, text: prefix + '\n\n' + reply.text} : reply;
  }

  private async pendingPages(identity: ParentIdentity, t: Catalogue): Promise<string[]> {
    const rows = await this.repository.db.runTransaction(async tx => {
      await this.repository.requireParent(tx, identity);
      return [...(await readActionSnapshot(this.repository, tx, identity.deviceId)).rows.values()].map(r => r.row);
    });
    const open = rows.filter(r => r.open).sort((a, b) => a.action.targetAt.localeCompare(b.action.targetAt) || a.action.sequence - b.action.sequence);
    const T = t.REMIND;
    if (!open.length) return [`${T.pending}\n\n${T.none}`];
    return paginate(T.pending, [T.pending, '', ...open.flatMap((r, i) => pendingEntry(i + 1, r.action, r.state, t))], t);
  }
}
