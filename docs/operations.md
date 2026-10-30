# Operations

Owner runbook for the hosted backend. Status 2026-10-30: `api` and `sweep` are deployed
from main 2c66e04 (`BACKEND_URL=https://api-ypt64ceg6a-lm.a.run.app`), and the webhook
is registered at `<BACKEND_URL>/telegram/webhook`. Each deploy, webhook change or data
deletion is an explicit owner action.

## What runs

| Piece | Where | Notes |
|---|---|---|
| `api` | Functions v2 (Cloud Run), `europe-central2` | Every HTTP route: `/v1/enroll`, `/v2/sync`, `/v1/pair-keys`, `/v1/access`, `/telegram/webhook`, `/internal/tasks`. Public invoker; each route authenticates itself. |
| `sweep` | Functions v2 scheduled, 00:30 Europe/Kyiv | Re-arms lost task intents, then `cleanup(now)` (see backend-delivery.md). One retry. |
| `delivery` queue | Cloud Tasks, same region | Outbox and deadline tasks to `/internal/tasks` with an OIDC token for `aw-tasks-invoker`. |
| Firestore | `(default)`, `europe-central2` | Deny-all client rules; Admin SDK only. |
| Secrets | Secret Manager | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, bound to both functions. |

Both functions run as `aw-backend@aw-telegram.iam.gserviceaccount.com`, never as a default
account. The full email is required: the Firebase CLI copies an `aw-backend@` shorthand
raw into the Scheduler job's OIDC identity and the secrets' IAM grants. Limits: `api` scales 0–2 instances (concurrency 20, 1 vCPU, 512 MiB, 60 s);
`sweep` runs on at most 1 instance for up to 540 s. The queue allows 2 concurrent
dispatches, matching `api`'s two instances.

## Deploying

Prerequisites are in setup.md: project, APIs, service accounts, queue, secrets,
rules and indexes, and the Telegram update TTL. Use the pinned Firebase CLI in
`bot/node_modules` (15.34.1), from the repository root.

1. CI (`.github/workflows/ci.yml`) runs the bot and companion checks on every push. Deploy only
   a commit whose CI run is green. To run the complete checks locally:
   - `npm.cmd test`
   - `npm.cmd run build`
   - `npm.cmd run check:bundle`
   - `npm.cmd run test:emulator -- auth pairing rules sync delivery purge`
   - the companion suite
2. Deploy the Firestore indexes first. Task 10 added three, for message-text clearing and
   stranded-message repair, and queries fail until they are built:
   `node bot/node_modules/firebase-tools/lib/bin/firebase.js deploy --only firestore:indexes --project aw-telegram`.
   The CLI then reports one field override missing from the file: that is the
   `telegramUpdates.expireAt` TTL policy. Never pass `--force` here; it would delete it.
3. First deploy, which discovers the `api` URL:
   `node bot/node_modules/firebase-tools/lib/bin/firebase.js deploy --only functions --project aw-telegram`.
   An interactive CLI asks for `BACKEND_URL`; leave it empty the first time. With
   `--non-interactive` it refuses to prompt, so create `bot/.env.aw-telegram` holding
   `BACKEND_URL=` first. Until it is set, Cloud Tasks are not created, and their intents
   stay pending for the next repair. The CLI exits 1 after a successful deploy while no
   image cleanup policy exists (step 6); check for "Successful create operation".
4. Put the `api` Cloud Run origin (`gcloud run services describe api
   --region=europe-central2 --format="value(status.url)"`, for example
   `https://api-xxxx-lm.a.run.app`; the CLI prints a `cloudfunctions.net` alias) in
   `bot/.env.aw-telegram` as `BACKEND_URL=...`, using `bot/.env.example` as the model.
   The file is git-ignored. Then deploy again.
5. Register the webhook: `node --experimental-strip-types bot/scripts/webhook.ts set
   --project aw-telegram --url <BACKEND_URL>/telegram/webhook`. Check it with `info`.
   It reads both secrets from Secret Manager with your ADC. It sets `secret_token`,
   `allowed_updates: message, callback_query` and `max_connections: 1`, which serializes
   redeliveries of an update. `set` also registers Telegram's command menu
   (`setMyCommands`, default scope) with the eight core commands, `/start`, `/status`,
   `/usage`, `/limit`, `/pending`, `/clear`, `/settings`, `/help`: English descriptions with
   no language, and Ukrainian ones for `language_code: uk`. `info` lists both menus;
   `remove` leaves them in place. The runtime never changes the menu, so run `set` again
   after changing `COMMANDS` in `bot/src/telegram/i18n/en.ts` or `uk.ts`.
6. Set an image cleanup policy so old function builds do not accumulate in Artifact
   Registry: `firebase functions:artifacts:setpolicy --project aw-telegram --location
   europe-central2 --days 1 --force`. Without `--location` it targets us-central1.
   Rollback redeploys from source, so old images are not needed.
7. Verify after the first deploy (these cannot be checked locally). Results of
   2026-10-30 are in implementation-plan.md under 10d:
   - The Scheduler job for `sweep` can invoke it as `aw-backend`. The CLI normally
     grants that; check the `sweep` service's `roles/run.invoker`.
   - The client IP that enrollment throttling sees: the adapter takes the last
     `X-Forwarded-For` entry, which Google's front end appends. Confirm against a
     known address before relying on the per-IP limit.
   - Cold-start latency of `api` after idle (target: a Telegram reply within 10 s).
   - Which identity Cloud Build used. Then review reducing the default compute
     account's project Editor role (setup.md).

## Logging

