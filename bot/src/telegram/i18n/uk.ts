/** Built-in Ukrainian copy, the reference catalogue: en.ts must have the same keys and signatures. Replies are sent as
 * plain text, so no markup escaping applies. */
import type {Settings,Counter,CategoryPath,Health} from '../../contracts.js';

const LABELS = {on: 'Увімкнути', off: 'Вимкнути', time: 'Змінити час', confirm: 'Підтвердити', cancel: 'Скасувати', back: '← Назад'};
const PAIRING = 'Щоб підключитися, створіть ключ у програмі на ноутбуці («Доступ батьків») і надішліть його сюди командою /pair КЛЮЧ.';
const OFFLINE_LINE = 'Ноутбук зараз не на зв’язку — застосується, коли він увімкнеться.';
const REVIEW = 'Перевірте зміну';
const TELL_OTHERS = 'Інших батьків буде повідомлено.';
const PARTIAL = ' (неповні дані)';
const q = (value: string): string => `«${value}»`;
/** A saved shared change, optionally with a note. The laptop applying it is told separately (UX-03). */
const savedText = (description: string, offline: boolean, note?: string): string =>
  `Збережено: ${description}${note ? '\n' + note : ''}${offline ? '\n' + OFFLINE_LINE : ''}`;
function duration(ms: number): string {
  if (ms > 0 && ms < 60000) return 'менше 1 хв';
  const minutes = Math.floor(ms / 60000), hours = Math.floor(minutes / 60);
  return hours ? `${hours} год ${String(minutes % 60).padStart(2, '0')} хв` : `${minutes} хв`;
}
/** null is the opt-in uncategorized pseudo-category. */
const categoryLabel = (path: CategoryPath | null): string => path === null ? 'Без категорії' : path.join(' › ');
function selectionLabel(paths: CategoryPath[], uncategorized: boolean): string {
  const labels = [...paths.map(categoryLabel), ...(uncategorized ? [categoryLabel(null)] : [])];
  return labels.length ? labels.join(', ') : 'нічого';
}
/** Plural of «хвилина» after a number. */
function minutesWord(n: number): string {
  const ten = n % 10, hundred = n % 100;
  if (ten === 1 && hundred !== 11) return 'хвилину';
  return ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? 'хвилини' : 'хвилин';
}
const daysWord = (n: number): string => n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дні' : 'днів';
const onOff = (enabled: boolean): string => enabled ? 'увімкнено' : 'вимкнено';
const endtimeState = (settings: Settings): string =>
  settings.endtimeEnabled ? `увімкнено, ${settings.endtimeLocalTime}` : `вимкнено (збережений час ${settings.endtimeLocalTime})`;
const measured = (minutes: number, partial: boolean, through: string): string =>
  `${minutes} хв; ${partial ? 'неповні дані' : 'виміряні дані'}, станом на ${through}`;
const reminderWhat = (kind: 'notify' | 'overlay', message: string): string => `${kind === 'overlay' ? 'повідомлення на екрані' : 'сповіщення'} ${q(message)}`;

