# Device sync/domain contract v2

This checkpoint defines JSON contracts, Python dataclasses, TypeScript types,
strict validators and pure time/invariant helpers. The AW adapter produces v2
daily aggregates. Storage/sync handlers and the scheduler remain pending; Task 4
enrollment/access uses its separate protocol v1. Schema validation cannot establish parent identity, private-chat status,
device scope, durable acceptance, clock honesty or retention enforcement in storage.

## Validation and wire scalars

All objects, including options, category records and receipts, reject unknown
fields. Validators do not coerce, trim, normalize, insert defaults or remove fields.
`validate_contract(name, value)` / `validateContract(name, value)` returns an equal
copy on success and raises an error without including message/title content on
failure. Supported names: `settings`, `day`, `live`, `action`, `ack`,
`cancellations`, `sync-request`, `sync-response`. The shared schema is definitions
only. Runtime semantic checks complement draft-07 JSON Schema shape checks.

| Value | Encoding |
|---|---|
| Schema version | Literal integer `1` on HTTP sync envelopes; unsupported versions fail. |
| Counter / duration | Integer `0..9007199254740991`; no negative values, booleans, unsafe integers, strings or coercion. Allowances have no smaller product maximum. |
| Instant | Real Gregorian UTC `YYYY-MM-DDTHH:mm:ss.SSSZ`, years `0001..9999`; exactly milliseconds, no offsets, leap seconds or implicit timezone. |
| Local date | Real Gregorian `YYYY-MM-DD`, years `1970..2099`, interpreted in `Europe/Kyiv`. |
| Telegram ID | Positive decimal string, no leading zeros, at most 20 digits; never a JavaScript number. Numeric shape does not authorize a chat. |
| Action / receipt ID | Lowercase UUID string; each receipt ID is stable across retries. |
| Text | Unicode scalar values; reject lone UTF-16 surrogates. Count scalars, not UTF-16 code units. Parent message 1–1000, title 0–1000, app 1–256. Null means unavailable identity. |

ID patterns use a portable absolute-end assertion rather than `$`, whose final-LF
behavior differs between Python and JavaScript regex engines. Trailing LF, CR and
CRLF are rejected on Telegram IDs, UUIDs and every UUID reference; raw JSON parsing
must preserve these strings unchanged before validation.

Defensive transport choices, not new product limits: paths have 1–16 segments of
1–256 scalars; 256 selected paths; 1024 leaf/catalog records; 100 offers, receipts,
acknowledged receipt IDs and explicit cancellation IDs per batch; seven summaries
with unique dates. Opaque rules revision is 1–128 scalars. A category ID allows
24625 scalars, enough for the worst JSON-escaped valid path (16×256 escaped scalars
plus quotes/commas/brackets). Decoded HTTP bodies are at most 128 KiB before JSON
parsing; receiving handlers must call `parse_json` / `parseJson` on raw UTF-8 input
before contract validation. Those parsers reject invalid UTF-8, duplicate decoded
object keys, nesting beyond 64, NaN/Infinity and fractional/exponent number notation.
Direct Python object validation also rejects integral floats; JavaScript cannot
distinguish `1.0` from `1` after parsing, so the raw parser enforces lexical parity.
Truncate original AW titles locally to the scalar cap; reject oversized wire data.

The date range stays within both pinned timezone databases' transition coverage
and leaves room for UTC conversion and next-date arithmetic. UTC instants have the
wider range so boundary day results remain valid.
Calendar helpers reject results outside the supported local-date range; retention
never silently returns fewer than seven dates. These are arithmetic bounds, not
permission to import ancient history.

## Categories and settings

`CategoryPath` is an exact segment array. Slashes, tildes, quotes, backslashes and
Unicode survive unchanged; joining segments with `/` loses identity. Normal
`CategoryRef` is `{id: compact JSON serialization of path, path: CategoryPath}`.
Uncategorized is exactly `{id:"uncategorized", path:null}` and cannot collide with
normal IDs. Do not substitute a translated label or a normal `['uncategorized']`
path. Catalogs expose references, never AW regex/URL rules.

