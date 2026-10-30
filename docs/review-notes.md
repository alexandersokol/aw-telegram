# Review notes

Findings from using the deployed system, collected to fix later. Add each new finding
at the end with the next number. When one is fixed, set its status and name the commit.

Status values: **open**, **designed (spec)**, **in progress**, **fixed (commit)**, **won't fix (reason)**.

---

## 1. No way back to the main menu after a command reply

- **Status:** fixed (81fc865, Task 11e) — docs/superpowers/specs/2026-10-30-bot-ux-design.md;
  deploy and live check pending
- **Found:** 2026-10-30, live acceptance (checkpoint 10d), one caregiver account.
- **Area:** Telegram bot, `bot/src/telegram/`.

**What happens.** Many command replies arrive as plain text with no buttons. To get back to the
menu the caregiver has to type `/start`. That makes the bot hard to use.

**Wanted.** Add a «Головне меню» button to the replies that a command produces, except for:
- replies that already have their own navigation (menu screens, submenus, period pickers);
- confirmation messages about the laptop;
- the shared status messages sent to caregivers (alerts, coordination, delivery status).

**Where.** These replies are built with `buttons: []`:
- the `plain()` helpers in `webhook.ts` (`reply`), `allowance.ts`, `clear.ts` and `reminders.ts`;
- `endtimeSaved` and the usage errors in `commands.ts`;
- `savedText` results in `allowance.ts`;
- `/hourly`, `/help` and unknown-command replies in `webhook.ts`.

Shared status messages go through the outbox (`bot/src/outbox.ts`), not through these replies, so
they stay as they are. Stale-menu toasts, the pairing hint for unpaired users and the farewell
after `/unpair` must not get the button either.

**Notes for the fix.**
- Opening a menu session for every reply would make any other open menu's buttons stale, because
  each caregiver has one session. A stateless callback that only opens the main menu (for example
  `nv:home`, handled before the session lookup) avoids that. Opening the main menu changes nothing,
  so the button doesn't need replay protection.
- Add it in one place, for example a `withHome(reply)` helper applied in `webhook.ts` before
  `deliver`. It should only touch replies with no buttons that are not toasts and are not marked
  to stay bare.
- Open question: what exactly does "confirmation on the device" cover? There are two readings:
  - replies that end with «⏳ Очікуємо підтвердження від ноутбука» (for example after `/clear`);
  - the review screens that ask the caregiver to confirm (they already have buttons).
  Settle this before implementing.
- Tests: `bot/tests/webhook.test.ts` (button present or absent per reply kind, and the tap opens
  the main menu without making another open menu stale) and an e2e check.

## 2. Border around the text of the laptop notification

- **Status:** fixed (d65f017); desktop check owner-pending
- **Found:** 2026-10-30, live acceptance (checkpoint 10d), on the workstation.
- **Area:** companion, `companion/src/aw_telegram/ui/notification.py`.

**What happens.** The notification card on the laptop shows a visible border around the message
text.

**Wanted.** No border around the text box.

**Where.** The text sits in a `QScrollArea` (`notification.py:20`), whose default frame draws the
border. Set `self.message_scroll.setFrameShape(QFrame.Shape.NoFrame)`. If the scroll area
background still differs from the card, also make its viewport transparent. `_position` already
subtracts `frameWidth()`, so the sizing follows automatically, because the width becomes 0.

**Notes for the fix.**
- Check the overlay and the countdown surface for the same look; only `notification.py` uses a
  `QScrollArea` today.
- Tests: extend the companion notification UI test to assert the scroll area has no frame
  (`frameShape() == QFrame.Shape.NoFrame`, `frameWidth() == 0`), then rebuild the portable app and
  check it on the desktop.

## 3. Settings changes never report that the laptop applied them

- **Status:** fixed (11ad3f0, b40be0e, Task 11e) — docs/superpowers/specs/2026-10-30-bot-ux-design.md;
  deploy and live check pending
- **Found:** 2026-10-30, live acceptance (checkpoint 10d).
- **Area:** Telegram bot and backend sync, `bot/src/telegram/`, `bot/src/deviceApi.ts`.

**What happens.** The reply to a settings change (`/limit`, `/free`, categories, `/clear`,
`/restore`, `/endtime`) says «Ноутбук: очікує застосування.» while the laptop hasn't picked it up
yet. Nothing follows when the laptop applies it a few seconds later. To find out, the caregiver
has to open the setting again. Laptop messages (`/notify`, `/overlay`) already get status messages;
settings don't.

**Wanted.** The reply only reports that the change was saved, without the "waiting" line. When the
laptop confirms the change, the caregiver who made it gets a short status message, the same way
laptop message statuses arrive today.

**Where.**
- The acknowledgement arrives in sync: `deviceApi.ts:86` advances `settingsAckRevision`. When it
  passes a revision that a caregiver created, enqueue a status event for that caregiver through the
  existing outbox (`bot/src/outbox.ts`).
- Reply copy: `savedText`, `appliedLine`, `endtimeSaved` and the «⏳ Очікуємо підтвердження від
  ноутбука» texts in `bot/src/telegram/uk.ts`.

