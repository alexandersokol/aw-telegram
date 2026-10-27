# User requirements

Status: user requirements established through discussion on 2026-10-27.
Later explicit decisions supersede earlier proposals; technical defaults are
listed separately in technical-design.md for review.
No application implementation has started.

## Purpose and initial scope

Let two parents review their son's Windows laptop activity and manage time
reminders through Telegram, including when the laptop is unavailable.

The initial scope is one Windows laptop with ActivityWatch. Android, Family Link,
and combined allowances across devices are outside this version. Use existing
ActivityWatch APIs through a separate companion; no ActivityWatch changes are
currently expected. Prefer Firebase and free hosting.

## Requested functions

### Access and pairing

- ACCESS-01: Support the bot in individual private chats only. Group chats are
  outside scope and must not provide reports or accept control commands.
- ACCESS-02: Pair a computer with authorized bot users using a security key.
  Each parent pairs in their own private chat using the companion-generated
  named keys specified below; group authorization is outside scope.
- ACCESS-03: Only the two authorized parents may access this family's data or
  issue control commands. Starting a chat with the bot must not itself grant access.

### Reports

- REPORT-01: Show time per category, sorted by time spent, highest first.
- REPORT-02: Per-application usage breakdowns are outside the first version.
  The current/last-known app remains part of today's report and status.
- REPORT-03: Present reports as readable, formatted Telegram text only.
  Graphs, generated images, and per-application report options are outside scope.
- REPORT-04: Offer only today (the default), yesterday, and the last seven
  calendar days including today. The week report supports an overall summary
  and a daily breakdown, with today as the final day. Arbitrary dates and other
  historical periods are outside scope.
- REPORT-05: Include the currently active application when available, otherwise
  identify the last active application and its timestamp.
- REPORT-06: Reports remain accessible while the laptop is off, using regularly
  synchronized data stored in Firestore. Indicate how fresh that data is and
  distinguish last-known activity from live activity.

### Messages, overlays, and timers

- REMIND-01: Let an authorized parent send a custom desktop notification.
- REMIND-02: Let an authorized parent send a custom screen overlay.
- REMIND-03: Schedule a notification or overlay after a delay specified in minutes.
- REMIND-04: Optionally show a countdown in the top-left corner for a delayed action.
- REMIND-05: Notify parents in Telegram when the companion reports that a
  notification or overlay was shown, using the status distinctions below:
  an OS notification accepted for delivery does not prove visible presentation
  or that the child read it.
- REMIND-06: Let parents clear all pending and currently active notifications,
  overlays, and associated timers under the companion's control, using the
  manual/all scopes specified in CANCEL-01.

### Daily allowance

- LIMIT-01: Provide a daily allowance of four hours by default.
- LIMIT-02: Apply the allowance to a selected combination of categories, e.g.
  Games + Media share four hours rather than receiving four hours each.
- LIMIT-03: Show laptop warnings with 15, 10, and 5 minutes remaining.
- LIMIT-04: At expiry, show a default overlay asking the child to turn off the
  computer. Automatic shutdown or enforced locking has not been requested here.
- LIMIT-05: Notify both paired parents through Telegram at 15, 10, and 5 minutes
  remaining and when the daily allowance expires. Free-use mode and today's
  automatic-reminder suppression silence these alerts; hourly milestone
  preferences do not affect allowance alerts.
- LIMIT-06: Let parents change the allowance for today only or change the
  recurring daily default. Changing the recurring default also updates today's
  effective allowance, replacing any today-only override. A today-only change
  leaves the recurring default unchanged and expires at the daily reset.

## Supporting behavior and design proposals

- USAGE-01: Reports, hourly milestones, and the daily allowance count active
  foreground-application usage only, excluding time ActivityWatch marks as AFK.
  Background applications do not add usage.
- USAGE-02: Selected allowance categories include all their subcategories.
  Count each moment at most once toward the combined allowance and its hourly
  milestones, even when both a parent category and its descendant are selected.
- TIME-01: Daily usage and allowances use calendar days in Europe/Kyiv and reset
  at local midnight, following that timezone's daylight-saving rules. Free-use
  mode, today-only allowance changes, and today's automatic-reminder suppression
  end at that boundary. Show report dates and timezone.
- TIME-02: The week report covers seven local calendar dates in Europe/Kyiv:
  the six preceding dates plus today, from midnight six days ago through the
  latest available data today. Today is the last day and is marked as in progress.
  This is not a Monday–Sunday week or a rolling 168-hour interval. Always identify
  the report date range.
