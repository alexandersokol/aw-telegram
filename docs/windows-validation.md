# Windows presentation validation — Task 1

Date: 2026-10-27. Status: automated assertions pass; remaining manual acceptance
blocks release. The user authorized Roblox testing on this PC. Roblox F11
fullscreen visual layering was observed; its borderless/exclusive renderer mode
was not established.

## Recorded environment and evidence

- Python 3.12.14; PySide6-Essentials/shiboken6 6.12.0; Windows x64.
- `platform.platform()`: `Windows-11-10.0.26300-SP0`.
- The agent process reported `IsUserAnAdmin: False` (standard token).
- Controller-observed primary desktop: 2560×1440 physical pixels; Qt reports
  1707×960 device-independent coordinates with devicePixelRatio 1.5 (150%).
- Controller ran the harness on the signed-in desktop, captured and viewed one
  isolated overlay. Centered opaque white Ukrainian text and the bottom «Закрити»
  button appeared over a translucent dim desktop. Native result remained
  `unconfirmed / topmost_requested`, with no minimization requested. The overlay
  auto-expired and the harness exited 0. An earlier capture had overlapping
  harnesses; only the isolated capture was used for the visual observation.
- Screenshots are local ignored scratch (`companion/.tmp/desktop-overlay-single.png`)
  and contain private desktop/chat content; they are not committed.
- The UI automation window inventory omitted the tool window despite visible
  pixels in the desktop capture. Enumeration and IsWindowVisible are not used as
  proof of actual presentation.
- Controller observed Roblox GDK 2.744.1075.0, Chop A Forest, after the user manually
  toggled F11: no titlebar and a full 1707×960 DIP game surface. A controller-viewed
  physical 2560×1440 capture showed actual gameplay under the dim layer, opaque
  centered Ukrainian text, and bottom «Закрити». No game was minimized; native
  result stayed `unconfirmed / topmost_requested`. Harness arguments were
  `--duration-ms 8000 --delay-ms 1000 --quit-after-ms 10000 --capture .tmp/roblox-fullscreen-overlay.png`.
  The overlay expired and the process exited 0. The capture contains player names
  and remains local/ignored. This proves visual layering in that F11 state only.

From companion/ with its local virtual environment:

```powershell
.venv/Scripts/python.exe -m pytest -q
# Latest after review fix round 1: 45 passed in 6.66s, exit 0
.venv/Scripts/python.exe -m pip check
# No broken requirements found., exit 0
```

The latest full test run also printed `Windows fatal exception: code 0x8001010d`
from pytest-qt `_process_events`; the process continued through all 45 passing
assertions and exited 0. The same nonfatal diagnostic appeared in focused RED and
GREEN runs, and persisted with controller desktop automation paused. Its cause
is not established; the run is not described as diagnostic-free. Earlier controller
verification before the review fixes was 39 passed in 5.27s without that diagnostic.

The suite checks real Qt alpha pixels/opaque white ink, screen geometry and
screen/DPI signal handling, click-capture flags and Qt event routing, dismissal,
buttonless duration, expiry, replacement, stale-ID clearing, countdown, runnable
harness modes, real Win32 pointer-sized handle bindings, and conservative adapter
policy. OS operations use controlled boundary doubles for unsafe-window/race
cases. Those policy tests do not prove behavior in a real game's fullscreen mode.
Synthetic Qt clicks do not prove physical Windows click routing to another app.

## Reproduce desktop smoke

Install using companion/README.md, then run from companion/:

```powershell
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --duration-ms 10000 --quit-after-ms 12000
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --buttonless --duration-ms 5000 --quit-after-ms 7000
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --mode notification --quit-after-ms 12000
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --mode countdown --duration-ms 10000 --quit-after-ms 12000
```

Launch delay is three seconds. Lifecycle `shown` means a local show request;
`completed`/dismissal/expiry are widget events. Native return values never upgrade
the result to `visible`. Optional `--capture .tmp/overlay.png` saves a primary
desktop PNG after 250 ms; inspect it, and use an external photo if a protected
surface is absent from capture. Do not commit private screenshots.

Endtime ordering (real presenter/scheduler, temporary store, simulated clock 3 s
before a 21:00 endtime; prints `card_shown`, `overlay_shown`, `overlay_completed` and
the queued receipt count). Run both orders and dismiss with «Закрити»:

```powershell
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --mode endtime-sequence --order manual-first --quit-after-ms 150000
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --mode endtime-sequence --order endtime-first --quit-after-ms 150000
```

Midnight and suppression removal are covered by automated tests only.

