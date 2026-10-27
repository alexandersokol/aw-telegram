# ActivityWatch validation — Task 3

Date: 2026-10-27. Task 2 base: `138bb66`. Task 3 is implemented; independent
scoped review approved both corrections. Commit/controller integration remains
pending. This checkpoint adds a local adapter;
it does not enroll a device, pair a parent, persist collection start, upload data,
or run a collection loop.

## Installed Windows binary: metadata and empty queries only

After the owner installed AW on this laptop, an explicit read-only
`127.0.0.1:5600` probe reported **v0.14.1**. Metadata identifies selectable local
`currentwindow` and `afkstatus` buckets. Hostnames, bucket IDs, titles, URLs,
settings values, and credentials are absent from the evidence output.

The supplied config root was
`C:/Users/rraze/AppData/Local/activitywatch/activitywatch`. The relevant TOMLs
contained empty configuration sections with defaults in comments; no configured
API key was detected. Files were read only. No database/log history was opened,
no settings were saved, and no watcher/server was restarted.

The server settings API has no persisted `classes`, `category_sets`, or
`active_set_ids`. Accordingly, `probe()` reports reachable AW but unsupported
category settings (`missing_category_settings`). The UI may still display its
implicit defaults. The adapter never interprets their absence as an empty
user taxonomy and never invokes `aw_client.classes.get_classes()`.

`RETURN = 1;` passed on an empty current time interval. A no-history query using
empty lists with `flood`, `filter_keyvals`, `filter_period_intersect`, and
`categorize` (including `priority` and `select_keys` fields) also passed. These
checks prove endpoint/parser/function availability, **not matching-rule behavior
against real events**. No real window/AFK history was requested; collection start
remained null. Roblox was running according to the owner, but no Roblox-specific
capture/counting or fullscreen acceptance is claimed by this probe.

Before installation, the same explicitly bounded read-only endpoint probe was
refused with `ConnectionRefusedError`, WinError 10061 after sandbox escalation.
That earlier result is retained rather than rewritten as successful.

Evidence: `.superpowers/sdd/implementation-plan/task-3-evidence/installed-probe-after-install.txt`
and `installed-probe.txt`.

### Owner setup required before supported categories

In the AW dashboard, open Settings → Categorization, deliberately create/edit the
intended category rules and save them using AW's own UI. Use foreground `app` or
`title` matching. Then repeat the metadata probe: category support must be true
before the companion can produce summaries. A customized persisted legacy
`classes` list, an explicitly saved `classes: []`, or fully persisted modern
category sets are supported. For modern sets, every active set must be present
in server settings. An empty taxonomy counts activity as the separate internal
uncategorized category; allowance selection remains an explicit choice.

If the UI uses a build-time preset, persist its definitions as an owned category
set rather than leaving an active ID that the settings API cannot resolve. A
genuinely unchanged legacy install-default list is conservatively unsupported
until saved as explicit modern sets or deliberately customized. Persisted custom
rules, colors or scores remain supported even with every stock category name;
recognition compares source-compatible rule/data signatures, not names alone. This
avoids a first-run theme save masking a shipped preset. The adapter does not
modify AW configuration to perform this setup. Metadata probing can precede
pairing; actual collection still requires the first real parent pairing.