- PROPOSE-03: Run the companion automatically after Windows sign-in, recover
  after sleep/restart, and retain today's allowance and scheduled actions locally.
- PROPOSE-04: Continue known allowance warnings offline; synchronize missed data
  when connectivity returns. Telegram requests require network connectivity.
- PROPOSE-05: Give actions an ID, expiry time, and status: pending, accepted by
  companion, completed, failed, canceled, or expired. Retrying delivery must not
  create another timer or overlay. Presentation acknowledgement is not proof of reading.
- PROPOSE-06: Report laptop reachability, last contact, and ActivityWatch health
  separately; unavailable must not automatically mean powered off. Never interpret
  missing activity data as zero usage.
- PROPOSE-07: Keep raw events, window titles, and URLs on the laptop. Upload only
  category/app totals, necessary timestamps, current/last app, settings, and action
  status. Retention and latest-title exceptions are specified below; provide
  deletion and access revocation. Per-application historical totals are not uploaded.
- PROPOSE-08: Use an expiring, single-use pairing key and separate laptop credentials.
  Pairing authorizes the intended parent account only. Support revoking
  a parent or the laptop. Do not ship backend administrator credentials
  or the Telegram bot token to the laptop.
- PROPOSE-09: Give the child a visible remaining allowance and a clear explanation
  of each reminder. Provide a parent-controlled way to stop an overlay.
- PROPOSE-10: Provide Telegram buttons, help, current settings, and clear command
  confirmations so both parents can use the bot without memorizing commands.
- PROPOSE-11: Avoid repeated threshold alerts after restarts, retries, or refreshed
  summaries. Define when allowance edits should produce a new warning.

## Readiness for design

The main user-facing scope and navigation are sufficiently resolved to begin
technical design. Earlier questions are resolved by the explicit decisions below.
The owner approved the technical design and implementation plan on 2026-10-27.
Implementation has not started.

Technical choices, bounded retry/queue behavior, security contracts, and Windows
validation gates are now specified in [technical-design.md](technical-design.md).
The phased work is in [implementation-plan.md](implementation-plan.md). The owner approved these technical documents on 2026-10-27.

## Privacy and technical boundaries

Telegram and the hosting provider are part of the trust boundary. Telegram bot
messages are not end-to-end encrypted. Access controls cannot prevent an
authorized recipient from forwarding or photographing a report.

The discussed architecture uses Firebase HTTP functions, Firestore, and Telegram
webhooks. The companion uploads summaries and retrieves commands using authenticated
outbound requests; ActivityWatch is not exposed to the public internet. TypeScript
on Node.js for the backend and Python for the companion remain proposed choices.

A laptop cannot display a new remote message while off or disconnected. The bot
must distinguish a stored command from confirmed execution. A notification or
overlay is a reminder, not proof of attention or tamper-resistant enforcement.

## Clarifications agreed on 2026-10-27

This section supersedes conflicting proposals and open questions above; remaining
unspecified details are still open.

- TIMING-01: Delayed reminders use a destination timestamp (elapsed wall-clock
  time). If the laptop resumes before that time, continue the remaining countdown.
  If it resumes after that time, expire the action without showing the reminder.
  Exactly-at-deadline handling and a small execution tolerance remain design details.
- LIMIT-07: Reducing the allowance below time already used immediately makes the
  expiry overlay due. An unavailable laptop can act only when it reconnects;
  cached local rules continue to apply offline until a change is received.
- CANCEL-01: Clearing reminders accepts an explicit scope: manual only, or all
  (including automatic allowance reminders). Clearing all suppresses automatic
  allowance reminders on the laptop and in Telegram until the next daily reset.
  Clearing manual reminders only does not suppress automatic allowance reminders.
  Clearing does not yet have an agreed effect on the allowance itself.
- OVERLAY-01: The automatic daily-limit overlay can be dismissed with a button
  and reappears after one minute. Manual overlay behavior is configured separately
  as specified below.
- CATEGORY-01: Parents can add, remove, and list categories counted toward the
  shared daily allowance, with commands such as `/add-category`,
  `/remove-category`, and `/list-category`. These names express user intent;
  final Telegram command spelling remains a design detail.
- STATUS-01: Include connection status and reliable action status as proposed.
- OFFLINE-01: Support offline operation and recovery after restart as proposed.
- PRIVACY-01: Keep a single latest-known application's window title for display
  with the current/last active app. Do not retain a history of window titles.
  Other raw event details and URLs remain on the laptop. Retention/logging must
  avoid accidentally preserving previous titles, and Telegram replies containing
  titles remain in chat history independently of backend retention.