`Settings` fields: `revision`, `selectedPaths`, `selectedUncategorized`,
`defaultLimitMs`, `todayOverride:{date,limitMs}|null`, `freeUseDate:null|date`,
`suppressedDate:null|date`. Domain defaults are revision 0, no selected paths,
uncategorized false, 14400000 ms and null date-scoped settings. Every field is
explicit on the wire. Empty selection counts nothing. Ancestor selections compare
segments; overlapping selected ancestors include each disjoint leaf once.

Cloud settings revisions are durable. Later transactional handlers must increment
with overflow rejection, apply date-scoped values only on their Kyiv date, and clear
today's override when changing the recurring allowance. Free use and suppression
are independent; restore clears suppression only. Older settings must not replace
newer cached settings. Personal hourly-update preferences are separate parent state.

## Summaries and latest live state

`DaySummary` fields: `date`, `leafTotalsMs:[{category,totalMs}]`,
`appLeafTotalsMs:[{app,categoryId,totalMs}]`, `totalActiveMs`,
`selectedTotalMs`, `settingsRevision`, `rulesRevision`, `availableFrom`,
`availableThrough`, `partial`, `sequence`. Leaf category IDs are unique;
`totalActiveMs` equals their disjoint sum; selected total is between zero and active.
Both coverage endpoints are null or both non-null. Null/null requires partial true,
empty leaves and zero totals; it means unknown, not measured zero. Non-null coverage
lies within the actual Kyiv day, from ≤ through, and bounds the total counted time.
Spring/fall days can be 23/25 hours. Coverage is half-open; endpoints do not prove
continuous coverage, so partial can remain true despite broad endpoints.

The authenticated server must enforce today plus six earlier Kyiv dates, reject
days wholly before collection start, and clip known coverage to collection start
and current time. `validate_activity_context` / `validateActivityContext` expresses
these pure invariants for later handlers; it does not read or enforce a database.
Snapshots replace by a durable sequence independently per date. A stale
`settingsRevision` does not invalidate useful leaf totals: recompute selected total
with current settings using `selected_total` / `selectedTotal`, and record the
revision used. Shape validation cannot verify a selected total without those settings.
Active v2 requires positive safe-integer milliseconds per exact `(app, categoryId)`
pair, no duplicates/orphans, at most 256 distinct apps and 4096 pairs. Every row
references an existing leaf; app rows for each leaf sum exactly to its duration.
The exact AW app value has 1–256 Unicode scalars: no trimming, normalization,
case folding or truncation. Parent and child category paths may both be disjoint
assignments; they are never inclusive rollups. Historical title/event/URL fields
remain forbidden. Missing/invalid app identity contributes no duration and marks
coverage partial/unknown; an actual app named `Unknown` is a distinct real identity.

`selected_app_totals` / `selectedAppTotals` uses the same selection union as leaf
totals, returning descending durations with Unicode scalar name ties. `project_day`
/ `projectDay` recalculates both projections from unfiltered evidence and returns
`sourceSettingsRevision`, current `settingsRevision`, `selectedTotalMs`, and
`appTotalsMs` without rewriting the source. A matching settings revision validates
the stored selected total; changed selections never reuse filtered app totals.

The coordinated pre-release cutover preserves immutable `contracts/v1`, rejects
v1 sync envelopes and category-only days, and never defaults missing app rows.
Task 5 must invalidate/recollect v1 report caches/outbox days after the immutable
pairing cutoff while preserving settings, credentials, commands/receipts and
monotonic counters. No storage migration or runtime compatibility framework exists.
`ensure_report_capacity` / `ensureReportCapacity` checks one whole day in a minimal
v2 envelope (maximum sequence width by default); the reader reports
`report_capacity_exceeded` and keeps its last valid summary on a cardinality or
byte failure. Cardinality ceilings do not guarantee byte fit. Task 5 must pack
whole dates and acknowledgments sequentially within the actual 131072-byte UTF-8
body, never split/trim day rows. See the [extension checkpoint](application-usage-amendment.md).

