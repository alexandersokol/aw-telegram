# Durable sync checkpoint

Task 5 implementation and correction round passed independent review. No runtime is deployed or
started implicitly; Telegram delivery, policy, native UI and action execution remain
later tasks. Enrollment/access keeps Task 4 protocol v1, active sync is POST /v2/sync.

Python `LocalStore(path, now=..., identity=None)` owns a SQLite connection on its
creating IO thread. It provides `commit_day(candidate,collected_at)`, `prepare_request`,
`apply_sync(SyncResponse)`, `pending_acks()`, `projection(date)`, `prune`, and `close`.
The reader's sequence-zero candidate becomes a durable, increasing per-date source
before handoff. Unfiltered app/category evidence survives selection edits; current
projections preserve sourceSettingsRevision. Whole dates and stable receipts are
packed sequentially using exactly the UTF-8 serializer sent by Transport.

Schema 1 means the known pre-release table layout with incompatible report bodies.
Its migration clears those bodies/manifests and schedules recollection, preserving
public identity, immutable pairing start, settings, receipts, fences and counters.
Unknown layouts/newer schema versions fail closed. No existing production cache or
category-only conversion is assumed. Retention clears report data outside seven Kyiv
dates; control receipts, unknown canceled IDs and sequence counters survive. AW source
is never modified. SQLite/WAL never receives a title, raw event/history or wire body.

`Transport(...,identity=DeviceIdentity).sync(request)` loads the secret through the
Task 4 vault on each exchange. `CredentialError` stops authenticated retries until
recovery; `SyncError` exposes sanitized retry/backoff metadata. Socket timeouts and
body deadlines are bounded, but DNS/header/end-to-end time has no hard 10s guarantee.

`ReaderAdapter` turns trustworthy current reader output into `Observation(live,health)`.
Query completion clocks establish health; metadata probes do not establish activity
success. Synthetic unknown on failed/stale evidence becomes omitted live. A title-free
query-success watermark survives restart and failures. `SyncCoordinator.step(utc,mono)`
uses the same injected UTC clock as LocalStore for IO completion times. It serializes
10s polls, 30s sync (`SYNC_INTERVAL`, Task 11d) and 30s current-day queries, with due
control sync first and one historical date per bounded opportunity. A today summary whose
only change is `availableThrough` is committed (and so sent) at most every 60s
(`UNCHANGED_SUMMARY_INTERVAL`); another date, the first summary since start, one after a
failed sync or a requested recollection is never held. A summary held when the app exits is
dropped: the stored copy differs only by at most 60s of `availableThrough`, and the next
start commits a fresh summary at once. A receipt queued since the last sync
began (an accepted offer, a shown or closed message, an applied setting) is sent at the next
step instead; a receipt already sent and not acknowledged waits for the next regular sync,
and failures keep their 15s-based backoff. Midnight and multi-day wake schedule newly
closed retained dates. `IOWorker` starts/stops explicitly and constructs its store on
its own thread through a factory. An unexpected step failure is counted and retried
after five seconds instead of ending background sync; a store that cannot open sets
`startup_failed`. `runtime.CompanionRuntime` (Task 8c) pairs it with the GUI-thread
presenter on a second connection and queues a presenter tick after each committed sync.

Cloud bound facades are `DeviceApi(repository,clock).syncDevice(identity,input)` and
`SettingsService(repository,clock).updateSettings(identity,change,callback?)` /
`.status(identity)`. Raw actorId/deviceId strings do not authorize mutations.
Authorization, settings generation, day replacement, receipt acceptance, fresh contact
and independent health/live guards share the Firestore transaction. All reads precede
writes; the callback performs no network, random ID generation, UI or message delivery.
Settings uses a validated wrapped-path Firestore representation while wire paths remain
exact arrays. New settings are pending until the device's durable installation Ack.

