# Application-name usage amendment

Status: requested and authorized on 2026-10-27; reporting extension pending.
This supersedes earlier category-only report and no-app-breakdown wording.
It does not claim that app reports, synchronization, or bot formatting exist.

## Required report behavior

`/usage` defaults to today. `/usage today` and `/usage yesterday` list application
names from ActivityWatch's foreground `app` value with durations, sorted by duration
descending. "Application titles" means these application names, never historical
window titles. Count exactly the categories selected for the shared allowance,
including their descendants once; uncategorized contributes only when explicitly
selected. Empty selection counts nothing. If an app spans selected and unselected
categories, include only its selected intervals. For complete measured data, app
row durations sum to the selected total. Missing data is explicitly partial/unknown,
never measured zero; do not invent an app identity to hide missing coverage.

Use foreground, not-AFK time only. Exclude background activity, companion-owned
foreground, and all activity before first successful parent pairing. Keep the
existing Europe/Kyiv boundaries, seven retained dates, freshness indicators, and
partial first-day behavior. `/usage week` remains daily totals across those seven
dates, today last/in progress, with the existing overall summary. Today and status
may show the single current/last-known app and latest window title with freshness;
yesterday and historical daily aggregates must never contain window-title history.

Category selection controls accounting, allowance and milestones independently
of the app-name display. An edit recalculates today's selected total and app rows
from all collected daily aggregates under the new selection. Do not recompute from
previously filtered app totals: that loses the app's unselected-category intervals.
Existing category-change, warning, suppression and milestone rules still apply.

## Mandatory extension checkpoint before Task 5 and Task 7

The current v1 `DaySummary`, JSON schemas, Python/TypeScript validators and AW
reader contain leaf-category totals only. Unknown fields are rejected, including
app fields in a daily summary. `bot/src` currently contains `contracts.ts` and
`clock.ts`; no usage formatter exists to fix. No contract or adapter code is
changed by this documentation amendment.

Before Task 5 persists/synchronizes reports or Task 7 implements `renderUsage`,
complete and review this extension to Tasks 2–3:

- [ ] Review and record a schema-version/compatibility decision. Decide whether
  to introduce a new version or a coordinated replacement of the current closed
  contract, including explicit handling of category-only persisted/wire snapshots.
  Do not silently accept app fields under the unchanged v1 validators or label
  older snapshots as complete app reports.
- [ ] Define daily application × disjoint leaf-category duration aggregates,
  alongside the existing leaf totals, as the preferred sufficient representation.
  Use the AW app value, exact category references and integer milliseconds; do not
  retain event timestamps, per-event records, historical window titles or URLs.
  Specify uniqueness, app identity validation and unavailable-identity/coverage
  semantics. Verify consistency of app aggregates, leaf totals and selected totals;
  complete measured data must reconcile exactly, otherwise report partial/unknown.
- [ ] Extend canonical schema generation, packaged schema assets, Python models
  and validation/selection helpers, TypeScript types/validators/helpers, and shared
  positive/negative fixtures together. Preserve rulesRevision, settingsRevision,
  sequence ordering per date, coverage intervals/partial flags, pairing clipping,
  strict unknown-field rejection, seven Kyiv dates and the 128 KiB raw UTF-8 JSON body
  bound. Review bounded app/category cardinality and batch sizing so an extension
  cannot silently truncate rows or exceed the transport cap.
- [ ] Extend AW counting/reader output using the same conservative disjoint
  foreground × not-AFK × category intervals used for leaf totals. Apply the same
  rules revision and evidence checks. Exercise app spanning selected/unselected
  leaves, overlapping parent/child selections, opt-in uncategorized, AFK/background
  exclusion, pre-pairing clipping, missing data and changed category selections.
- [ ] Validate cross-language fixtures for exact row/selected-total reconciliation,
  revision races, unknown identity/coverage, incompatible/legacy summaries,
  retained-date boundaries and payload-size failures. Review the checkpoint before
  dependent storage, sync or formatters proceed.

Task 5 must store and synchronize unfiltered category-attributed app aggregates,
recompute selected app rows and totals under current settings even for a stale
snapshot settings revision, and preserve sequence/rules/coverage checks. An app's
unselected-category duration must never leak into selected usage. Task 7 must test
descending names/durations, empty selections, escaping/pagination, partial/unknown
data and the sum invariant. Neither task may infer these rows from category totals
alone or claim the extension implemented merely because this document exists.

## Privacy and current timer change

Daily aggregated application names/durations and category attribution may be
retained locally and in cloud report summaries for the retained dates. Raw history,
per-event records, URLs and window-title history stay off the backend. Latest title
remains a single live value overwritten in place, excluded from daily snapshots,
durable outbox bodies, logs and title-revision history. Existing deletion/access
rules and Telegram/provider retention limitations continue to apply.

The top-left countdown now uses a #242424 background at 70% opacity (alpha 179)
and fully opaque white text. It uses per-pixel transparency, never whole-window
opacity. The fullscreen overlay's existing dim layer, layout, input behavior and
pending real-game acceptance gates are unchanged. Timer deadlines, IDs, replacement,
expiry, positioning and lifecycle keep their existing behavior.