- UX-01: Provide buttons for common/frequent commands; less common commands may
  use typed commands or navigable menus. An exhaustive flat button list is not
  required.
- ACCESS-04: Use the companion-managed named pairing-key flow specified in
  PAIR-01 through PAIR-07.


## Additional scope decisions on 2026-10-27

These decisions supersede conflicting statements elsewhere in this draft.

### Private chats only

- ACCESS-05: Remove all group-chat functionality from this version. Both parents
  use separate private chats and obtain access through pairing codes. No group
  setup, invitations to groups, or group membership management is required.
- ACCESS-06: Reports and control commands must be rejected in groups, even when
  the sender is an otherwise authorized parent.

### Free-use mode for today

- FREE-01: Provide a command to enable free use for the current day. While enabled,
  skip all notifications and overlays, including manual/scheduled reminders,
  countdown displays, automatic daily-allowance reminders, and automatic Telegram
  reminder/allowance alerts. Reports and command confirmations remain available.
- FREE-02: Provide another command to turn free-use mode off and restore reminders.
- FREE-03: Free-use mode ends at the next daily reset and must survive companion
  restarts during the current day. The daily boundary is midnight in Europe/Kyiv.
- FREE-04: Previously pending or active reminders must not bypass free-use mode.
  Manual reminders due during free use are skipped, not deferred for replay.
  Timers scheduled before free use retain their original deadlines. If free use
  ends before a timer is due, it remains scheduled and can execute normally.
  If its deadline passes during free use, skip it without replay.
- FREE-05: A remote change takes effect on the laptop when received; the bot must
  distinguish saving the setting from the companion acknowledging it.

### Manual overlay options

- OVERLAY-02: Overlays have a dismiss button by default in every case. A manual
  overlay without a dismiss button is available only through an explicit special
  option; it must never be the default, including for automatic allowance overlays.
  Parents can set an automatic disappearance duration for this special option
  and cancel it earlier through Clear Notifications (manual or all scope).
  A positive automatic disappearance duration is mandatory; a buttonless
  overlay cannot be requested without one.
- OVERLAY-03: The default manual overlay has a dismiss button and shows once:
  dismissing it ends that action and it does not return. Repetition must be
  explicitly enabled by the parent; this does not change the automatic daily-limit
  overlay's one-minute repeat behavior.
- OVERLAY-04: With a dismiss button, also support a repeating overlay: after the
  child dismisses it, wait a parent-configured interval before showing it again.
  The interval starts at dismissal, not at the overlay's initial appearance.
  Repeating manual overlays end at the next midnight in Europe/Kyiv: remove
  any visible instance and cancel further repetitions, including after a restart.
- OVERLAY-05: The one-minute repeat rule applies to the automatic daily-limit
  overlay; it is not a mandatory repeat interval for manual overlays.

## Parent coordination agreed on 2026-10-27

- FREE-06: Free-use mode also silences automatic Telegram reminder and allowance
  warnings. It does not prevent hourly usage updates, requested reports, or
  command/status confirmations.
- COORD-01: When either authorized parent issues a command affecting the shared
  laptop, notify the other paired parent in their private chat. Include who issued
  it, which laptop it affects, the action/settings, and its status. This covers
  manual and delayed reminders, category/allowance changes, clearing reminders,
  and enabling/disabling free use. Such coordination messages remain enabled
  during free use.
- COORD-02: Distinguish a parent's request or saved setting from the companion's
  acknowledgement/execution. Do not tell the other parent that an action was
  displayed when it is only pending.
- COORD-03: Requested reports are private to the requesting parent. Do not send
  the report or a report-request notification to the other parent. Shared-laptop
  actions and settings changes still notify the other parent. Automatic usage
  milestones and allowance alerts follow their separately defined recipient rules.

## Usage milestones and Ukrainian interface

- MILESTONE-01: Offer automatic Telegram updates at cumulative hourly usage
  milestones, such as one hour spent, two hours spent, and so on. These are
  usage thresholds, not notifications at the top of each clock hour.
- MILESTONE-02: Each parent independently enables or disables milestone
  notifications through a bot command. Changing this personal preference does
  not change the other parent's notifications.
- MILESTONE-03: Send enabled milestone updates to each parent using the current
  day's selected-category totals. Hourly usage updates remain enabled during
  free-use mode and after clearing reminders, subject to each parent's own
  milestone preference. They are informational reports, not allowance reminders.
