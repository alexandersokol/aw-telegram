/** Persisted per-caregiver menu sessions. Every transition advances the version so old buttons go stale. */
import {FirestoreRepository,newSecret,type ParentIdentity} from '../repository.js';
import type {Instant} from '../contracts.js';
import type {CallbackGuard} from '../settings.js';
import type {EndtimeMenuState} from './menus.js';

export const SESSION_TTL_MS = 30 * 60000;
export interface MenuSession extends CallbackGuard {state: EndtimeMenuState}

export class MenuSessions {
  constructor(private readonly repository: FirestoreRepository, private readonly clock: () => Instant) {}
  private ref(identity: ParentIdentity) {return this.repository.db.doc(`devices/${identity.deviceId}/sessions/${identity.userId}`);}
  private value(identity: ParentIdentity, guard: CallbackGuard, state: EndtimeMenuState) {
    return {pairingId: identity.pairingId, chatId: identity.chatId, ...guard, expiresAt: Date.parse(this.clock()) + SESSION_TTL_MS, menu: 'endtime', state};
  }

  /** A new nonce invalidates every button rendered for an earlier menu. */
  async open(identity: ParentIdentity, state: EndtimeMenuState): Promise<CallbackGuard> {
    return this.repository.db.runTransaction(async tx => {
      await this.repository.requireParent(tx, identity);
      const guard = {nonce: newSecret(16), version: 0};
      tx.set(this.ref(identity), this.value(identity, guard, state));
      return guard;
    });
  }
  /** Rejects (401) unless the guard names the caregiver's current, unexpired session. */
  async read(identity: ParentIdentity, guard: CallbackGuard): Promise<MenuSession> {
    return this.repository.db.runTransaction(async tx => {
      await this.repository.requireCallback(tx, identity, guard.nonce, guard.version);
      return {...guard, state: (await tx.get(this.ref(identity))).data()!.state};
    });
  }
  /** The current session for plain text input, or null when none is live. */
  async current(identity: ParentIdentity): Promise<MenuSession | null> {
    return this.repository.db.runTransaction(async tx => {
      await this.repository.requireParent(tx, identity);
      const session = (await tx.get(this.ref(identity))).data();
      if (!session || session.menu !== 'endtime' || session.pairingId !== identity.pairingId || session.chatId !== identity.chatId ||
          !(Date.parse(this.clock()) < session.expiresAt)) return null;
      return {nonce: session.nonce, version: session.version, state: session.state};
    });
  }
  /** Compare-and-advance; a null state closes the session. */
  async advance(identity: ParentIdentity, guard: CallbackGuard, state: EndtimeMenuState | null): Promise<CallbackGuard> {
    return this.repository.db.runTransaction(async tx => {
      await this.repository.requireCallback(tx, identity, guard.nonce, guard.version);
      const next = {nonce: guard.nonce, version: guard.version + 1};
      if (state) tx.set(this.ref(identity), this.value(identity, next, state));
      else tx.delete(this.ref(identity));
      return next;
    });
  }
}
