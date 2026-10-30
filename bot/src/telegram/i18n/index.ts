/** Bot languages (LANG-01). Controllers render through text(identity.lang); shared messages carry every language. */
import {uk} from './uk.js';
import {en} from './en.js';

export type Lang = 'uk' | 'en';
export type Catalogue = typeof uk;
/** A shared message in every language; each recipient's outbox row gets theirs. */
export type Localized = Record<Lang, string>;
export const LANGS: readonly Lang[] = ['uk', 'en'];

export interface Button {text: string; data: string}
/** extra holds follow-up pages of a long report, sent after the main message without buttons. */
/** navigate hands over to another menu, which the webhook opens in place of this empty reply. */
export interface Reply {text: string; buttons: Button[][]; navigate?: 'settings' | 'main' | 'limit' | 'clear' | 'reminders'; extra?: string[];
  /** On a button tap, show only as a callback toast and leave the tapped message unchanged. */
  toast?: boolean;
  /** Never gets the main-menu button (UX-02). */
  bare?: true}

/** Anything but 'en' (a binding written before 11f, a test identity) reads as Ukrainian, the earlier behaviour. */
export const text = (lang: Lang): Catalogue => lang === 'en' ? en : uk;
export const both = (render: (t: Catalogue, lang: Lang) => string): Localized => ({uk: render(uk, 'uk'), en: render(en, 'en')});
/** A stored choice, or undefined when none (or an unknown value) is stored. */
export const storedLang = (value: unknown): Lang | undefined => value === 'uk' || value === 'en' ? value : undefined;
/** Without a stored choice: Telegram's language_code, Ukrainian for `uk` and `ru`, English for anything else or none. */
export const languageOf = (code: unknown): Lang => typeof code === 'string' && /^(?:uk|ru)(?:$|[-_])/i.test(code) ? 'uk' : 'en';

/** satisfies accepts a function with fewer parameters; this rejects any parameter list that differs from Ukrainian. */
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Parameters_<T> = {[K in keyof T]: T[K] extends (...args: infer P) => unknown ? P : T[K] extends object ? Parameters_<T[K]> : never};
export const PARITY: Same<Parameters_<Catalogue>, Parameters_<typeof en>> = true;
