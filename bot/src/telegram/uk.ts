/** Built-in Ukrainian copy. Replies are sent as plain text, so no markup escaping applies. */
import type {Settings,Counter} from '../contracts.js';

export interface Button {text: string; data: string}
/** extra holds follow-up pages of a long report, sent after the main message without buttons. */
/** navigate hands over to another menu, which the webhook opens in place of this empty reply. */
export interface Reply {text: string; buttons: Button[][]; navigate?: 'settings' | 'main' | 'limit' | 'clear' | 'reminders'; extra?: string[];
  /** On a button tap, show only as a callback toast and leave the tapped message unchanged. */
  toast?: boolean;
  /** Never gets the main-menu button (UX-02). */
  bare?: true}

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

/** Saved cloud state only; the companion's acknowledgement arrives as its own message (UX-03). */
export function endtimeSaved(settings: Settings, changed: boolean, offline: boolean): string {
  if (!changed) return `Без змін: час завершення вже ${state(settings)}.`;
  return savedText(`час завершення ${state(settings)}.`, offline);
}

export const endtimeReview = (localTime: string): string =>
  `Перевірте зміну\n\nЧас завершення: ${localTime}\nПісля підтвердження його буде увімкнено, а інших батьків повідомлено.`;

export const PAIRING = 'Щоб підключитися, створіть ключ у програмі на ноутбуці («Доступ батьків») і надішліть його сюди командою /pair КЛЮЧ.';
export const PAIRED = 'Доступ підтверджено.';
export const PAIR_FAILED = 'Не вдалося підключитися: ключ недійсний, використаний або прострочений.';
export const PAIR_THROTTLED = 'Забагато спроб підключення. Спробуйте пізніше.';
export const ALREADY_PAIRED = 'Цей обліковий запис уже підключено.';
export const LEAVE_CONFIRM = 'Відключитися від цього ноутбука? Ви більше не отримуватимете звіти й сповіщення. Щоб повернутися, потрібен новий ключ із ноутбука.';
export const LEAVE_LAST = 'Ви останній підключений дорослий. Після цього всі правила на ноутбуці зупиняться.';
export const LEFT = 'Вас відключено.';
export const STALE_NAV = 'Це меню застаріло. Відкрийте /start знову.';
export const ACTION_CAPACITY = 'Забагато активних нагадувань. Очистьте їх через /clear і спробуйте знову.';
export const DATA_CAPACITY = 'Зміну не збережено: перевищено допустимий обсяг даних. Спробуйте меншу зміну.';
export const OPERATION_CONFLICT = 'Цей запит уже оброблено або він застарів. Спробуйте ще раз.';
export const TOO_MANY = 'Забагато запитів. Спробуйте пізніше.';
export const REQUEST_FAILED = 'Не вдалося виконати запит. Перевірте введені дані й спробуйте ще раз.';
export const MAIN_MENU = 'Головне меню';
export const HOME_LABEL = '🏠 Головне меню';
export const SETTINGS_MENU = '⚙️ Налаштування';
export const HINT = 'Оберіть дію в меню: /start';
export const UNKNOWN_COMMAND = 'Невідома команда. Список команд: /help';
export const HOURLY_USAGE = 'Використання: /hourly on або /hourly off.';
export const USAGE_USAGE = 'Використання: /usage, /usage today, /usage yesterday або /usage week.';
export const CHOOSE_PERIOD = '📊 Використання\n\nОберіть період:';
export const hourlySaved = (enabled: boolean): string => `Щогодинні звіти ${enabled ? 'увімкнено' : 'вимкнено'}.`;
export const HELP = [
  'Команди:',
  '/start — головне меню',
  '/usage — використання (today, yesterday, week)',
  '/status — стан ноутбука',
  '/limit — ліміт часу (ТРИВАЛІСТЬ today|daily)',
  '/categories, /add_category НАЗВА, /remove_category НАЗВА — категорії для обліку',
  '/free on|off — вільний режим до опівночі',
  '/notify [+ХВ] [countdown] ТЕКСТ — сповіщення на ноутбук',
  '/overlay [+ХВ] [countdown] [repeat=ХВ | nodismiss=С] ТЕКСТ — повідомлення на екрані',
  '/pending — активні та заплановані нагадування',
  '/clear [manual|all] — очистити нагадування',
  '/restore — відновити автоматичні нагадування',
  '/settings — налаштування',
  '/hourly on|off — ваші щогодинні звіти',
  '/endtime — час завершення (status, set ГГ:ХХ, on, off)',
  '/unpair — відключитися від ноутбука',
  '/help — ця довідка',
].join('\n');
export const NAV_LABELS = {
  usage: '📊 Використання', status: '💻 Стан ноутбука', reminders: '💬 Нагадування', limit: '⏱ Ліміт часу',
  settings: '⚙️ Налаштування', help: 'Допомога', back: LABELS.back,
  leave: '🚪 Відключитися', leaveyes: 'Так, відключитися', leaveno: LABELS.cancel,
} as const;
export const NOTHING_TO_REMOVE = 'Для обліку нічого не вибрано.';
export const hourlyLabel = (enabled: boolean): string => `Щогодинні звіти: ${enabled ? 'увімкнено' : 'вимкнено'}`;
export const endtimeLabel = (settings: Settings): string => `Час завершення: ${settings.endtimeEnabled ? settings.endtimeLocalTime : 'вимкнено'}`;

