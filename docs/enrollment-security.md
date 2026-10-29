# Enrollment and access boundary (Task 4)

The backend is an Admin SDK service. `firestore.rules` denies all authenticated and
anonymous client database reads and writes, including unknown nested paths. Those
rules do not restrict Admin SDK operations; production security also requires IAM.
There is no device mint, device revoke, Telegram webhook, sync, menu or send server
started automatically by importing the package.

## Owner setup and recovery

Run the CLI on the owner's administrative workstation, with the project's owner
ADC/IAM environment already configured. Never copy an admin key, bot token or
webhook secret to the companion laptop. The CLI requires an explicit project and
does not log in or deploy anything. Build first, then issue a 15-minute bundle:

```powershell
Set-Location C:/Users/rraze/OneDrive/Documents/Projects/other/aw-telegram/bot
npm.cmd run build
node --experimental-strip-types scripts/enroll.ts issue --project YOUR_PROJECT --backend-url https://YOUR_BACKEND_HOST
```

The CLI prints `{backendUrl,secret}` once. Keep that output out of persistent logs,
shell transcripts and command arguments. The companion validates the URL and must
show the canonical host for explicit acceptance before sending the secret. HTTPS
proves the server hostname's TLS identity; acceptance establishes owner intent.
Only HTTPS origins are supported (optional port, no base path beyond `/`). No
redirect is followed. The enrollment response contains a random device UUID and
32-byte bearer; only its SHA-256 digest is persisted in Firestore.

`Transport.enroll` stores the bearer in the explicit Windows Credential Manager
backend, verifies the write, then returns only `{deviceId,backendUrl}`. Configuration
may persist those public values. Do not persist enrollment bundles or pair-key
response secrets. There is no plaintext keyring fallback. A missing/unavailable
vault fails setup. Use `tools/probe_vault.py` for a synthetic write/read/delete
probe; it never enumerates existing credentials.

Enrollment consumption is final even if the HTTP response is lost or vault storage
fails. The service keeps no plaintext bearer to replay. The owner must revoke the
orphan and issue a new bundle. Supply the original enrollment code through stdin
to this recovery operation (use secure interactive input rather than a literal
shell command or a transcript):

```powershell
node --experimental-strip-types scripts/enroll.ts revoke-enrollment --project YOUR_PROJECT
```

The CLI reads stdin through EOF. Recovery expires an unconsumed enrollment or
revokes its consumed device in one transaction. If the device UUID is already
known, `revoke-device --project YOUR_PROJECT --device-id UUID` also works. Device
revocation clears its digest and invalidates its parents and pending keys. Any
partially written vault entry can be deleted by its public backend/device values;
it cannot authorize the revoked device. A newly issued enrollment is a new identity.

Revoking an already paired device preserves its historical parent/binding
documents. Its parents immediately fail authorization, but the retained numeric
Telegram binding blocks automatic pairing to a replacement device. That migration
requires owner administrative maintenance: revoke the old parent and matching
binding together (and remove the old active slot), then pair a fresh key on the
new device. Preserve collectionStartedAt and all generation checks. This CLI
does not automate paired-device migration. Orphan enrollment recovery before any
pairing has no such bindings to migrate.

## HTTP contracts and identities

Every JSON request uses strict UTF-8 parsing, duplicate-key rejection, integer
notation and the existing 128 KiB limit. The two POST envelopes are closed. Secret
and access responses have `Cache-Control: no-store`; errors never echo input.

| Route | Request | Result |
|---|---|---|
| `POST /v1/enroll` | `{schemaVersion:1,secret}` | `{schemaVersion:1,deviceId,deviceSecret}` |
| `POST /v1/pair-keys` | bearer and `{schemaVersion:1,name}` | `{schemaVersion:1,id,name,secret,expiresAt}` (201) |
| `GET /v1/access` | bearer; optional `?page=UUID` | `{schemaVersion:1,parents,keys,nextPage}` |
| `DELETE /v1/access/ID` | bearer, empty body | 204, including stale/missing/foreign references |

Labels contain 1–80 Unicode scalars and cannot be whitespace-only. Device bearers
are canonical, unpadded base64url encodings of 32 bytes in exactly one
`Authorization: Bearer ...` header. No body/query/cookie/device-ID fallback exists.
The Node adapter checks raw header duplication. Digest lookup is bounded to two
devices and requires exactly one active result. No authorization success is cached.

Parent keys contain 16 random bytes and expire at server `now >= expiresAt` after
15 minutes. Their hashed document IDs are never public access IDs. A pending key
uses `key:UUID`; a parent uses `parent:NUMERIC_USER_ID:PAIRING_UUID`. Consumed keys
do not alias parents. Access responses list current parents plus at most 50
unconsumed keys per page, including derived pending/expired/revoked status.

Invalid/used/expired/revoked exchanges share generic errors. Transaction-backed
15-minute attempt windows permit 5 enrollment attempts per normalized trusted IP
and 10 pairing attempts per numeric sender, across repository instances/restarts.
Throttled requests use a generic 429 plus Retry-After. Throttle IDs hash their
subjects; raw IPs and secrets are not logged or stored as document IDs.

The Node adapter uses socket source IP and ignores forwarded headers. Behind a
managed reverse proxy, this may be a shared proxy address and share a quota across
clients. Before production deployment, establish and test the platform's verified
client-IP semantics and ingress limits, then inject a trusted adapter if needed.
Do not trust arbitrary `X-Forwarded-For` supplied by callers.

## Rules for Task 5–7 consumers

`authorizeDevice(request, repository)` resolves `{deviceId,credentialDigest}`. This
is not a permanent grant. Every mutation must call
`repository.requireDevice(transaction, identity)` inside the mutation's Firestore
transaction before protected writes. Derive all device scope from that identity.
The enrollment creates default settings and `collectionStartedAt:null`; the first
successful pairing fixes `collectionStartedAt` permanently. Revoking all parents
does not clear it. No AW collection/import starts in this task.

