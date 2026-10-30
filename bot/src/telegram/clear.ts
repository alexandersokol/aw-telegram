/** /clear: manual scope applies directly; Clear all always asks for confirmation first. */
import {BoundaryError,FirestoreRepository,type ParentIdentity} from '../repository.js';
import type {Instant} from '../contracts.js';
import type {ActionService} from '../actions.js';
import type {CallbackGuard} from '../settings.js';
import {MenuSessions,type MenuSession} from './sessions.js';
import {laptopOffline} from './reports.js';
import {text as copy,type Catalogue,type Reply} from './i18n/index.js';

/** from records where Back returns. */
type ClearState = {step: 'choose' | 'confirmAll'; from?: 'reminders'};
type Action = 'manual' | 'all' | 'confirm' | 'cancel' | 'back';
const CALLBACK = /^cl:([A-Za-z0-9_-]{1,43}):(0|[1-9][0-9]{0,15}):(manual|all|confirm|cancel|back)$/;
const stale = (t: Catalogue): Reply => ({text: t.STALE_CLEAR, buttons: [], toast: true});
const plain = (text: string): Reply => ({text, buttons: []});

export class ClearController {
  private readonly sessions: MenuSessions;
  constructor(private readonly repository: FirestoreRepository, private readonly actions: ActionService, private readonly clock: () => Instant) {
    this.sessions = new MenuSessions(repository, clock);
  }

  async command(identity: ParentIdentity, args: string, updateId: number): Promise<Reply> {
    if (args === 'manual') {
      await this.actions.clearActions(identity, 'manual', `tg:${updateId}`);
      return this.saved(identity, 'CLEARED_MANUAL');
    }
    if (args === 'all' || !args) return this.open(identity, {step: args ? 'confirmAll' : 'choose'});
    return plain(copy(identity.lang).CLEAR_USAGE);
  }

  openFromReminders(identity: ParentIdentity): Promise<Reply> {return this.open(identity, {step: 'choose', from: 'reminders'});}
  private async open(identity: ParentIdentity, state: ClearState): Promise<Reply> {
    return this.render(copy(identity.lang), await this.sessions.open(identity, 'clear', state), state);
  }

  async callback(identity: ParentIdentity, data: unknown): Promise<Reply> {
    const match = typeof data === 'string' ? CALLBACK.exec(data) : null;
    if (!match) return stale(copy(identity.lang));
    try {
      const session = await this.sessions.read<ClearState>(identity, {nonce: match[1]!, version: Number(match[2])}, 'clear');
      return await this.step(identity, session, match[3] as Action);
    } catch (error) {
      if (error instanceof BoundaryError && error.status === 401) return stale(copy(identity.lang));
      throw error;
    }
  }

  private async step(identity: ParentIdentity, session: MenuSession<ClearState>, action: Action): Promise<Reply> {
    // The session version names the operation: a duplicate tap replays, a moved session is rejected.
    const operation = `menu:${session.nonce}:${session.version}`, t = copy(identity.lang);
    switch (`${session.state.step}:${action}`) {
      case 'choose:manual':
        await this.actions.clearActions(identity, 'manual', operation, session);
        await this.sessions.advance(identity, session, 'clear', null);
        return this.saved(identity, 'CLEARED_MANUAL');
      case 'choose:all': {
        const next: ClearState = {...session.state, step: 'confirmAll'};
        return this.render(t, await this.sessions.advance(identity, session, 'clear', next), next);
      }
      case 'choose:back':
        await this.sessions.advance(identity, session, 'clear', null);
        return {text: '', buttons: [], navigate: session.state.from ?? 'main'};
      case 'confirmAll:confirm':
        await this.actions.clearActions(identity, 'all', operation, session);
        await this.sessions.advance(identity, session, 'clear', null);
        return this.saved(identity, 'CLEARED_ALL');
      case 'confirmAll:cancel':
        await this.sessions.advance(identity, session, 'clear', null);
        return plain(t.CANCELED);
    }
    return stale(t);
  }

  private async saved(identity: ParentIdentity, description: 'CLEARED_MANUAL' | 'CLEARED_ALL'): Promise<Reply> {
    const t = copy(identity.lang);
    return plain(t.savedText(t[description], await laptopOffline(this.repository, identity, this.clock())));
  }

  private render(t: Catalogue, guard: CallbackGuard, state: ClearState): Reply {
    const button = (action: Action, text: string) => ({text, data: `cl:${guard.nonce}:${guard.version}:${action}`});
    return state.step === 'choose' ?
      {text: t.CLEAR_CHOOSE, buttons: [[button('manual', t.LIMIT_LABELS.clearManual)], [button('all', t.LIMIT_LABELS.clearAll)], [button('back', t.LABELS.back)]]} :
      {text: t.CLEAR_ALL_CONFIRM, buttons: [[button('confirm', t.LIMIT_LABELS.clearConfirm)], [button('cancel', t.LABELS.cancel)]]};
  }
}
