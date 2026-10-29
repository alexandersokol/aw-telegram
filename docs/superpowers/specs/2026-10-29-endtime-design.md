# Endtime Design

Status: draft for owner approval, 2026-10-29.

## Intent

Add a recurring daily "endtime" policy for the laptop. It gives the laptop user
advance notice that the configured end of the day is approaching, then shows a
dismissible repeating overlay at the configured time. Authorized caregivers
control the policy through Telegram while the Windows companion evaluates it
locally so it continues to work without a network connection.

This amendment also corrects the original assumption that a laptop has exactly
two parents. A laptop may have from zero to ten active authorized
parents/caregivers.

## Goals

- Store one daily endtime in 24-hour `HH:MM` form using the existing
  Europe/Kyiv calendar and daylight-saving rules.
- Support `/endtime`, `/endtime status`, `/endtime set HH:MM`, `/endtime on`,
  and `/endtime off`, plus a button-driven flow under Telegram Settings.
- Warn the laptop user locally at 15, 10, and 5 minutes before endtime.
- At endtime, show a dismissible overlay that returns one minute after each
  dismissal until local midnight.
- Send one Telegram endtime alert to every currently authorized caregiver only
  after the companion confirms that the endtime overlay was actually shown.
- Reuse free-use mode and Clear-all suppression for endtime warnings, overlays,
  and the reached-endtime Telegram alert.
- Make newest-overlay-wins the common presentation rule: a newly due overlay
  replaces and permanently finishes the currently visible overlay.
- Support up to ten active authorized caregivers in pairing and recipient fan-out.

## Non-goals

- Different endtimes by weekday or date.
- Multiple endtimes per day, snoozing, grace periods, automatic shutdown,
  locking Windows, or proof that the laptop user read the overlay.
- Telegram alerts for the 15/10/5-minute warnings.
- Replaying an endtime missed while the companion was stopped, asleep, or
  otherwise unable to evaluate the policy.
- Per-caregiver endtime values; endtime is shared laptop policy.

## Anti-goals

- Do not turn endtime into a daily cloud-created manual action. Cloud delivery
  must not be required for local warnings or presentation.
- Do not send a clock-based Telegram alert when the laptop is offline. The
  backend must have a durable, authenticated companion receipt proving a fresh
  endtime presentation.
- Do not allow a replaced overlay to resume later as the same presentation.
- Do not let a time edit, restart, resume, or reconnect replay all missed warning
  thresholds or show a late overlay for an already missed day.

## Constraints and defaults

- A newly enrolled laptop has endtime disabled and a saved time of `21:00`.
- Time input is an exact zero-padded 24-hour value from `00:15` through `23:59`;
  seconds, earlier times, and locale-dependent forms are rejected. This keeps all
  three warning thresholds and the reached-time cycle within one local date.
- The policy follows `Europe/Kyiv`, matching all existing daily settings and
  reset behavior. The selected wall-clock time is resolved independently for
  each local date, including DST transitions.
- Endtime is one revisioned shared setting and must participate in the existing
  settings acknowledgement flow. Bot confirmations distinguish cloud-saved
  state from companion-applied state.
- All built-in laptop and Telegram text remains Ukrainian. Parent-authored text
  is not involved in automatic endtime messages.
- The active v2 contracts remain strict. Since v2 is the current in-development
  contract, update v2 on both sides together and migrate persisted settings that
  predate the new fields to the disabled/`21:00` default. Archived v1 remains
  unchanged.

## Chosen architecture

Extend the shared revisioned `Settings` value with an enabled flag and a local
time string plus a dedicated endtime generation counter. The generation advances
only when the effective enabled/time pair changes, so unrelated category/limit
edits cannot earn another endtime alert. Repeating an idempotent no-op command
does not create a new generation. Telegram settings mutations update this value; normal companion
sync persists and acknowledges it. The companion's planned offline policy and
scheduler calculate today's endtime, warning thresholds, suppression, overlay
state, and midnight cleanup.

