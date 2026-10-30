# Bot UX Design: menu button, "applied" messages, command menu

Status: approved by the owner in conversation, 2026-10-30; spec pending review.
Covers review notes 1 and 3 (docs/review-notes.md) and proposal B from the same session.

## Intent

The bot is hard to move around in after a command, and settings changes never say when the
laptop has applied them. This design adds three things:
- a way back to the main menu from every plain reply;
- a message to the author when the laptop applies their change;
- Telegram's own command menu.

## Non-goals

- A persistent reply keyboard.
- Telling other caregivers that a change was applied. They keep receiving the existing
  coordination message.
- Delayed "still not applied" reminders.
- Any change to the sync contract or the companion.
- English text. That is review note 4, which will add English command descriptions and copy.

## 1. «🏠 Головне меню» button

**Behaviour.**
- Every reply that has no buttons gets one inline button, «🏠 Головне меню».
- Tapping it replaces that message with the main menu, the same screen `/start` opens.
- It doesn't affect any other open menu.

**Gets the button.**
- Plain command replies: `/hourly`, `/help`, usage and format errors, unknown-command and
  hint replies.
- Every «Збережено: …» save reply, for limits, free use, categories, clears, restore and endtime.
- Laptop-message replies.

**Stays bare.**
- Replies that already have buttons: menus, submenus, review screens, period pickers.
- Pop-up notices (`toast`), for example «Це меню застаріло…».
- The pairing hint for unpaired users, the pairing failure and throttle texts, and the farewell
  after `/unpair`.
- Everything sent through the outbox: alerts, coordination, action statuses and the new "applied"
  messages.

**Mechanics.**
- Callback data `nv:home`. This is a fixed string with no nonce. `NavigationController` handles it
  before any session lookup by calling `openMain(identity)`. Opening the main menu changes nothing,
  so a replayed tap needs no protection. It creates a new menu session the same way `/start` does.
- `Reply` gains an optional `bare?: true`.
- One helper, `withHome(reply)`, runs in `TelegramBot` just before a reply is sent or edited. When
  `buttons` is empty and the reply is neither `toast` nor `bare`, it adds the button.
- The pairing texts and the farewell are marked `bare`. Outbox delivery never goes through this
  path.
- Extra report pages (`reply.extra`) stay without buttons; the first page carries the menus.

## 2. "Applied on the laptop" messages

**The save reply.**
- It reports only the saved change, for example «Збережено: ліміт на сьогодні 0:10.» It no longer
  carries «Ноутбук: очікує застосування.»/«застосовано.» or «⏳ Очікуємо підтвердження від
  ноутбука.».
- If the device's last sync (`sync/current.serverReceivedAt`) is older than 2 minutes, or there has
  been none, the reply adds a line: «Ноутбук зараз не на зв’язку — застосується, коли він
  увімкнеться.».
- Status screens such as `/limit` and `/endtime` keep showing whether the laptop has applied the
  current revision.

**Recording the author.**
- Each settings change that bumps the revision writes a notice
  `devices/{deviceId}/appliedNotices/s-{revision}` with these fields:
  - `pairingId`, the author;
  - `summary`, the short text the coordination message already builds with `changeSummary`;
  - `createdAt`.
- Each clear that bumps the cancellation revision writes `c-{revision}` in the same way.
- An unchanged save («Без змін: …») writes no notice.

**Sending.**
- During sync, when `settingsAckRevision` or `cancellationAckRevision` advances (`deviceApi.ts`),
  the same transaction does three things:
  - reads the notices up to the new acknowledged revisions, in revision order, at most 50;
  - groups them by `pairingId`;
  - enqueues one outbox event per author.
- The message text: «✅ Ноутбук застосував: » followed by the summaries joined with «; », for
  example «✅ Ноутбук застосував: ліміт на сьогодні 0:10; вільний режим вимкнено.».
- The notices are deleted in that transaction.
- Recipients are resolved and authorized at send time as today, so a removed author receives
  nothing.
- All reads happen before the transaction's writes, like the rest of sync. If more than 50 notices
  are due, the rest go out on the next sync.

**Edge cases.**
- A repeated or redelivered sync finds no notices and sends nothing.
- Two changes by the same author before the laptop syncs arrive as one message listing both, in
  order.
- Changes by two caregivers in one sync produce one message to each.
- A device purge and the daily cleanup also remove `appliedNotices`. Notices older than the
  retention window are deleted unsent.

## 3. Telegram's command menu

- `bot/scripts/webhook.ts set` also calls `setMyCommands` (default scope, no language) with eight
  commands and Ukrainian descriptions:
  - `/start` — головне меню
  - `/status` — стан ноутбука
  - `/usage` — використання
  - `/limit` — ліміт часу
  - `/pending` — активні нагадування
  - `/clear` — очистити нагадування
  - `/settings` — налаштування
  - `/help` — усі команди
- `webhook.ts info` also shows the registered commands. `remove` leaves them in place.
- This is an owner action at registration time; the runtime never calls it.

## Files

- `bot/src/telegram/uk.ts`: the button label, the «✅ Ноутбук застосував: » prefix, the offline
  line, the command descriptions, and the new save texts.
- `bot/src/telegram/webhook.ts`: `withHome`, routing `nv:home`, marking `bare` replies.
- `bot/src/telegram/navigation.ts`: handling `nv:home` without a session.
- `bot/src/telegram/allowance.ts`, `clear.ts`, `commands.ts`: save replies without the
  acknowledgement line, with the offline line.
- `bot/src/settings.ts` and the clear path: writing notices.
- `bot/src/deviceApi.ts`: turning notices into outbox events on acknowledgement.
- `bot/src/cleanup.ts`, `bot/src/purge.ts`: removing notices.
- `bot/src/webhookAdmin.ts`, `bot/scripts/webhook.ts`: `setMyCommands`.
- Docs:
  - user-requirements.md: new requirements UX-02 (menu button) and UX-03 ("applied"
    messages), plus an update to FREE-05;
  - operations.md: the command menu;
  - review-notes.md: notes 1 and 3 point here.

## Tests

- **Unit:**
  - which reply kinds get the button and which stay bare;
  - a home tap opens the main menu and leaves another open menu working;
  - a save reply has no acknowledgement line, and has the offline line only when the last sync
    is old;
  - one author with two changes, two authors, and a clear plus a setting together, each giving
    the right messages;
  - a repeated sync sends nothing;
  - a removed author receives nothing;
  - more than 50 notices are spread over syncs;
  - `setMyCommands` sends the exact eight commands.
- **Emulator:** the notice query by revision is bounded and runs on real Firestore inside the
  sync transaction.
- **E2E:** a caregiver changes the limit, the laptop syncs, and the author receives «✅ Ноутбук
  застосував: ліміт на сьогодні …», while a second caregiver receives only the coordination
  message.
- **Deploy:** backend only, since the sync contract doesn't change. Run `webhook.ts set` once after
  the deploy to register the command menu.