Endtime evidence, 2026-10-29, Windows 11 build 10.0.26300, owner's development
desktop (not the son's laptop), standard user context:

- Owner runs (A, B, B with `--delay-ms 15000`): the manual overlay appeared with
  native `topmost_requested`, «Закрити» dismissed it, and it recurred one minute
  later. The endtime overlay never appeared and receipts were 0. Cause: a harness
  defect, since fixed. The simulated clock ran during `--delay-ms`, so the first tick
  landed after endtime and the policy correctly skipped the date. These runs therefore
  do not verify replacement ordering.
- Controller real-desktop run after diagnosis (`manual-first`, `--delay-ms 0`, no
  clicks, event log only, pixels not inspected): manual shown, then `cleared` and
  replaced by endtime at endtime, both `topmost_requested`, receipt count 1.
- Pending: owner re-run of both orders with the fixed harness, observing the
  replacement visually and clicking «Закрити».

## Pending acceptance protocol

Record game name/version, actual executable path, Windows build, token/elevation,
physical/DIP resolution, DPI, monitor arrangement, mode, outcome, and evidence
reference for every run. Do not mark a row passed from the automated suite.

| Case | Required observation | Status |
|---|---|---|
| Roblox F11 fullscreen, primary | Text/button visibly above actual gameplay | Observed PASS for visual layering; renderer mode not established |
| Target game, borderless primary | Text/button visibly above game, dim only primary | Pending: confirm renderer mode |
| Target game, exclusive primary | Visible or accurate unconfirmed result; fallback observed separately | Pending: exclusive mode not established |
| Opt-in minimize fallback | Only approved primary fullscreen game receives one minimize request | Pending: fallback not exercised |
| Unrelated foreground app | Never minimized, even if an approved game exists behind it | Pending: physical run |
| Elevated/system dialog | No minimize attempt; OS restrictions remain effective | Pending: physical run |
| Physical clicks | Clicking background cannot trigger an underlying test-app control; close button works once | Pending: physical run |
| Buttonless duration | No close button; Alt+F4/close cannot dismiss early; expires at duration | Pending: physical run |
| Monitor/primary/DPI change | Overlay follows primary with full DIP geometry; other monitors undimmed | Pending: hardware run |
| Endtime: manual then endtime | Endtime replaces the manual overlay on primary; the manual family never returns | Pending: physical run (offscreen smoke only) |
| Endtime: endtime then manual | Manual replaces endtime; endtime returns ~1 min later as newest; «Закрити» clickable | Pending: physical run (offscreen smoke only) |
| Endtime recurrence/suppression | Dismissal recurs after one minute; no foreground oscillation with a fullscreen app | Manual-overlay recurrence observed by owner; endtime recurrence and fullscreen pending |
| Notification/countdown | Card lifetime and top-left countdown remain controllable on primary | Automated; physical run pending |

For a fallback run, add the actual game's full path (example only):

```powershell
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --duration-ms 10000 --quit-after-ms 12000 --allow-minimize-exe 'C:\Games\Game\Game.exe'
```

No executable is allowed by default. The fallback is explicitly opt-in and
deterministic for an eligible fullscreen candidate, after the initial topmost
request; it does not guess whether the first request produced visible pixels.
The adapter captures foreground before showing the overlay, accepts only an
exact normalized executable path, checks a top-level unowned window with a
primary-monitor-sized client area, rejects shell/dialog/cloaked/hung/minimized
windows, elevated or Windows-directory processes, unknown identity, and other
sessions. It revalidates the complete identity just before asynchronous
minimization. A remaining OS race cannot be eliminated atomically; no retry/focus
loop or synchronous cross-process message is used. Async success means requested,
not confirmed minimized. Store that distinction in later action receipts.

The overlay accepts/captures mouse events; it has no keyboard hook or OS lock.
Secure desktop, anti-cheat bypass, tamper resistance, and game injection are
outside scope. Foreground/category/AFK gating belongs to later Tasks 3 and 8.

## Primary API references checked

- [Qt QWidget transparency and window behavior](https://doc.qt.io/qtforpython-6/PySide6/QtWidgets/QWidget.html)
- [Qt QScreen geometry and DPI signals](https://doc.qt.io/qtforpython-6/PySide6/QtGui/QScreen.html)
- [SetWindowPos flags and topmost](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)
- [ShowWindowAsync request semantics](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindowasync)
- [GetMonitorInfoW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getmonitorinfow)
- [OpenProcessToken and handle ownership](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken)
- [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation)
