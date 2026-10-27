# Windows development handoff

Updated: 2026-10-27. Repository: https://github.com/alexandersokol/aw-telegram.git

## Current state

Requirements and technical implementation plan are approved. Task 1 now has a
Windows/Qt presentation shell, locally pinned dependencies, a runnable manual
harness, and 45 passing companion test assertions after review fix round 1. A
nonfatal COM diagnostic remains recorded in windows-validation.md. The controller viewed primary-desktop
captures at 150% DPI: dim background, opaque Ukrainian centered text, and bottom
«Закрити» were visible. The user authorized Roblox testing, and the controller also
observed the overlay visibly above Roblox GDK 2.744.1075.0 gameplay in an F11
fullscreen state. Its borderless/exclusive renderer mode was not established.
Native click-through/close, exclusive-mode, display-change, and minimize-fallback
acceptance remain pending. See windows-validation.md for exact evidence and limits.

Task 1's software checkpoint is committed at b69714d. Task 2 contracts, shared
fixtures and Kyiv time policy are implemented, with controller review/commit
pending. Final companion suite: 52 passed (including 7 contract tests), exit 0,
with the existing unsuppressed COM 0x8001010d diagnostic. Node's full suite has
6 passing tests; TypeScript build and isolated compiled-schema validation pass.
pip check passes; npm audit reports zero vulnerabilities. Continue with Task 3
after Task 2 review, carrying pending game acceptance gates forward and blocking
release until they pass. See api-contract.md for exact wire fields and invariants.
No working bot, backend, AW integration, packaged executable, or cloud deployment
exists yet. Do not restart approved requirements discovery. Do not deploy or send
Telegram messages without the owner's test configuration and authorization, or
modify the separate ActivityWatch repository.

## Get the repository on Windows

PowerShell, from your preferred projects directory:

```powershell
git clone https://github.com/alexandersokol/aw-telegram.git
cd aw-telegram
git status
```

Open this folder in the coding agent/editor. Read in this order:

1. This handoff.
2. user-requirements.md (chronological decisions; later explicit decisions win).
3. bot-navigation.md and companion-navigation.md.
4. technical-design.md (consolidated technical decisions).
5. implementation-plan.md (ten tasks, 51 checkable steps).
6. hosting-cost-estimate.md.

All these documents are in docs/. They travel with this standalone repository.

## First implementation checkpoint

Task 1's Qt/Windows presentation shell is implemented. The local setup and harness
commands are in companion/README.md. Complete the remaining real-game acceptance
early while proceeding to the next approved implementation checkpoint:

- Dim only the primary monitor with see-through black at initial 70% opacity.
- Large opaque white centered/wrapped message; bottom-centered «Закрити» button.
- Capture mouse clicks; no click-through to the game.
- Manual default: dismissible, once. Explicit buttonless mode requires duration.
- Show during borderless and exclusive fullscreen; minimizing the game is allowed
  when needed. Do not inject into games, bypass anti-cheat, or defeat OS protections.
- Check primary monitor/DPI changes and that overlays do not cause foreground
  activity-gating oscillation. If Windows blocks visibility, report it accurately.

Record observed Windows version, DPI/monitor layout, game names/display modes,
standard/elevated execution context, and evidence in docs/windows-validation.md
as actual evidence becomes available. The observed Roblox F11 visual layering
does not establish exclusive-mode, native input-capture or fallback acceptance.

## Toolchain to install/check for implementation

- Git and Windows PowerShell; Python 3.12 with venv/pip.
- Node.js 22 and npm for the backend, with Java and Firebase CLI as required by
  the chosen Firebase emulator release. Verify current emulator prerequisites
  before installing; do not infer them from old examples.
- Task 1 uses PySide6-Essentials and pytest/pytest-qt in companion/.venv, pinned in
  requirements.lock. Task 2 adds jsonschema and tzdata; requests, aw-client and keyring remain deferred to their
  implementation tasks; do not install an unbounded global environment.
- Task 2 pins Node/Ajv/moment-timezone/Vitest dependencies locally in bot. Both
  timezone databases are IANA 2025b. Supported local calendar dates are 1970–2099;
  wider dates are explicitly rejected because moment's packed transitions do not
  extrapolate like zoneinfo. UTC wire instant years remain 0001–9999. Use bot/.npmrc
  and the lockfile; npm 10.9.2 needs the recorded optional-peer resolver workaround.
- PyInstaller one-directory packaging is a later task, built on Windows.

Prefer a task branch such as codex/windows-companion. Build/run on the signed-in
user's desktop, not as a Windows service or a permanently elevated process.
Choose inline/native execution unless the owner explicitly selects delegation.
Follow applicable skill/repository workflow instructions in the new session.

## Standalone paths and ActivityWatch reference material

The plan was written while this folder was nested inside a checkout of
ActivityWatch; its source references (aw-client/, aw-notify/, aw-server/aw-webui/)
are NOT included in this repository and are not submodules here.

Plan command examples beginning `cd aw-telegram/...` assume the parent projects
directory. From this repository's root use `cd companion` or `cd bot` instead.
All planned file paths in the plan's file map are repository-relative. Do not
create another nested aw-telegram folder to follow those examples literally.

If AW source is needed for query/category implementation, obtain a separate
ActivityWatch checkout next to this repo. The reference checkout used during design:

- activitywatch: 0d114d7 (master at inspection).
- aw-client: fe106969fcd413ffadbd5a9d3b75808cc636cd54.
- aw-core: 28c3acf047b225f90592e1c47c8ec2596612d70b.
- aw-server: 67cfb479a9f8511ad3a9595224cb22c35b9dbe65.
- aw-server-rust: fe558c4f106a70004a42bc30558c7438f8b66b4f.
- aw-webui: d6e9d7072c9b65214a7c15fbda48450972783653.

