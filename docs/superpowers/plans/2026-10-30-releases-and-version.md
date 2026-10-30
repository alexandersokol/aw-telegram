# Releases and the App Version (Task 11b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every companion change on `main` becomes a numbered, downloadable, self-checked build,
and the app shows which build it is.

**Architecture:**
- `VERSION` (repo root) holds `MAJOR.MINOR`. `companion/tools/release.py` (stdlib only, unit
  tested) holds all release logic: the next patch from git tags, stamping, the Windows version
  resource, the previous tag, notes, patch and the self-check report check.
- `companion/src/aw_telegram/_version.py` holds `VERSION = "0.0.0-dev"`. The release job
  overwrites it before the build; the app shows it in «Налаштування» and `--self-check` reports it.
- `aw-telegram.spec` builds the Windows version resource from the stamped `_version.py`, so there
  is one source of truth and no second file to drift.
- `.github/workflows/release.yml` runs on pushes to `main` that touch `companion/**`,
  `contracts/**` or `VERSION`, and on `workflow_dispatch` (dry run by default).

**Tech Stack:** GitHub Actions (`actions/checkout@v7`, `setup-node@v7`, `upload-artifact@v7`,
`gh` on the runner), the python.org CPython 3.12.6 installer, PyInstaller 6.22.3, pytest.

Spec: [2026-10-30-ci-release-readme-design.md](../specs/2026-10-30-ci-release-readme-design.md),
sections 2 and 3. Task: implementation-plan.md, 11b.

## Global Constraints

- Patch = 1 + the highest `v{MAJOR}.{MINOR}.N` tag, or 0 with none; `VERSION` `1.1` gives `1.1.0`.
- Concurrency group `release`, no cancellation. Permissions `contents: write`, built-in token only.
- The build uses the python.org installer `python-3.12.6-amd64.exe` with its SHA-256 pinned in the
  workflow (`5914748e6580e70bedeb7c537a0832b3071de9e09a2e4e7e3d28060616045e0a`; its MD5 matches
  the one python.org lists on the release page).
- Tests run before stamping, so the default `0.0.0-dev` is what they see.
- A failed run leaves no tag or release: publish as a draft (a draft has no tag), then publish it
  as the last step; if publishing fails, delete the draft.
- File and product version are `MAJOR.MINOR.PATCH.0`; local builds get `0.0.0.0`.
- Do not touch `bot/`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: The app knows its version

**Files:** `companion/src/aw_telegram/_version.py` (new), `main.py`, `ui/settings.py`,
`tests/test_packaging.py`, `tests/test_settings_ui.py`

- [ ] **Step 1: Failing tests.** `_version.VERSION == "0.0.0-dev"`; `self_check()` has a
  `version` entry equal to `VERSION` and the other entries stay `ok`; `--self-check` exits 0 with
  it; the Settings panel has a «Версія …» label that follows `VERSION`.
- [ ] **Step 2: Implement.** `_version.py`; `self_check()` adds `"version"`; `main` ignores that
  entry when judging `ok`; a small label at the bottom of `SettingsPanel`.
- [ ] **Step 3: Run** `tests/test_packaging.py tests/test_settings_ui.py`, then commit
  `feat: show the app version in Settings and the self-check`.

### Task 2: Release tooling

**Files:** `VERSION` (new, `1.0`), `companion/tools/release.py` (new),
`companion/tests/test_release.py` (new), `companion/aw-telegram.spec`

- [ ] **Step 1: Failing tests** (against throwaway git repos where git is involved): next
  version (none, existing, numeric not lexical order, other MAJOR.MINOR ignored, `1.1` restarts,
  bad `VERSION` rejected); stamping rewrites `_version.py` and the `pyproject.toml` version;
  the version resource carries `X.Y.Z.0` (dev: `0.0.0.0`); previous tag (highest across all
  versions, else the first commit); notes (not-signed line first, commits, files, compare link);
  patch bytes; the report check (all `ok`, version matches, mismatch fails).
- [ ] **Step 2: Implement** `release.py` with subcommands `next`, `stamp`, `previous`, `notes`,
  `patch`, `verify`.
- [ ] **Step 3: Spec** reads the stamped version, writes the resource into the work path and
  passes it to `EXE(version=...)`.
- [ ] **Step 4: Run** the new tests and the existing packaging tests; commit
  `feat: release tooling and a Windows version resource`.

### Task 3: The workflow

**Files:** `.github/workflows/release.yml` (new)

- [ ] **Step 1: Write the workflow:** checkout (`fetch-depth: 0`), Node + `npm ci` in `bot/`
  (the end-to-end test builds the bot), pinned python.org install, venv `.venv-build` from
  `requirements.lock`, licenses, tests, version, stamp, PyInstaller, self-check + verify, zip,
  dry-run artifact, notes and patch, draft release with assets, publish, draft cleanup on failure.
- [ ] **Step 2: Check** the YAML parses and has the required shape, and run the same commands
  locally as far as possible (version against this repo's history; a stamped PyInstaller build
  and `--self-check`; the Explorer version fields from the exe).
- [ ] **Step 3: Commit** `ci: build and publish a numbered release on companion changes`.

### Task 4: Docs

- [ ] **Step 1:** record 11b under `### 11b` in `docs/implementation-plan.md` (Done bullet with
  evidence and the owner-pending list); describe the release flow and the version in
  `docs/operations.md` or the doc that fits (check what mentions building the companion).
- [ ] **Step 2: Commit** `docs: record 11b (releases and the app version)`.

### Owner-pending (needs GitHub or the owner's desktop)

- A dry run (`workflow_dispatch`, `dry_run` true) on GitHub, once, before relying on the push trigger.
- The first real release, and its notes, assets and tag.
- File Explorer → Properties on the released exe shows `1.0.x.0`; «Налаштування» shows «Версія 1.0.x».