`pairPrivateUpdate(repository, secret, update)` is an internal adapter and must be
called only after Task 7 verifies the Telegram webhook secret. It rejects groups,
channels, business/inline/forwarded contexts, bots, unsafe IDs and mismatched chat
and sender IDs before database access. Its scalar `pairParent` repository method
cannot establish provenance by itself and must never become a public HTTP route.

`authorizeParent(actor)` resolves `{deviceId,userId,chatId,pairingId}` from the
current binding. Each successful pairing creates a new random pairingId and
atomically updates the key, parent, binding and device `activeParentIds`. The
device document serializes the maximum of ten active caregivers. Named keys do not
reserve parent slots. Re-pairing requires revoking the current access first.

The ten-account limit supersedes Task 4's two-account guard. It is implemented as
the shared `MAX_ACTIVE_CAREGIVERS` (commit d113476) in `activeDevice`, the pairing
transaction, recipient reads and outbox bounds. An emulator race proves the eleventh
concurrent pairing fails without consuming its key and revocation frees a slot.
Existing generation-bound authorization and revocation behavior is unchanged. The
`/endtime` menu sessions use `requireCallback` with a per-caregiver nonce/version
and 30-minute expiry. Revocation deletes the session, so old buttons are rejected.

Callbacks must store the same pairingId with chat, nonce, version and expiry, then
call `requireCallback(tx, identity, nonce, version)` inside their protected
transaction. `requireParent(tx, identity)` is the corresponding command/read
boundary. Revocation deletes sessions and invalidates all old generations. A
stale access-list deletion cannot revoke replacement access.

Queued recipients must persist only `{deviceId,userId,pairingId}` as their
authorization reference, resolve the actual chat using `authorizeRecipient(ref)`
after acquiring a lease, and repeat that guard immediately before every send or
retry. Do not use a queued chat ID as authority. Task 4 tests this with a fake
sink only. Task 6 supplies leasing/delivery. A Telegram request already in flight
when revocation commits cannot be recalled. No outbox cleanup is required to
invalidate queued authorization, and no Telegram request was made in this task.

Database timestamps here are server-process UTC epoch milliseconds; HTTP expiry
uses canonical UTC millisecond strings. Firestore callbacks may retry: all
randomness is generated outside them and callbacks perform no external side
effects. Later consumers must read authorization and all other required documents
before writes in the same transaction. These endpoint envelopes do not modify
the Task 2 sync contract; the pending usage amendment remains a Task 5/7 gate.

## IAM and deployment gate (documentation only)

Use a dedicated backend service account with Firestore data access
(`roles/datastore.user`, or a reviewed narrower custom role), rather than project
Owner/Editor. Only authorized owner administration identities may run issuance
and recovery. Do not make admin credentials available to the companion or client
SDK. Restrict bot/webhook secrets to their named Secret Manager resources and only
the service accounts that need them; later webhook/deployment setup remains a
separate gate. Review HTTP ingress, verified proxy semantics and TLS hostname
before publishing the service. Deploy the deny-all rules and declared indexes
through the owner's reviewed deployment process. Equality digest indexes remain
automatic; the two pair-key composite indexes support public-ID lookup and
bounded pagination. Review cleanup/retention for old consumed keys and throttle
windows before a long-running deployment; no scheduler or TTL setup is added here.

Emulators verify transaction behavior and client rules, not production IAM,
deployed indexes, TLS hosting trust, webhook verification or external delivery.
No real Firebase login, credentials, deployment or Telegram send was used here.

## Local verification

Use exact local dependencies with Node 22.14.0, npm 10.9.2, Python 3.12 and the
verified JBR 25.0.3. Firebase CLI 15.34.1 downloads Firestore emulator 1.22.0 into
ignored project `.firebase/emulators`; config is redirected to `.firebase/config`
using the CLI's supported `FIREBASE_EMULATORS_PATH` and `XDG_CONFIG_HOME` handling.
Only process environment values change:

```powershell
Set-Location C:/Users/rraze/OneDrive/Documents/Projects/other/aw-telegram/bot
$env:JAVA_HOME='C:/Program Files/JetBrains/PyCharm 2023.3.5/jbr'
$env:Path=$env:JAVA_HOME+'/bin;'+$env:Path
npm.cmd run build
npm.cmd run test:emulator -- auth pairing rules
npm.cmd test
npm.cmd run check:bundle
Set-Location ../companion
.venv/Scripts/python.exe -m pytest tests/test_enrollment.py -q --basetemp=.tmp/task4-enrollment
.venv/Scripts/python.exe tools/probe_vault.py
```

Tests require exact `demo-aw-telegram`, explicit loopback
`FIRESTORE_EMULATOR_HOST`, and no credential-file environment. Fixture resets
target only that demo emulator. Metadata probing is disabled for emulator tests.
Rules use the client SDK separately from Admin transaction tests. The regular
unit suite excludes emulator files so it cannot fall through to a live project.
Restricted sandbox temp/network/vault access may need the host's scoped local
execution approval; this is not Firebase login or deployment permission.

Runtime npm audit currently reports zero vulnerabilities. Full development audit
reports 10 (6 moderate, 4 high), all from local Firebase CLI/client test tooling:
the client pins old gRPC, and CLI brings OTel/pubsub, uuid/gaxios and optional re2.
Do not expose the emulator publicly or treat these tools as production runtime.
The exact advisory/tree evidence and attempted narrow override limit are recorded
in the Task 4 implementation report; resolve toolchain advisories before a broader
deployment/test environment, without silently changing the repository runtime.
