# English in the Bot (Task 11f) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** each caregiver uses the bot in Ukrainian or English, and shared alerts reach every
recipient in theirs.

**Architecture:**
- `bot/src/telegram/i18n/uk.ts` holds all bot copy (the reference catalogue), `en.ts` the
  English one, typed `satisfies typeof uk`; `index.ts` exports `Lang`, `text(lang)`, the
  `language_code` fallback, `both()` for shared messages, `Reply` and `Button`.
- The language is resolved into `ParentIdentity.lang` by `authorizeParent`/`authorizeCallback`:
  the stored `telegramUsers/{id}.lang`, otherwise `language_code` (`uk*`/`ru*` give `uk`, else
  `en`). Unpaired replies use the fallback.
- A stored choice is written to the binding (kept on revocation and re-pairing) and mirrored on
  `devices/{d}/parents/{id}.lang`, which every fan-out already reads, so per-recipient language
  costs no extra Firestore reads.
- Events carry `text: {uk, en}`; each outbox row stores the recipient's version (parent `lang`,
  default `uk`). Delivery reads only rows, so rows queued by the old backend still send.
- Applied notices store `summary: {uk, en}` and the author's `lang`; old string summaries are
  sent as stored.
- `webhook.ts set` registers English commands (default) and Ukrainian (`language_code: 'uk'`).
  The spec does not add `/language` to the menu, so it keeps 11e's 8 commands.

**Tech Stack:** TypeScript 5.9, vitest, Firestore emulator.

Spec: [2026-10-30-english-design.md](../specs/2026-10-30-english-design.md), part 1. Task:
implementation-plan.md, 11f.

## Global Constraints

- No contract change; backend-only deploy. Idle and summary sync operation counts stay as pinned.
- Ukrainian copy is moved verbatim; existing tests keep their Ukrainian expectations (test
  updates use `language_code: 'uk'`).
- Settings button «🌐 Мова: Українська» / "🌐 Language: English"; choice «Українська» / "English".
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Catalogues

**Files:** create `bot/src/telegram/i18n/{index,uk,en}.ts`; delete `bot/src/telegram/uk.ts` and
`bot/src/format.ts`; test `bot/tests/i18n.test.ts`.

- [x] Test: every English and Ukrainian value (strings, nested strings, functions called with
  sample arguments) is non-empty; `languageOf` maps `uk`, `uk-UA`, `ru` to `uk`, `en`, `de`,
  missing to `en`; durations render in both languages.
- [x] Move every literal from controllers, reports and backend message builders into `uk`,
  translate into `en`; a compile-time check rejects differing parameter lists.

### Task 2: Resolving and choosing the language

**Files:** `repository.ts`, `pairing.ts`, `settings.ts`, `telegram/webhook.ts`,
`telegram/navigation.ts`; tests in `tests/language.test.ts`.

- [x] Tests: fallback from `language_code`; stored choice overrides it; unpaired users get the
  pairing hint in the fallback; `/language en|uk` and the Settings choice change only that
  caregiver, create no event, and survive `/unpair` plus re-pairing; `/language` alone shows
  the choice; `/help` lists it.
- [x] `privateActor` passes `languageCode`; `authorizeParent`/`authorizeCallback` resolve `lang`;
  `pairParent` keeps the binding's `lang` and copies it to the parent; `setLanguage` writes both.

### Task 3: Shared messages per recipient

**Files:** `outbox.ts`, `actions.ts`, `alertPlans.ts`, `settings.ts`, `endtime.ts`,
`notices.ts`; tests in `tests/language.test.ts`, `tests/notices.test.ts`.

- [x] Tests: an alert to a Ukrainian and an English caregiver gives one row in each language;
  an applied message reaches its author in the author's language; an old row with a single
  string still delivers unchanged; an old string notice summary still sends.
- [x] `ParentEvent.text` becomes `{uk, en}`, built with `both()`; rows pick the recipient's.

### Task 4: Durations, command menu, E2E

- [x] `parseDuration` accepts `1 h 30 min`, `90 min`, `1 год 30 хв`, `90 хв`, `2:30`.
- [x] `WebhookAdmin.set` calls `setMyCommands` twice; `info` lists both menus.
- [x] E2E: a caregiver switches to English and receives the next alert in English while
  another stays in Ukrainian.

### Task 5: Docs

- [x] LANG-01 (user-requirements.md), bot-navigation.md (language row, `/language`),
  technical-design.md (`lang` fields), hosting-cost-estimate.md (no extra reads), the 11f
  Done bullet in implementation-plan.md.
