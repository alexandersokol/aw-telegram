# AW Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Owner approved design/plan on 2026-10-27. Task 1 presentation code is committed at b69714d; complete fullscreen acceptance remains pending. Task 2 contracts/time policy are committed at 138bb66. Task 3 adapter/counting corrections passed independent scoped review; 74 focused tests and 127 full native tests after the timer amendment pass. Included in the reviewed implementation checkpoint.

**Goal:** Build the agreed private-parent Telegram reports, allowance reminders, and Windows companion without changing ActivityWatch.

**Architecture:** A Python/Qt signed-in-session companion queries local AW and persists schedules offline. Authenticated outbound exchanges synchronize summaries, revisioned settings, and commands with a TypeScript Firebase webhook backend. Firestore plus Cloud Tasks provide durable commands and parent messages; no always-running cloud bot or direct device database access.

**Tech Stack:** Python 3.12, PySide6, aw-client, SQLite, requests, keyring, PyInstaller; Node.js 22, TypeScript, grammY, Firebase Functions v2, Firestore, Cloud Tasks/Scheduler, Vitest, pytest/pytest-qt.

**Spec:** [technical-design.md](technical-design.md), [user-requirements.md](user-requirements.md), [bot-navigation.md](bot-navigation.md), [companion-navigation.md](companion-navigation.md).

## Global constraints

- One Windows laptop; two parents maximum; private Telegram chats only.
- Ukrainian built-in text; English command identifiers; today/yesterday app names/durations filtered by selected categories; no graphs/window-title history.
- Europe/Kyiv calendar days; retain today plus six previous dates; no pre-pairing import.
- Active foreground time only; no audible/always-active AFK exceptions; category descendants deduplicated.
- Four hours default; 15/10/5-minute warnings; hourly updates independent per parent.
- Report freshness target one minute; immediate command target 30 seconds; three offers/60s maximum.
- Free use and Clear-all suppression independent; hourly updates survive both.
- Primary monitor only, click-capturing translucent overlay; default dismissible once for manual actions.
- Mandatory buttonless duration; repeat after dismissal, end at Kyiv midnight; no OS lock/tamper resistance.
- No bot token or cloud admin credentials on laptop; cloud reports only, latest title overwritten in place.
- Daily app names/durations may be retained as category-attributed aggregates for retained dates; app rows sum to selected total for complete data, otherwise explicitly partial/unknown.
- Complete the reviewed application-usage contract/reader extension below before Task 5 sync or Task 7 formatting; current v1 rejects app fields.
- Modify only aw-telegram files; no changes to submodule pins/root build without a separate reason.
- Exact library patches locked during implementation; root runtime pins do not apply.

## Review focus

- Overlay becoming foreground or minimizing the game must not cause show/hide oscillation (Tasks 1, 3, 8).
- Revocation/duplicate pairing or stale Telegram callbacks must not bypass parent authorization (Tasks 4, 7).
- Late/out-of-order sync and opposite parent edits must not revive canceled reminders (Tasks 5, 6, 8).
- Local midnight, DST, sleep/wake and clock corrections must not replay expired timers (Tasks 2, 8).
- Missing AW data and stale titles must not look like zero usage or fresh live activity (Tasks 3, 5, 7).

## File layout and responsibilities

All paths below are relative to aw-telegram/. This is one integrated plan because
contracts, settings, and delivery state cross both subsystems. Each task is a
separately testable checkpoint, not a separate independently deployed product.

