# Backend delivery checkpoint (Task 6)

Implemented locally and approved by independent review. Task 7 has not
started. Task 8's local offer store/executor is not implemented: existing LocalStore
intentionally rejects nonempty offers. No production deployment, Telegram send or
Google service behavior is claimed.

The 2026-10-29 approved [endtime amendment](superpowers/specs/2026-10-29-endtime-design.md)
required a follow-up to this completed checkpoint. It is implemented locally
(commits d113476, 88aee42, 9344289) but not yet independently reviewed: recipient
fan-out rises from two to ten, device sync accepts strict endtime presentation
receipts, and free use/Clear all retroactively cancel undelivered endtime events.
Settings coordination now excludes only the issuer, who still gets their own
allowance warning when an edit makes one due. The approved Task 6 history below is
unchanged.

## Entry points and authority

- `ActionService.createAction(identity, draft, operationId, callback?)` and
  `clearActions(identity, scope, operationId, callback?)` require a current
  `ParentIdentity`. Drafts are closed notify/overlay values with delay 0..1439 minutes.
- `SettingsService.updateSettings(identity, change, operationId, callback?)` and
  `setHourly(identity, enabled, operationId, callback?)` use the same parent boundary.
  Task 7 must supply a stable trusted Telegram update operation ID. Pairing generation
  plus exact canonical intent deduplicate retries; conflicting reuse fails.
- `DeviceApi.syncDevice(DeviceIdentity, request)` rechecks device authority within
  the mutation transaction. Internal `offerActions`/`recordAck` wrappers use that
  boundary; raw device IDs do not authorize a parent mutation.
- `createBackend(repository, {telegram, taskAdapter, oidc, clock?})` composes the device
  router, separate `/internal/tasks` OIDC route, outbox and bounded post-sync repair.
  Production adapters are explicitly constructed; imports do not obtain credentials
  or contact providers. Task 10 owns Functions/IAM/Cloud Scheduler wiring.

Authority, evidence reads, validation and final response sizing precede writes.
Actions, receipt facts, alerts, deterministic parent events, recipient outbox and
schedule intents commit together. External calls occur afterward. All accepted
receipt IDs remain atomic; optional offers fit both the 131072-byte UTF-8 response limit and the
450-document transaction budget, and omitted offers consume no attempts.

## Lifecycle and policy

Immediate offers use the same action ID at most 3 times, at least 20 seconds apart,
strictly before created+60 seconds. Three is a ceiling: 15-second polling may yield
only 2. Scheduled timers retain created+1..1439minutes and the inclusive target+5s
initial-presentation bound; they do not inherit the immediate 60-second window.
Repeat families always end at their original target date's Kyiv midnight.

Accepted offline timers become execution_unconfirmed, without a cancellation fence,
when execution evidence is late. Valid original-timestamp receipts can correct that
uncertainty without replay. Receipt UUID, event sequence, acceptance, occurrence,
dismissal interval and immutable presentation facts are checked separately.
Dismissed/completed/replaced with null presentedAt are valid widget lifecycle facts;
they do not confirm native visibility. Confirmation uses proof from that same
occurrence, never an earlier occurrence. Once-only dismissal closes the action;
repeat dismissal preserves its interval and durable original-midnight closure.

Clear advances a revisioned sequence fence; Clear-all independently suppresses
allowance warnings for the current Kyiv date. Free use cancels current manual
families with complete explicit IDs (max 100), preserves future initial timers and
skips timers due during free use. Restore/free-off never revives fenced work.
Evidence the laptop sends after a fence or during free use it had not yet learned
about (CANCEL-02) is recorded, not rejected. The action stays `canceled` or
`skipped`, and the parent status explains that the reminder appeared before the
change reached the laptop, including inside a batched status message.

Alerts use measured current-day projection with partial/freshness context. Hourly
observed/reserved/delivered highwaters belong to each parent pairing generation.
Unknown coverage at hourly enablement records a pending baseline; the first usable
projection establishes its floor. Category coordination includes the updated total
and reserves milestones. Free use/suppression leave hourly and coordination enabled.