**Notes for the fix.**
- Several revisions can be acknowledged in one sync. Send one message per acknowledged change, or
  combine them into one message per caregiver per sync; decide which.
- Who gets it: the caregiver who made the change. Other caregivers already get the coordination
  message about the change; an "applied" message to them as well may be noise.
- If the laptop stays offline, nothing is sent. Optionally say so in the save reply («застосується,
  коли ноутбук буде на зв’язку»).
- This interacts with finding 1: the save reply would no longer count as a "confirmation" message.
- Tests: unit tests for one and several acknowledgements in a sync, a redelivered sync that sends
  nothing twice, and an e2e check.

## 4. English language in the bot, chosen per Telegram user

- **Status:** fixed (13ff509, 749f5b0, Task 11f bot, Task 11g laptop app) —
  docs/superpowers/specs/2026-10-30-english-design.md (extended to the laptop app: a language
  setting there, default from the Windows display language, otherwise English); deploy, release
  and live check pending
- **Found:** 2026-10-30, owner request during live acceptance.
- **Area:** Telegram bot, all user-facing text.

**What happens.** All bot text is Ukrainian, from one module, `bot/src/telegram/uk.ts`.

**Wanted.** Ukrainian and English, with a switch in the bot. The choice belongs to each Telegram
user and applies only to them.

**Where.**
- `uk.ts` holds the copy (about 60 exports). Turn it into a message catalogue with a Ukrainian and
  an English variant behind one lookup function, and have the controllers render with the
  caregiver's language.
- Store the choice on the caregiver, either the parent document or the `telegramUsers/{id}`
  binding. The binding also covers unpaired users, who see the pairing hint; decide where.
- The switch: a Settings button (for example «Мова: українська» / "Language: English") and a
  `/language uk|en` command, listed in `/help`.
- Outbox messages (alerts, coordination, statuses) are rendered once when the event is created
  (`bot/src/outbox.ts`). With per-user languages they must be rendered per recipient.

**Notes for the fix.**
- Default: Ukrainian. Optionally pick English for new users whose Telegram `language_code` isn't
  `uk`.
- Category and app names come from ActivityWatch and are not translated.
- The laptop app's language (`companion/src/aw_telegram/ui/i18n.py`) is a separate decision.
- Bot command names stay English (`/limit`, `/usage`). Only text and buttons change.
- Tests: every message key exists in both languages, switching affects only that caregiver, and
  a two-caregiver alert arrives in each one's own language.

## 5. CI/CD: build and release the companion on every commit to main

- **Status:** fixed (Task 11a CI checks, Task 11b releases and app version, 2026-10-30); the first GitHub run (the first push to main publishes release 1.0.0) is pending. Spec: docs/superpowers/specs/2026-10-30-ci-release-readme-design.md
- **Found:** 2026-10-30, owner request.
- **Area:** new `.github/workflows/`, `companion/`.

**What happens.** The companion app is built by hand on the owner's workstation (setup.md).
There is no CI, no tag and no release.

**Wanted.** On each new commit to `main`, a workflow:
1. builds the portable companion app;
2. creates a tag and a GitHub release whose name and tag follow `1.0.x`, where `x` goes up by one
   with every build;
3. attaches the build as the release artifact;
4. lists the changes since the previous release in the release notes.

The major and minor numbers are set by hand, and changing them restarts `x` at 0.

**Where and how.**
- Runner: `windows-latest`. The PyInstaller spec refuses any base Python other than a python.org
  CPython for Windows (`companion/aw-telegram.spec:14-21`, which checks its `LICENSE.txt`). Check that
  `actions/setup-python` 3.12 passes that check, or install the python.org 3.12.6 installer in the
  job.
- Steps:
  - install `requirements.lock`;
  - run `tools/licenses.py check` and the companion test suite;
  - run `pyinstaller --clean --noconfirm aw-telegram.spec`;
  - run `aw-telegram.exe --self-check` and require every entry to be `ok`;
  - zip `dist/aw-telegram/`.
- Version:
  - keep the major and minor numbers in one file, for example `VERSION` containing `1.0`;
  - the patch is one more than the highest existing `v1.0.*` tag, or 0 when there is none, so
    bumping `VERSION` to `1.1` restarts it;
  - stamp the version into the app (`pyproject.toml`, a Windows version resource, and the
    self-check report).
- Release: create the tag `v1.0.x` and release `1.0.x` with the `GITHUB_TOKEN`
  (`contents: write`). The notes come from `git log --oneline <previous tag>..HEAD` and
  `git diff --stat <previous tag>..HEAD`; the full diff is too large for release notes.
- Concurrency: one release job at a time (a `concurrency` group), so two quick pushes can't take
  the same number.

**Notes for the fix.**
- Decide whether docs-only commits should release. A `paths` filter on `companion/` and `contracts/`
  avoids a new version for every docs change.
- The bot backend is deployed separately by the owner (operations.md). This workflow doesn't
  deploy anything.
