# Review notes

Findings from using the deployed system, collected to fix later. Add each new finding
at the end with the next number. When one is fixed, set its status and name the commit.

Status values: **open**, **in progress**, **fixed (commit)**, **won't fix (reason)**.

---

## 1. No way back to the main menu after a command reply

- **Status:** open
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

- **Status:** open
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
