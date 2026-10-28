# Telegram bot backend

Task 2 contains shared contracts and Kyiv time helpers. Task 4 adds the Admin-only
enrollment, bearer authorization, private parent pairing and revocation boundary.
Task 5 durable v2 synchronization is reviewed. Task 6 adds action lifecycle, alert
policy, recipient outbox and injected Google/Telegram adapters; independent review is approved. See [backend delivery](../docs/backend-delivery.md) for interfaces and
limits. Task 7 webhook/menu/usage formatting has not started. Task 8 local offers
remain fail closed until its executor is implemented.

Use Node.js 22 (verified 22.14.0) and the locally locked dependencies:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd run check:bundle
```

The local `.npmrc` bypasses npm 10.9.2's optional-peer resolver crash with Vitest.
No global installation is needed. Build output includes schemas in `dist/schemas`;
the compiled backend never needs a deployment-time sibling contracts directory.
See `../docs/api-contract.md` for wire semantics and later-task invariants.
See [enrollment security](../docs/enrollment-security.md) for the local owner CLI,
recovery, consumer authorization requirements, IAM and emulator commands.

Active v2 contracts now require app/category daily rows and provide exact current
selection projections, including descending duration and Unicode scalar name ties.
The [contract/reader extension](../docs/application-usage-amendment.md) is implemented
and approved by independent review. Archived v1 is immutable; legacy report caches
require recollection. Task 4 enrollment/access still uses protocol v1.
Task 5 storage/sync and whole-date bounded batching are reviewed. Task 7 usage
formatting remains unstarted; no usage formatter exists yet.
