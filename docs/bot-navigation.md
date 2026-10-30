# Bot buttons and navigation

Status: base navigation and reminder flow recorded 2026-10-27; Endtime Settings
flow approved 2026-10-29. This is a user-interface specification, not implemented
behavior. Built-in text is Ukrainian or English per caregiver (LANG-01, Task 11f); the
examples here are the Ukrainian copy. See user-requirements.md for timing,
privacy, pairing, and delivery rules.

## General behavior

- Private chats only; unpaired users receive pairing instructions.
- `/start` shows the main menu after pairing.
- A reply without buttons carries «🏠 Головне меню» (UX-02), which opens the main menu in
  place of that message. Pop-up notices, pairing texts, the farewell after `/unpair` and
  notifications stay without it.
- A save reply says only what was saved («Збережено: …»), plus «Ноутбук зараз не на
  зв’язку — застосується, коли він увімкнеться.» when the laptop has not synced for
  2 minutes. The author learns that the laptop applied it from «✅ Ноутбук застосував: …»
  (UX-03).
- Each submenu provides «← Назад»; unfinished input flows provide «Скасувати».
- Canceling an unfinished flow does not submit a laptop command.
- Report requests stay private. Shared-laptop actions and settings changes notify
  every other active caregiver, with accurate pending/acknowledged/completed status.
- Show an action summary before submission, explaining the effects of shared
  settings changes. Free-use mode blocks reminder creation with an explanation.

## Main menu

```text
[ 📊 Використання ] [ 💻 Стан ноутбука ]
[ 💬 Нагадування ] [ ⏱ Ліміт часу     ]
[ ⚙️ Налаштування ]
```

### Usage

```text
[ Сьогодні ] [ Учора ] [ Останні 7 днів ]
[ ← Назад ]
```

Today/yesterday show AW application names and durations sorted by usage as formatted
text. Count exactly selected allowance categories plus descendants once, with
uncategorized only by explicit opt-in. An app contributes only selected intervals;
complete rows sum to the selected total. Missing data is partial/unknown. The
seven-day report keeps daily totals, with today last; no graphs or historical
window titles. Today includes the current/last-known app and latest title. Show
freshness and dates. Category edits recompute app rows from category-attributed
daily app aggregates. See [application-usage-amendment.md](application-usage-amendment.md)
for the implemented v2 contract/reader prerequisite (independent review pending).
Task 5 storage/sync and this Task 7 formatter/navigation remain unimplemented.

### Laptop status

Show connectivity, last synchronization, current/last app and title, counted
usage, remaining allowance, free-use mode, and automatic-reminder suppression.

```text
[ 🔄 Оновити ] [ ← Назад ]
```

### Daily allowance

Show today's effective allowance, recurring default, selected categories, and usage.

```text
[ Змінити на сьогодні ]
[ Змінити щоденний ліміт ]
[ Категорії ]
[ Увімкнути вільний режим ]
[ ← Назад ]
```

When free use is enabled, replace its button with «Вимкнути вільний режим».
Explain that changing the recurring default updates today and future days.
Categories lists selected entries and offers «Додати» / «Видалити», with pagination
when needed. Category selections include descendants and do not double-count.

### Settings

```text
[ Щогодинні звіти: увімкнено/вимкнено ]
[ Час завершення: вимкнено/21:00 ]
[ 🌐 Мова: Українська ]
[ Допомога ]
[ 🚪 Відключитися ]
[ ← Назад ]
```

Hourly updates and the language are per parent. The language row reads
"🌐 Language: English" in English; it opens «🌐 Оберіть мову бота:» with «Українська»,
"English" and «← Назад». A choice saves it for that caregiver only (no coordination
message) and returns to Settings in the chosen language, prefixed «Мову бота змінено:
українська.» / "Bot language changed: English.". `/language uk` and `/language en` do the
same; a bare `/language` shows the choice. Named pairing-key creation,
listing, and revocation stay in the companion app.

### Endtime

The Endtime row opens a status and editing submenu. `/endtime` and
`/endtime status` render the same status; `/endtime set HH:MM`, `/endtime on`,
and `/endtime off` provide the direct command equivalents.

```text
🌙 Час завершення

Стан: вимкнено
Збережений час: 21:00
Ноутбук: очікує застосування / застосовано

[ Увімкнути ]
[ Змінити час ]
[ ← Назад ]
```

When enabled, replace «Увімкнути» with «Вимкнути». Changing the time accepts
exact `HH:MM` from `00:15` through `23:59`, shows a review, and enables endtime
on confirmation. Status also identifies active free-use or Clear-all suppression.
Confirm saved state separately from companion acknowledgement and notify every
other active caregiver of set/on/off changes.

## Reminder menu

```text
💬 Нагадування

Надішліть повідомлення на ноутбук або
перегляньте активні й заплановані нагадування.

[ 🔔 Сповіщення ]
[ 🖥 Повідомлення на екрані ]
[ 📋 Активні та заплановані ]
[ 🧹 Очистити… ]
[ ← Назад ]
```

### Creating an overlay

