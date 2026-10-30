# Hosting cost estimate

Checked 2026-10-27; sync interval and Firestore operations updated 2026-10-30 (Task 11d).
Estimates for one laptop, not a guarantee of a zero bill. Blaze bills usage beyond
included allowances.

## Thirty-second polling

| Laptop online | Device requests/day | Device requests/30 days |
|---|---:|---:|
| 4 hours/day | 480 | 14,400 |
| 8 hours/day | 960 | 28,800 |
| 24 hours/day | 2,880 | 86,400 |

A few more requests come from receipts, which the companion sends at once (one per
accepted, shown or closed reminder and per applied setting).

Telegram webhook, queue, and scheduler requests add to these counts. Request-based
Cloud Run free usage lists 2 million requests/month, 180,000 vCPU-seconds/month,
and 360,000 GiB-seconds/month, valued using us-central1 active pricing. Functions
v2 uses underlying Cloud Run pricing; do not mix these with first-generation
Functions GB-second allowances. Region/rate adjustments and billing-account
shared free usage must be checked in the actual deployment.

At 24h/day and an illustrative 0.5 billed seconds/request at 1 vCPU, device polling
uses 43,200 vCPU-seconds/month; at 256 MiB, 10,800 GiB-seconds. This omits startup,
background handlers, and rounding/concurrency effects; measure billed time.
A handler averaging over a second has much less CPU headroom even when request
counts are well below quota. Never implement the poll endpoint as a 30-second
server-side wait; answer promptly and sleep on the laptop.

Firestore free quotas: 50,000 reads/day and 20,000 writes/day. Empty queries have
minimum charges and transactions may retry. Target bounded indexed lookups, summary
replacement rather than a new history document every poll, batching, and no cloud
task per empty poll. Evaluate alerts only on summary/settings changes, not every
heartbeat.

## Firestore operations per laptop (Task 11d)

Before 11d (Cloud Monitoring, one hour on 2026-10-30, 15 s sync): 1,051 writes and
4,188 reads, so about 25,000 writes and 100,000 reads a day for a laptop online all day.

Per sync after 11d, counted in the `sync` emulator suite (transaction only):
- idle (no summary, no receipt, health unchanged): 7 reads, 1 write (`sync/current`);
- a today summary (two caregivers): 14 reads, 2 writes (the day and `sync/current`), however
  many days are stored. Only the summarized date is read; the daily sweep deletes days
  outside the retained dates, and an unchanged alert state is not rewritten. With one
  caregiver it is 13 reads.

Applied notices (Task 11e, UX-03) cost nothing on these syncs: they are read only when the
laptop's settings or cancellation acknowledgement advances, or when an earlier sync left more
than 50 due. An acknowledging sync costs 13 reads and 2 writes (its receipt and
`sync/current`); when it covers a change, it adds one notice query (1 read, plus 1 per notice
past the first), one event check per author (1 read), and per author the event, its outbox
row and task intent (3 writes) plus one deletion per notice: 2 reads and 4 writes for one
change by one author. Each settings change or clear writes its notice in its own transaction
(1 write). Acknowledgements follow parent changes, so this is a few operations a day.

Every sync is followed by the task-intent repair, two queries (2 reads). It stays: it is the
frequent retry for intents whose Cloud Tasks enqueue failed and the recovery for lost
enqueued tasks, which otherwise wait for the next Telegram update or the daily sweep. Health
is also written at least every 5 minutes (288 writes a day), and live when the app or title
changes.

Projected for one laptop online 24 hours (2,880 syncs, one caregiver):

| Case | Reads/day | Writes/day |
|---|---:|---:|
| Before 11d (measured hour x 24) | 100,512 | 25,224 |
| Idle syncs only | 25,920 | 3,168 |
| In use: usage changes, a summary on every sync | 43,200 | 6,048 + live changes |
| Idle: only `availableThrough` moves, a summary every 60 s | 34,560 | 4,608 |
| Idle, if the repair also ran at most every 5 minutes | 29,376 | 4,608 |

The companion collects today's summary every 30 s. A summary whose only change is
`availableThrough` is sent at most every 60 s (`UNCHANGED_SUMMARY_INTERVAL`, owner decision
2026-10-30). A held summary is committed after 60 s and then waits for the next sync, so on
an idle laptop "Дані станом на" can be up to about 90 s old. Any other change, a new date,
the first summary after start and one after a failed sync go with the next sync. An idle
laptop therefore alternates summary and idle syncs.

By hours online a day (one caregiver; the post-sync repair runs after every sync):

| Online | Idle: reads | Idle: writes | In use: reads | In use: writes |
|---|---:|---:|---:|---:|
| 8 hours | 11,520 | 1,536 | 14,400 | 2,016 |
| 12 hours | 17,280 | 2,304 | 21,600 | 3,024 |
| 24 hours | 34,560 | 4,608 | 43,200 | 6,048 |

"In use" means usage changes on every sync; live writes on app or title changes come on top.

Owner decision (2026-10-30): the laptop is not online 24 hours a day, so the 11d bound
(6,000 writes and 30,000 reads a day) is judged for a realistic online day, which the 8- and
12-hour rows meet. The 24-hour rows are a known overage the owner accepts, as is missing the
goal of about 4,000 writes and 20,000 reads at 24 hours. The repair after every sync and the
60 s summary hold stay. Still an option, not implemented: run the post-sync repair at most
every 5 minutes (29,376 reads for an idle 24-hour day), which retries failed enqueues within
5 minutes instead of 30 s.

Measured after the 11d deploy (owner-pending): one hour of
`firestore.googleapis.com/document/read_count` and `write_count` for one online laptop:
_reads: pending, writes: pending; per day (x24): pending_.

Cloud Tasks includes 1 million billable operations/month; only reminders,
notifications and deadline checks use it. One Cloud Scheduler job fits its
3-jobs/billing-account free allowance if unused elsewhere. Secret Manager includes
6 active versions and 10,000 accesses/month: load secrets per instance, not once
per heartbeat, and avoid device endpoints needing the bot token. Artifact Registry,
builds, logs, network egress and region-specific data transfer are separate costs.
European outbound traffic must not be assumed to have North America's allowance.

## Decision

Keep 30-second short polling (Task 11d, from 15 s): a command reaches an online laptop
within about 30 s, and receipts go back at once. The laptop makes no requests when powered off/asleep.
Use exponential backoff on connection/server failures to prevent retry storms.
Do not add AFK polling slowdowns beyond 30s without revisiting responsiveness.
Today's summary is collected every 30s and rides the next sync. After first
staging deployment, compare seven days of actual consumption with this estimate
and optimize before enabling routine production use. Account-level free quotas
may already be consumed by the owner's other Firebase/Google Cloud projects.

## Sources

- https://cloud.google.com/run/pricing
- https://firebase.google.com/pricing
- https://firebase.google.com/docs/firestore/quotas
- https://cloud.google.com/tasks/pricing
- https://cloud.google.com/scheduler/pricing
- https://cloud.google.com/secret-manager/pricing