`LiveState` fields: `observedAt`, `state:active|afk|unknown`, nullable `app`, `title`,
`category`, `rulesRevision`, plus `categoryCatalog`. Unknown clears all four
identity/rules fields to null. AFK identity may remain but never counts active.
Missing `live` means no update. Explicit unknown clears previous identity. Freshness
uses the original observedAt; upload arrival does not refresh an old observation.
Later storage writes only live/current and overwrites its title in place; no title
history, audit copy, receipt body or outbox body is permitted.

## Manual actions, receipts and cancellation

`Action` fields: `id`, cloud-supplied `actorId`, `kind:notify|overlay`, `createdAt`,
`targetAt`, `expiresAt`, `options`, `sequence`, `settingsRevision`. Immediate target
equals creation and expires exactly 60 seconds later. Delayed target is 1–1439
whole minutes after creation and expires five seconds after target. Timestamps are
original and never restart on delivery/retry. A future timer's execution deadline
is distinct from delivery-offer bookkeeping. Server-only offer count/time metadata
does not belong in the companion's action input.

Every options variant requires `message` and explicit `countdown:boolean`.
Notify has only those fields; its card lifetime is 10 seconds. Overlay options are
either `dismissible:true, repeatEveryMinutes:1..1439|null` (null means once), or
`dismissible:false, durationSeconds:1..3600`. Buttonless duration is mandatory;
buttonless repeat and dismissible duration are rejected. No arbitrary executable,
shell, URL, recipient or monitor options exist.

`Ack` has three closed variants:

- Settings: `{id,kind:"settings",revision,appliedAt}`.
- Cancellation: `{id,kind:"cancellation",revision,throughActionSequence,appliedAt}`.
- Action: `{id,kind:"action",actionId,eventSequence,occurrence,status,at,acceptedAt,presentedAt,reason}`.

Action event sequence is durable per action. Occurrence 0 is initial presentation;
positive occurrences are later repeats. Receipt ID deduplicates retry while event
sequence orders receipts. Action status is accepted/presenting/presented/dismissed/
completed/replaced/expired/skipped/canceled/failed/unconfirmed. Reasons are closed:
display_busy, free_use, missed_deadline, canceled, replaced, presentation_blocked,
presentation_failed, crash_during_presentation; incompatible status/reason pairs fail.

`acceptedAt` is nullable only for never-accepted initial expired/skipped/canceled/
failed rejection receipts. It is required for accepted/presenting/presented/
dismissed/completed/replaced/unconfirmed and whenever presentedAt is non-null.
Acceptance must be persisted before acknowledging. Receipt event time cannot
precede acceptance; confirmed presentation lies between acceptance and event time.
`presented` requires presentedAt; accepted/presenting/expired/skipped/unconfirmed
must not claim it. Dismissed/completed/replaced may retain null presentedAt: local
widget lifecycle is not proof of native visibility. Canceled/failed may retain
earlier confirmed presentation. The backend must never describe null-evidence
dismissal or completion as confirmed display.

`validate_action_receipt` / `validateActionReceipt` also checks action identity,
original acceptance window, event time after creation and initial presentation
window. Immediate presentation begins strictly before expiry; delayed presentation
may begin through target+5s. Only configured repeating dismissible overlays can
have later occurrences, and confirmed repeated presentations must be before the
target day's Kyiv midnight. Repeat interval scheduling, event transitions, durable
receipt ordering and actual UI visibility belong to later tasks. This helper accepts
late arrival of timely offline evidence; arrival time is deliberately not its input.
Signed-in-device authentication is not a trusted-clock or tamper-resistance proof.

Cloud delivery and execution observations are separate. Silence after accepting a
timer means execution_unconfirmed, not proven expiry. An accepted offline timer
remains eligible locally until its original deadline; waking too late expires it
without display. A timely valid receipt can correct previous cloud uncertainty on
reconnect. Never reoffer expired commands to obtain confirmation. Persist presenting
before calling UI; a crash during presentation remains unconfirmed without replay.
Repeated occurrences may be after original expiry and must not be tested against
the initial deadline. Repetition ends at Kyiv midnight and does not accumulate.

