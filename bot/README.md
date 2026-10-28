# Telegram bot backend

Task 2 contains shared contracts and Kyiv time helpers. Task 4 adds the Admin-only
enrollment, bearer authorization, private parent pairing and revocation boundary.
Telegram webhook verification, menus, sync and delivery remain later checkpoints.

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

There is no usage formatter yet. Today/yesterday must eventually show application
names/durations for selected-category intervals. Complete/review the pending
[contract/reader extension](../docs/application-usage-amendment.md) before Task 5
sync or Task 7 formatting; current v1 DaySummary rejects app fields.
