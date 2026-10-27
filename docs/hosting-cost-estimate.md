# Hosting cost estimate

Checked 2026-10-27. Estimates for one laptop, not measured implementation results
or a guarantee of a zero bill. Blaze bills usage beyond included allowances.

## Fifteen-second polling

| Laptop online | Device requests/day | Device requests/30 days |
|---|---:|---:|
| 4 hours/day | 960 | 28,800 |
| 8 hours/day | 1,920 | 57,600 |
| 24 hours/day | 5,760 | 172,800 |

Telegram webhook, queue, and scheduler requests add to these counts. Request-based
Cloud Run free usage lists 2 million requests/month, 180,000 vCPU-seconds/month,
and 360,000 GiB-seconds/month, valued using us-central1 active pricing. Functions
v2 uses underlying Cloud Run pricing; do not mix these with first-generation
Functions GB-second allowances. Region/rate adjustments and billing-account
shared free usage must be checked in the actual deployment.

At 24h/day and an illustrative 0.5 billed seconds/request at 1 vCPU, device polling
uses 86,400 vCPU-seconds/month; at 256 MiB, 21,600 GiB-seconds. This omits startup,
background handlers, and rounding/concurrency effects; measure billed time.
A handler averaging over a second has much less CPU headroom even when request
counts are well below quota. Never implement the poll endpoint as a 15-second
server-side wait; answer promptly and sleep on the laptop.

Firestore free quotas: 50,000 reads/day and 20,000 writes/day. A hypothetical
average of five document reads and two writes per device request consumes 28,800
reads/day and 11,520 writes/day even when online continuously. This is a budget,
not a measurement: empty queries have minimum charges, transactions may retry,
and scanning pending actions/history or writing per-poll audit documents can
exceed it. Target bounded indexed lookups, summary replacement rather than a
new history document every poll, batching, and no cloud task per empty poll.
Evaluate alerts only on summary/settings changes, not every heartbeat. Measure
actual operations with emulator instrumentation and staging billing metrics.

Cloud Tasks includes 1 million billable operations/month; only reminders,
notifications and deadline checks use it. One Cloud Scheduler job fits its
3-jobs/billing-account free allowance if unused elsewhere. Secret Manager includes
6 active versions and 10,000 accesses/month: load secrets per instance, not once
per heartbeat, and avoid device endpoints needing the bot token. Artifact Registry,
builds, logs, network egress and region-specific data transfer are separate costs.
European outbound traffic must not be assumed to have North America's allowance.

## Decision

Keep 15-second short polling for predictable <=30s online command delivery; it is
reasonable for one laptop. The laptop makes no requests when powered off/asleep.
Use exponential backoff on connection/server failures to prevent retry storms.
Do not add AFK polling slowdowns beyond 30s without revisiting responsiveness.
Report uploads every 30s are separate from the command-poll cadence. After first
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