The official [REST API](https://docs.activitywatch.net/en/latest/api/rest.html)
documents the info, buckets, query, and key-value settings endpoints, including
null for missing settings. It does not document an effective-default-category
endpoint. The official [categorization guide](https://docs.activitywatch.net/en/latest/features/categorization.html)
describes editing categories and foreground app/title rules; URL matching is
unavailable there. Source `aw-webui/src/util/classes.ts` resolves browser defaults
and build-time presets within the UI. This checkpoint does not scrape UI assets
or claim knowledge of browser-only unsaved settings.

## Dependency and source distinction

The source checkout at `../activity-watch` was used read only. Its `aw-client`
pyproject advertises **0.5.15**, but its newer query helper supports exact bucket
IDs and always-active configuration, and its client has API-key headers. The
published **aw-client 0.5.15 wheel** does not: it always uses `find_bucket`, has no
`exact_bucket_ids` or `always_active_pattern` arguments, and its HTTP methods have
no authentication or request timeout support. Its client constructor also loads
configuration and constructs a request queue.

Therefore Task 3 uses a small audited local fragment builder and standard-library
HTTP transport. No companion runtime dependency was added. The builder preserves
AW server `flood → not-afk filter → period intersection → categorize` authority,
but uses exact IDs, explicit rules, no browser/always-active exceptions, and no
implicit settings client. This local builder must be maintained against AW query
changes; fixtures and explicit semantic checks are the compatibility boundary.

The source fixture server's pyproject advertises **0.14.0**, while its actual info
endpoint reports **v0.13.2**. Neither is the installed binary's **v0.14.1**.
Version labels alone do not establish equal behavior. Every nonempty real read
will verify server priority/select-keys/tie behavior on its transient source
sample before accepting categorization; the installed empty-list probe cannot
establish these semantics yet.

Optional fixture-only dependencies are pinned separately in
`companion/tools/aw-fixture-requirements.lock`, installed under ignored
`companion/.tmp/aw-fixture-deps`. They do not alter the companion runtime venv.
The initial pip target install printed a jsonschema conflict with the editable
companion because that isolated target contains 4.26.0; the actual companion venv
retains its locked 4.25.1 and its own `pip check` is recorded separately.

## Isolated real-source counting proof

`companion/tools/validate_aw_fixture.py` launches a child with APPDATA,
LOCALAPPDATA, XDG roots and AW_PROFILE redirected under `companion/.tmp`, and
`PYTHONDONTWRITEBYTECODE=1`. It imports the source checkout without installing it
editable, starts an authenticated ephemeral nondefault loopback AW server using
MemoryStorage, seeds only synthetic fixture events/settings in memory, then stops
it. Real installed AW config/datastore roots are never seeded or changed.

Input is `companion/tests/fixtures/aw-desktop.json`, a synthetic 120-second stream:
a game with a two-second heartbeat gap, an unrelated Python IDE, a ten-second
companion foreground interval, then an audible browser while AFK.

| Calculation | Total |
|---|---:|
| Companion strict evidence, own foreground excluded | 88,000 ms |
| Selected game category, overlapping parent+child selections | 58,000 ms |
| Companion total after first-pairing clip at second 20 | 68,000 ms |
| UI-source canonical query, strict AFK mode | 100,000 ms |
| UI-source canonical query, default audible exception | 120,000 ms |

The 12-second difference from strict UI-source canonical totals is deliberate:
two seconds of canonical flood estimation are removed by final raw-evidence
intersection, and ten seconds of companion focus are excluded. The additional
20 seconds in default UI mode are audible AFK browser activity, excluded here.
The baseline executes the UI-equivalent source canonical query through the real
server; this is **not** a screenshot comparison against the installed UI.

The same real-source fixture verifies explicit empty categories without default
fallback, a legitimate category literally named `Uncategorized` distinct from
the internal uncategorized ID, modern active-set order/tombstones, escaped Unicode
category paths, first-pair clipping, and AFK live state. It prints no real titles.
Final source output: `task-3-evidence/12-source-server-final.txt`.

To reproduce from companion after installing the isolated fixture dependencies:

```powershell
.venv/Scripts/python.exe -m pip install --target .tmp/aw-fixture-deps -r tools/aw-fixture-requirements.lock
.venv/Scripts/python.exe tools/validate_aw_fixture.py --source-root C:/path/to/activity-watch
```

## Counting and integration boundaries

The adapter validates/normalizes raw events, clips to the paired retained Kyiv
date and now, gives later original timestamps precedence for overlap, intersects
foreground with explicit not-AFK evidence, and counts disjoint category leaves.
It does not extend heartbeat tails or fill sleep gaps. It rounds interval starts
inward/up and ends inward/down to whole milliseconds, so AW microseconds cannot
create invalid wire instants or overstate measured time.

Known AFK and companion-focus spans can establish zero use. Active external spans
need matching canonical identity/category evidence. Missing/malformed evidence
leaves unknown coverage or `partial: true`; a successful empty result has null
coverage, not a measured zero day. The coverage endpoints bound known evidence;
`partial` also records interior gaps. A transport/unsupported result raises for
summaries and preserves `last_summary`. Stale/unavailable live results clear title
and identity; they do not imply power-off. No raw event stream is persisted here.

Bucket choice uses local hostname/type/known watcher metadata, rejecting synced,
remote, importer, Android and ScreenTime candidates. Multiple valid sources need
explicit IDs; there is no most-recent bucket guessing. Metadata-preserving imports
cannot be perfectly distinguished from original local data; that provenance limit
remains explicit. Unknown unsafe IDs and malformed metadata are not queried.

Default companion focus detection matches the packaged executable names or Python
with one of the three exact existing companion window titles, retaining unrelated
Python apps. AW events lack reliable PID/HWND ownership, so a caller may inject
an ownership predicate based on known own identity. Identical spoofed app/title
identity cannot be distinguished through AW metadata alone.

`AWReader` exposes capabilities/health locally. Task 5 must persist the immutable
first-pairing start, provide a durable sequence allocator, and add reviewed health
sync/status semantics while preserving last-known freshness. Default sequence 0
is an unsequenced candidate, not a durable counter or production sync loop.
Missing categories, unresolved presets/active IDs, unsupported rule types/fields,
URL/custom enrichment keys, unsafe bucket IDs, and failed server semantics are
explicit setup/compatibility failures. No generated default taxonomy is used.

## Automated verification

Initial checkpoint (historical): focused adapter/counting suite **40 passed**;
full native companion suite **92 passed in 6.61s**, exit 0. Raw RED/GREEN and
initial verification output is retained under
`.superpowers/sdd/implementation-plan/task-3-evidence/`.

After the two Task 3 review corrections, the focused suite has **74 passed** and
the full suite had **126 passed**. Independent scoped review approved both
corrections in `.superpowers/sdd/implementation-plan/task-3-fix1-review.md`.
After the timer rendering amendment, the current full native companion result is
**127 passed in 9.05s**, exit 0, with scoped test-only loopback/Qt access; the
ordinary sandbox run had 126 passes and one loopback transport failure. Exact
commands/results are in `.superpowers/sdd/implementation-plan/amendment-report.md`.
No offscreen backend or Qt diagnostic suppression was configured. The passing
run emitted no COM diagnostic; the independently reproduced baseline Qt diagnostic
remains documented in `windows-validation.md` and has not been declared fixed.
No TypeScript files changed, so npm checks were not repeated. Included in the reviewed implementation checkpoint.
