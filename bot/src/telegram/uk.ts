/** Built-in Ukrainian copy. Replies are sent as plain text, so no markup escaping applies. */
import type {Settings,Counter} from '../contracts.js';

export interface Button {text: string; data: string}
export interface Reply {text: string; buttons: Button[][]; navigate?: 'settings'}

export const STALE_MENU = 'Це меню застаріло. Відкрийте /endtime знову.';
export const TIME_FORMAT = 'Вкажіть час у форматі ГГ:ХХ від 00:15 до 23:59, наприклад 21:00.';
export const ENDTIME_USAGE = 'Використання: /endtime, /endtime status, /endtime set ГГ:ХХ, /endtime on, /endtime off.';
export const ENTER_TIME = 'Введіть час завершення у форматі ГГ:ХХ (від 00:15 до 23:59).';
export const CANCELED = 'Скасовано.';
export const LABELS = {on: 'Увімкнути', off: 'Вимкнути', time: 'Змінити час', confirm: 'Підтвердити', cancel: 'Скасувати', back: '← Назад'} as const;

const applied = (settings: Settings, acknowledged: Counter | null): string =>
  acknowledged !== null && acknowledged >= settings.revision ? 'застосовано' : 'очікує застосування';
const state = (settings: Settings): string =>
  settings.endtimeEnabled ? `увімкнено, ${settings.endtimeLocalTime}` : `вимкнено (збережений час ${settings.endtimeLocalTime})`;

export function endtimeStatus(settings: Settings, acknowledged: Counter | null, today: string): string {
  const lines = ['🌙 Час завершення', '', `Стан: ${settings.endtimeEnabled ? 'увімкнено' : 'вимкнено'}`,
    `Збережений час: ${settings.endtimeLocalTime}`, `Ноутбук: ${applied(settings, acknowledged)}`];
  if (settings.freeUseDate === today) lines.push('Сьогодні не діє: увімкнено вільний режим.');
  if (settings.suppressedDate === today) lines.push('Сьогодні не діє: автоматичні нагадування вимкнено до півночі.');
  return lines.join('\n');
}

/** Saved cloud state is confirmed separately from the companion's acknowledgement. */
export function endtimeSaved(settings: Settings, acknowledged: Counter | null, changed: boolean): string {
  if (!changed) return `Без змін: час завершення вже ${state(settings)}.`;
  return `Збережено: час завершення ${state(settings)}.\nНоутбук: ${applied(settings, acknowledged)}.`;
}

export const endtimeReview = (localTime: string): string =>
  `Перевірте зміну\n\nЧас завершення: ${localTime}\nПісля підтвердження його буде увімкнено, а інших батьків повідомлено.`;