Add a dedicated idempotent endtime presentation receipt to the v2 acknowledgement
union rather than disguising an automatic policy event as a manual action. The
receipt identifies the local date, settings revision, configured time, and actual
presentation timestamp. The backend validates it against the settings revision
known to the device, deduplicates by device/date/policy generation, and creates
one outbox event addressed to all active caregivers. A deliberate same-day time
change is a new settings generation and may produce another alert after its new
overlay is shown. Existing outbox retries, recipient authorization rechecks, and
current-policy suppression rechecks apply.

### Alternatives considered

1. **Shared settings plus local policy (chosen).** Correct offline behavior,
   natural settings status, and reuse of suppression/day-reset infrastructure.
2. **Daily cloud-created action.** Reuses action delivery but makes local policy
   depend on cloud scheduling and complicates missed/offline semantics.
3. **Companion-only configuration delivered as a special action.** Fewer settings
   changes but creates split-brain status and awkward acknowledgements.

The first approach was chosen because endtime is recurring laptop policy, not a
one-off reminder.

## Telegram behavior

`/endtime` and `/endtime status` are equivalent. Status shows the saved time,
enabled/disabled state, whether the current revision has been acknowledged by
the companion, and whether free use or Clear all currently suppresses automatic
reminders.

`/endtime set HH:MM` validates the exact format, saves the new time, and enables
endtime. `/endtime on` enables the saved time. `/endtime off` disables the policy
but retains the saved time. Set/on/off are shared laptop setting changes: confirm
the result to the issuer and send a coordination message to every other currently
authorized caregiver.

Telegram Settings contains an Endtime row showing its current state. Its submenu
offers status, enable/disable, and change-time actions with Back and Cancel behavior
consistent with the existing menu specification. Changing the time requires a
review/confirmation step before mutation.

## Daily evaluation

For each eligible local date, derive warning instants at endtime minus 15, 10,
and 5 minutes and the reached instant at endtime. A date is eligible only while
the setting is enabled and neither free use nor Clear-all suppression is active
for that date.

- During continuous operation, show each warning once.
- On start, resume, enabling, restoring, disabling free use, or changing the time
  before today's endtime, show at most the most urgent already-crossed warning.
  Later thresholds proceed normally. Persist threshold state so restart does not
  duplicate a warning already shown for the same settings revision/date.
- If the first eligible evaluation occurs strictly after today's endtime, skip
  that date. Do not show a late overlay or Telegram alert. Begin again tomorrow.
- Evaluation exactly at the configured minute is due, not late.
- Changing the time immediately removes any visible endtime overlay and cancels
  its pending recurrence. Reevaluate the replacement setting: a future time is
  scheduled, an already-passed time skips today, and a time inside the warning
  window emits only the most urgent applicable warning.
- Turning endtime off immediately removes its visible overlay and pending repeat.
  Turning it on follows the same eligibility/catch-up rules.

The local warnings use the existing companion-controlled notification card and
do not create Telegram events.

## Endtime overlay and Telegram receipt

At endtime, show a dismissible automatic overlay on the primary monitor. Dismissal
finishes that presentation instance and schedules the next instance for one minute
later. Continue until Europe/Kyiv midnight. Midnight removes a visible instance,
cancels recurrence, clears per-date warning/presentation state according to local
retention rules, and starts evaluation for the new date.

The first successfully shown endtime overlay for a date and settings generation
queues a durable receipt. The backend sends one Telegram alert to every caregiver
who is still authorized when delivery occurs. Repeated overlays from the same
generation never create additional Telegram alerts. Deliberately setting a later
endtime on the same date creates a new generation and may create a second alert
after the new overlay is shown. If presentation fails or is unconfirmed, do not
claim it was shown and do not send the endtime alert until a later instance has
confirmed presentation. If the companion was offline or asleep through endtime,
the date is skipped and produces no delayed receipt.

## Suppression

Free-use mode and Clear-all suppression silence all endtime warning cards,
endtime overlays, pending recurrences, and endtime Telegram receipts for their
active local date. Enabling either while an endtime overlay is visible removes it
immediately. The enabled flag and saved time are retained. Suppression is
retroactive for undelivered alerts: settings mutation cancels matching queued
endtime outbox work, and the delivery worker rechecks current suppression so a
receipt earned before suppression cannot be sent afterward. A Telegram request
already accepted by Telegram remains subject to the documented unavoidable
crash-after-send uncertainty.

