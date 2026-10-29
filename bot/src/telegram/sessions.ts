/** Persisted per-caregiver menu sessions. Every transition advances the version so old buttons go stale. */
import {FirestoreRepository,newSecret,unauthorized,type ParentIdentity} from '../repository.js';
import type {Instant} from '../contracts.js';
import type {CallbackGuard} from '../settings.js';

export const SESSION_TTL_MS = 30 * 60000;
/** One session document per caregiver; opening another menu replaces it and invalidates its buttons. */
export type MenuName = 'endtime' | 'nav' | 'limit' | 'clear' | 'remind';
export interface MenuSession<S> extends CallbackGuard {state: S}

export class MenuSessions {
  constructor(private readonly repository: FirestoreRepository, private readonly clock: () => Instant) {}
  private ref(identity: ParentIdentity) {return this.repository.db.doc(`devices/${identity.deviceId}/sessions/${identity.userId}`);}
  private value(identity: ParentIdentity, guard: CallbackGuard, menu: MenuName, state: unknown) {
    return {pairingId: identity.pairingId, chatId: identity.chatId, ...guard, expiresAt: Date.parse(this.clock()) + SESSION_TTL_MS, menu, state};
  }

  /** A new nonce invalidates every button rendered for an earlier menu. */
  async open<S>(identity: ParentIdentity, menu: MenuName, state: S): Promise<CallbackGuard> {
    const guard = {nonce: newSecret(16), version: 0};
    return this.repository.db.runTransaction(async tx => {
      await this.repository.requireParent(tx, identity);
      tx.set(this.ref(identity), this.value(identity, guard, menu, state));
      return guard;
    });
  }
  /** Rejects (401) unless the guard names the caregiver's current, unexpired session for this menu. */
  async read<S>(identity: ParentIdentity, guard: CallbackGuard, menu: MenuName): Promise<MenuSession<S>> {
    return this.repository.db.runTransaction(async tx => {
      await this.repository.requireCallback(tx, identity, guard.nonce, guard.version);
      const session = (await tx.get(this.ref(identity))).data()!;
      if (session.menu !== menu) return unauthorized();
      return {nonce: guard.nonce, version: guard.version, state: session.state};
    });
  }
  /** The current session of this menu for plain text input, or null when none is live. */
  async current<S>(identity: ParentIdentity, menu: MenuName): Promise<MenuSession<S> | null> {
    return this.repository.db.runTransaction(async tx => {
      await this.repository.requireParent(tx, identity);
      const session = (await tx.get(this.ref(identity))).data();
      if (!session || session.menu !== menu || session.pairingId !== identity.pairingId || session.chatId !== identity.chatId ||
          !(Date.parse(this.clock()) < session.expiresAt)) return null;
      return {nonce: session.nonce, version: session.version, state: session.state};
    });
  }
  /** Compare-and-advance within one menu; a null state closes the session. */
  async advance(identity: ParentIdentity, guard: CallbackGuard, menu: MenuName, state: unknown | null): Promise<CallbackGuard> {
    return this.repository.db.runTransaction(async tx => {
      await this.repository.requireCallback(tx, identity, guard.nonce, guard.version);
      if ((await tx.get(this.ref(identity))).data()!.menu !== menu) return unauthorized();
      const next = {nonce: guard.nonce, version: guard.version + 1};
      if (state) tx.set(this.ref(identity), this.value(identity, next, menu, state));
      else tx.delete(this.ref(identity));
      return next;
    });
  }
}