- MILESTONE-04: Avoid repeating the same milestone due to restarts or sync retries.
  Catch-up and enable-midday behavior are specified in MILESTONE-06 through 08.
- MILESTONE-05: Hourly milestones measure combined usage of the categories
  selected for the shared daily allowance, not all laptop usage. For example,
  Games + Media share the same cumulative milestone counter as the daily limit.
- LANG-01: All built-in bot and companion text is Ukrainian only, including
  replies, reports, menus, button labels, default notifications, overlays,
  countdown labels, errors, and confirmations. Remove English localization and
  language selection from this version.
- LANG-02: Command names remain unchanged and are not localized. Parent-authored
  messages, application names, category names, and window titles remain as entered
  or reported; no automatic translation is required.


## Resuming allowance reminders

- FREE-07: Tracking and report synchronization continue during free-use mode.
  Free use does not reset accumulated usage or change the configured allowance.
- FREE-08: Disabling free-use mode immediately resumes allowance reminders based
  on all counted usage accumulated that day, including usage during free use.
  If the allowance is already exhausted, show the daily-limit overlay as soon
  as the companion receives the change. Remote execution remains subject to
  laptop connectivity. This does not decide whether skipped manual actions replay.


## Reminder commands during free use

- FREE-09: If a parent requests an immediate or delayed manual notification or
  overlay while free-use mode is enabled, tell them immediately that free-use
  mode is on and the reminder will be skipped. Do not queue that command for
  execution after free use ends, and do not present it as successfully displayed.
- FREE-10: Skipped reminders are not replayed when free-use mode is disabled.
  The other parent receives the action/status notification under COORD-01,
  identifying that the request was skipped because of free-use mode.


## Report retention

- RETAIN-01: Keep seven calendar days (today plus the six preceding dates) of report history in the bot backend for this version.
  Use Europe/Kyiv date boundaries, retaining the entire earliest included date
  rather than a rolling 168-hour window. Remove older report data from cloud storage. This does not delete the original
  ActivityWatch history on the laptop or reports already sent into Telegram chats.
  The latest-known app title remains a single current value, not a seven-day title history.

- RETAIN-02: Start collecting bot report data at initial laptop pairing. Do not
  import ActivityWatch activity from before enrollment. Identify the first day as
  partial when enrollment occurs during the day; do not imply earlier usage was zero.
  Reconnection/restart still backfills activity missed after enrollment.


## Online responsiveness

- RESPONSE-01: While the laptop, ActivityWatch, and backend are available with
  working network connectivity, target report updates within one minute and
  delivery of immediate laptop commands within 30 seconds. These are normal
  operating targets, not guarantees during service/network failures.
- RESPONSE-02: Show last-update time and pending/failed status when freshness or
  delivery targets cannot be met. Do not imply an unavailable laptop executed a command.


## Hosting and cost

- HOST-01: Firebase Blaze billing is acceptable. Target operation within included
  free allowances and configure cost controls and usage monitoring during
  deployment. Do not promise a guaranteed zero bill; deployment and supporting
  services may have separate costs.


## Companion operation

- RUN-01: Start the companion automatically with Windows in the signed-in user's
  session, so notifications and overlays can appear on that user's desktop.
- RUN-02: Protection against deliberately stopping, disabling, or uninstalling the
  companion is outside the first version. Retain the agreed connection/status
  reporting, offline behavior, and restart recovery.

## Simplified reports and companion-managed pairing

These decisions supersede conflicting report command and enrollment proposals.

- CMD-USAGE-01: `/usage` defaults to `/usage today`.
- CMD-USAGE-02: `/usage today` shows today's usage by category, sorted by time
  spent, as formatted text, with the current/last-known app as previously specified.
- CMD-USAGE-03: `/usage week` shows usage for the last seven calendar days broken
  down by day, with today last, as formatted text. No separate `categories` or `days`
  command options are needed.
- CMD-USAGE-04: `/usage yesterday` shows the previous local calendar day's
  category usage, sorted by time spent, as formatted text. Per-application
  breakdowns are removed from scope. These three report periods are the complete
  usage command set; no graph options are provided.