Application logs never contain request bodies, message text, titles, tokens or
provider detail. An unexpected failure logs `request failed` with a fixed route label
(IDs removed, e.g. `DELETE /v1/access/:id`) and the error type only. The sweep logs its
counts. Route boundary errors (4xx) are answers, not logged failures, with one exception:
an authenticated laptop sync that is refused logs one warning, `sync refused`, with
`route` (`POST /v2/sync`), `status`, a fixed `reason` (for example `health observation
is in the future`) and `skewMs`: for a laptop time refused as too late, that time minus
server time; as too early, that time minus collection start (negative); otherwise null.
It holds no body, device ID or user ID.

Cloud Run's own request logs record method, full path, status and latency for 30 days.
An access removal's path is `/v1/access/parent:<Telegram user ID>:<pairing ID>`, so
those logs would hold caregivers' Telegram user IDs. Exclude them once, after the first
deploy:

```powershell
gcloud logging sinks update _Default --project=aw-telegram --add-exclusion=name=access-ids,filter='resource.type="cloud_run_revision" AND httpRequest.requestUrl:"/v1/access/"'
```

## Costs and alerts

See hosting-cost-estimate.md for request volumes and free allowances. Beyond
Firestore, the deployment also uses:
- **Functions/Cloud Run:** requests and vCPU/GiB-seconds. With minimum 0 instances,
  nothing is billed while idle.
- **Cloud Tasks:** operations.
- **Cloud Scheduler:** one job.
- **Secret Manager:** two secrets, versions and access calls, one per cold start.
- **Artifact Registry:** storage of function images; keep the cleanup policy.
- **Cloud Build:** minutes per deploy.
- **Cloud Logging:** ingestion.
- **Egress:** to Telegram.

Google Cloud budgets only alert; there is no hard spend cap. Create a budget with
email alerts at low thresholds (for example 1, 5 and 10 USD) on the billing account.
The real bounds are structural:
- `maxInstances` of 2 and 1;
- the queue's 5/s and 2 concurrent dispatches;
- the app's throttles: enrollment 5 and pairing 10 attempts per 15 min, at most 3
  immediate offers per minute, 100 receipts per sync, the 128 KiB body cap;
- Telegram's single webhook connection.

A runaway would show first as Cloud Run request count and vCPU-seconds. Stopping
it means removing the webhook and deleting or scaling down `api` (see Rollback).

## Recovery

- **Laptop lost, replaced or compromised:** revoke it with `bot/scripts/enroll.ts
  revoke-device`, then issue a new code. On the laptop, «Налаштування» → «Підключити
  заново…» accepts the new code, keeping the old local database. To move the
  caregivers, purge the old device (below); its Telegram bindings are removed, so each
  caregiver can pair a fresh key.
- **Enrollment code used but the laptop failed to save it:** use `revoke-enrollment`
  with the code on stdin, then issue a new one (enrollment-security.md).
- **A caregiver's Telegram account is lost:** remove that access in «Доступ
  батьків», then create a new key for the new account. A caregiver who still has
  the account can remove themselves with `/unpair` (ACCESS-09).
- **No caregiver left:** the laptop pauses every rule (ACCESS-08) until someone pairs.

## Troubleshooting

- **A laptop never syncs** (the laptop app and `/status` show no sync, the request logs
  show `POST /v2/sync` 400s): read the `sync refused` warnings in Cloud Logging
  (`jsonPayload.message="sync refused"`). A reason about a future observation, coverage
  or live time, with `skewMs` beyond ±300000, means the laptop clock is more than 5
  minutes off: turn on «Set time automatically» in Windows Settings → Time & language →
  Date & time, or press «Sync now» there. The backend accepts and corrects a clock up
  to 5 minutes off (api-contract.md, activity time validation). Before 2026-10-30 it
  accepted none, so a laptop clock even 1 s ahead of the server failed every sync
  (review-notes.md, note 9). A reason that does not name a time points at the
  companion or the request; compare the companion version with the deployed backend.

## Rotating secrets

- **Bot token:**
  1. Revoke it in BotFather and store the new one with `functions:secrets:set
     TELEGRAM_BOT_TOKEN` at the hidden prompt.
  2. Redeploy, since functions bind the secret version at deploy time.
  3. Set the webhook again: the webhook belongs to the token.
- **Webhook secret:**
  1. Add a new version of `TELEGRAM_WEBHOOK_SECRET` without printing it.
  2. Redeploy, then run `webhook.ts set` again straight away.
  3. Between the two steps Telegram's calls are refused with 401 and retried, so
     nothing is lost.
- **Device and parent credentials:** these are per laptop and per pairing. Rotate them
  by revoking and re-enrolling or re-pairing.

## Deleting data

- **Automatic retention:** the daily `sweep` keeps seven Kyiv dates of reports and
  evidence and clears message text after 24 hours. Details are in
  backend-delivery.md.
- **One device, completely:** `node --experimental-strip-types bot/scripts/purge.ts
  --project aw-telegram --device-id ID --confirm ID`. It is irreversible; revoke the
  device first.
- **On the laptop:** `aw-telegram.exe --uninstall`, then delete
  `%LOCALAPPDATA%\AW Telegram` by hand if wanted.

## Rollback

1. Stop intake first if needed: `webhook.ts remove`. Telegram keeps undelivered
   updates for 24 hours. The laptop keeps working offline.
2. Redeploy the previous good commit's functions.
3. Watch for wire contract changes. The sync contract is closed on both sides
   (`additionalProperties: false`): a backend that adds a field breaks an older companion,
   and one that lacks a required field breaks a newer one. `activeCaregivers` (ACCESS-08)
   is such a field. Deploy and roll back the backend and the companion as a matched
   pair. A future wire change needs a `schemaVersion` bump or a companion that tolerates
   it first.
4. Last resort: `firebase functions:delete api sweep`. Firestore data is untouched.
