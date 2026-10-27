# Shared v1 contracts

`generate_schemas.py` contains the compact schema definitions. Run it with Python
to regenerate `v1/*.schema.json` and identical packaged companion schema assets.
The checked-in JSON schemas work without that script. The Python and TypeScript
validators add Gregorian time, canonical category ID, uniqueness and sum checks
that JSON Schema alone cannot express. Use the runtime validator at each boundary.

`fixtures/` is shared by both suites. `wire.json` contains accepted/rejected payloads;
`time.json` pins Kyiv DST/calendar results; `selection.json` pins exact paths and
deduplication; `evidence.json` covers collection, receipt and cancellation invariants.
Fixture values contain synthetic IDs, messages and current titles only.

See `docs/api-contract.md` for field semantics, defensive transport caps and the
authenticated state transitions that later tasks must implement.