export const uk = {
  // Formats.
  duration, categoryLabel, selectionLabel, quote: q,

  // Pairing, access and general replies.
  PAIRING,
  PAIRED: 'Доступ підтверджено.',
  KEY_DELETED: ' Повідомлення з ключем видалено.',
  KEY_NOT_DELETED: ' Видаліть повідомлення з ключем із чату.',
  PAIR_FAILED: 'Не вдалося підключитися: ключ недійсний, використаний або прострочений.',
  PAIR_THROTTLED: 'Забагато спроб підключення. Спробуйте пізніше.',
  ALREADY_PAIRED: 'Цей обліковий запис уже підключено.',
  LEAVE_CONFIRM: 'Відключитися від цього ноутбука? Ви більше не отримуватимете звіти й сповіщення. Щоб повернутися, потрібен новий ключ із ноутбука.',
  LEAVE_LAST: 'Ви останній підключений дорослий. Після цього всі правила на ноутбуці зупиняться.',
  LEFT: 'Вас відключено.',
  STALE_NAV: 'Це меню застаріло. Відкрийте /start знову.',
  ACTION_CAPACITY: 'Забагато активних нагадувань. Очистьте їх через /clear і спробуйте знову.',
  DATA_CAPACITY: 'Зміну не збережено: перевищено допустимий обсяг даних. Спробуйте меншу зміну.',
  OPERATION_CONFLICT: 'Цей запит уже оброблено або він застарів. Спробуйте ще раз.',
  TOO_MANY: 'Забагато запитів. Спробуйте пізніше.',
  REQUEST_FAILED: 'Не вдалося виконати запит. Перевірте введені дані й спробуйте ще раз.',
  HINT: 'Оберіть дію в меню: /start',
  UNKNOWN_COMMAND: 'Невідома команда. Список команд: /help',
  CANCELED: 'Скасовано.',
  REVIEW,

  // Main menu, Settings and language.
  MAIN_MENU: 'Головне меню',
  HOME_LABEL: '🏠 Головне меню',
  SETTINGS_MENU: '⚙️ Налаштування',
  CHOOSE_PERIOD: '📊 Використання\n\nОберіть період:',
  NAV_LABELS: {
    usage: '📊 Використання', status: '💻 Стан ноутбука', reminders: '💬 Нагадування', limit: '⏱ Ліміт часу',
    settings: '⚙️ Налаштування', help: 'Допомога', back: LABELS.back,
    leave: '🚪 Відключитися', leaveyes: 'Так, відключитися', leaveno: LABELS.cancel,
    today: 'Сьогодні', yesterday: 'Учора', week: 'Останні 7 днів', refresh: '🔄 Оновити',
  },
  hourlyLabel: (enabled: boolean): string => `Щогодинні звіти: ${onOff(enabled)}`,
  endtimeLabel: (settings: Settings): string => `Час завершення: ${settings.endtimeEnabled ? settings.endtimeLocalTime : 'вимкнено'}`,
  LANGUAGE_LABEL: '🌐 Мова: Українська',
  CHOOSE_LANGUAGE: '🌐 Оберіть мову бота:',
  /** Each language is named in itself, so both catalogues hold the same names. */
  LANGUAGE_NAMES: {uk: 'Українська', en: 'English'},
  LANGUAGE_SAVED: 'Мову бота змінено: українська.',
  LANGUAGE_USAGE: 'Використання: /language uk або /language en.',
  HOURLY_USAGE: 'Використання: /hourly on або /hourly off.',
  USAGE_USAGE: 'Використання: /usage, /usage today, /usage yesterday або /usage week.',
  hourlySaved: (enabled: boolean): string => `Щогодинні звіти ${onOff(enabled)}.`,
  HELP: [
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
    '/language uk|en — мова бота',
    '/unpair — відключитися від ноутбука',
    '/help — ця довідка',
  ].join('\n'),
  /** Telegram's command menu for `language_code: uk`, registered by scripts/webhook.ts set. */
  COMMANDS: [
    {command: 'start', description: 'головне меню'}, {command: 'status', description: 'стан ноутбука'},
    {command: 'usage', description: 'використання'}, {command: 'limit', description: 'ліміт часу'},
    {command: 'pending', description: 'активні нагадування'}, {command: 'clear', description: 'очистити нагадування'},
    {command: 'settings', description: 'налаштування'}, {command: 'help', description: 'усі команди'},
  ],

  // Saved changes and the laptop's "applied" message (UX-03).
  OFFLINE_LINE,
  savedText,
  APPLIED_PREFIX: '✅ Ноутбук застосував: ',

  // Endtime.
  LABELS,
  STALE_MENU: 'Це меню застаріло. Відкрийте /endtime знову.',
  TIME_FORMAT: 'Вкажіть час у форматі ГГ:ХХ від 00:15 до 23:59, наприклад 21:00.',
  ENDTIME_USAGE: 'Використання: /endtime, /endtime status, /endtime set ГГ:ХХ, /endtime on, /endtime off.',
  ENTER_TIME: 'Введіть час завершення у форматі ГГ:ХХ (від 00:15 до 23:59).',
  endtimeStatus(settings: Settings, acknowledged: Counter | null, today: string): string {
    const applied = acknowledged !== null && acknowledged >= settings.revision ? 'застосовано' : 'очікує застосування';
    const lines = ['🌙 Час завершення', '', `Стан: ${onOff(settings.endtimeEnabled)}`, `Збережений час: ${settings.endtimeLocalTime}`, `Ноутбук: ${applied}`];
    if (settings.freeUseDate === today) lines.push('Сьогодні не діє: увімкнено вільний режим.');
    if (settings.suppressedDate === today) lines.push('Сьогодні не діє: автоматичні нагадування вимкнено до півночі.');
    return lines.join('\n');
  },
  /** Saved cloud state only; the companion's acknowledgement arrives as its own message (UX-03). */
  endtimeSaved(settings: Settings, changed: boolean, offline: boolean): string {
    if (!changed) return `Без змін: час завершення вже ${endtimeState(settings)}.`;
    return savedText(`час завершення ${endtimeState(settings)}.`, offline);
  },
  endtimeReview: (localTime: string): string =>
    `${REVIEW}\n\nЧас завершення: ${localTime}\nПісля підтвердження його буде увімкнено, а інших батьків повідомлено.`,

  // Limit, categories, free use and restore.
  STALE_LIMIT: 'Це меню застаріло. Відкрийте /limit знову.',
  LIMIT_USAGE: 'Використання: /limit, /limit ТРИВАЛІСТЬ today або /limit ТРИВАЛІСТЬ daily, наприклад /limit 2:30 today.',
  DURATION_FORMAT: 'Вкажіть тривалість від 0 до 24 годин, наприклад 2:30, 90 хв або 1 год 30 хв.',
  FREE_USAGE: 'Використання: /free on або /free off.',
  ADD_CATEGORY_USAGE: 'Використання: /add_category НАЗВА, наприклад /add_category Games › Minecraft.',
  REMOVE_CATEGORY_USAGE: 'Використання: /remove_category НАЗВА, наприклад /remove_category Games.',
  ENTER_TODAY_LIMIT: 'Введіть ліміт на сьогодні, наприклад 2:30 або 90 хв.',
  ENTER_DAILY_LIMIT: 'Введіть новий щоденний ліміт, наприклад 4:00 або 240 хв.',
  NO_CATALOG: 'Список категорій ще не отримано з ноутбука. Спробуйте пізніше.',
  PICK_ADD: 'Оберіть категорію, яку додати до обліку:',
  PICK_REMOVE: 'Оберіть категорію, яку прибрати з обліку:',
  NOTHING_TO_ADD: 'Усі категорії з ноутбука вже враховуються.',
  NOTHING_TO_REMOVE: 'Для обліку нічого не вибрано.',
  FREE_STILL_ON: 'Вільний режим усе ще увімкнено, тому нагадування призупинені, доки його не вимкнуть.',
  LIMIT_LABELS: {
    today: 'Змінити на сьогодні', daily: 'Змінити щоденний ліміт', categories: 'Категорії', freeOn: 'Увімкнути вільний режим',
    freeOff: 'Вимкнути вільний режим', restore: 'Відновити нагадування', add: 'Додати', remove: 'Видалити', prev: '‹', next: '›',
    clearManual: 'Лише ручні', clearAll: 'Усі нагадування', clearConfirm: '✅ Очистити всі',
  },
  /** The limit menu's status; usage is null without data for today, categories null when none is selected. */
  limitStatus(s: {today: string; override: boolean; daily: string; usage: string | null; partial: boolean; categories: string | null; free: boolean; suppressed: boolean}): string {
    const lines = ['⏱ Ліміт часу', '', `Сьогодні: ${s.today} (${s.override ? 'лише сьогодні' : 'щоденний ліміт'})`, `Щоденний ліміт: ${s.daily}`,
      `Враховано сьогодні: ${s.usage === null ? 'даних немає' : s.usage + (s.partial ? PARTIAL : '')}`, `Категорії: ${s.categories ?? 'не вибрано'}`,
      `Вільний режим: ${s.free ? 'увімкнено до опівночі' : 'вимкнено'}`];
    if (s.suppressed) lines.push('Автоматичні нагадування: вимкнено до опівночі');
    return lines.join('\n');
  },
  categoriesScreen: (labels: string[]): string => labels.length ? `Категорії для обліку\n\nВибрано:\n${labels.map(l => '• ' + l).join('\n')}` :
    'Категорії для обліку\n\nВибрано: нічого, тому нічого не враховується.',
  reviewToday: (limit: string): string => `${REVIEW}\n\nЛіміт лише на сьогодні: ${limit}\nЩоденний ліміт не зміниться. Зміна діє до опівночі. ${TELL_OTHERS}`,
  reviewDaily: (limit: string): string => `${REVIEW}\n\nНовий щоденний ліміт: ${limit}\nДіє з сьогодні й надалі та замінює зміну лише на сьогодні. ${TELL_OTHERS}`,
  reviewFree: (enabled: boolean): string => enabled ?
    `${REVIEW}\n\nУвімкнути вільний режим до опівночі?\nНагадування й попередження про ліміт буде пропущено, облік часу продовжиться. ${TELL_OTHERS}` :
    `${REVIEW}\n\nВимкнути вільний режим?\nНагадування про ліміт відновляться з урахуванням усього часу за сьогодні. ${TELL_OTHERS}`,
  REVIEW_RESTORE: `${REVIEW}\n\nВідновити автоматичні нагадування на сьогодні?\nСкасовані ручні нагадування не повернуться. ${TELL_OTHERS}`,
  reviewCategory: (add: boolean, label: string): string =>
    `${REVIEW}\n\n${add ? 'Додати до обліку' : 'Прибрати з обліку'}: ${label}\nСьогоднішній облік буде перераховано з усіх даних за день. ${TELL_OTHERS}`,
  /** savedText descriptions and no-op replies of the limit changes. */
  savedToday: (limit: string): string => `ліміт на сьогодні ${limit}.`,
  sameToday: (limit: string): string => `Без змін: ліміт на сьогодні вже ${limit}.`,
  savedDaily: (limit: string): string => `щоденний ліміт ${limit}.`,
  sameDaily: (limit: string): string => `Без змін: щоденний ліміт уже ${limit}.`,
  savedFree: (enabled: boolean): string => enabled ? 'вільний режим увімкнено до опівночі.' : 'вільний режим вимкнено.',
  sameFree: (enabled: boolean): string => `Без змін: вільний режим уже ${onOff(enabled)}.`,
  SAVED_RESTORE: 'автоматичні нагадування відновлено.',
  SAME_RESTORE: 'Без змін: автоматичні нагадування не вимкнено.',
  savedCategories: (selection: string): string => `категорії для обліку — ${selection}.`,
  sameCategory: (add: boolean, label: string): string => `Без змін: ${q(label)} ${add ? 'уже враховується' : 'не враховується'}.`,
  countedVia: (typed: string, parent: string): string => `${q(typed)} враховується через ${q(parent)}. Щоб її не враховувати, приберіть ${q(parent)}.`,
  notCounted: (name: string): string => `Без змін: ${q(name)} не враховується.`,
  categoryNotFound: (name: string): string => `Категорію ${q(name)} не знайдено. Перелік: /categories`,

  // Clear.
  STALE_CLEAR: 'Це меню застаріло. Відкрийте /clear знову.',
  CLEAR_USAGE: 'Використання: /clear, /clear manual або /clear all.',
  CLEAR_CHOOSE: 'Що очистити?',
  CLEAR_ALL_CONFIRM: 'Скасувати всі активні та заплановані\nнагадування й вимкнути попередження\nпро денний ліміт до опівночі?\n\nОблік часу та щогодинні звіти продовжаться.',
  /** savedText descriptions of the two clears. */
  CLEARED_MANUAL: 'ручні нагадування буде скасовано.',
  CLEARED_ALL: 'усі нагадування буде скасовано, попередження про ліміт вимкнено до опівночі.',

  // Reminders.
  REMIND: {
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
  },
  REMIND_LABELS: {
    notify: '🔔 Сповіщення', overlay: '🖥 Повідомлення на екрані', pending: '📋 Активні та заплановані', clear: '🧹 Очистити…',
    now: 'Зараз', later: 'Через…', custom: 'Інший час', yes: 'Так', no: 'Ні', schedule: '✅ Запланувати', send: '✅ Надіслати',
    options: '⚙️ Додаткові параметри', once: 'Показати один раз', repeat: 'Повторювати після закриття', buttonless: 'Без кнопки закриття',
    limit: 'Перейти до ліміту часу', refresh: '🔄 Оновити',
  },
  minutesShort: (n: number): string => `${n} хв`,
  secondsShort: (n: number): string => `${n} с`,
  scheduledAt: (time: string): string => `Заплановано на ${time}`,
  /** The review of a reminder before it is sent; delay null means now. */
  reminderReview(r: {kind: 'notify' | 'overlay'; message: string; delay: {minutes: number; at: string} | null; countdown: boolean;
                    buttonless: number | null; repeat: number | null}): string {
    const lines = [r.kind === 'overlay' ? '🖥 Повідомлення на екрані' : '🔔 Сповіщення', '', `Текст: ${r.message}`];
    lines.push(r.delay ? `Показати: через ${r.delay.minutes} ${minutesWord(r.delay.minutes)}, о ${r.delay.at}` : 'Показати: зараз');
    if (r.delay) lines.push(`Зворотний відлік: ${onOff(r.countdown)}`);
    if (r.kind === 'overlay') {
      lines.push(r.buttonless !== null ? `Кнопка закриття: немає, показ ${r.buttonless} с` : 'Кнопка закриття: є');
      lines.push(r.repeat !== null ? `Повторення: через ${r.repeat} хв після закриття, до опівночі` : 'Повторення: немає');
    }
    return lines.join('\n');
  },
  PENDING_STATE: {pending: 'Очікує доставки на ноутбук', presented: 'Показано на ноутбуці', other: 'Ноутбук отримав запит'},
  PENDING_COUNTDOWN: ' · відлік увімкнено',
  pendingButtonless: (seconds: number): string => ` · без кнопки закриття, ${seconds} с`,
  pendingRepeat: (minutes: number): string[] => [`   Повторення через ${minutes} хв після закриття`, '   Діє до опівночі'],

  // Reports.
  WEEKDAYS: ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
  PARTIAL,
  continued: (header: string): string => `${header} (продовження)`,
  NO_DAY_DATA: 'Даних за цей день немає.',
  coverageFrom: (from: string, through: string): string => `Дані з ${from} до ${through}`,
  coverageAsOf: (through: string): string => `Дані станом на ${through}`,
  coveragePartial: (through: string): string => `Дані неповні, до ${through}`,
  COVERAGE_FULL: 'Дані повні',
  LIMIT_FREE: 'Ліміт: вільний режим до опівночі',
  limitLine: (limit: string, rest: string): string => `Ліміт: ${limit} · ${rest}`,
  left: (time: string): string => `залишилось ${time}`,
  over: (time: string): string => `перевищено на ${time}`,
  liveAway: (app: string): string => `Зараз неактивний. Остання програма: ${app}`,
  liveNow: (app: string, title: string): string => `Зараз: ${app}${title}`,
  liveLast: (at: string, app: string, title: string): string => `Остання активність о ${at}: ${app}${title}`,
  dayHeader: (period: 'today' | 'yesterday', date: string): string => `📊 ${period === 'today' ? 'Сьогодні' : 'Учора'}, ${date}`,
  counted: (total: string): string => `Враховано: ${total}`,
  NO_SELECTION: 'Категорії для обліку не вибрано, тому нічого не враховується.',
  NO_APPS: 'У вибраних категоріях програм немає.',
  WEEK_HEADER: '📊 Останні 7 днів',
  noData: (label: string): string => `${label} — немає даних`,
  WEEK_NOTES: {today: 'сьогодні', partial: 'неповні'},
  weekTotal: (total: string, days: number, partial: boolean): string => `Разом: ${total} за ${days} ${daysWord(days)} з даними${partial ? PARTIAL : ''}.`,
  NO_WEEK_DATA: 'Даних за цей тиждень немає.',
  AW_STATE: {
    ready: 'працює', partial: 'неповні дані', stale: 'дані застаріли', unavailable: 'недоступний',
    unsupported: 'категорії не налаштовано', unknown: 'невідомо',
  } satisfies Record<Health['awState'], string>,
  STATUS_TITLE: '💻 Стан ноутбука',
  NEVER_SYNCED: 'Зв’язок: ноутбук ще не синхронізувався',
  online: (time: string): string => `Зв’язок: на зв’язку, остання синхронізація о ${time}`,
  offline: (at: string): string => `Зв’язок: немає зв’язку з ${at}`,
  awLine: (state: string, reportError: boolean): string => `ActivityWatch: ${state}${reportError ? ' (звіт завеликий, показано останні дані)' : ''}`,
  TODAY_NO_DATA: 'Сьогодні: даних немає',
  todayFree: (used: string, partial: string): string => `Сьогодні: ${used}${partial}, вільний режим`,
  todayLimit: (used: string, limit: string, rest: string, partial: string): string => `Сьогодні: ${used} з ${limit}, ${rest}${partial}`,
  freeUseLine: (on: boolean): string => `Вільний режим: ${on ? 'увімкнено до опівночі' : 'вимкнено'}`,
  remindersLine: (suppressed: boolean): string => `Автоматичні нагадування: ${suppressed ? 'вимкнено до опівночі' : 'активні'}`,

  // Shared messages: every recipient's outbox row carries their language's version.
  reminderCreated: (kind: 'notify' | 'overlay', message: string, name: string, at: string | null): string =>
    `Нове нагадування від ${q(name)}: ${reminderWhat(kind, message)}. Показати: ${at === null ? 'зараз' : 'о ' + at}. Очікуємо підтвердження ноутбука.`,
  reminderSkipped: (kind: 'notify' | 'overlay', message: string, name: string): string =>
    `Нагадування від ${q(name)} пропущено, бо ввімкнено вільний режим: ${reminderWhat(kind, message)}.`,
  clearing: (scope: 'manual' | 'all', name: string): string => scope === 'all' ?
    `${q(name)} очищує всі нагадування та вимикає попередження про ліміт до опівночі. Очікуємо підтвердження ноутбука.` :
    `${q(name)} очищує ручні нагадування. Очікуємо підтвердження ноутбука.`,
  LATE_CLEAR: 'Нагадування встигло з’явитися на ноутбуці до того, як туди дійшло очищення (це не означає прочитання).',
  LATE_FREE: 'Нагадування встигло з’явитися на ноутбуці до того, як туди дійшов вільний режим (це не означає прочитання).',
  DEADLINE: {execution_unconfirmed: 'Очікуємо підтвердження виконання', delivery_unconfirmed: 'Не вдалося підтвердити доставку',
    skipped: 'Таймер пропущено: вільне користування', done: 'Команду завершено'},
  RECEIPT: {presented: 'Показ підтверджено (це не означає прочитання)', accepted: 'Розклад прийнято ноутбуком',
    updated: 'Оновлено стан команди; показ не підтверджено'},
  receiptBatch: (changed: number, confirmed: number): string =>
    `Оновлено стан ${changed} команд. Підтверджено показ: ${confirmed}. Показ не означає прочитання.`,
  /** What a clear's "applied" message says (UX-03); settings changes reuse their coordination summary. */
  CLEAR_APPLIED: {manual: 'ручні нагадування скасовано', all: 'усі нагадування скасовано, попередження про ліміт вимкнено до опівночі'},
  settingsChangedBy: (name: string): string => `Налаштування змінив(-ла) ${q(name)}.`,
  /** Coordination summaries, each with a leading space; the applied message reuses them as clauses. */
  summaryEndtime: (enabled: boolean, localTime: string): string => ` Час завершення: ${onOff(enabled)}, ${localTime}.`,
  summaryToday: (limit: string): string => ` Ліміт на сьогодні ${limit}.`,
  summaryDaily: (limit: string): string => ` Щоденний ліміт ${limit}.`,
  summaryCategories: (selection: string): string => ` Категорії для обліку: ${selection}.`,
  summaryFree: (enabled: boolean): string => enabled ? ' Вільний режим увімкнено до опівночі.' : ' Вільний режим вимкнено.',
  summarySuppression: (enabled: boolean): string => enabled ? ' Автоматичні нагадування вимкнено до опівночі.' : ' Автоматичні нагадування відновлено.',
  currentTime: (minutes: number, partial: boolean, through: string): string => ` Поточний час: ${measured(minutes, partial, through)}.`,
  used: (minutes: number, partial: boolean, through: string): string => `Використано ${measured(minutes, partial, through)}.`,
  /** null: the daily time has run out. */
  warning: (minutesLeft: number | null): string => minutesLeft === null ? 'Денний час вичерпано.' : `Залишилося ${minutesLeft} хв або менше.`,
  endtimeReached: (localTime: string, date: string): string => `Настав час завершення ${localTime} (${date}); нагадування показано на ноутбуці.`,
};
