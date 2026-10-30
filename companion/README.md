# Windows companion: developer notes

The companion is a PySide6 tray app for Windows x64 (Python 3.12). It reads the local
ActivityWatch server, syncs with the backend every 30 s, and shows reminders, overlays and the
Settings window. What the project does, how to set it up and the architecture are in the
[root README](../README.md); this page covers working on the companion.

## Virtual environments

Two separate environments, both from `requirements.lock` (every runtime, test and build
dependency is pinned there). Run the commands from this directory in PowerShell.

- **Tests** (`.venv`, any Python 3.12):

  ```powershell
  python -m venv .venv
  .venv/Scripts/python.exe -m pip install -r requirements.lock
  ```

- **Builds** (`.venv-build`): made from a python.org CPython 3.12 for Windows, because the
  PyInstaller spec refuses any other base Python. Commands:
  [docs/setup.md](../docs/setup.md#companion-laptop).

If sandbox temp storage is unwritable, set `TEMP` and `TMP` to an existing ignored local
directory such as `companion/.tmp` before creating the environment.

## Running the tests

```powershell
.venv/Scripts/python.exe tools/licenses.py check
.venv/Scripts/python.exe -m pytest -q
```

Do not set `QT_QPA_PLATFORM=offscreen`; some UI tests need a real window. The cross-process
test `tests/test_e2e_simulated.py` builds the bot and serves it on loopback, so run `npm ci` in
`../bot` first. CI runs the same two commands (`.github/workflows/ci.yml`).

## Building and the self-check

Build with `.venv-build\Scripts\pyinstaller.exe --clean --noconfirm aw-telegram.spec`, which
writes the portable folder `dist\aw-telegram\`. `tools\licenses.py check` must pass first: it
verifies that `licenses/` holds the license texts the PySide6 wheels and Python omit.

Check a build with:

```powershell
dist\aw-telegram\aw-telegram.exe --self-check report.json
```

Every entry in the report must be `ok`, except `version`, which names the build. A local build
reports `0.0.0-dev` (`src/aw_telegram/_version.py`); the release workflow
(`.github/workflows/release.yml`, using `tools/release.py`) stamps `1.0.x` and requires the
self-check to report it. See [CI and releases](../README.md#ci-and-releases).

Other command-line options: `--background` (start hidden in the tray, as autostart does) and
`--uninstall`.

## Manual presentation harness

`aw_telegram.manual_presentation` shows the overlay, notification card and countdown without a
backend or Telegram, for checking them by eye. It waits three seconds before showing, so you can
switch to the target app:

```powershell
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --duration-ms 10000 --quit-after-ms 12000
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --mode notification --quit-after-ms 12000
.venv/Scripts/python.exe -m aw_telegram.manual_presentation --mode countdown --duration-ms 10000 --quit-after-ms 12000
```

`--buttonless` shows an overlay that cannot be dismissed until it expires. By default no other
window is minimized; `--allow-minimize-exe` and `--capture` are explained in
[Windows validation](../docs/windows-validation.md), which also records what has and has not been
verified over fullscreen games. Captures can contain private desktop content; keep them in
ignored local folders.

## Where to read more

- [Companion interface](../docs/companion-navigation.md) and [API contract](../docs/api-contract.md)
- [Sync and local storage](../docs/sync-storage.md) and
  [enrollment security](../docs/enrollment-security.md)
- [ActivityWatch evidence and limitations](../docs/activitywatch-validation.md)
- [Technical design](../docs/technical-design.md)
