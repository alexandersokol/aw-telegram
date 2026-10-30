# English Language Design (bot and laptop app)

Status: approved by the owner in conversation, 2026-10-30; spec pending review.
Covers review note 4 (docs/review-notes.md), extended by the owner to the laptop app.

## Intent

Caregivers can use the bot in Ukrainian or English, each choosing for themselves. The laptop app
can also run in Ukrainian or English, set on the laptop. Neither part changes the sync contract,
so the bot and the laptop app ship independently. Each part gets its own implementation plan.

## Non-goals

- Languages other than Ukrainian and English.
- Translating ActivityWatch category or app names, or the text a caregiver types for a
  notification or overlay.
- Translating command names (`/limit`, `/usage` and the rest).
- Caregivers choosing the laptop's language from Telegram.

## Part 1: the bot

**Catalogue.**
- `bot/src/telegram/uk.ts` moves to `bot/src/telegram/i18n/uk.ts`, with a new
  `bot/src/telegram/i18n/en.ts`.
- The English file is typed `satisfies typeof uk`, so a missing key or a function with a different
  signature fails to compile.
- `i18n/index.ts` exports `type Lang = 'uk' | 'en'` and `text(lang)`, which returns the catalogue.
- Every controller renders through `text(identity.lang)` instead of importing constants directly.

**Choosing the language.**
- **Stored choice:** `lang` on `telegramUsers/{userId}`, written only when the user picks a
  language.
- **Fallback:** without a stored choice, use the update's `from.language_code`. A value starting
  with `uk` or `ru` gives `uk`; anything else, including a missing value, gives `en`.
- **Resolution:** `authorizeParent` and `authorizeCallback` resolve it into
  `ParentIdentity.lang`. The private-update adapter passes `language_code` along with the actor.
- **Unpaired users:** the pairing hint, pairing failures and throttling texts use the fallback.
- **On revocation:** the stored choice stays on the binding, so the same account keeps its
  language after pairing again.

**Switching.**
- **Settings button:** one row, «🌐 Мова: Українська» in Ukrainian and "🌐 Language: English" in
  English. Tapping it opens a two-button choice, «Українська» / "English", then returns to Settings
  in the chosen language.
- **Command:** `/language uk` or `/language en`. With no argument it shows the choice.
- **Help:** `/help` lists it.
- **Scope:** the change affects only that Telegram user, and isn't a shared setting, so no
  coordination message goes to others.

**Shared messages** (alerts, coordination, action statuses, "applied" messages):
- **Events:** an outbox event carries `text: {uk, en}` instead of one string. Its creators render
  both from the catalogues.
- **Rows:** fan-out resolves each recipient's language from their binding (stored or the default
  `uk`) and writes that version into the recipient's outbox row.
- **Reading old events:** rows already store their own text, and delivery reads rows. During
  rollout the event reader accepts both the old string and the new object.
- **Unknown language:** a recipient with no stored choice and no language code available at
  fan-out time gets Ukrainian. Their earlier behaviour was Ukrainian, so nothing changes for
  them.

**Formats.**
- Times stay 24-hour.
- Durations render as «2 год 30 хв» or "2 h 30 min".
- Input parsing accepts both forms in either language: `2:30`, `90 хв`, `90 min`, `1 год 30 хв`
  and `1 h 30 min`.

**Command menu.**
- `webhook.ts set` calls `setMyCommands` twice: English descriptions with no `language_code`, and
  Ukrainian ones with `language_code: 'uk'`.
- Telegram picks one by the user's app language, which can differ from the in-bot choice. That is
  acceptable.

## Part 2: the laptop app

**Catalogue.**
- `companion/src/aw_telegram/texts.py` holds `UK` and `EN` dictionaries with the same keys, and
  `t(key, **params)`.
- All user-facing text goes through it:
  - windows, the tray, access and settings;
  - overlay, notification and countdown;
  - the status texts in `status.py`;
  - laptop-generated limit and endtime warnings (`scheduler.py`, `manual_presentation.py`);
  - uninstall prompts.
- A test fails if any key is missing from either dictionary.

**Setting.**
- «Налаштування» gains «Мова / Language» with three choices:
  - «Системна / System»;
  - «Українська»;
  - "English".
- It is stored in the local store and applies at once: open windows re-render, and the next
  overlay or notification uses it.
- **System:**
  - Ukrainian when Windows' user interface language, from `GetUserDefaultUILanguage`, is
    Ukrainian (`uk-UA`); English otherwise.
  - The Windows call is made through the existing `windows/` native helpers.
- **Qt strings:** `ui/i18n.py` installs `qtbase_uk` only when the effective language is
  Ukrainian, and removes it when switching to English.

**Requirements.** LANG-01 in user-requirements.md becomes: "Bot text is in Ukrainian or English
per Telegram user (default from the Telegram app language). Laptop text is in Ukrainian or
English, set on the laptop (default from the Windows display language, otherwise English)."

## Tests

**Bot.**
- Catalogue parity is enforced by the compiler, plus a test that every value is non-empty.
- The fallback from `language_code`, and a stored choice overriding it.
- `/language` and the Settings choice affect only that caregiver.
- An alert to two caregivers with different languages gives one row in each language.
- Old string events still deliver.
- Durations parse in both languages.
- E2E: one caregiver switches to English and receives the next alert in English.

**Laptop.**
- Key parity, and every key has a value.
- The system default is detected for `uk-UA` and `en-US`, with the native call mocked.
- The setting persists across a restart.
- Switching re-renders the settings window.
- Warnings are rendered in the chosen language.
- Qt's Ukrainian translator is installed only for Ukrainian.

## Order

The bot part has no dependency on the laptop part and goes first. The laptop part follows. A
release from the CI design publishes it.
