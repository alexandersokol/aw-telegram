# Caregiver Self-Removal Design

Status: approved by the owner in conversation, 2026-10-30; spec pending review.

## Intent

Let a paired caregiver remove their own access from Telegram, the opposite of
`/pair`. Today only the laptop's «Доступ батьків» can remove a caregiver, and
blocking the bot leaves the caregiver active: they keep a slot, count toward
`activeCaregivers` and keep ACCESS-08 from pausing the rules.

## Goals

- A typed `/unpair` command and a «🚪 Відключитися» button in Settings, both
  opening one confirmation screen.
- Confirmed removal has exactly the effect of removal from the laptop.
- The last active caregiver is warned that every rule on the laptop will pause,
  and may still proceed.

## Non-goals

- Notifying other caregivers or the laptop. Nobody is told, matching removal
  from the laptop. The laptop's access list stops showing the caregiver.
- Reacting to Telegram's `my_chat_member` (bot blocked) updates. Blocking a bot
  happens by accident too easily to remove access on its own.
- Any change to the sync contract or the companion.

## Requirement

ACCESS-09 (owner decision, 2026-10-30): a paired caregiver may remove their own
access from Telegram with `/unpair` or the Settings button, after a confirmation.
The effect is identical to removal in «Доступ батьків». Nobody else is notified.
When the caregiver is the last active one, the confirmation says that every rule
on the laptop will pause (ACCESS-08). Returning requires a new key.

## Telegram behaviour

Entry points, both opening the `leave` screen:
- `/unpair` from a paired caregiver.
- «🚪 Відключитися» on the Settings screen, in its own row above «Назад».

The `leave` screen:
- Text: «Відключитися від цього ноутбука? Ви більше не отримуватимете звіти й
  сповіщення. Щоб повернутися, потрібен новий ключ із ноутбука.»
- When the device's `activeParentIds` has exactly one entry at render time, a
  second paragraph: «Ви останній підключений дорослий. Після цього всі правила на
  ноутбуці зупиняться.»
- Buttons: «Так, відключитися» (confirm) and «Скасувати» (back to Settings).

After confirmation the reply is «Вас відключено.» followed by a blank line and
the existing `PAIRING` hint.

Edge cases:
- `/unpair` from an unpaired user gets the `PAIRING` hint, like any other text.
- A confirm tap that arrives after removal (repeated tap, or a second open
  screen) comes from an unpaired user. It gets the existing unpaired reply, the
  `PAIRING` hint in place of the tapped message, and changes nothing.
- An old «Так» button from an earlier `leave` screen is refused by the menu
  session's nonce and version check, like every other stale button.
- The warning reflects the count when the screen was shown. If the count changes
  before the tap, removal still proceeds; the warning is informational.

## Backend

`repository.ts`:
- Extract the caregiver branch of `revokeAccess` into one private transaction
  helper, `revokeParentTx(tx, deviceId, device, userId, pairingId, now)`. It
  marks the parent document and the matching Telegram binding revoked, removes
  the user from `activeParentIds` and deletes their menu session. Both
  `revokeAccess` and the new method call it, so the two paths cannot drift.
- Add `leaveDevice(identity: ParentIdentity)`. In one transaction it checks the
  caregiver exactly as `requireParent` does, then calls the helper. A caregiver
  who is no longer authorized gets the usual 401.

`telegram/navigation.ts`:
- `NavScreen` gains `leave`; `NavAction` gains `leave`, `leaveyes` and
  `leaveno`.
- Transitions: `settings + leave → leave`; `leave + leaveno → settings`;
  `leave + leaveyes → state null, effect 'leave'`; anything else on `leave` is
  stale.
- The controller performs the `leave` effect with `repository.leaveDevice` and
  returns the farewell reply. A 401 maps to the stale toast, as today.
- `openLeave(identity)` opens the screen for `/unpair`.

`telegram/webhook.ts`: `case 'unpair'` calls `navigation.openLeave`.

`telegram/uk.ts`: the labels and texts above, and a `/unpair` line in `HELP`.

Unchanged, and relied on:
- Queued messages to the caregiver stop: delivery calls `authorizeRecipient`,
  which refuses a revoked caregiver.
- The laptop learns the new `activeCaregivers` on its next sync; at 0 it pauses
  every rule, as after removal on the laptop.
- The parent document and binding are kept revoked, as after removal on the
  laptop, and the same Telegram account can pair again with a new key.

## Docs

- user-requirements.md: ACCESS-09.
- operations.md, Recovery: a caregiver can also remove themselves with `/unpair`.
- implementation-plan.md: a short task entry and its check counts.

## Tests

Unit (`bot/tests`):
- Menu transitions: Settings → leave, confirm, cancel, and stale actions.
- The leave screen with one and with two active caregivers.
- `/unpair` while paired opens the screen; while unpaired gives the pairing hint.
- A repeated confirm after removal gets the pairing hint and writes nothing.
- A confirm whose `leaveDevice` call fails with 401 (removed on the laptop
  between screen and tap) gets the stale toast.

Emulator (`pairing` selector):
- `leaveDevice` revokes the parent and binding, frees the slot and deletes the
  session; the same account then pairs again with a new key.
- `revokeAccess` behaviour is unchanged after the extraction.

E2E: two caregivers; one removes themselves through the Settings button and the
other keeps working; then the last removes themselves with `/unpair`, and the
next sync reports `activeCaregivers: 0`.