- PAIR-01: Pairing keys are generated through the companion app. The parent
  chooses to create a key, enters a descriptive name (e.g. a parent's name), and
  receives a generated key for use in the Telegram private-chat pairing flow.
- PAIR-02: The companion shows a list of named keys/access entries and their
  pairing status. A name labels an entry; it does not itself authenticate anyone.
- PAIR-03: A parent can remove a key/access entry in the companion. Removing an
  unused key invalidates it; removing a paired entry revokes that Telegram
  account's access to this laptop after the backend receives the revocation.
  The interface must not claim remote revocation completed while offline.
- PAIR-04: Proposed security details: use an expiring, single-use key that binds
  to one Telegram user on successful pairing; do not display the original secret
  in the list after pairing. Keep the name and paired-account identity/status
  available for recognition. Unused-key expiry is specified in PAIR-06.
- PAIR-05: Each parent obtains their own named pairing key. Public self-service
  enrollment or group-chat access is not required.


## Bot navigation

The main menu, submenus, reminder creation/review flow, advanced overlay options,
status feedback, clearing confirmations, and free-use explanation are recorded
in [bot-navigation.md](bot-navigation.md). Time entry uses preset buttons plus
«Інший час» for custom input.

## Final interaction and edge-case decisions

- INPUT-01: Offer preset time buttons (5, 10, 15, and 30 minutes) plus «Інший час»
  for custom numeric input. Apply this pattern to minute-based time choices;
  special short display durations may use appropriate units in the detailed design.
- MILESTONE-06: When delayed synchronization crosses several hourly milestones,
  send one update with the latest total instead of replaying each missed milestone.
- MILESTONE-07: Enabling hourly updates midway through the day starts with the
  next milestone; do not replay previously crossed milestones.
- LIMIT-08: If changing the allowance crosses several warning thresholds, send
  one current-state warning instead of multiple outdated warnings. Existing
  free-use and automatic-reminder suppression rules still apply.
- USAGE-03: Show uncategorized activity in reports, but exclude it from the shared
  allowance unless the parent explicitly selects it as a counted category.
- DISPLAY-01: Show all overlays, countdowns, and requested laptop notifications
  on the primary monitor only. OS notification placement must be verified on
  Windows; use companion-controlled presentation if necessary to meet this rule.
- PAIR-06: Unused pairing keys expire 15 minutes after generation. A parent can
  generate a replacement in the companion.
- PAIR-07: Paired access does not expire due to inactivity in this version.
  Parents can revoke it by removing the paired entry in the companion.
  Inactivity-based expiration is deferred.

## Reminder suppression precedence

- SUPPRESS-01: Clear all suppresses automatic allowance reminders until midnight,
  independently of free-use mode. Changing allowance values or counted categories
  does not lift this suppression. Turning free-use mode off does not lift it either.
- SUPPRESS-02: Provide an explicit «Відновити нагадування» action to remove
  suppression created by Clear all. Evaluate today's accumulated usage immediately
  when automatic reminders become enabled; show the expiry overlay if exhausted.
- SUPPRESS-03: Automatic allowance reminders are enabled only when neither
  free-use mode nor Clear-all suppression is active. Restoring reminders does not
  implicitly disable free use; explain any remaining suppression to the parent.
- SUPPRESS-04: Restoring allowance reminders does not recreate manual actions
  canceled by clearing. Hourly updates remain governed by personal preferences.
- SUPPRESS-05: Notify the other parent when reminders are explicitly restored,
  just as for other shared-laptop setting changes.

## Automatic overlay activity gating

- LIMIT-09: After the allowance is exhausted, show/repeat the automatic daily-limit
  overlay only while the child actively uses an application in a counted category.
  Hide it and pause repetition when the child becomes AFK or switches to an
  uncounted category. Show it again upon active return to a counted category,
  subject to free-use and Clear-all suppression. Do not require dismissal of
  a stale visible overlay after switching to schoolwork.
- LIMIT-10: Manual overlays follow their own configured schedule and presentation
  options, independently of application category and AFK status. All previously
  agreed free-use, clearing, expiry, and midnight rules still apply.

## Category-selection changes

- CATEGORY-02: Adding or removing a counted category recalculates today's counted
  usage from all of today's collected activity, not just activity after the edit.
  Active-only filtering, descendant inclusion, and overlap deduplication apply.
  Initial enrollment still excludes activity from before pairing.
- CATEGORY-03: Evaluate the updated remaining allowance and automatic-overlay
  eligibility after recalculation. Preserve free-use/Clear-all suppression and
  notify the other parent of the category change.

## Milestones after category recalculation

- MILESTONE-08: After a counted-category selection change recalculates today's
  usage, send one updated-total message instead of replaying crossed hourly
  milestones. Continue with the next milestone above the recalculated total,
  without repeating hourly milestones already delivered to that parent today.
  Honor each parent's hourly-update preference for milestone messages; the shared
  category-change confirmation still reaches both parents under COORD-01 and can
  include the updated total to avoid duplicate messages.

## Immediate-command delivery retries

- DELIVERY-01: If an immediate notification/overlay cannot be delivered, retry
  briefly a limited number of times instead of retaining it for a later laptop
  session: make up to three delivery attempts within one minute, then stop.
  Notify the issuing parent if delivery still has no confirmation. Preserve the
  other parent's agreed action/status updates. Do not replay the expired action
  when the laptop reconnects later. The previously suggested five-minute
  lifetime is not used.
- DELIVERY-02: Retries refer to the same action ID and must not create duplicate
  presentations. If acknowledgement is missing, distinguish unconfirmed delivery
  from confirmed failure; do not claim certainty that nothing was shown.

- DELIVERY-03: Failure feedback must reach the parent who issued the command.
  If delivery is unconfirmed, say «Не вдалося підтвердити доставку» rather than
  asserting the message was never displayed. If the companion explicitly reports
  an execution failure, show that failure accurately. Stop further delivery
  attempts after the one-minute window and reject stale executions on the laptop.

## Companion local interface

- UI-PC-01: Provide a small companion window accessible through a Windows tray
  icon, with «Стан», «Доступ батьків», and «Налаштування» sections.
- UI-PC-02: Closing the window leaves the companion running in the tray. Background
  work and reminder presentation do not depend on keeping the window open.
- UI-PC-03: Show ActivityWatch/backend connectivity, last sync, remaining allowance,
  and active modes. Manage named pairing keys and paired access in the access
  section. Settings include ActivityWatch address, backend connection, and startup.
- UI-PC-04: See [companion-navigation.md](companion-navigation.md) for the agreed
  local navigation. No local permission boundary against deliberate changes by
  the child has been requested for this version.

## First-time setup

- SETUP-01: Deploy the Firebase backend once using documented deployment steps.
- SETUP-02: Generate a one-time laptop enrollment code through the deployment/setup
  process. Enter it in the companion to enroll the laptop with that backend.
  This code is distinct from parent Telegram pairing keys.
- SETUP-03: The companion connects to the backend and automatically checks the
  local ActivityWatch connection. Show actionable setup errors if either fails;
  allow adjusting the ActivityWatch address in settings.
- SETUP-04: Once enrolled, create named pairing keys in the companion for each
  parent and complete pairing in their respective Telegram private chats.
- SETUP-05: Never require Firebase administrator credentials or the Telegram bot
  token on the laptop. Exact enrollment-code lifetime, device credential exchange,
  and deployment implementation are technical-design details.

## Overlay visual design and interaction

- VISUAL-01: Cover the primary monitor with a see-through dark dimming layer.
  Keep the underlying application visible. Initial proposed appearance is black
  at 70% opacity; message text and controls remain fully opaque.
- VISUAL-02: Show large white text centered horizontally and vertically, wrapping
  long messages so they remain readable.
- VISUAL-03: For dismissible overlays, show «Закрити» centered horizontally near
  the bottom, with a comfortable margin from the screen edge.
- VISUAL-04: Capture mouse clicks across the overlay; do not pass them through
  to the underlying application/game. The dismiss control remains interactive.
  This does not introduce keyboard blocking, OS locking, or tamper resistance.
- VISUAL-05: The explicitly requested buttonless variant uses the same dimmed
  layout without a dismiss button and automatically disappears after its mandatory
  parent-specified duration. Parents may cancel it earlier through clearing.
- VISUAL-06: Preserve the previously agreed repeat, activity-gating, free-use,
  clearing, and primary-monitor rules. Verify fullscreen behavior on Windows.

## Fullscreen-game visibility requirement

- FULLSCREEN-01: Overlays must appear even while a fullscreen game is active on
  the laptop's primary monitor. Cover borderless fullscreen and investigate/test
  exclusive fullscreen explicitly; an ordinary always-on-top window alone must
  not be assumed sufficient.
- FULLSCREEN-02: Technical design must identify how visibility is achieved for
  exclusive fullscreen. Minimizing the game when necessary to display the
  overlay is explicitly permitted. Prefer displaying over the game when possible;
  validate the fallback on Windows rather than assuming focus changes succeed.
  If testing reveals unsupported modes, report the limitation rather than
  claiming the overlay was visible. Windows validation is required before
  declaring this requirement satisfied.
