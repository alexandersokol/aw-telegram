/** Built-in English copy. `satisfies typeof uk` fails the build on a missing or extra key or a changed type;
 * index.ts also rejects a function with a different parameter list. */
import type {Settings,Counter,CategoryPath,Health} from '../../contracts.js';
import type {uk} from './uk.js';

const LABELS = {on: 'Turn on', off: 'Turn off', time: 'Change time', confirm: 'Confirm', cancel: 'Cancel', back: '← Back'};
const PAIRING = 'To connect, create a key in the laptop app ("Parent access", «Доступ батьків») and send it here with /pair KEY.';
const OFFLINE_LINE = 'The laptop is offline right now; this applies when it is back on.';
const REVIEW = 'Check the change';
const TELL_OTHERS = 'The other parents will be told.';
const PARTIAL = ' (incomplete data)';
const q = (value: string): string => `"${value}"`;
const savedText = (description: string, offline: boolean, note?: string): string =>
  `Saved: ${description}${note ? '\n' + note : ''}${offline ? '\n' + OFFLINE_LINE : ''}`;
function duration(ms: number): string {
  if (ms > 0 && ms < 60000) return 'under 1 min';
  const minutes = Math.floor(ms / 60000), hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`;
}
const categoryLabel = (path: CategoryPath | null): string => path === null ? 'Uncategorized' : path.join(' › ');
function selectionLabel(paths: CategoryPath[], uncategorized: boolean): string {
  const labels = [...paths.map(categoryLabel), ...(uncategorized ? [categoryLabel(null)] : [])];
  return labels.length ? labels.join(', ') : 'nothing';
}
const minutesWord = (n: number): string => n === 1 ? 'minute' : 'minutes';
const daysWord = (n: number): string => n === 1 ? 'day' : 'days';
const onOff = (enabled: boolean): string => enabled ? 'on' : 'off';
const endtimeState = (settings: Settings): string =>
  settings.endtimeEnabled ? `on, ${settings.endtimeLocalTime}` : `off (saved time ${settings.endtimeLocalTime})`;
const measured = (minutes: number, partial: boolean, through: string): string =>
  `${minutes} min; ${partial ? 'incomplete data' : 'measured data'}, as of ${through}`;
const reminderWhat = (kind: 'notify' | 'overlay', message: string): string => `${kind === 'overlay' ? 'on-screen message' : 'notification'} ${q(message)}`;

export const en = {
  duration, categoryLabel, selectionLabel, quote: q,

  PAIRING,
  PAIRED: 'Access confirmed.',
  KEY_DELETED: ' The message with the key was deleted.',
  KEY_NOT_DELETED: ' Delete the message with the key from the chat.',
  PAIR_FAILED: 'Could not connect: the key is invalid, used or expired.',
  PAIR_THROTTLED: 'Too many connection attempts. Try again later.',
  ALREADY_PAIRED: 'This account is already connected.',
  LEAVE_CONFIRM: 'Disconnect from this laptop? You will no longer get reports and notifications. To come back, you need a new key from the laptop.',
  LEAVE_LAST: 'You are the last connected adult. After this, all rules on the laptop stop.',
  LEFT: 'You are disconnected.',
  STALE_NAV: 'This menu is out of date. Open /start again.',
  ACTION_CAPACITY: 'Too many active reminders. Clear them with /clear and try again.',
  DATA_CAPACITY: 'The change was not saved: it exceeds the allowed data size. Try a smaller change.',
  OPERATION_CONFLICT: 'This request was already handled or is out of date. Try again.',
  TOO_MANY: 'Too many requests. Try again later.',
  REQUEST_FAILED: 'Could not complete the request. Check what you entered and try again.',
  HINT: 'Choose an action in the menu: /start',
  UNKNOWN_COMMAND: 'Unknown command. List of commands: /help',
  CANCELED: 'Canceled.',
  REVIEW,

  MAIN_MENU: 'Main menu',
  HOME_LABEL: '🏠 Main menu',
  SETTINGS_MENU: '⚙️ Settings',
  CHOOSE_PERIOD: '📊 Usage\n\nChoose a period:',
  NAV_LABELS: {
    usage: '📊 Usage', status: '💻 Laptop status', reminders: '💬 Reminders', limit: '⏱ Time limit',
    settings: '⚙️ Settings', help: 'Help', back: LABELS.back,
    leave: '🚪 Disconnect', leaveyes: 'Yes, disconnect', leaveno: LABELS.cancel,
    today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days', refresh: '🔄 Refresh',
  },
  hourlyLabel: (enabled: boolean): string => `Hourly reports: ${onOff(enabled)}`,
  endtimeLabel: (settings: Settings): string => `Endtime: ${settings.endtimeEnabled ? settings.endtimeLocalTime : 'off'}`,
  LANGUAGE_LABEL: '🌐 Language: English',
  CHOOSE_LANGUAGE: '🌐 Choose the bot language:',
  LANGUAGE_NAMES: {uk: 'Українська', en: 'English'},
  LANGUAGE_SAVED: 'Bot language changed: English.',
  LANGUAGE_USAGE: 'Usage: /language uk or /language en.',
  HOURLY_USAGE: 'Usage: /hourly on or /hourly off.',
  USAGE_USAGE: 'Usage: /usage, /usage today, /usage yesterday or /usage week.',
  hourlySaved: (enabled: boolean): string => `Hourly reports ${onOff(enabled)}.`,
  HELP: [
    'Commands:',
    '/start — main menu',
    '/usage — usage (today, yesterday, week)',
    '/status — laptop status',
    '/limit — time limit (DURATION today|daily)',
    '/categories, /add_category NAME, /remove_category NAME — tracked categories',
    '/free on|off — free use until midnight',
    '/notify [+MIN] [countdown] TEXT — notification on the laptop',
    '/overlay [+MIN] [countdown] [repeat=MIN | nodismiss=SEC] TEXT — on-screen message',
    '/pending — active and scheduled reminders',
    '/clear [manual|all] — clear reminders',
    '/restore — restore automatic reminders',
    '/settings — settings',
    '/hourly on|off — your hourly reports',
    '/endtime — endtime (status, set HH:MM, on, off)',
    '/language uk|en — bot language',
    '/unpair — disconnect from the laptop',
    '/help — this help',
  ].join('\n'),
  /** Telegram's default command menu (no language_code). */
  COMMANDS: [
    {command: 'start', description: 'main menu'}, {command: 'status', description: 'laptop status'},
    {command: 'usage', description: 'usage'}, {command: 'limit', description: 'time limit'},
    {command: 'pending', description: 'active reminders'}, {command: 'clear', description: 'clear reminders'},
    {command: 'settings', description: 'settings'}, {command: 'help', description: 'all commands'},
  ],

  OFFLINE_LINE,
  savedText,
  APPLIED_PREFIX: '✅ The laptop applied: ',

  LABELS,
  STALE_MENU: 'This menu is out of date. Open /endtime again.',
  TIME_FORMAT: 'Enter the time as HH:MM from 00:15 to 23:59, for example 21:00.',
  ENDTIME_USAGE: 'Usage: /endtime, /endtime status, /endtime set HH:MM, /endtime on, /endtime off.',
  ENTER_TIME: 'Enter the endtime as HH:MM (from 00:15 to 23:59).',
  endtimeStatus(settings: Settings, acknowledged: Counter | null, today: string): string {
    const applied = acknowledged !== null && acknowledged >= settings.revision ? 'applied' : 'waiting to apply';
    const lines = ['🌙 Endtime', '', `State: ${onOff(settings.endtimeEnabled)}`, `Saved time: ${settings.endtimeLocalTime}`, `Laptop: ${applied}`];
    if (settings.freeUseDate === today) lines.push('Not in effect today: free use is on.');
    if (settings.suppressedDate === today) lines.push('Not in effect today: automatic reminders are off until midnight.');
    return lines.join('\n');
  },
  endtimeSaved(settings: Settings, changed: boolean, offline: boolean): string {
    if (!changed) return `No change: endtime is already ${endtimeState(settings)}.`;
    return savedText(`endtime ${endtimeState(settings)}.`, offline);
  },
  endtimeReview: (localTime: string): string =>
    `${REVIEW}\n\nEndtime: ${localTime}\nConfirming turns it on and tells the other parents.`,

  STALE_LIMIT: 'This menu is out of date. Open /limit again.',
  LIMIT_USAGE: 'Usage: /limit, /limit DURATION today or /limit DURATION daily, for example /limit 2:30 today.',
  DURATION_FORMAT: 'Enter a duration from 0 to 24 hours, for example 2:30, 90 min or 1 h 30 min.',
  FREE_USAGE: 'Usage: /free on or /free off.',
  ADD_CATEGORY_USAGE: 'Usage: /add_category NAME, for example /add_category Games › Minecraft.',
  REMOVE_CATEGORY_USAGE: 'Usage: /remove_category NAME, for example /remove_category Games.',
  ENTER_TODAY_LIMIT: 'Enter today\'s limit, for example 2:30 or 90 min.',
  ENTER_DAILY_LIMIT: 'Enter the new daily limit, for example 4:00 or 240 min.',
  NO_CATALOG: 'The category list has not arrived from the laptop yet. Try again later.',
  PICK_ADD: 'Choose a category to track:',
  PICK_REMOVE: 'Choose a category to stop tracking:',
  NOTHING_TO_ADD: 'All categories from the laptop are already tracked.',
  NOTHING_TO_REMOVE: 'Nothing is selected for tracking.',
  FREE_STILL_ON: 'Free use is still on, so reminders stay paused until it is turned off.',
  LIMIT_LABELS: {
    today: 'Change for today', daily: 'Change the daily limit', categories: 'Categories', freeOn: 'Turn on free use',
    freeOff: 'Turn off free use', restore: 'Restore reminders', add: 'Add', remove: 'Remove', prev: '‹', next: '›',
    clearManual: 'Manual only', clearAll: 'All reminders', clearConfirm: '✅ Clear all',
  },
  limitStatus(s: {today: string; override: boolean; daily: string; usage: string | null; partial: boolean; categories: string | null; free: boolean; suppressed: boolean}): string {
    const lines = ['⏱ Time limit', '', `Today: ${s.today} (${s.override ? 'today only' : 'daily limit'})`, `Daily limit: ${s.daily}`,
      `Counted today: ${s.usage === null ? 'no data' : s.usage + (s.partial ? PARTIAL : '')}`, `Categories: ${s.categories ?? 'none selected'}`,
      `Free use: ${s.free ? 'on until midnight' : 'off'}`];
    if (s.suppressed) lines.push('Automatic reminders: off until midnight');
    return lines.join('\n');
  },
  categoriesScreen: (labels: string[]): string => labels.length ? `Tracked categories\n\nSelected:\n${labels.map(l => '• ' + l).join('\n')}` :
    'Tracked categories\n\nSelected: nothing, so nothing is counted.',
  reviewToday: (limit: string): string => `${REVIEW}\n\nLimit for today only: ${limit}\nThe daily limit stays. The change lasts until midnight. ${TELL_OTHERS}`,
  reviewDaily: (limit: string): string => `${REVIEW}\n\nNew daily limit: ${limit}\nApplies from today on and replaces a today-only change. ${TELL_OTHERS}`,
  reviewFree: (enabled: boolean): string => enabled ?
    `${REVIEW}\n\nTurn on free use until midnight?\nReminders and limit warnings will be skipped; time is still counted. ${TELL_OTHERS}` :
    `${REVIEW}\n\nTurn off free use?\nLimit reminders resume, counting all of today's time. ${TELL_OTHERS}`,
  REVIEW_RESTORE: `${REVIEW}\n\nRestore automatic reminders for today?\nCleared manual reminders do not come back. ${TELL_OTHERS}`,
  reviewCategory: (add: boolean, label: string): string =>
    `${REVIEW}\n\n${add ? 'Start tracking' : 'Stop tracking'}: ${label}\nToday's count is recalculated from all of the day's data. ${TELL_OTHERS}`,
  savedToday: (limit: string): string => `today's limit ${limit}.`,
  sameToday: (limit: string): string => `No change: today's limit is already ${limit}.`,
  savedDaily: (limit: string): string => `daily limit ${limit}.`,
  sameDaily: (limit: string): string => `No change: the daily limit is already ${limit}.`,
  savedFree: (enabled: boolean): string => enabled ? 'free use on until midnight.' : 'free use off.',
  sameFree: (enabled: boolean): string => `No change: free use is already ${onOff(enabled)}.`,
  SAVED_RESTORE: 'automatic reminders restored.',
  SAME_RESTORE: 'No change: automatic reminders are not off.',
  savedCategories: (selection: string): string => `tracked categories — ${selection}.`,
  sameCategory: (add: boolean, label: string): string => `No change: ${q(label)} is ${add ? 'already tracked' : 'not tracked'}.`,
  countedVia: (typed: string, parent: string): string => `${q(typed)} is tracked through ${q(parent)}. To stop tracking it, remove ${q(parent)}.`,
  notCounted: (name: string): string => `No change: ${q(name)} is not tracked.`,
  categoryNotFound: (name: string): string => `Category ${q(name)} not found. List: /categories`,

  STALE_CLEAR: 'This menu is out of date. Open /clear again.',
  CLEAR_USAGE: 'Usage: /clear, /clear manual or /clear all.',
  CLEAR_CHOOSE: 'What to clear?',
  CLEAR_ALL_CONFIRM: 'Cancel all active and scheduled\nreminders and turn off daily limit\nwarnings until midnight?\n\nTime counting and hourly reports continue.',
  CLEARED_MANUAL: 'manual reminders will be canceled.',
  CLEARED_ALL: 'all reminders will be canceled, limit warnings off until midnight.',

  REMIND: {
    home: '💬 Reminders\n\nSend a message to the laptop or\nsee active and scheduled reminders.',
    text: 'Enter the message text:', when: 'When to show the message?', delay: 'Show the message in how long?',
    delayInput: 'Enter the delay in minutes, from 1 to 1439.', minutes: 'Enter a whole number of minutes from 1 to 1439.',
    countdown: 'Show a countdown in the top left corner?', options: 'More options',
    repeatInput: 'Repeat how many minutes after it is closed? From 1 to 1439.',
    durationInput: 'Show without a close button for how many seconds? From 1 to 3600.', seconds: 'Enter a whole number of seconds from 1 to 3600.',
    message: 'The text must have 1 to 1000 characters.',
    queued: '⏳ Request saved. Waiting for the laptop to confirm.',
    free: 'ℹ️ Free use is on until midnight.\nThis reminder will be skipped.',
    pending: '📋 Active and scheduled', none: 'No active or scheduled reminders.',
    notifyUsage: 'Usage: /notify [+MINUTES] [countdown] TEXT, for example /notify +15 countdown Time for a break.',
    overlayUsage: 'Usage: /overlay [+MINUTES] [countdown] [repeat=MINUTES | nodismiss=SECONDS] TEXT.',
    conflict: 'Repeating cannot be combined with showing without a close button.',
    countdownDelay: 'A countdown is only possible for a delayed reminder.',
  },
  REMIND_LABELS: {
    notify: '🔔 Notification', overlay: '🖥 On-screen message', pending: '📋 Active and scheduled', clear: '🧹 Clear…',
    now: 'Now', later: 'Later…', custom: 'Other time', yes: 'Yes', no: 'No', schedule: '✅ Schedule', send: '✅ Send',
    options: '⚙️ More options', once: 'Show once', repeat: 'Repeat after closing', buttonless: 'No close button',
    limit: 'Go to the time limit', refresh: '🔄 Refresh',
  },
  minutesShort: (n: number): string => `${n} min`,
  secondsShort: (n: number): string => `${n} s`,
  scheduledAt: (time: string): string => `Scheduled for ${time}`,
  reminderReview(r: {kind: 'notify' | 'overlay'; message: string; delay: {minutes: number; at: string} | null; countdown: boolean;
                    buttonless: number | null; repeat: number | null}): string {
    const lines = [r.kind === 'overlay' ? '🖥 On-screen message' : '🔔 Notification', '', `Text: ${r.message}`];
    lines.push(r.delay ? `Show: in ${r.delay.minutes} ${minutesWord(r.delay.minutes)}, at ${r.delay.at}` : 'Show: now');
    if (r.delay) lines.push(`Countdown: ${onOff(r.countdown)}`);
    if (r.kind === 'overlay') {
      lines.push(r.buttonless !== null ? `Close button: none, shown for ${r.buttonless} s` : 'Close button: yes');
      lines.push(r.repeat !== null ? `Repeat: ${r.repeat} min after closing, until midnight` : 'Repeat: no');
    }
    return lines.join('\n');
  },
  PENDING_STATE: {pending: 'Waiting for delivery to the laptop', presented: 'Shown on the laptop', other: 'The laptop received the request'},
  PENDING_COUNTDOWN: ' · countdown on',
  pendingButtonless: (seconds: number): string => ` · no close button, ${seconds} s`,
  pendingRepeat: (minutes: number): string[] => [`   Repeats ${minutes} min after closing`, '   Until midnight'],

  WEEKDAYS: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  PARTIAL,
  continued: (header: string): string => `${header} (continued)`,
  NO_DAY_DATA: 'No data for this day.',
  coverageFrom: (from: string, through: string): string => `Data from ${from} to ${through}`,
  coverageAsOf: (through: string): string => `Data as of ${through}`,
  coveragePartial: (through: string): string => `Data incomplete, up to ${through}`,
  COVERAGE_FULL: 'Data complete',
  LIMIT_FREE: 'Limit: free use until midnight',
  limitLine: (limit: string, rest: string): string => `Limit: ${limit} · ${rest}`,
  left: (time: string): string => `${time} left`,
  over: (time: string): string => `over by ${time}`,
  liveAway: (app: string): string => `Away now. Last app: ${app}`,
  liveNow: (app: string, title: string): string => `Now: ${app}${title}`,
  liveLast: (at: string, app: string, title: string): string => `Last activity at ${at}: ${app}${title}`,
  dayHeader: (period: 'today' | 'yesterday', date: string): string => `📊 ${period === 'today' ? 'Today' : 'Yesterday'}, ${date}`,
  counted: (total: string): string => `Counted: ${total}`,
  NO_SELECTION: 'No categories are selected for tracking, so nothing is counted.',
  NO_APPS: 'No apps in the selected categories.',
  WEEK_HEADER: '📊 Last 7 days',
  noData: (label: string): string => `${label} — no data`,
  WEEK_NOTES: {today: 'today', partial: 'incomplete'},
  weekTotal: (total: string, days: number, partial: boolean): string => `Total: ${total} over ${days} ${daysWord(days)} with data${partial ? PARTIAL : ''}.`,
  NO_WEEK_DATA: 'No data for this week.',
  AW_STATE: {
    ready: 'running', partial: 'incomplete data', stale: 'data is out of date', unavailable: 'unavailable',
    unsupported: 'categories are not set up', unknown: 'unknown',
  } satisfies Record<Health['awState'], string>,
  STATUS_TITLE: '💻 Laptop status',
  NEVER_SYNCED: 'Connection: the laptop has not synced yet',
  online: (time: string): string => `Connection: online, last sync at ${time}`,
  offline: (at: string): string => `Connection: offline since ${at}`,
  awLine: (state: string, reportError: boolean): string => `ActivityWatch: ${state}${reportError ? ' (report too large, latest data shown)' : ''}`,
  TODAY_NO_DATA: 'Today: no data',
  todayFree: (used: string, partial: string): string => `Today: ${used}${partial}, free use`,
  todayLimit: (used: string, limit: string, rest: string, partial: string): string => `Today: ${used} of ${limit}, ${rest}${partial}`,
  freeUseLine: (on: boolean): string => `Free use: ${on ? 'on until midnight' : 'off'}`,
  remindersLine: (suppressed: boolean): string => `Automatic reminders: ${suppressed ? 'off until midnight' : 'active'}`,

  reminderCreated: (kind: 'notify' | 'overlay', message: string, name: string, at: string | null): string =>
    `New reminder from ${q(name)}: ${reminderWhat(kind, message)}. Show: ${at === null ? 'now' : 'at ' + at}. Waiting for the laptop to confirm.`,
  reminderSkipped: (kind: 'notify' | 'overlay', message: string, name: string): string =>
    `A reminder from ${q(name)} was skipped because free use is on: ${reminderWhat(kind, message)}.`,
  clearing: (scope: 'manual' | 'all', name: string): string => scope === 'all' ?
    `${q(name)} is clearing all reminders and turning off limit warnings until midnight. Waiting for the laptop to confirm.` :
    `${q(name)} is clearing manual reminders. Waiting for the laptop to confirm.`,
  LATE_CLEAR: 'The reminder appeared on the laptop before the clear reached it (this does not mean it was read).',
  LATE_FREE: 'The reminder appeared on the laptop before free use reached it (this does not mean it was read).',
  DEADLINE: {execution_unconfirmed: 'Waiting for confirmation that it ran', delivery_unconfirmed: 'Could not confirm delivery',
    skipped: 'Timer skipped: free use', done: 'Command finished'},
  RECEIPT: {presented: 'Display confirmed (this does not mean it was read)', accepted: 'The laptop accepted the schedule',
    updated: 'Command state updated; display not confirmed'},
  receiptBatch: (changed: number, confirmed: number): string =>
    `Updated the state of ${changed} commands. Display confirmed: ${confirmed}. Display does not mean it was read.`,
  CLEAR_APPLIED: {manual: 'manual reminders canceled', all: 'all reminders canceled, limit warnings off until midnight'},
  settingsChangedBy: (name: string): string => `Settings changed by ${q(name)}.`,
  summaryEndtime: (enabled: boolean, localTime: string): string => ` Endtime: ${onOff(enabled)}, ${localTime}.`,
  summaryToday: (limit: string): string => ` Today's limit ${limit}.`,
  summaryDaily: (limit: string): string => ` Daily limit ${limit}.`,
  summaryCategories: (selection: string): string => ` Tracked categories: ${selection}.`,
  summaryFree: (enabled: boolean): string => enabled ? ' Free use on until midnight.' : ' Free use off.',
  summarySuppression: (enabled: boolean): string => enabled ? ' Automatic reminders off until midnight.' : ' Automatic reminders restored.',
  currentTime: (minutes: number, partial: boolean, through: string): string => ` Current time: ${measured(minutes, partial, through)}.`,
  used: (minutes: number, partial: boolean, through: string): string => `Used ${measured(minutes, partial, through)}.`,
  warning: (minutesLeft: number | null): string => minutesLeft === null ? 'Daily time is used up.' : `${minutesLeft} min or less left.`,
  endtimeReached: (localTime: string, date: string): string => `Endtime ${localTime} (${date}) has come; the reminder was shown on the laptop.`,
} satisfies typeof uk;