1. Select «🖥 Повідомлення на екрані».
2. Prompt «Введіть текст повідомлення:», with «Скасувати».
3. After text entry, prompt «Коли показати повідомлення?» with «Зараз», «Через…»,
   and «Скасувати».
4. For «Через…», request the delay in minutes, then ask whether to show a countdown
   in the top-left corner, using «Так» / «Ні».
5. Show a review with message, delay and destination time, countdown state,
   dismiss-button state, and repetition state. Default: dismissible, shown once.

Example review (times are illustrative):

```text
🖥 Повідомлення на екрані

Текст: Завершуй гру, будь ласка.
Показати: через 15 хвилин, о 18:45
Зворотний відлік: увімкнено
Кнопка закриття: є
Повторення: немає

[ ✅ Запланувати ]
[ ⚙️ Додаткові параметри ]
[ Скасувати ]
```

For immediate actions use «✅ Надіслати» rather than «Запланувати».

Advanced options:

```text
[ Показати один раз ✓ ]
[ Повторювати після закриття ]
[ Без кнопки закриття ]
[ ← Назад ]
```

- Show once is the default. Dismissal completes the action.
- Repeat asks for the interval in minutes after dismissal. Stop and remove any
  visible instance at midnight Europe/Kyiv, or earlier if cleared/suppressed.
- Without a dismiss button is an explicit special option requiring a positive
  display duration. Auto-remove at the end; parents can clear earlier. It is not
  combined with repetition and is never a default.
- Return to review after changing options. Options do not submit the action.

### Creating an ordinary desktop notification

Use the same text, timing, optional countdown, review, and submit flow, without
manual-overlay repetition or dismiss-button options.

### Submission and delivery feedback

Use status based on actual evidence, not optimistic assumptions.

Acknowledged schedule:

```text
✅ Нагадування заплановано на 18:45.
Ноутбук підтвердив отримання.
```

Not yet acknowledged:

```text
⏳ Запит збережено. Очікуємо підтвердження
від ноутбука.
```

Overlay presentation acknowledged:

```text
🖥 Ноутбук підтвердив показ повідомлення:
«Завершуй гру, будь ласка.»
```

Presentation does not prove reading. For ordinary OS notifications, report
submission to Windows if visibility cannot be confirmed. Report failures/expiry
accurately. Notify every other active caregiver of the requesting caregiver's identity, message,
schedule, and status. Retries must not create duplicate actions.

### Active and scheduled list

Show current action status, message, scheduled time, countdown, repeat interval,
and midnight end boundary where relevant. Example:

```text
📋 Активні та заплановані

1. 🖥 Завершуй гру, будь ласка.
   Заплановано на 18:45 · відлік увімкнено

2. 🖥 Час зробити перерву
   Повторення через 2 хв після закриття
   Діє до опівночі

[ 🔄 Оновити ]
[ 🧹 Очистити… ]
[ ← Назад ]
```

Individual action cancellation has not been agreed; the current scope offers
manual/all clearing.

### Clearing

```text
Що очистити?

[ Лише ручні ]
[ Усі нагадування ]
[ ← Назад ]
```

Manual scope cancels pending/active manual notifications, overlays, and countdowns.
All scope additionally suppresses automatic allowance reminders until midnight.
Show a confirmation for all scope:

```text
Скасувати всі активні та заплановані
нагадування й вимкнути попередження
про денний ліміт до опівночі?

Облік часу та щогодинні звіти продовжаться.

[ ✅ Очистити всі ]
[ Скасувати ]
```

### Reminder creation during free use

Immediately explain that the reminder is skipped, without queuing it:

```text
ℹ️ Увімкнено вільний режим до опівночі.
Це нагадування буде пропущено.

[ Перейти до ліміту часу ]
[ ← Назад ]
```

Existing timers retain their original deadlines. Timers due during free use are
skipped; timers due after free use ends remain eligible. Hourly usage updates,
reports, and command/status messages remain available.

## Open interaction details

- Use preset minute buttons (5 / 10 / 15 / 30 хв) plus «Інший час» for
  custom numeric input. All laptop presentation targets the primary monitor only.
- Final input bounds, validation text, pagination size, and exact keyboard
  implementation remain design details.

## Explicit restoration after clearing all

When automatic allowance reminders are suppressed by Clear all, show
«Відновити нагадування» in the daily-allowance menu. It removes Clear-all
suppression without recreating canceled manual actions. Evaluate today's usage
when reminders become enabled. Free-use mode is separate: if still enabled,
explain that reminders remain paused until it is disabled. Allowance/category
edits and disabling free use do not silently undo Clear-all suppression.
Notify every other active caregiver of restoration.

## Endtime automatic messages

The 15/10/5-minute endtime warnings are laptop-only. At the configured time, the
companion shows the endtime overlay. Only a durable receipt confirming actual
presentation creates one Telegram alert to all currently authorized caregivers
for that date/settings generation. Repeating instances do not send more alerts;
a deliberate same-day reschedule may earn a new alert. Free use or Clear all
cancels undelivered endtime alerts as well as local warning/presentation behavior.
