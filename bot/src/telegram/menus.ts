/** Pure Endtime submenu transitions and bounded callback data. No I/O. */
import type {SettingsChange} from '../settings.js';
import {isEndtimeLocalTime} from '../clock.js';

export type EndtimeStep = 'status' | 'enterTime' | 'review';
export interface EndtimeMenuState {step: EndtimeStep; draft: string | null}
export type MenuInput = {kind: 'changeTime' | 'confirm' | 'cancel' | 'back'} | {kind: 'toggle'; enabled: boolean} | {kind: 'text'; text: string};
/** A null state leaves the submenu for Settings. */
export interface MenuResult {state: EndtimeMenuState | null; change?: SettingsChange; error?: 'time' | 'stale'; notice?: 'canceled'}

const STATUS: EndtimeMenuState = {step: 'status', draft: null};
const ENTER: EndtimeMenuState = {step: 'enterTime', draft: null};

export function transitionEndtimeMenu(state: EndtimeMenuState, input: MenuInput): MenuResult {
  switch (`${state.step}:${input.kind}`) {
    case 'status:changeTime': return {state: ENTER};
    case 'status:toggle': return {state: STATUS, change: {kind: 'setEndtimeEnabled', enabled: (input as {enabled: boolean}).enabled}};
    case 'status:back': return {state: null};
    case 'enterTime:text': {
      const text = (input as {text: string}).text.trim();
      return isEndtimeLocalTime(text) ? {state: {step: 'review', draft: text}} : {state: ENTER, error: 'time'};
    }
    case 'enterTime:back': return {state: STATUS};
    case 'review:back': return {state: ENTER};
    case 'enterTime:cancel': case 'review:cancel': return {state: STATUS, notice: 'canceled'};
    case 'review:confirm': return {state: STATUS, change: {kind: 'setEndtime', localTime: state.draft!}};
    default: return {state, error: 'stale'};
  }
}

export type CallbackAction = 'on' | 'off' | 'time' | 'confirm' | 'cancel' | 'back';
const ACTIONS: readonly CallbackAction[] = ['on', 'off', 'time', 'confirm', 'cancel', 'back'];
const CALLBACK = /^et:([A-Za-z0-9_-]{1,43}):(0|[1-9][0-9]{0,15}):([a-z]+)$/;

/** Telegram limits callback_data to 64 bytes; identity comes from the session, never from the payload. */
export const encodeCallback = (nonce: string, version: number, action: CallbackAction): string => `et:${nonce}:${version}:${action}`;
export function decodeCallback(data: unknown): {nonce: string; version: number; action: CallbackAction} | null {
  const match = typeof data === 'string' ? CALLBACK.exec(data) : null;
  if (!match || !ACTIONS.includes(match[3] as CallbackAction)) return null;
  const version = Number(match[2]);
  return Number.isSafeInteger(version) ? {nonce: match[1]!, version, action: match[3] as CallbackAction} : null;
}

export const inputFor = (action: CallbackAction): MenuInput =>
  action === 'on' || action === 'off' ? {kind: 'toggle', enabled: action === 'on'} : {kind: action === 'time' ? 'changeTime' : action};
