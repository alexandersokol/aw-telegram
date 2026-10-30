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
- one new today summary (two caregivers, no stored days): 14 reads, 3 writes (day, alert
  state, `sync/current`). With one caregiver and seven stored days it is 19 reads, because
  the `days` query reads every stored day.

Every sync is followed by the task-intent repair, two queries (2 reads). Health is also
written at least every 5 minutes (288 writes a day), and live when the app or title changes.

Projected for one laptop online 24 hours (2,880 syncs):

| Case | Reads/day | Writes/day |
|---|---:|---:|
| Before 11d (measured hour x 24) | 100,512 | 25,224 |
| Idle syncs only | 25,920 | 3,168 |
| A today summary on every sync | 60,480 | 8,928 + live changes |

The companion collects and sends a new today summary every 30 s, even when only its
`availableThrough` time moved, so with today's cadence nearly every sync carries one: the
last row applies. That misses the 11d goal (about 4,000 writes and 20,000 reads) and its
bound (6,000 and 30,000). Not done in 11d, with their effect on a summary sync:
- read only the summarized dates' day documents, leaving pruning to the daily sweep: -6 reads;
- skip the alert state write when it is unchanged: -1 write;
- run the task-intent repair only after a sync that queued work: -2 reads;
- send an unchanged today summary (only `availableThrough` moved) at most every 5 minutes:
  most syncs of an idle laptop become idle syncs.

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