These are source references, not proof of the son's installed AW version. The
ActivityWatch LAN dashboard was http://192.168.50.60:5600/ and the hostname was
DESKTOP-0DO2F57. The laptop was off when discussed; installed version and bucket
compatibility have NOT been verified. On the laptop use loopback APIs, discover
bucket IDs, and never expose AW publicly. Do not reset/delete the existing AW data.

## Important product decisions — preserve these

- One laptop, two parents maximum, private chats only. Ukrainian built-in UI and
  messages; English command identifiers. No language chooser or groups.
- `/usage` = today; `/usage today`, `/usage yesterday` show sorted categories.
  `/usage week` is today plus six earlier Kyiv calendar dates, daily breakdown.
  Formatted text only; no graphs or per-app historical breakdowns. Today includes
  current/last app and only the latest window title.
- Start collection at first successful parent pairing, not laptop enrollment or
  earlier AW history. Reconnect fills only missing post-pairing data still retained.
- Active foreground time, excluding AFK/background activity. Include selected
  category descendants, count overlaps once; uncategorized is opt-in for allowance.
- Shared four-hour default; selected categories configurable. Category edits
  recalculate today. Default-limit edits also replace today's override; today-only
  changes expire at Europe/Kyiv midnight. Seven-calendar-date cloud retention.
- Both parents get 15/10/5-minute and expiry alerts; optional hourly milestones
  are independent per parent. Hourly updates continue in free use and after clear.
- Free use skips laptop and Telegram allowance reminders; tracking continues.
  New manual reminder commands are skipped with immediate explanation. Old future
  timers keep deadlines; timers due during free use are skipped, not replayed.
- Clear manual cancels manual actions. Clear all also suppresses automatic allowance
  reminders until midnight. `/restore` explicitly removes that suppression;
  changing limits/categories or turning free use off does NOT remove it.
- Exhausted allowance overlay repeats one minute after dismissal, only during
  active counted use; hide on AFK or switching to schoolwork. Manual overlays use
  their own timing, optional repeat, and stop repeating at midnight.
- Immediate actions: at most three delivery offers in 60s, IDs deduplicated. Issuing
  parent receives failure/unconfirmed delivery notice; other parent receives status.
  No stale action on next boot. Delayed timers run offline if already accepted;
  cloud silence means execution unconfirmed, not proof of expiry/failure.
- Requests for reports stay private. Shared laptop actions/settings notify the
  other parent. Bot replies distinguish queued/accepted/presented/failed/unconfirmed.
- Named parent keys generated/listed/revoked in companion; unused expiry 15min;
  single-use, bound to Telegram numeric ID. No paired-access inactivity expiry.
- Companion tray window: status, parent access, settings; close-to-tray and autostart.
  No protection against the child intentionally stopping the app in this version.

## Architecture and security

Python 3.12/PySide6 companion + SQLite + Windows Credential Manager. TypeScript /
Node.js 22 / grammY Telegram webhooks in Firebase Functions v2. Firestore state,
Cloud Tasks for deadline/outbox reliability, one daily cleanup Scheduler job.
No aw-notify dependency or AW changes required. No direct client Firestore access,
no bot token/admin credentials on laptop, no remote script execution.

Device enrollment is separate from parent pairing. Backend setup CLI generates
one-time enrollment bundle, exchanged for device credential. All device traffic
is authenticated outbound HTTPS. Telegram webhook secret and per-request parent
private-chat authorization are mandatory, including callbacks and outgoing messages
after revocation. Do not commit real secrets or include them in logs/test fixtures.

The backend stores summaries, not raw history/URLs/window-title history. Latest
app title is overwritten in one live document and excluded from durable outbox
payloads. Telegram messages and provider infrastructure copies are outside our
seven-date cloud report deletion guarantee. Bot messages are not end-to-end encrypted.

## Hosting and validation status

Owner accepts Blaze billing with cost controls. Fifteen-second short polls are
approved; summary uploads every 30s, online command target 30s/report target 1min.
Estimated polls: 1,920/day for 8h online, or 5,760/day continuously. Free allowances
are not a spending cap, may be shared with other projects, and CPU/database/network
costs must be measured. Do not use a long-running function waiting for each poll.

Task 1 has passing automated presentation/policy tests and primary-desktop visual
smoke evidence. These do not establish real-game fullscreen acceptance or backend
integration. Earlier design review resolved presentation-queue expiry, offline
accepted timer reconciliation, and pairing-vs-enrollment collection start; those
later domain behaviors are not implemented yet. Credentials/project ID/real Telegram
bot are not provided. Do not invent them or mark integration/Windows gates complete
with mocks.

Task 2 implements strict schemas, model validation and pure invariants only. It
does not implement authenticated endpoints, persistent first-pairing collection
start, sync transactions, ActivityWatch counting, action delivery or scheduling.
The schema cannot establish a sender's authority or prove native visibility.
The nonfatal COM diagnostic also reproduced in a standalone visible Qt widget
without app imports or pytest; its underlying cause remains unestablished. See
windows-validation.md and the preserved diagnostic report; do not suppress it or
describe the native suite as diagnostic-free.

## Suggested continuation prompt

> Read docs/windows-handoff.md and its linked specification/plan. Continue the
> approved implementation plan in this repository. Task 2 contracts/time policy
> are implemented and verified, awaiting controller review and commit; after that
> continue with Task 3's ActivityWatch adapter. Carry forward Task 1's pending
> real-game acceptance and the deferred Task 8 notification scroll reset.
> Implement inline, preserve all documented product decisions,
> and use meaningful automated tests plus real Windows fullscreen validation.
> Record progress and actual evidence so another session can resume. Do not deploy
> or send Telegram messages until I provide the test configuration and authorize it.