Turning free use off or explicitly restoring reminders reevaluates the current
date. If endtime is still in the future, use the one-warning catch-up rule. If it
has passed, skip today. Clear-all suppression and free use remain independent:
ending one does not bypass the other.

## Overlay replacement rule

Replace the existing manual-before-automatic/FIFO blocking rule with one global
rule: whenever any overlay becomes due, it replaces the currently visible overlay
regardless of source. The displaced presentation is durably recorded as
`replaced`, is permanently finished, and never resumes. Replacement terminates an
entire manual repeating action and cancels its future occurrences. Endtime differs
because recurrence belongs to the still-active daily policy rather than to the
displaced presentation instance: a new endtime occurrence becomes due one minute
after an endtime instance is dismissed or replaced and, as the newest due overlay,
may replace whatever is visible then. Clear and suppression still take precedence
over presentation.

Notification cards and countdowns retain their separate slots and lifecycles.
Only overlays use the newest-wins rule.

## Caregiver cardinality amendment

Replace all product claims and implementation bounds of exactly/two parents with
zero to ten active authorized parents/caregivers per laptop. The eleventh concurrent
pairing fails without consuming its pairing key. Revocation frees a slot.

Shared command coordination goes to all other active caregivers; automatic
allowance and endtime alerts go to all active caregivers; per-caregiver preferences
such as hourly milestones remain independent. Requested reports remain private.
Recipient lists are snapshotted for durable event creation but authorization is
rechecked before Telegram delivery, so revoked recipients do not receive queued
messages. Update pairing transaction guards, active-parent validation, outbox
recipient bounds, emulator races, UI wording, pagination, cost estimates, and
end-to-end acceptance coverage to use the ten-caregiver boundary.

## Failure and recovery behavior

- Settings sync remains revisioned and idempotent; reordered responses cannot
  restore an older endtime.
- Local warning/overlay state survives companion restart for the current date,
  but restart after endtime skips the date rather than replaying it.
- A queued endtime receipt survives network failure and is retried through normal
  sync. Duplicate receipt delivery cannot create duplicate Telegram outbox events.
  Free use or Clear all may later suppress that receipt and cancel its unsent event.
- Telegram delivery remains honestly at-least-once under the already documented
  crash-after-send limitation.
- Clock or timezone changes trigger reevaluation. They may produce at most one
  applicable warning and must never turn a strictly missed endtime into a late
  overlay.
- A time edit while an endtime receipt is queued does not retract proof of an
  overlay that was already shown, but the event remains deduplicated for that
  local date/policy generation. A later generation may earn its own same-day alert.

## Documentation and plan impact

After approval, amend `README.md`, `docs/user-requirements.md`,
`docs/technical-design.md`, `docs/bot-navigation.md`,
`docs/companion-navigation.md`, `docs/enrollment-security.md`,
`docs/backend-delivery.md`, `docs/windows-handoff.md`, and
`docs/implementation-plan.md`. The implementation plan must add contract/settings
work to the prerequisite/amendment area, expand the completed pairing/backend
tasks with explicit follow-up amendments, add endtime Telegram/menu work to Task
7, and add local evaluation/presentation/recovery work plus newest-overlay-wins
tests to Task 8. Task 10 acceptance must cover ten-caregiver fan-out and endtime
offline/suppression/edit/replacement cases.

## Builder-owned details

- Exact Ukrainian wording for warning cards, overlay text, bot confirmations,
  status, and menus, following the existing tone and escaping rules.
- Internal field and type names, provided the wire representation remains strict
  and expresses enabled state, exact local time, and a bounded generation counter.
- SQLite table/index layout and bounded local retention for per-date endtime state.
- Exact deterministic receipt/outbox IDs, provided they include enough policy
  identity to deduplicate retries and distinguish a later valid policy generation.