`Cancellations:{revision,throughActionSequence,canceledIds}` combines a durable
monotonic clear fence and targeted IDs. `action_canceled` / `actionCanceled` tests
action sequence ≤ fence or explicit ID membership. Settings, snapshot, action,
cancellation and sync counters are different streams; receipt IDs are different
from action IDs. Clear applies fences before offers in one local transaction,
preserves the greatest durable revision/fence across reordered responses, and
retains targeted IDs until their action retention boundary (paginate above batch
cap). New actions beyond a fence survive. Restore does not roll back fences.
Cancellation ACK means local clearing completed, separately from cloud acceptance
of a clear request. These state transitions are requirements for Tasks 5/6/8.

## Sync and immutable collection start

`SyncRequest:{schemaVersion:2,sequence,summaries?,live?,acks}` has no credential,
device/recipient ID, settings mutation, cloud path or collectionStartedAt. Authenticate
the bearer outside JSON. Device scope comes from authentication, never the payload.

`SyncResponse:{schemaVersion:2,requestSequence,serverNow,collectionStartedAt,
settings,cancellations,deliveryOffers,acknowledgedAckIds}` correlates transport
requests independently of each state stream. Acknowledged receipt IDs confirm
durably committed receipts; a successful HTTP status alone must not clear pending
receipts. Replay stable IDs idempotently. Older request sequence must not discard a
useful newer action receipt. Apply settings/fences/accepted actions/receipt removal
transactionally. Make at most three immediate offers, at least 20 seconds apart,
before expiry; no offer metadata is controlled by the companion.

Before first parent pairing, collectionStartedAt is null: no AW collection, summaries
or live uploads; heartbeat/settings/control exchange may continue. Cloud sets the
first non-null value once, at successful parent pairing. Persist it before collection.
Restart, parent revocation/replacement and re-pairing never change or clear it.
`collection_start` / `collectionStart` rejects a changed non-null value or later null;
the caller must preserve cached state when rejecting inconsistent/stale responses.
A newly enrolled device identity is a separate boundary. The helper does not itself
persist anything or prove pairing happened. Authenticated transactions must enforce
this invariant. Enrollment time is never a substitute for collection start.

## Calendar helpers, packaging and verification

Python `local_day_bounds(date)` returns aware UTC datetimes. TypeScript
`dayBounds(date)` returns `{start,end}` canonical UTC strings. Both expose Kyiv date,
seven retained dates, retention start and canonical parse/format helpers. Python uses
zoneinfo loaded explicitly from pinned tzdata; Node uses pinned moment-timezone with
its bundled IANA database. Construct each midnight in Europe/Kyiv separately;
never add 24 hours or subtract 168 hours. Local short waits later use monotonic time;
UTC deadlines remain authoritative after wake or wall-clock correction.

Both pinned timezone databases are IANA 2025b: Python tzdata 2025.2 and Node
moment-timezone 0.6.0. This is a deliberately matched data revision, not a claim
to use the latest tzdb. A probe found moment's packed transitions end in 2499;
year 3000 summer returned 22:00Z while Python's continuing rules returned 21:00Z.
The supported local-date range is therefore defensively 1970–2099, superseding
the initial broader proposal. Fixtures verify the 1970 conversion boundary,
2099 summer and rejection beyond the range; unsupported dates fail explicitly.

Schemas are generated by `python contracts/generate_schemas.py`; the companion
includes the same JSON assets as package data. `npm run build` copies canonical
schemas into bot/dist/schemas, so deployment needs no contracts directory outside
the bot package. `npm run check:bundle` loads an isolated compiled copy and checks
validation/time behavior. Evaluation is a domain result type only. Python re-exports
the existing windows.foreground.PresentationResult; no new HTTP result schema or
scheduler was added.

Run companion `python -m pytest` and bot `npm test`, `npm run build`,
`npm run check:bundle`. Exact dependencies are local to companion/requirements.lock
and bot/package-lock.json. npm's local .npmrc records the optional-peer resolver
workaround needed by npm 10.9.2; no global packages/configuration are required.
Shared fixtures cover DST, retention edges, exact path escaping/selection,
unavailable versus measured zero, strict fields/scalars, buttonless duration,
never-accepted terminal receipts, late offline evidence, repeats and cancellation.
