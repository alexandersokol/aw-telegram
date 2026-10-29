# Cloud environment setup

Recorded 2026-10-29. Owner-run setup of the hosted environment; nothing is
deployed yet. Deploying, the webhook, rotation, deletion and rollback are in
[operations.md](operations.md). Commands run on the owner's workstation with the owner's own
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

## Firestore rules and indexes

`firestore.rules` (deny all client reads and writes) and the seven composite
indexes in `firestore.indexes.json` were deployed on 2026-10-29. The live
ruleset was compared with the file and is identical. Redeploy after changing
either file:

```powershell
npx firebase-tools@15.32.1 deploy --only firestore:rules,firestore:indexes --project=aw-telegram
```

Rules do not restrict the Admin SDK; backend access is governed by IAM.

Not yet applied: a TTL policy on the `expireAt` field of `telegramUpdates`. These are
redelivery markers that expire two days after an update. The daily sweep remains a
bounded fallback. Owner-run:

```powershell
gcloud firestore fields ttls update expireAt --collection-group=telegramUpdates --enable-ttl --project=aw-telegram
```

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

## Companion laptop

The companion is a portable folder, `aw-telegram\`, containing `aw-telegram.exe`. It
runs as the signed-in Windows user and needs no Python or administrator rights.

Build it on the owner's workstation from `companion\`, in a separate virtual
environment made from a python.org CPython 3.12 for Windows. Its `LICENSE.txt`
carries the Windows-build terms, and the spec refuses any other base Python. The
first build used python.org 3.12.6.

```powershell
C:\Users\YOU\AppData\Local\Programs\Python\Python312\python.exe -m venv .venv-build
.venv-build\Scripts\python.exe -m pip install -r requirements.lock
.venv-build\Scripts\python.exe tools\licenses.py check
.venv-build\Scripts\pyinstaller.exe --clean --noconfirm aw-telegram.spec
```

`tools\licenses.py check` must pass before the folder is given to anyone.
`companion\licenses\` must hold:
- `LGPL-3.0.txt` and `GPL-3.0.txt`: the PySide6 wheels name LGPL-3.0 but ship no
  license text.
- `qt-third-party.txt`: Qt 6.12's "Licenses Used in Qt", for the third-party code
  inside the Qt libraries.
- `python-incorporated.txt`: Python's "Licenses and Acknowledgements for
  Incorporated Software", for OpenSSL, expat, mpdecimal, zlib, SQLite and others.

The spec resolves DLLs from the build Python first. It ships only Python's own OpenSSL
(PyInstaller's Qt hook had picked Git's from PATH, which broke `_ssl`). It drops Qt
parts a tray app does not use: software OpenGL, image formats, SVG, TLS and the
network-information plugins. To check a build, run
`dist\aw-telegram\aw-telegram.exe --self-check report.json`; every entry in the
report must be `ok`.

On the laptop:

1. Copy `dist\aw-telegram\` to a folder the child's Windows account can read, for
   example `C:\Program Files\AW Telegram\` (installed by an administrator), and
   start `aw-telegram.exe`. Local data lives in `%LOCALAPPDATA%\AW Telegram\`.
2. In «Налаштування», paste the one-line code from `scripts/enroll.ts issue`, check
   the server name it shows, then press «Підключити». The window then checks
   ActivityWatch at `127.0.0.1:5600`; change the port there if needed. If the owner
   later revokes the laptop, «Підключити заново…» there accepts a new code. The old
   database is kept beside the new one as `companion-retired-<time>.sqlite`.
3. Tick «Запускати разом з Windows». This writes the current user's
   `HKCU\…\Run` value «AW Telegram» with the quoted executable and `--background`.
4. In «Доступ батьків», create a key for each parent. Each parent sends the shown
   `/pair` command to the bot in a private chat within 15 minutes.

To retire a laptop, quit the companion from the tray, then run
`aw-telegram.exe --uninstall`. It turns off autostart, optionally removes every
parent's access, deletes the laptop's credential from Windows, and shows the
owner's `revoke-device` command for the server. It never deletes
`%LOCALAPPDATA%\AW Telegram\`; remove that folder by hand if wanted. Code signing
and automatic updates are not provided in this version.