```text
contracts/v1/{shared,sync-request,sync-response,action,settings,day,ack,live,cancellations}.schema.json
contracts/fixtures/{wire,time,selection,evidence}.json
companion/pyproject.toml, requirements.lock, aw-telegram.spec
companion/src/aw_telegram/{main,models,clock,storage,transport,credentials}.py
companion/src/aw_telegram/{aw_reader,category_settings,counting,policy,scheduler}.py
companion/src/aw_telegram/ui/{window,tray,overlay,notification,countdown,access}.py
companion/src/aw_telegram/windows/{foreground,startup}.py
companion/tests/test_*.py
bot/package.json, package-lock.json, tsconfig.json, vitest.config.ts
bot/src/{index,contracts,clock,repository,auth,enrollment,pairing}.ts
bot/src/{deviceApi,settings,actions,deadlines,alerts,outbox,tasks,cleanup}.ts
bot/src/telegram/{webhook,commands,menus,sessions,reports,uk}.ts
bot/scripts/{enroll,webhook,purge}.ts
bot/tests/*.test.ts
firebase.json, firestore.rules, firestore.indexes.json
.github/workflows/validate.yml (under aw-telegram; install at root only when explicitly integrating CI)
docs/{api-contract,setup,windows-validation,operations}.md
```

Shared language-domain names in this plan: Settings, Action, DaySummary, SyncRequest,
SyncResponse, Ack, Evaluation are defined in Task 2; PresentationResult reuses Task 1's type. No
cross-language executable code sharing; JSON fixtures pin equivalent behavior.

## Task 1: Windows overlay feasibility and presentation shell

**Files:** create companion/pyproject.toml, companion/src/aw_telegram/ui/{overlay,notification,countdown}.py,
companion/src/aw_telegram/windows/foreground.py, companion/tests/test_presentation.py,
docs/windows-validation.md. Add only dependencies needed by this checkpoint.

**Interfaces:** `OverlayWindow.show_message(text: str, dismissible: bool, duration_ms: int | None) -> None`;
`OverlayWindow.hide_message() -> None`; `ForegroundAdapter.reveal_overlay(hwnd: int) -> PresentationResult`.
Define PresentationResult as visible/unconfirmed/failed with a non-sensitive reason.
Presentation callbacks emit shown/dismissed/expired IDs; no backend integration yet.

- [x] Write pytest-qt tests `test_text_opaque_over_dim_background`, `test_primary_monitor_geometry`,
  `test_clicks_do_not_pass_through`, `test_buttonless_requires_duration`,
  `test_dismiss_signal_once`, `test_foreground_failure_is_unconfirmed`.
- [x] Run `cd aw-telegram/companion && python -m pytest tests/test_presentation.py -q`;
  confirm tests fail for missing presentation implementation.
- [x] Implement frameless Qt painting, 70% black layer, centered white text, bottom
  «Закрити», primary monitor/DPI changes, controllable 10s notification card/countdown.
  Implement bounded Win32 topmost/minimization adapter; never inject or bypass anti-cheat.
- [ ] Re-run tests; then run a documented manual harness on Windows against the actual
  game in borderless and exclusive fullscreen. Record capture, minimize fallback,
  and unrelated foreground app behavior. Mac mocks cannot pass this gate.
- [ ] If Windows access is unavailable, mark gate pending and continue backend/core
  tasks without claiming fullscreen support. Commit this checkpoint after passing
  automated tests; block release pending Windows evidence.

Checkpoint evidence: [windows-validation.md](windows-validation.md). Full companion
suite after review fixes: 45 passed on Windows/Python 3.12.14, with a nonfatal COM
diagnostic recorded in the validation document. Desktop and Roblox F11 fullscreen
visual layering were observed at 150% DPI; exclusive renderer mode, native
click-through/close, monitor changes, and minimize fallback remain manual gates.
The software checkpoint is committed at b69714d; the combined manual/commit
steps above remain unchecked because the full manual acceptance conditions remain pending.

## Task 2: Contracts, shared fixtures, and time policy

