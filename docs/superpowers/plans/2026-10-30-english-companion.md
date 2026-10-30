# English in the Laptop App (Task 11g) Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The laptop app speaks Ukrainian or English, chosen in «Налаштування», defaulting to the
Windows display language.

**Architecture:**
- `aw_telegram/texts.py` holds `UK` and `EN` (same keys) and `t(key, **params)`. A module-level
  language is set once at startup and when the choice changes; the default is `uk`, so code that
  never sets it keeps today's text.
- `windows/language.py` wraps `GetUserDefaultUILanguage`; `texts.apply(choice)` resolves
  `system` / `uk` / `en` to the effective language (system: Ukrainian for primary language `uk`,
  English otherwise, and English if the call fails).
- The choice is stored in the local store's `app` config (`language`, default `system`), next to the
  ActivityWatch address.
- Every window and panel gets `retranslate()`; transient messages are remembered as factories
  (`ui/i18n.py` mixin) so a switch re-renders them. `CompanionApp.apply_language` stores, applies,
  swaps Qt's `qtbase_uk` translator (`ui/i18n.py`) and retranslates all open windows. Overlay,
  notification and countdown translate their own chrome whenever they are shown.
- Scheduler warning/overlay text and the status lines call `t()` at render time. Caregiver message
  text is never routed through `t()`.

**Tech Stack:** Python 3.12, PySide6, pytest-qt.

Spec: `docs/superpowers/specs/2026-10-30-english-design.md`, part 2. Task:
`docs/implementation-plan.md`, 11g.

## Global Constraints

- Companion only. No bot, contract or backend change.
- `status.py`: leave the `ONLINE = timedelta(...)` line and its comment untouched (a parallel bot
  branch changes those constants); no hard-coded sync/online seconds in new tests.
- Existing tests keep asserting Ukrainian text; `tests/conftest.py` pins language `uk` and mocks the
  native call for every test.
- Ukrainian text is moved verbatim; no wording changes.
- Owner-pending: a released build (11b) checked on the owner's desktop in both languages.

---

### Task 1: Catalogue, detection, storage

**Files:** `texts.py`, `windows/language.py`, `storage.py`, `ui/i18n.py`; tests `test_texts.py`,
`test_language.py`, `conftest.py`.

- [ ] **Step 1: Failing tests.** Key parity and non-empty values (and equal `{placeholders}`);
  `system_language` for `uk-UA`, `en-US`, others and a failing call (native mocked); `apply()`
  resolves each choice; the store persists `language` across reopen and rejects unknown values;
  Qt's translator installs only for `uk`.
- [ ] **Step 2: Implement** the modules and the store property/setter.
- [ ] **Step 3:** run the new tests.

### Task 2: Route the text

**Files:** `status.py`, `scheduler.py`, `uninstall.py`, `main.py`, `manual_presentation.py`,
`aw_reader.py`, `ui/*.py`; tests `test_texts.py`, `test_companion_ui.py`, `test_settings_ui.py`,
`test_access_ui.py`, `test_presentation.py`.

- [ ] **Step 1: Failing tests.** An AST scan fails on any Cyrillic string literal outside
  `texts.py` (docstrings and comments excepted), proven on a sample leftover; status lines,
  scheduler warnings and overlay text, uninstall report render in English.
- [ ] **Step 2:** move every literal into `texts.py` and call `t()`. `aw_reader`'s own-window titles
  accept both languages.
- [ ] **Step 3:** run the full suite; existing assertions unchanged.

### Task 3: The setting and live switching

**Files:** `ui/settings.py`, `ui/window.py`, `ui/tray.py`, `ui/access.py`, `main.py`.

- [ ] **Step 1: Failing tests.** «Мова / Language» offers System, Українська, English; choosing one
  stores it, switches `texts`, re-renders the settings, access, status, tabs and tray without a
  restart, and a restarted `CompanionApp` starts in the stored language; the next overlay and
  notification use it.
- [ ] **Step 2:** `retranslate()` everywhere, `CompanionApp.apply_language`, startup reads the
  stored choice (also before the uninstall prompts).
- [ ] **Step 3:** full suite and `python tools/licenses.py check`.

### Task 4: Docs

- [ ] `docs/companion-navigation.md` (language, window names), `docs/implementation-plan.md` 11g
  Done bullet with evidence and owner-pending items.