Task 11d skips writes and reads a sync doesn't need; the contract is unchanged.
`sync/current` is written on every sync (contact time, request ordering) and also keeps
the latest accepted live and health observation (`observed.live`/`observed.health`:
request sequence, observation time, content digest). Ordering and the same-instant
conflict check use it, so `live/current` and `health/current` keep the sequence that
last wrote them. Live is rewritten only when it changes apart from `observedAt`; reports
take the newer observation time from `sync/current`. Health is rewritten when it changes
apart from `observedAt` and `lastSuccessAt`, or when the stored copy is 5 minutes older
than the new observation. A sync reads only the day documents of the dates it is sent
(the daily sweep alone deletes days outside the retained dates), alert state only when
today's summary changed, and with neither summaries nor receipts the action snapshot reads
controls, policy and parents only when an action is open. An unchanged alert state is not
rewritten. An idle sync costs 7 reads and 1 write, a summary sync 14 reads and 2 writes with
two caregivers (`sync` emulator suite).

Every submitted date receives its durable source highwater. Unknown manifests are
ignored locally; malformed receipt/date/sequence/Ack associations reject atomically.
Reordered responses cannot regress settings, pairing, query-success timestamps,
cancellation fences, day or receipt state. Equal sequence/revision with different
canonical content conflicts. A server-ahead day watermark requests recollection and
advances the next durable local source sequence.

The 131072-byte cap applies to raw UTF-8 request and response bodies. Admission reserves
maximum mandatory health and request-sequence width; actual packing measures all
optional data, whole dates and receipts. Oversize sources preserve last-valid evidence
and publish report_capacity_exceeded while heartbeats and Acks continue. No truncation,
fragments or invented apps are permitted. Cloud settings changes reserve mandatory
response/receipt overhead before commit rather than saving an undeliverable catalog.

Task 8a (schema 4) accepts delivery offers durably. In the `apply_sync` transaction,
an offer that is new and valid is recorded in `actions` and acknowledged `accepted`
at once. A known ID is ignored. An offer already covered by the cancellation fence
gets `canceled`, and one past its window gets `expired` (`missed_deadline`); neither
has acceptance. Acceptance is no earlier than the delivering response's `serverNow`
(the backend requires it no earlier than its first offer) or the action's creation.
Presentation is no earlier than acceptance, and event times never go backwards per
action (schema 5 keeps `last_status` and `last_at`). So a laptop clock behind the
server, or stepped back, cannot get a receipt rejected. A new fence marks covered open
actions `canceled` in the same transaction as the cancellation Ack, unless the latest
occurrence already ended between repeats, in which case the family ends locally. No
later-occurrence receipt is sent at or after the family's Kyiv midnight, and receipts
outside the retained dates are pruned. `contracts/fixtures/action-receipts.json`
records real companion receipt sequences that the bot replay test must accept. The scheduler removes any visible instance on its next one-second tick, so clearing
is durable before the Ack and visible within about a second. A malformed offer still
rejects the whole response atomically.

Task 8b adds an `activity` entry to the state row for overlay gating, written by the
IO worker after each live poll: `{observedAt, state, path, ownedAt}`, with no app or
title. An active or AFK observation replaces it. An observation of the companion's own
foreground window only refreshes `ownedAt`, so the last outside observation stays
authoritative while our overlay has focus. An unknown observation changes nothing. AFK
is checked before companion-owned foreground, so walking away from the overlay is AFK.
The scheduler reads today's selected total through `selected_usage(date)` under the
current settings, without revalidating the stored body each second.

Task 9 adds two more state entries. `app` holds the local ActivityWatch address
(`awHost` loopback, `awPort`). `pendingRevocations` lists access removals, each
`{id, name, requestedAt}`, saved before any DELETE and cleared only after the server
answers. The sync worker sends at most two after each successful sync. Neither entry
holds a secret.

`activeCaregivers` (ACCESS-08) is taken only from the newest applied response. When it
is 0, every open action is canceled in the same `apply_sync` transaction; one waiting
between repeats ends locally, as for fences. The scheduler then treats allowance and
endtime as ineligible. Before any sync the value is unknown and the rules run.

Verification uses synthetic sources and exact demo-aw-telegram loopback Firestore only.
The guarded runner rejects non-demo/non-loopback/credentialed environments and disables
metadata probing. Raw RED/GREEN evidence and scope limits are recorded in
`.superpowers/sdd/implementation-plan/task-5-report.md`. There are no production Firebase,
Telegram, installed AW, GUI, game, credential, login or deployment operations in this
checkpoint's verification.
