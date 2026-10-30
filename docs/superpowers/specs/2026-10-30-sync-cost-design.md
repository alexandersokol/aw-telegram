# Sync Cost Design

Status: approved by the owner in conversation, 2026-10-30; spec pending review.
Covers proposal A from the 2026-10-30 review session (docs/review-notes.md, note 7).

## Intent

During live acceptance one laptop that stayed online cost 1,051 Firestore writes and 4,188
reads in an hour. That is about 25,000 writes and 100,000 reads a day, over Firestore's free
20,000 writes and 50,000 reads a day. There are two causes:
- The companion syncs every 15 s.
- Every sync rewrites the health and live documents, and reads all stored days and the alert
  state, even when nothing has changed.

The goal is to bring an always-online laptop to about 4,000 writes and 20,000 reads a day.

## Non-goals

- Any change to the sync contract, which stays v2 with no new fields. The backend and the
  companion therefore deploy independently.
- Server push or long polling.
- Changes to report contents, retention or alerts.

## 1. Companion: 30-second sync

- `sync.py`: the regular sync interval becomes 30 s (today `self._sync_due = mono + 15`). The
  interval becomes a named constant. Failure backoff keeps its current 15 s base and 300 s cap.
- The companion still syncs promptly when it has acknowledgements to send, for example after
  showing or closing a message. Check that path and keep it.
- `status.py`: the companion's own "online" window, `ONLINE`, goes from 60 s to 90 s, three sync
  intervals, so one slow sync doesn't show the laptop as offline.

## 2. Backend: skip unchanged writes

All of these are in `deviceApi.ts`'s sync transaction:
- **Health:** write `health/current` only if the new value differs from the stored one in any
  field other than `observedAt`, or the stored copy is more than 5 minutes old.
- **Live:** write `live/current` only if the value differs from the stored one in any field other
  than `observedAt`.
- **Sync:** `sync/current` is written on every sync as today. It carries `serverReceivedAt`
  (online status and the offline line from the bot UX design) and `maxRequestSequence` (request
  ordering).
- **Sequences:** health and live documents keep their stored `sequence` when not rewritten.
  Readers must not assume it equals the latest request sequence. Check `reports.ts` and `/status`.

## 3. Backend: skip unneeded reads

- **Days:** read the `days` collection only when the request carries `summaries`. Today it is
  read on every sync.
- **Alerts:** call `readAlerts` only when the request carries summaries or acknowledgements, or
  the settings revision changed since the last sync. That means `settings.revision` differs from
  the stored `settingsAckRevision` or from a new last-evaluated revision kept in `sync/current`.
  If alert evaluation depends on time passing even with no new data (for example the endtime
  alert at the configured time), keep a time-based trigger. The companion's acknowledgement for
  that alert arrives as a receipt, so it already counts as "acknowledgements present". Confirm
  this when implementing.
- **Actions:** the action snapshot is read only when acknowledgements reference actions. That is
  already the case; keep it.

## 4. Measurement

- An emulator test (`sync` selector) instruments the Firestore client and counts document reads
  and writes for:
  - an idle sync: health unchanged, no summaries, no acknowledgements;
  - a sync with one new summary.
  It asserts an idle sync uses at most 7 reads and 2 writes.
- After the deploy, the owner or Claude reads `firestore.googleapis.com/document/read_count` and
  `write_count` for one hour through the Monitoring API, as on 2026-10-30, and records the result
  in implementation-plan.md.

## Expected result

For one laptop online for 24 hours:
- about 2,900 syncs;
- about 3,000–4,000 writes (from about 25,000);
- about 20,000 reads (from about 100,000).

## Risks and trade-offs

- A Telegram command can take up to 30 s to reach the laptop, up from 15 s.
- `/status` shows the current app up to 30 s late.
- Backend health details can be up to 5 minutes old while nothing changes. The online indicator
  is unaffected.

## Files

- `companion/src/aw_telegram/sync.py`, `status.py`, with their tests.
- `bot/src/deviceApi.ts`, `bot/src/alerts.ts` (if the trigger needs a stored revision), and
  `bot/src/telegram/reports.ts` (the sequence assumption).
- Tests: `bot/tests/sync.test.ts`, `bot/tests/sync.emulator.test.ts`, companion sync and status
  tests.
- Docs: hosting-cost-estimate.md (the measured numbers before and after), sync-storage.md (the
  interval and the skipped writes).