Endtime follow-up (`bot/src/endtime.ts`) plans one event per device/local-date/
endtime-generation, with ID `sha256("endtime:"+device+":"+date+":"+generation)`.
Recipients are all active caregivers, and outbox rows carry
`policy {kind:'endtime',deviceId,endtimeDate,endtimeGeneration}`. `policy/current`
retains `endtimeGenerations` for the seven Kyiv dates plus the last pre-window baseline,
capped at 256 entries, so a receipt arriving after a later edit still validates.
Repeated occurrences create no more events; an intentional later same-day generation
may. Free use, Clear all and the Clear-all setting cancel up to 100 pending/uncertain
rows for the date in their own transaction. The worker cancels at lease time and
again after recipient authorization, immediately before `sendMessage`, when free use
or Clear all covers the row's date. A single ten-caregiver receipt plans 21 writes.

## Delivery, recovery and limits

Recipient rows contain generation references; current recipient authority is checked
immediately before every send. Leases fence finalization. 403 affects one recipient,
429 respects retry_after, and uncertain/transient outcomes use bounded retries.
A crash after Telegram accepts sendMessage but before Firestore finalization may
produce a duplicate Telegram message. Laptop action deduplication is separate.

Cloud Tasks use authenticated REST and real Google OIDC verification with exact
configured audience/service-account checks. Durable logical task identities and
persisted dispatch generations repair enqueue crashes and lost-enqueued work.
Every webhook update and every executed task is followed by a bounded `repair(25)`, as
every sync is by `repair(2)`. Messages and deadlines a Telegram command queues therefore
reach Cloud Tasks at once, even while the laptop is off. The daily sweep task
(`kind:'sweep'`) re-arms lost task intents, runs `cleanup(now)` (`src/cleanup.ts`), and
dispatches again. Cleanup cleans every device and repeats bounded rounds (each under 500
writes) until nothing changes or its 300-second budget ends:
- **Evidence:** retained for seven Kyiv dates, compared as Kyiv dates. Completed
  message text clears after 24 hours. Events and outbox rows carry `scrubbed:false` until
  then, so the clearing query never re-reads cleared rows.
- **Inactive laptop:** days outside the seven retained dates are deleted even when the
  laptop no longer syncs. A laptop silent past retention loses its last window title.
- **Short-lived records:** expired menu sessions and throttle windows go.
- **Keys and enrollments:** pairing keys of any state go a week after expiry. Unused
  enrollments also go a week after expiry; consumed ones stay for owner recovery.
- **Operation tombstones:** after 30 days, when a replay is impossible.
- **Delivery repair:** a pending or uncertain outbox message more than 10 minutes overdue
  whose task intent was lost gets a new one.

Physical cleanup can lag. Minimal expired-operation digest tombstones prevent replay
from creating a new action after its cached result is removed.

`scripts/purge.ts --project P --device-id ID --confirm ID` (owner IAM, irreversible)
deletes a device's document tree and every top-level document that names it: keys,
Telegram bindings (freeing those accounts for a replacement laptop), events, outbox,
task intents, action locations and the enrollment. It refuses a device that is not yet
revoked, and stops with an error if any delete fails (a rerun is safe).

## Local verification

From repository root with Node.js 22 and the locked bot dependencies:

```powershell
npm.cmd --prefix bot test -- --maxWorkers=1
npm.cmd --prefix bot run build
npm.cmd --prefix bot run check:bundle
npm.cmd --prefix bot run test:emulator -- delivery sync
```

The emulator runner requires exact demo-aw-telegram, explicit valid loopback and no
credentials; use the existing Java 21+ runtime (this laptop's verified JBR25 requires
process JAVA_HOME and its bin on PATH). No login or production fallback is needed.
Offline adapter tests exercise real locally signed JWT verification and injected
Telegram/Tasks HTTP responses. See [the API contract](api-contract.md),
[sync storage](sync-storage.md), and [the implementation plan](implementation-plan.md).
