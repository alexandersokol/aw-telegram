# Shared contracts: active v2, archived v1

`generate_schemas.py` contains the compact schema definitions. Run it with Python
to regenerate `v2/*.schema.json` and identical active packaged companion assets.
`v1/*.schema.json` is immutable and is never regenerated. Sync uses schemaVersion 2;
Task 4 enrollment/access endpoints keep their separate schemaVersion 1 protocol.
The checked-in JSON schemas work without that script. The Python and TypeScript
validators add Gregorian time, canonical category ID, uniqueness and sum checks
that JSON Schema alone cannot express. Use the runtime validator at each boundary.

`fixtures/` is shared by both suites. `wire.json` contains accepted/rejected payloads;
`time.json` pins Kyiv DST/calendar results; `selection.json` pins exact paths and
deduplication; `evidence.json` covers collection, receipt and cancellation invariants.
Fixture values contain synthetic IDs, application names, messages and current titles only.
`v1-sha256.json` pins the archived schema bytes; regeneration tests verify the archive.

See `docs/api-contract.md` for field semantics, defensive transport caps and the
authenticated state transitions that later tasks must implement.

Active v2 requires exact positive-ms `appLeafTotalsMs` app/category pairs, at most
256 distinct apps and 4096 pairs, reconciled with every disjoint leaf total.
Selection helpers derive descending app totals with Unicode scalar ties from
unfiltered rows. A pure preflight checks one atomic day with maximum mandatory health
and request-sequence overhead inside a 131072-byte
UTF-8 sync body; cardinality limits do not guarantee byte fit. Task 5 bounds
the actual packed body using the transport serializer. Legacy category-only reports must be invalidated/recollected,
never converted into app reports. Task 5 storage/sync is implemented and independently reviewed; Telegram formatting remains pending. Required sync health separates activity
query success from contact; summaryReceipts confirms only submitted date highwaters.
See the [extension checkpoint](../docs/application-usage-amendment.md) for scope.