**Files:** create contracts/v1/*.schema.json, contracts/fixtures/*.json,
companion/src/aw_telegram/{models,clock}.py, companion/tests/test_contracts.py,
bot/{package.json,tsconfig.json,vitest.config.ts}, bot/src/{contracts,clock}.ts,
bot/tests/contracts.test.ts, docs/api-contract.md.

**Interfaces:** `local_day_bounds(date: str) -> tuple[datetime, datetime]` / TS
`dayBounds(date: string): {start: string; end: string}`; Settings includes revision,
selectedPaths, selectedUncategorized, defaultLimitMs, todayOverride, freeUseDate, suppressedDate.
DaySummary includes date, leafTotalsMs, coverage interval/partial flag, sequence,
rulesRevision. Action includes id, actorId, kind, targetAt, expiresAt, options,
sequence, settingsRevision; SyncRequest includes sequence, summaries?, live?, acks;
SyncResponse includes serverNow, nullable collectionStartedAt, settings,
cancellations, deliveryOffers. Before first parent pairing, do not collect/upload
activity. Persist collectionStartedAt once assigned; do not reset on restart/re-pairing.

- [x] Write fixture tests for spring/fall Kyiv DST bounds, seven-calendar-date
  retention, category path escaping, negative durations, oversized titles/messages,
  unknown schema versions, and required buttonless duration.
- [x] Run `python -m pytest tests/test_contracts.py -q` in companion and
  `npm test -- contracts.test.ts` in bot; verify meaningful initial failures.
- [x] Implement schemas, Python dataclasses/validation, TypeScript validators, and
  timezone helpers using zoneinfo/tzdata and a Node timezone library with explicit
  Europe/Kyiv. No fixed UTC offset or '168 hours' shortcut.
- [x] Run both suites; verify shared fixtures produce identical normalized results.
- [x] Lock dependencies and commit contracts/time policy.

Checkpoint evidence: [api-contract.md](api-contract.md). Dependencies are locked;
commit: `138bb66`. Shared wire fixtures contain 143 cases plus
calendar, selection and receipt/context cases. Final native Windows companion
suite: 52 passed, exit 0, with the existing unsuppressed COM 0x8001010d diagnostic.
Node full suite: 6 passed; TypeScript build and isolated compiled-schema check pass;
pip check passes and npm audit reports zero vulnerabilities. Both timezone databases
are pinned to IANA 2025b. Defensive local dates are 1970–2099 after a year-3000
probe exposed moment's finite packed-transition horizon; UTC instants remain
0001–9999. This arithmetic/transport bound does not authorize historical import.
Authentication, persistence, ActivityWatch and scheduler behavior remain later tasks.

## Task 3: Real ActivityWatch adapter and summary calculation

**Files:** create companion/src/aw_telegram/{aw_reader,category_settings,counting}.py,
companion/tests/{test_aw_reader,test_counting}.py; local fixture inputs under companion/tests/fixtures/.

**Interfaces:** `AWReader.probe() -> AWCapabilities`; `AWReader.summarize(start: datetime,
end: datetime, collection_started_at: datetime) -> DaySummary`; `AWReader.live() -> LiveState`;
`selected_total(leaf_totals: dict[tuple[str,...], int], paths: list[tuple[str,...]]) -> int`.
AWCapabilities includes explicit chosen bucket IDs and category-settings support.

- [x] Write tests for foreground/AFK intersection, overlapping parent selections,
  malformed events, bucket ambiguity, modern/legacy category settings, audible AFK
  exclusion, enrollment-before-first-pairing exclusion, pre-pairing clipping,
  stale heartbeat after sleep, companion-owned
  foreground, and nondefault AW port (no accidental localhost:5600 fallback).
- [x] Run `python -m pytest tests/test_aw_reader.py tests/test_counting.py -q`; verify failures.
- [x] Implement explicit client query parameters, effective category resolver,
  local aggregation and missing-data coverage. Reuse canonical query machinery
  without its implicit default-client settings call or always-active exceptions.
- [x] Run tests and a read-only probe against a local development AW server;
  compare a known window/AFK fixture total against the UI and explain intentional
  active-only differences. Record installed Windows AW compatibility when available.
- [x] Commit adapter/counting without modifying AW repositories.

Checkpoint evidence: [activitywatch-validation.md](activitywatch-validation.md).
Both Task 3 corrections passed independent scoped review; 74 focused tests and
127 full native tests after the timer amendment pass (scoped test-only loopback/Qt
access). The initial 40/92 results are historical evidence. Installed v0.14.1 metadata and
constant/empty queries pass; real counting uses an isolated MemoryStorage source
fixture, not installed history. Installed category settings are missing and remain
an explicit setup requirement. A local audited canonical fragment/stdlib HTTP
adapter replaces planned aw-client dependency because PyPI 0.5.15 lacks source
checkout exact-ID/auth/timeout capabilities. Included in the reviewed implementation checkpoint.

## Required amendment checkpoint: application-name usage (Tasks 2–3 extension)

Status: pending, authorized on 2026-10-27. Read the binding
[application-usage-amendment.md](application-usage-amendment.md) before proceeding.
The implemented DaySummary/schema/reader remain category-only. Bot source has
contracts and clock helpers, no report formatter; no report implementation is
completed by this amendment. Task 4 can proceed independently, but Task 5 and
Task 7 depend on this reviewed extension:

- [ ] Record the version/compatibility decision for the closed existing v1 schema
  and category-only persisted summaries; do not silently add wire fields.
- [ ] Extend canonical/packaged schemas, Python models/validation, TS types and
  validators/helpers, shared fixtures and AW reader/counting with daily unfiltered
  app × disjoint leaf-category aggregates alongside existing leaf totals.
- [ ] Preserve retained dates, immutable pairing start, rules/settings revisions,
  per-date sequence, coverage/partial semantics, exact selection recomputation and
  128 KiB requests; review app/category bounds and batch sizing without silent loss.
- [ ] Verify names/durations descending, app spanning selected/unselected leaves,
  descendants counted once, opt-in uncategorized, no AFK/background/pre-pairing
  time, exact complete app-row/selected-total equality, explicit partial/unknown,
  and category edits recomputed from category-attributed aggregates.
- [ ] Review cross-language schema/fixture/reader compatibility before Task 5 sync
  and Task 7 formatting. Keep historical window titles/events/URLs prohibited.

Timer amendment: the top-left countdown now paints #242424 at alpha 179 with
opaque white text; the real Qt rendering regression and existing lifecycle tests
cover this change. Fullscreen overlay and manual game acceptance gates are unchanged.

## Task 4: Secure backend enrollment, parent pairing, and revocation

**Files:** create firebase.json, firestore.rules/indexes, bot/src/{index,repository,auth,enrollment,pairing}.ts,
bot/scripts/enroll.ts, bot/tests/{auth,pairing}.test.ts;
companion/src/aw_telegram/{credentials,transport}.py, companion/tests/test_enrollment.py.

**Interfaces:** HTTP `POST /v1/enroll` exchanges backendURL+one-time secret for deviceId+deviceSecret;
`POST /v1/pair-keys` creates a named key, `GET /v1/access`, `DELETE /v1/access/{id}`;
`authorizeDevice(request): Promise<DeviceIdentity>`;
`pairParent(secret: string, userId: string, chatId: string): Promise<Parent>`.
`Transport.enroll(bundle: EnrollmentBundle) -> DeviceIdentity` stores secret in vault.

- [x] Write emulator tests for one-time/15-minute expiry, concurrent consume,
  two-parent cap, numeric IDs, group rejection, guessed/forged device ID,
  revoked access on old callbacks/outbox, and generic throttled invalid-key responses.
  Python tests assert no secret enters SQLite/config/log output.
- [x] Run `npm run test:emulator -- auth pairing` and `python -m pytest tests/test_enrollment.py -q`;
  verify failures before implementation.
- [x] Implement random key generation/hashing, transactional consumption, device
  token checks, access lookup/deletion, deny-all direct database rules, vault storage,
  and local owner-only enrollment CLI. Validate trusted HTTPS URL before exchange.
- [x] Run emulator suites with a rules client and Admin repository separately;
  verify unauthorized clients cannot read any document and IAM setup is documented.
- [x] Commit authorization boundary.

Checkpoint: implementation and focused verification complete; independent review approved.
22 emulator checks (separate Admin transactions and client deny-all rules), 29 Python enrollment tests,
6 existing Node contract groups, build/bundle checks and native synthetic vault write/read/delete pass.
See [enrollment-security.md](enrollment-security.md) for interfaces, recovery, IAM, timeout and tooling limits.

## Task 5: Durable local storage and authenticated synchronization

**Prerequisite:** complete/review the application-name usage checkpoint above.
Persist unfiltered app × leaf-category daily aggregates and recompute selected app
rows/totals under current settings, preserving rules/sequence/coverage/retention
and payload bounds. Do not derive app reports from category-only v1 snapshots.

**Files:** create companion/src/aw_telegram/storage.py, finish transport.py,
companion/tests/test_sync.py, bot/src/{deviceApi,settings}.ts, bot/tests/sync.test.ts.

**Interfaces:** `LocalStore.apply_sync(response: SyncResponse) -> None`;
`LocalStore.pending_acks() -> list[Ack]`; `Transport.sync(request: SyncRequest) -> SyncResponse`;
`syncDevice(identity: DeviceIdentity, input: SyncRequest): Promise<SyncResponse>`;
`updateSettings(deviceId: string, change: SettingsChange, actorId: string): Promise<Settings>`.

- [ ] Write tests for stale/out-of-order snapshot rejection, reconnect backfill
  within retained dates, missing-data flags, settings revision races, two parents'
  opposite edits, title replacement only, canceled-ID fences, credential errors,
  and midnight retention without deleting AW source data.
- [ ] Run `python -m pytest tests/test_sync.py -q` and `npm test -- sync.test.ts`; verify failures.
- [ ] Implement SQLite migrations/WAL transactions, snapshot queue/coverage,
  sequence numbers, revisioned cloud settings, sanitized device API, 15s poll/30s
  summary cadence and IO worker. Settings update returns accurate acknowledgement state.
- [ ] Re-run tests with dropped/reordered fake network responses. Assert no raw
  title/history appears in daily snapshots, SQLite history, or logs.
- [ ] Commit sync and storage checkpoint.

## Task 6: Backend command lifecycle, alert policy, and reliable parent messages

**Files:** create bot/src/{actions,deadlines,alerts,outbox,tasks}.ts,
bot/tests/{delivery,alerts,outbox}.test.ts, finish repository.ts.

**Interfaces:** `createAction(deviceId: string, actorId: string, draft: ActionDraft): Promise<Action>`;
`offerActions(deviceId: string, now: string): Promise<Action[]>`;
`recordAck(deviceId: string, ack: Ack): Promise<void>`;
`evaluateAlerts(input: AlertInput): AlertEvent[]` (pure);
`enqueueParentEvent(event: ParentEvent): Promise<void>`;
`deliverOutbox(eventId: string): Promise<void>`; `expireAction(actionId: string): Promise<void>`.

- [ ] Write tests: exactly three offers >=20s apart before 60s expiry; accepted offline delayed timer
  remains execution-unconfirmed until reconciliation, late valid receipt corrects
  cloud uncertainty; no stale
  execution; deadline notice when laptop stays off; duplicate acknowledgements;
  transaction/outbox crash recovery; Task OIDC rejection; revoked recipient; one
  parent's Telegram 403; Telegram 429 retry; uncertain sendMessage outcome;
  catch-up milestone, enabling midday, category decrease/increase, clear/free precedence.
- [ ] Run `npm test -- delivery alerts outbox`; verify failures.
- [ ] Implement transactionally versioned actions and cancellation fences,
  deterministic domain event IDs, outbox leases/Cloud Tasks, deadline closure,
  per-parent milestone high-water marks and consolidated warnings. No background
  setTimeout used for cloud deadlines. Never store live titles in durable messages.
- [ ] Run unit/emulator suites; simulate a crash after Telegram accepts a send
  and document the unavoidable possible duplicate cloud message (not laptop action).
- [ ] Commit backend policy/delivery checkpoint.

## Task 7: Telegram private-chat commands and approved button navigation

**Prerequisite:** complete/review the application-name usage checkpoint above.
Today/yesterday render AW app names/durations sorted descending, only selected
category intervals incl descendants once and uncategorized opt-in; complete rows
sum to selected total, missing data is partial/unknown. Test changed selection,
app spanning selected/unselected leaves, escaping and pagination. Week remains
daily totals; latest window title is current-only.

**Files:** create bot/src/telegram/{webhook,commands,menus,sessions,reports,uk}.ts,
bot/tests/{telegram,reports,menus}.test.ts; finish bot/src/index.ts, bot/scripts/webhook.ts.

**Interfaces:** `handleUpdate(update: unknown): Promise<void>`;
`renderUsage(period: 'today'|'yesterday'|'week', data: ReportData): string[]`;
`transitionMenu(session: MenuSession, input: MenuInput): MenuResult` (pure);
`buildBot(): Bot` initialized once per function instance without starting polling.

- [ ] Write tests for webhook secret, unauthorized/group/forwarded/forged callbacks,
  duplicate updates after partial failure, stale session buttons, escaped Ukrainian
  text/HTML-like titles, report privacy, personal preference privacy, seven dates,
  partial first day, old titles marked stale, presets/custom values, mandatory
  duration, conflicting options, review/cancel, free-use skip and restore action.
- [ ] Run `npm test -- telegram reports menus`; verify failures.
- [ ] Implement grammY webhook routing, command set from design, persisted session
  state machine, exact agreed navigation and Ukrainian templates. Use Task 6 for
  mutation/outbox effects, not direct sends inside Firestore transactions.
- [ ] Run suites using recorded Telegram fixtures, mocked Bot API and emulator;
  verify every navigation leaf has back/cancel and all shared actions notify the other parent.
- [ ] Commit usable bot interface.

## Task 8: Offline scheduler, allowance engine, and presentation integration

**Files:** create companion/src/aw_telegram/{policy,scheduler}.py,
companion/tests/{test_policy,test_scheduler,test_action_recovery}.py; integrate storage and UI.

**Interfaces:** `evaluate_policy(settings: Settings, usage: UsageState, now: datetime) -> Evaluation`;
`Scheduler.accept(action: Action) -> Ack`; `Scheduler.tick(now: datetime, resumed: bool) -> list[Presentation]`;
`Scheduler.clear(scope: str, revision: int) -> list[Ack]`;
`Scheduler.dismiss(action_id: str, now: datetime) -> None`.
Evaluation includes allowance warning/overlay eligibility, current suppression and day reset.

- [ ] Write fake-clock tests for countdown to UTC target, wake past target skip,
  wake before target resume, 5s running tolerance, crash after presenting marked
  uncertain, one-time dismissal, repeat interval from dismissal, midnight removal,
  buttonless auto-close, free-use timers, queue-busy expiry without interruption,
  one pending repeat without backlog, independent suppression, clear fences,
  counted/uncounted app/AFK gating and overlay foreground self-oscillation.
- [ ] Run `python -m pytest tests/test_policy.py tests/test_scheduler.py tests/test_action_recovery.py -q`;
  verify failures.
- [ ] Implement SQLite-persisted state transitions, source-aware foreground tracking,
  Qt timers on UI thread, immediate acknowledgements, manual-before-auto presentation,
  date-based reset and normal-operation local warnings independent of internet.
- [ ] Run tests plus Windows resume/fullscreen manual cases from Task 1. Verify
  cancellation after reconnect cannot replay old offers. Record real AW foreground
  behavior during overlays and minimization, not only mocked foreground names.
- [ ] Commit integrated reminder engine.

## Task 9: Companion tray, setup window, named access, and packaging

**Files:** create companion/src/aw_telegram/{main}.py,
companion/src/aw_telegram/ui/{window,tray,access}.py,
companion/src/aw_telegram/windows/startup.py, companion/aw-telegram.spec,
companion/tests/test_companion_ui.py, docs/setup.md.

**Interfaces:** `main() -> int`; UI calls Transport/LocalStore, never cloud Admin APIs.
`set_startup(enabled: bool, executable: str) -> None`; `access` displays backend
acknowledged entries, pending revocations and one-time key values.

- [ ] Write pytest-qt tests for enrollment wizard, status health vs missing data,
  no-selected-category guidance, named keys/expiry/revocation, close-to-tray,
  cancellation on free use, and two instances attempting to start.
- [ ] Run `python -m pytest tests/test_companion_ui.py -q`; verify failures.
- [ ] Implement agreed three-section window, QSystemTrayIcon, single-instance guard,
  current-user Run-key autostart with quoted executable, SQLite migrations and
  Credential Manager backend check. Disable accidental console/file secrets.
- [ ] Run tests; build on Windows `pyinstaller --clean aw-telegram.spec` and smoke
  test standard-user install/run/restart on a machine without Python. Bundle tzdata,
  Qt plugins, license notices. Uninstall removes startup entry and offers device revocation.
- [ ] Commit portable distribution; do not promise code signing/automatic updates in v1.

## Task 10: Retention, deployment controls, and end-to-end acceptance

**Files:** create bot/src/cleanup.ts, bot/scripts/purge.ts,
bot/tests/{cleanup,e2e}.test.ts, docs/{operations,setup}.md,
companion/tests/test_e2e_simulated.py; lockfiles and Firebase configuration updates.

**Interfaces:** `cleanup(now: string): Promise<CleanupResult>` removes expired
report/state ranges and repairs stranded delivery events; purge CLI scopes a device
and requires explicit confirmation. Scheduler and task handlers use cloud identity.

- [ ] Write tests for seven local dates across DST, inactive laptop cleanup,
  no pre-pairing import, stale report filtering before deletion, sessions/outbox
  message retention, purging subcollections and indexes, and recovery of unqueued outbox.
- [ ] Run `npm run test:emulator -- cleanup e2e` and
  `python -m pytest tests/test_e2e_simulated.py -q`; verify failures.
- [ ] Implement daily after-midnight cleanup, scheduler/task permissions, secrets,
  minInstances=0/maxInstances=2, rate limits, log redaction and artifact cleanup.
  Document costs beyond Firestore, alerts versus spend caps, cold-start targets,
  access recovery, token rotation, data deletion and deployment rollback.
- [ ] Run complete automated suites once, then staging E2E with two parent chats:
  pairing, reports/offline report, limit/category edits, suppress/restore/free,
  milestones, manual/delayed/countdown/clear, deadline failure while off,
  reboot/offline local policy, named access revoke. Perform Windows fullscreen gate.
- [ ] Review requirements coverage; record actual evidence and unresolved platform
  limitations. Commit deployment docs/package only after checks pass. Production
  deployment and sending real Telegram messages require the owner's deployment/test
  configuration and authorization; do not use guessed tokens/accounts.

## Completion and evidence

A milestone is complete only with its specified tests and observed results. A
passing backend suite does not establish Windows fullscreen visibility. Do not
mark the whole project complete with pending Windows gates or unavailable
credentials. Keep a requirements-to-test checklist in docs/windows-validation.md
and bot tests for the shared rules; preserve meaningful failures rather than
adding tests that merely duplicate the implementation.

## Execution handoff

The owner approved this plan and technical design on 2026-10-27. Read technical-design.md first, including the defaults it introduces (empty
initial category selection, 10s notification cards, bounded inputs, cloud cleanup,
latest-title privacy, and finite retries). Record any subsequent design changes explicitly. Recommend
native execution in this chat for the tightly shared contracts and state machines;
subagent-driven execution is an optional explicit user choice, not enabled by
this plan alone. Windows testing may be scheduled when the son's laptop is on.