- The app is not code-signed (setup.md), so Windows SmartScreen will warn on the downloaded build.
- Run the bot unit tests in the same workflow, or in a separate check, so a red backend doesn't
  release a matching companion.

## 6. A proper README for GitHub

- **Status:** fixed (11a4f25, Task 11h) — docs/superpowers/specs/2026-10-30-ci-release-readme-design.md;
  view on GitHub pending
- **Found:** 2026-10-30, owner request.
- **Area:** `README.md` (repository root).

**What happens.** The root `README.md` is an old progress log by task number. It doesn't
explain the project to a new reader. `companion/README.md` has the same problem.

**Wanted.** A well-formatted README following common GitHub practice. It needs:
- a project description;
- an overview;
- a detailed setup guide;
- a guide for developers.

**Suggested outline.**
1. Title, a one-line description, and badges (CI status from finding 5, latest release, license).
2. What it does: caregivers use Telegram to see a child's Windows laptop activity from
   ActivityWatch, set daily limits and an endtime, and send reminders. Include a short feature
   list and a screenshot or two (bot menu, laptop overlay).
3. How it works: a diagram of the three parts (companion on the laptop, Firebase Functions
   backend, Telegram bot) and the data that crosses each link. Include privacy notes: retention,
   no message text kept past 24 hours, what leaves the laptop.
4. Setup for owners: prerequisites (Windows, ActivityWatch, a Google Cloud project on Blaze, a
   BotFather token), cloud setup, deploy, the webhook, enrolling a laptop and pairing caregivers.
   Link setup.md and operations.md for the details instead of repeating them.
5. Using the bot: the main commands and menus, with a link to the full command list.
6. Development:
   - repository layout (`bot/`, `companion/`, `contracts/`, `docs/`);
   - local setup for Node 22 and Python 3.12;
   - running the unit, emulator and e2e tests;
   - regenerating contracts;
   - building the companion;
   - coding conventions.
7. Contributing, security reporting, license, acknowledgements (ActivityWatch, Qt/PySide6 licenses).

**Notes for the fix.**
- Replace the task-progress text. That history lives in `docs/implementation-plan.md` and git.
- Trim `companion/README.md` to a short pointer, or rewrite it as the companion's developer notes.
- The repository has no license file yet. Choosing one is the owner's decision and the README
  depends on it.

## 7. Each laptop exceeds the Firestore free allowance

- **Status:** fixed (0a2487d, f0c4f2d, 5459e9b, 282567e, Task 11d) — docs/superpowers/specs/2026-10-30-sync-cost-design.md;
  deploy and live measurement pending
- **Found:** 2026-10-30, measured during live acceptance (proposal A of the review session).
- **Area:** companion sync, `bot/src/deviceApi.ts`.

**What happens.** One laptop that stayed online cost 1,051 writes and 4,188 reads an hour. That
is about 25,000 writes and 100,000 reads a day, against Firestore's free 20,000 and 50,000. The
companion syncs every 15 s, and every sync rewrites health and live and reads all stored days and
the alert state.

**Wanted.** Sync every 30 s, skip unchanged writes and unneeded reads, and measure the result.
The target is about 4,000 writes and 20,000 reads a day per laptop.

## 8. Cloud hardening found at the first deploy

- **Status:** designed (here). The steps are owner-run gcloud commands, then a redeploy.
- **Found:** 2026-10-30, first deployment (proposal C of the review session).
- **Area:** the Google Cloud project `aw-telegram`, setup.md and operations.md.

**What happens.**
- Cloud Build builds the functions as the default compute account,
  `1094377867688-compute@developer.gserviceaccount.com`. That account holds project
  `roles/editor` by Google default. Nothing else uses it, because both functions run as
  `aw-backend`.
- The Firebase CLI enabled the Firebase Extensions API during the first deploy, and nothing
  uses it.

**Wanted.** Function builds run with only the roles they need, and the unused API is off.

**Steps.**
1. Check whether Firebase CLI 15.34.1 can deploy with a dedicated build service account (Cloud
   Functions gen2 `buildServiceAccount`).
   - **If it can:** create `aw-build@aw-telegram.iam.gserviceaccount.com` with
     `roles/cloudbuild.builds.builder` and `roles/artifactregistry.writer`, plus
     `roles/logging.logWriter`. Add read access to the source bucket if the builder role doesn't
     include it. Point the deploy at it.
   - **If it can't:** keep the default compute account as the builder, but replace its project
     `roles/editor` with exactly those roles.
2. Remove `roles/editor` from the default compute account. Do this only after confirming no
   other resource runs as it: list Cloud Run services, functions and scheduler jobs with their
   identities.
3. Redeploy the functions once, unchanged, to prove builds still work. Then make one `/status`
   request and check the request logs.
4. Disable the API: `gcloud services disable firebaseextensions.googleapis.com
   --project=aw-telegram`. Do this only if no extension is installed:
   `firebase ext:list --project aw-telegram` must show none.
5. Record the result in setup.md (service accounts table) and operations.md (deploying).

**Rollback.** Grant `roles/editor` back to the default compute account and re-enable the API.
Neither affects the running functions.
