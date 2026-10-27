# Windows companion

Task 1 implements the Qt presentation shell: primary-monitor dimming overlay,
notification card, countdown, and conservative Win32 presentation adapter. It has
no backend, tray, autostart, pairing, or scheduler integration yet.
Task 2 adds strict shared v1 contracts/dataclasses and explicit Kyiv calendar helpers;
see [API contract](../docs/api-contract.md).
Task 3 adds the read-only AW adapter and conservative active-time calculation;
see [ActivityWatch evidence and limitations](../docs/activitywatch-validation.md).
Actual game fullscreen acceptance is pending; see
[Windows validation](../docs/windows-validation.md).

## Local setup

Use Python 3.12 on Windows x64. From this directory in PowerShell:

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.lock
.venv/Scripts/python.exe -m pip install --no-build-isolation --no-deps -e .
.venv/Scripts/python.exe -m pytest -q
```

All runtime, test, and editable-build dependencies are pinned in requirements.lock.
Runtime dependencies are PySide6-Essentials, jsonschema and tzdata. Qt Addons
and cloud libraries are deferred. The AW adapter uses standard-library HTTP and
server query transforms; the published aw-client wheel lacks required endpoint
safety capabilities. Optional source-fixture dependencies live in a separate
`tools/aw-fixture-requirements.lock`, outside the runtime venv. If sandbox temp storage is unwritable, set TEMP and TMP to
an existing ignored local directory such as companion/.tmp before creating the venv.

## Manual harness

```powershell
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --duration-ms 10000 --quit-after-ms 12000
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --buttonless --duration-ms 5000 --quit-after-ms 7000
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --mode notification --quit-after-ms 12000
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --mode countdown --duration-ms 10000 --quit-after-ms 12000
```

The three-second launch delay allows switching to a target app. «Закрити» dismisses
an ordinary overlay/card. Buttonless overlays require 1–3600 seconds and ignore
window-close requests until expiry; explicit local `hide_message()`/`clear(id)` can
still cancel them. Use `--quit-after-ms` for unattended harness cleanup.

By default no external window is minimized. Explicitly supply
`--allow-minimize-exe 'C:\Games\Game\Game.exe'` to permit one bounded fallback for
that executable's primary-monitor fullscreen window, after a topmost request.
Only use the actual resolved executable path, never an unrelated application.
See the validation protocol before interpreting this as fullscreen support.

`--capture .tmp/overlay.png` optionally captures the primary desktop for manual
inspection. Captures can include private desktop content; keep them local/ignored.
The harness prints only IDs, screen geometry/scaling, lifecycle events, and fixed
native result reasons. It never sends Telegram messages or calls network services.

## Presentation contracts

Call all UI methods on the Qt main thread with a QApplication running.
`OverlayWindow.show_message(text, dismissible, duration_ms)` and `hide_message()`
implement the agreed interface. NotificationCard uses `show_message(text,
duration_ms=10000)`; CountdownWindow uses `start_countdown(duration_ms, text)`.
Each show creates a local UUID available as `presentation_id`. `clear(id)` only
clears that currently active ID, so a stale ID cannot clear a replacement.

Signals `shown(id)`, `dismissed(id)`, and `expired(id)` describe the local widget
lifecycle. `completed(id, reason)` distinguishes `dismissed`, `replaced`, `cleared`,
and `expired`; each active ID terminates once. `shown` means the show request was
issued, not proof that a person saw the pixels. The later scheduler will map these
local IDs to action IDs and own deadline/repeat/free-use policy.
Callbacks may synchronously clear or replace a presentation. A newer show request
made inside a retirement callback supersedes the outer replacement request before
that outer request publishes an ID. Countdown state/timers are initialized before
`shown` is emitted. Notification cards grow within a bounded primary-screen area;
overflow remains reachable with scrollbars rather than clipping message text.

`ForegroundAdapter.reveal_overlay(hwnd)` returns PresentationResult with
`visible`/`unconfirmed`/`failed` state and a non-sensitive reason. This checkpoint
never automatically returns `visible`: accepted Win32 requests and
IsWindowVisible cannot prove pixel visibility over a game. `minimized_hwnd`, when
set, identifies a requested minimization for later foreground gating; it is not
proof of successful minimization. Do not persist or log foreground titles/paths.

Packaging, PyInstaller, Qt redistribution notices, and installation/autostart are
later checkpoints; this source setup is not a distributable release.


## ActivityWatch adapter checkpoint

Construct `LocalAWClient(host="127.0.0.1", port=5600, timeout=3, api_key=None)`
with an explicit local endpoint; supply a configured API key in memory if needed.
No proxies, redirects, retries, default-client settings lookup, or AW writes occur.
The timeout bounds socket operations, and a response is capped at 16 MiB.

`AWReader(client=client).probe()` reads metadata/settings during setup. Its chosen
bucket IDs stay local. Fresh AW v0.14.1 on this machine is reachable but has no
persisted category settings; save intentional app/title categories in the AW UI
and require a supported probe before counting. See the validation guide for preset
and legacy compatibility details. Do not print full settings or bucket/event data.

`live()` and `summarize(start, end, collection_started_at)` require the immutable
first-parent-pairing start. Enrollment is not that start. There is no collection
loop or durable store yet. The caller must inject `sequence_provider` from Task 5's
durable storage before sending snapshots; default 0 is an unsequenced candidate.
`settings` supplies selected category paths/revision. `owned_foreground` can
supply stronger known-own identity; the default recognizes exact existing
companion app/window identities while retaining other Python applications.

`health` exposes local ready/partial/stale/unavailable/unsupported state and the
last successful query/metadata poll instant; it does not establish power-off.
`last_summary` survives source failure. Task 5 owns network health propagation and
must retain last-known remote data/freshness rather than upload fabricated zero.

The countdown background is #242424 at alpha 179 (70% opacity), with fully opaque
white text via per-pixel transparency. Its existing position/lifecycle are preserved.

Current day summaries contain leaf-category totals only. The required
[application-name usage extension](../docs/application-usage-amendment.md) must be
reviewed and implemented before Task 5 sync/Task 7 formatting: daily app × leaf
aggregates, schema/version compatibility, Python/TS contracts and fixtures, and
reader/counting changes. App rows use selected intervals only and reconcile to
selected total when complete; missing data stays partial/unknown. No window-title
history is permitted. Customized persisted legacy categories are supported even
with stock names; truly unchanged install-default signatures remain unresolved
until explicit setup, as described in the validation guide.