export const OFFLINE_LINE = 'Ноутбук зараз не на зв’язку — застосується, коли він увімкнеться.';
/** A saved shared change, optionally with a note. The laptop applying it is told separately (UX-03). */
export const savedText = (description: string, offline: boolean, note?: string): string =>
  `Збережено: ${description}${note ? '\n' + note : ''}${offline ? '\n' + OFFLINE_LINE : ''}`;
export const REVIEW = 'Перевірте зміну';
export const STALE_LIMIT = 'Це меню застаріло. Відкрийте /limit знову.';
export const STALE_CLEAR = 'Це меню застаріло. Відкрийте /clear знову.';
export const LIMIT_USAGE = 'Використання: /limit, /limit ТРИВАЛІСТЬ today або /limit ТРИВАЛІСТЬ daily, наприклад /limit 2:30 today.';
export const DURATION_FORMAT = 'Вкажіть тривалість від 0 до 24 годин, наприклад 2:30, 90 хв або 1 год 30 хв.';
export const FREE_USAGE = 'Використання: /free on або /free off.';
export const CLEAR_USAGE = 'Використання: /clear, /clear manual або /clear all.';
export const ADD_CATEGORY_USAGE = 'Використання: /add_category НАЗВА, наприклад /add_category Games › Minecraft.';
export const REMOVE_CATEGORY_USAGE = 'Використання: /remove_category НАЗВА, наприклад /remove_category Games.';
export const ENTER_TODAY_LIMIT = 'Введіть ліміт на сьогодні, наприклад 2:30 або 90 хв.';
export const ENTER_DAILY_LIMIT = 'Введіть новий щоденний ліміт, наприклад 4:00 або 240 хв.';
export const NO_CATALOG = 'Список категорій ще не отримано з ноутбука. Спробуйте пізніше.';
export const PICK_ADD = 'Оберіть категорію, яку додати до обліку:';
export const PICK_REMOVE = 'Оберіть категорію, яку прибрати з обліку:';
export const NOTHING_TO_ADD = 'Усі категорії з ноутбука вже враховуються.';
export const FREE_STILL_ON = 'Вільний режим усе ще увімкнено, тому нагадування призупинені, доки його не вимкнуть.';
export const CLEAR_CHOOSE = 'Що очистити?';
export const CLEAR_ALL_CONFIRM = 'Скасувати всі активні та заплановані\nнагадування й вимкнути попередження\nпро денний ліміт до опівночі?\n\nОблік часу та щогодинні звіти продовжаться.';
/** savedText descriptions of the two clears. */
export const CLEARED_MANUAL = 'ручні нагадування буде скасовано.';
export const CLEARED_ALL = 'усі нагадування буде скасовано, попередження про ліміт вимкнено до опівночі.';
export const LIMIT_LABELS = {
  today: 'Змінити на сьогодні', daily: 'Змінити щоденний ліміт', categories: 'Категорії', freeOn: 'Увімкнути вільний режим',
  freeOff: 'Вимкнути вільний режим', restore: 'Відновити нагадування', add: 'Додати', remove: 'Видалити', prev: '‹', next: '›',
  clearManual: 'Лише ручні', clearAll: 'Усі нагадування', clearConfirm: '✅ Очистити всі',
} as const;
