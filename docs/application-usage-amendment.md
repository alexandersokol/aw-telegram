# Application-name usage amendment

Status: authorized on 2026-10-27; contract/reader extension implemented on
2026-10-28, independent review approved. Task 5 storage/sync is now implemented and reviewed;
bot formatting remains pending.
This supersedes earlier category-only report and no-app-breakdown wording.
Application aggregates and pure projections exist; no user-facing usage formatter exists.

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

The active schema/domain/sync version is now v2. `contracts/v1` remains immutable
and rejects app fields. Active v2 rejects category-only days and v1 sync envelopes;
Task 4 enrollment/access endpoints retain their separate protocol v1.

- [x] Coordinated pre-release v2 cutover recorded. Task 5 must invalidate and
  recollect incompatible v1 report caches after pairing, preserving settings,
  credentials, command/receipt state and monotonic counters. No fake app rows or
  runtime negotiation/migration framework is provided.
- [x] Required `appLeafTotalsMs:[{app,categoryId,totalMs}]` uses the exact AW app
  identity, 1–256 Unicode scalars, and positive safe-integer durations. Each pair
  is unique, references one exact leaf and reconciles exactly. Limits: 1024 leaves,
  256 distinct apps, 4096 pairs. No historical timestamps, titles or URLs are stored.
- [x] Canonical v2/package schemas, Python/TS models, validators, selection helpers,
  shared fixtures and bundle checks updated together. Pure projections derive
  current totals/app rows without rewriting source settings revision. Scalar name
  ties sort identically across languages; ancestors/descendants count once.
- [x] Counting emits apps and leaves in the same conservative measured-span loop.
  Invalid identity/AFK evidence remains unknown, including invalid later overlaps;
  missing identity never becomes a fabricated `Unknown` app. Reader captures
  settings/rules used for the query and rejects detected category revision changes.
- [x] Focused regressions cover reconciliation, identity, selections, coverage,
  clipping, races, immutable v1, bounds and oversized dates. A pure minimal-envelope
  capacity preflight reports `report_capacity_exceeded` and retains the last valid
  summary. Cardinality ceilings do not guarantee 131072-byte body fit.
- [x] Independent aggregate review before Task 5 completed. Task 5 whole-date
  batching, sequential acknowledgment packing, durable sequence acceptance and
  legacy cache invalidation/recollection are implemented and independently reviewed;
  presentation/escaping and formatter review remain Task 7 work.

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
opacity. Mouse clicks pass through the countdown to the underlying app while it
stays on top. The fullscreen overlay's existing dim layer, layout, input behavior and
pending real-game acceptance gates are unchanged. Timer deadlines, IDs, replacement,
expiry, positioning and lifecycle keep their existing behavior.
