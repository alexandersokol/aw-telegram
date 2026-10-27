# Telegram bot backend

Task 2 contains shared contract validation, TypeScript domain types and Kyiv time
helpers. Firebase, grammY, authentication and Telegram sends are later checkpoints.

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

There is no usage formatter yet. Today/yesterday must eventually show application
names/durations for selected-category intervals. Complete/review the pending
[contract/reader extension](../docs/application-usage-amendment.md) before Task 5
sync or Task 7 formatting; current v1 DaySummary rejects app fields.
