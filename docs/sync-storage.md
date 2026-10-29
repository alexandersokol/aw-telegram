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
10s polls, 15s sync and 30s current-day queries, with due control sync first and one
historical date per bounded opportunity. Midnight and multi-day wake schedule newly
closed retained dates. `IOWorker` starts/stops explicitly and constructs its store on
its own thread through a factory; later Qt integration must use queued notifications.

Cloud bound facades are `DeviceApi(repository,clock).syncDevice(identity,input)` and
`SettingsService(repository,clock).updateSettings(identity,change,callback?)` /
`.status(identity)`. Raw actorId/deviceId strings do not authorize mutations.
Authorization, settings generation, day replacement, receipt acceptance, fresh contact
and independent health/live guards share the Firestore transaction. All reads precede
writes; the callback performs no network, random ID generation, UI or message delivery.
Settings uses a validated wrapped-path Firestore representation while wire paths remain
exact arrays. New settings are pending until the device's durable installation Ack.

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
has acceptance. Acceptance and event times are clamped to no earlier than the action's
creation, so a laptop clock slightly behind the server cannot reject a whole sync. A new
fence marks covered open actions `canceled` in the same transaction as the cancellation
Ack. The scheduler removes any visible instance on its next one-second tick, so clearing
is durable before the Ack and visible within about a second. A malformed offer still
rejects the whole response atomically.

Verification uses synthetic sources and exact demo-aw-telegram loopback Firestore only.
The guarded runner rejects non-demo/non-loopback/credentialed environments and disables
metadata probing. Raw RED/GREEN evidence and scope limits are recorded in
`.superpowers/sdd/implementation-plan/task-5-report.md`. There are no production Firebase,
Telegram, installed AW, GUI, game, credential, login or deployment operations in this
checkpoint's verification.
