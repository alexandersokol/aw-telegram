# CI, Releases, App Version and README Design

Status: approved by the owner in conversation, 2026-10-30; spec pending review.
Covers review notes 5 and 6 (docs/review-notes.md) and proposal D from the same session.

## Intent

Every change gets tested automatically, and every change to the companion produces a numbered,
downloadable build. The app shows which build it is, and the repository explains itself to a
new reader.

## Non-goals

- Deploying the backend from CI. That stays an owner action (operations.md).
- Code signing and automatic updates.
- Releases for bot-only or docs-only commits.

## 1. CI: `.github/workflows/ci.yml`

- **Triggers:** every push and every pull request.
- **Job `bot`** (`ubuntu-latest`, Node 22, Java 21 via `actions/setup-java`), in `bot/`:
  1. `npm ci`;
  2. `npm test`;
  3. `npm run build`;
  4. `npm run check:bundle`;
  5. `npm run test:emulator -- auth pairing rules sync delivery purge cleanup`, using the pinned
     `firebase-tools` from `bot/node_modules`.
- **Job `companion`** (`windows-latest`), in `companion/`:
  1. set up Python 3.12.6 with `actions/setup-python`. The tests don't need the python.org build;
     the installer requirement applies to the release build in section 2;
  2. create a virtual environment and `pip install -r requirements.lock`;
  3. run `python tools/licenses.py check`;
  4. run `python -m pytest -q`. Some UI tests need a real window; the Windows runner provides a
     desktop session, so they run without `QT_QPA_PLATFORM=offscreen`.
- **Permissions:** `contents: read`. No secrets are used.

## 2. Release: `.github/workflows/release.yml`

- **Trigger:** a push to `main` that changes `companion/**`, `contracts/**` or `VERSION`.
  - A `concurrency: release` group with no cancellation runs one release at a time, so version
    numbers never collide.
  - Permissions are `contents: write`; it uses the built-in `GITHUB_TOKEN`.
  - It checks out with `fetch-depth: 0` so tags and history are available.
- **Steps** (`windows-latest`):
  1. **Python:**
     - Download `python-3.12.6-amd64.exe` from python.org.
     - Check its SHA-256 against a value pinned in the workflow.
     - Install it silently for the job.
     - The spec (`companion/aw-telegram.spec`) refuses any other base Python, so the build matches
       the owner's workstation build.
  2. **Checks:** the same companion checks as CI: install, licenses, tests.
  3. **Version:**
     - Read `VERSION`, which holds `MAJOR.MINOR`, for example `1.0`.
     - Find the highest existing tag `v{MAJOR}.{MINOR}.{N}`. The patch is N+1, or 0 if there is
       none.
     - Bumping `VERSION` to `1.1` therefore starts at `1.1.0`.
  4. **Stamp:** write `companion/src/aw_telegram/_version.py` with `VERSION = "1.0.x"`, and a
     PyInstaller version-info file that the spec reads (section 3).
  5. **Build:** `pyinstaller --clean --noconfirm aw-telegram.spec`.
  6. **Verify:** `dist\aw-telegram\aw-telegram.exe --self-check report.json`. Every entry must be
     `ok`, and `version` must equal the stamped version.
  7. **Package:** zip `dist\aw-telegram\` as `aw-telegram-1.0.x-windows.zip`.
  8. **Diff:** take the previous tag, or the repository's first commit when there is none, as
     `PREV`, and write:
     - the notes: `git log --oneline PREV..HEAD` and `git diff --stat PREV..HEAD`, plus the
       compare link `https://github.com/<owner>/<repo>/compare/PREV...v1.0.x`;
     - the patch: `git diff PREV..HEAD > changes-1.0.x.patch`.
  9. **Publish:**
     - create the tag `v1.0.x` on `HEAD`;
     - create the GitHub release `1.0.x` with those notes and both files attached, using
       `gh release create`;
     - start the notes with a line saying the build is not code-signed, so SmartScreen will warn.
- **Failure:** if any step fails, nothing is tagged or released, and the number is taken by the
  next successful run.

## 3. Version in the app

- `companion/src/aw_telegram/_version.py` holds `VERSION = "0.0.0-dev"`. Local and test builds
  use that value; the release job overwrites it before building. The checked-in file keeps the
  dev value.
- «Налаштування» shows «Версія 1.0.x» in small text at the bottom.
- The `--self-check` report gains `"version": "1.0.x"`.
- `aw-telegram.spec` passes a Windows version resource built from the same value, with
  `FileVersion` and `ProductVersion` set to `1.0.x.0`, so File Explorer's Properties dialog shows
  it. Local builds get `0.0.0.0`.
- `pyproject.toml`'s `version` is set from `VERSION` during release (`1.0.x`), and stays `0.1.0`
  in the repository.

## 4. README and license

- **`LICENSE`:** the MIT License, `Copyright (c) 2026 alexandersokol`. The holder is the GitHub
  account name; replace it if a personal name is wanted.
- **`README.md`**, rewritten in English:
  1. Title, a one-line description, and badges for CI status, latest release and license.
  2. **What it does:** a short paragraph and a feature list:
     - reports;
     - daily limits with categories;
     - endtime;
     - reminders and overlays;
     - free use and clearing;
     - up to ten caregivers;
     - self-removal.
  3. **How it works:** a Mermaid diagram showing the three parts and what crosses each link:
     - the Windows companion with ActivityWatch;
     - Firebase Functions with Firestore and Cloud Tasks;
     - the Telegram bot.
     Include a short note on the 30 s pull.
  4. **Privacy:**
     - only aggregated usage and the current app and category leave the laptop;
     - retention is seven Kyiv dates;
     - message text is cleared after 24 hours;
     - there are no service-account keys.
  5. **Setup for owners**, a numbered guide. Each step links to setup.md or operations.md for the
     exact commands:
     - prerequisites;
     - cloud project;
     - secrets;
     - deploy;
     - webhook;
     - download a release or build the companion;
     - enroll the laptop;
     - pair caregivers.
  6. **Using the bot:** the core commands and the menu, with a link to the full command list.
  7. **Development:**
     - the repository layout;
     - toolchain versions (Node 22, Python 3.12, Java 21 for the emulator);
     - commands for unit, emulator and e2e tests;
     - regenerating contracts;
     - building the companion;
     - the CI and release workflows and how to bump `VERSION`.
  8. **Contributing, security reporting, license and acknowledgements:** ActivityWatch, and
     Qt/PySide6 under LGPL-3.0, whose texts ship in `companion/licenses/`.
  - Screenshots: add a `docs/images/` folder when the owner supplies them. The README does not
    reference images that don't exist.
- **`companion/README.md`:** replaced with short developer notes covering the virtual
  environments, running the tests, building and the self-check, with links back to the root
  README.

## Tests and checks

- The first CI run on a branch must pass both jobs before the release workflow merges.
- **Release dry run:** the release workflow also allows `workflow_dispatch` with a `dry_run`
  input. A dry run builds, verifies and uploads the zip as a workflow artifact, but creates no tag
  or release. Use it once before relying on the push trigger.
- **Companion unit tests:**
  - the self-check reports the version;
  - the Settings window shows it;
  - `_version.py` defaults to `0.0.0-dev`.
- `tools/licenses.py check` keeps passing with the new `LICENSE` file.
