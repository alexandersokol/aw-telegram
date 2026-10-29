# Cloud environment setup

Recorded 2026-10-29. Owner-run setup of the hosted environment; nothing is
deployed yet. Commands run on the owner's workstation with the owner's own
`gcloud auth login` and Application Default Credentials. No service account key
is created or downloaded at any step.

## Project

| Item | Value |
|---|---|
| Project ID | `aw-telegram` (number 1094377867688) |
| Plan | Blaze; billing enabled |
| Firestore | `(default)`, Standard edition, Native mode, `europe-central2` |
| Region | `europe-central2` for functions, tasks and scheduler (co-located) |

The repository root `.firebaserc` (git-ignored) selects `aw-telegram` as the
default Firebase CLI project.

## Enabled APIs

Firestore, Cloud Functions, Cloud Run, Cloud Build, Artifact Registry, Cloud
Tasks, Cloud Scheduler, Pub/Sub, Eventarc, Secret Manager, IAM, IAM Credentials
and Logging.

## Service accounts

| Account | Purpose | Roles |
|---|---|---|
| `aw-backend@aw-telegram.iam.gserviceaccount.com` | Runtime identity of every function | `roles/datastore.user` on the project; `roles/iam.serviceAccountUser` on `aw-tasks-invoker` only |
| `aw-tasks-invoker@aw-telegram.iam.gserviceaccount.com` | `oidcToken.serviceAccountEmail` on Cloud Tasks HTTP calls to `/internal/tasks` | None |

`aw-backend` needs `serviceAccountUser` on the invoker so it can create tasks
whose OIDC token names that account. The `/internal/tasks` handler accepts only
a Google-signed token for exactly that email and the configured audience, so the
invoker needs no project roles. Other grants are resource-level only:
`roles/cloudtasks.enqueuer` for `aw-backend` on the `delivery` queue, and
`roles/secretmanager.secretAccessor` for `aw-backend` on the two Telegram
secrets (both below).

Grant the two roles above with:

```powershell
gcloud projects add-iam-policy-binding aw-telegram --member=serviceAccount:aw-backend@aw-telegram.iam.gserviceaccount.com --role=roles/datastore.user --condition=None
gcloud iam service-accounts add-iam-policy-binding aw-tasks-invoker@aw-telegram.iam.gserviceaccount.com --project=aw-telegram --member=serviceAccount:aw-backend@aw-telegram.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser
```

The project also has the Google-created `firebase-adminsdk-fbsvc` and default
compute service accounts. Functions must not run as either of them. The default
compute account holds project `roles/editor` by Google default; review reducing
it after the first deploy confirms which identity Cloud Build uses.

## Cloud Tasks queue

`projects/aw-telegram/locations/europe-central2/queues/delivery` carries outbox
and deadline tasks. Task names are deterministic (`<intent>-<dispatchGeneration>`)
and the adapter treats 409 as already enqueued, so the application owns retries
and lost-task repair; the queue retries only transient handler failures.

| Setting | Value |
|---|---|
| Max dispatches/second | 5 (burst 10) |
| Max concurrent dispatches | 2, matching `maxInstances=2` |
| Retries | 5 attempts within 1 hour, 10s to 300s backoff, 4 doublings |

Grant `aw-backend` permission to enqueue on this queue only:

```powershell
gcloud tasks queues add-iam-policy-binding delivery --project=aw-telegram --location=europe-central2 --member=serviceAccount:aw-backend@aw-telegram.iam.gserviceaccount.com --role=roles/cloudtasks.enqueuer
```

## Secrets

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather token, entered by the owner at a hidden prompt |
| `TELEGRAM_WEBHOOK_SECRET` | 64 random base64url characters (48 bytes), sent by Telegram as `X-Telegram-Bot-Api-Secret-Token` |

Both use user-managed replication in `europe-central2` and carry the
`firebase-managed=true` label, so Functions deploys bind them without prompting
and prune superseded versions. Values never appear in chat, files, command
arguments or logs. The webhook secret was generated in a local process and
written to Secret Manager over stdin without being printed.

Set or rotate the bot token at the hidden prompt:

```powershell
npx firebase-tools@15.32.1 functions:secrets:set TELEGRAM_BOT_TOKEN --project=aw-telegram
```

Grant `aw-backend` read access to these two secrets only:

```powershell
gcloud secrets add-iam-policy-binding TELEGRAM_BOT_TOKEN --project=aw-telegram --member=serviceAccount:aw-backend@aw-telegram.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding TELEGRAM_WEBHOOK_SECRET --project=aw-telegram --member=serviceAccount:aw-backend@aw-telegram.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
```
