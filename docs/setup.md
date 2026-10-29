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
invoker needs no project roles. Later steps add, at resource level only:
`roles/cloudtasks.enqueuer` for `aw-backend` on the `delivery` queue, and
`roles/secretmanager.secretAccessor` for `aw-backend` on the bot token and
webhook secret.

Grant the two roles above with:

```powershell
gcloud projects add-iam-policy-binding aw-telegram --member=serviceAccount:aw-backend@aw-telegram.iam.gserviceaccount.com --role=roles/datastore.user --condition=None
gcloud iam service-accounts add-iam-policy-binding aw-tasks-invoker@aw-telegram.iam.gserviceaccount.com --project=aw-telegram --member=serviceAccount:aw-backend@aw-telegram.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser
```

The project also has the Google-created `firebase-adminsdk-fbsvc` and default
compute service accounts. Functions must not run as either of them.
