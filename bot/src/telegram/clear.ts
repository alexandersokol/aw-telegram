/** /clear: manual scope applies directly; Clear all always asks for confirmation first. */
import {BoundaryError,FirestoreRepository,type ParentIdentity} from '../repository.js';
import type {Instant} from '../contracts.js';
import type {ActionService} from '../actions.js';
import type {CallbackGuard} from '../settings.js';
import {MenuSessions,type MenuSession} from './sessions.js';
import {LABELS,LIMIT_LABELS,STALE_CLEAR,CLEAR_USAGE,CLEAR_CHOOSE,CLEAR_ALL_CONFIRM,CLEARED_MANUAL,CLEARED_ALL,CANCELED,type Reply} from './uk.js';

/** from records where Back returns. */
type ClearState = {step: 'choose' | 'confirmAll'; from?: 'reminders'};
type Action = 'manual' | 'all' | 'confirm' | 'cancel' | 'back';
const CALLBACK = /^cl:([A-Za-z0-9_-]{1,43}):(0|[1-9][0-9]{0,15}):(manual|all|confirm|cancel|back)$/;
const stale = (): Reply => ({text: STALE_CLEAR, buttons: [], toast: true});
const plain = (text: string): Reply => ({text, buttons: []});

export class ClearController {
  private readonly sessions: MenuSessions;
  constructor(repository: FirestoreRepository, private readonly actions: ActionService, clock: () => Instant) {
    this.sessions = new MenuSessions(repository, clock);
  }

  async command(identity: ParentIdentity, args: string, updateId: number): Promise<Reply> {
    if (args === 'manual') {
      await this.actions.clearActions(identity, 'manual', `tg:${updateId}`);
      return plain(CLEARED_MANUAL);
    }
    if (args === 'all' || !args) return this.open(identity, {step: args ? 'confirmAll' : 'choose'});
    return plain(CLEAR_USAGE);
  }

  openFromReminders(identity: ParentIdentity): Promise<Reply> {return this.open(identity, {step: 'choose', from: 'reminders'});}
  private async open(identity: ParentIdentity, state: ClearState): Promise<Reply> {
    return this.render(await this.sessions.open(identity, 'clear', state), state);
  }

  async callback(identity: ParentIdentity, data: unknown): Promise<Reply> {
    const match = typeof data === 'string' ? CALLBACK.exec(data) : null;
    if (!match) return stale();
    try {
      const session = await this.sessions.read<ClearState>(identity, {nonce: match[1]!, version: Number(match[2])}, 'clear');
      return await this.step(identity, session, match[3] as Action);
    } catch (error) {
      if (error instanceof BoundaryError && error.status === 401) return stale();
      throw error;
    }
  }

  private async step(identity: ParentIdentity, session: MenuSession<ClearState>, action: Action): Promise<Reply> {
    // The session version names the operation: a duplicate tap replays, a moved session is rejected.
    const operation = `menu:${session.nonce}:${session.version}`;
    switch (`${session.state.step}:${action}`) {
      case 'choose:manual':
        await this.actions.clearActions(identity, 'manual', operation, session);
        await this.sessions.advance(identity, session, 'clear', null);
        return plain(CLEARED_MANUAL);
      case 'choose:all': {
        const next: ClearState = {...session.state, step: 'confirmAll'};
        return this.render(await this.sessions.advance(identity, session, 'clear', next), next);
      }
      case 'choose:back':
        await this.sessions.advance(identity, session, 'clear', null);
        return {text: '', buttons: [], navigate: session.state.from ?? 'main'};
      case 'confirmAll:confirm':
        await this.actions.clearActions(identity, 'all', operation, session);
        await this.sessions.advance(identity, session, 'clear', null);
        return plain(CLEARED_ALL);
      case 'confirmAll:cancel':
        await this.sessions.advance(identity, session, 'clear', null);
        return plain(CANCELED);
    }
    return stale();
  }

  private render(guard: CallbackGuard, state: ClearState): Reply {
    const button = (action: Action, text: string) => ({text, data: `cl:${guard.nonce}:${guard.version}:${action}`});
    return state.step === 'choose' ?
      {text: CLEAR_CHOOSE, buttons: [[button('manual', LIMIT_LABELS.clearManual)], [button('all', LIMIT_LABELS.clearAll)], [button('back', LABELS.back)]]} :
      {text: CLEAR_ALL_CONFIRM, buttons: [[button('confirm', LIMIT_LABELS.clearConfirm)], [button('cancel', LABELS.cancel)]]};
  }
}
