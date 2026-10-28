# AW Telegram

A companion in development for ActivityWatch that lets two parents review their child's
Windows laptop activity and send reminders through Telegram.

Requirements and the implementation plan are approved. Tasks 1–2 provide the
Windows/Qt presentation shell, strict contracts and Kyiv calendar helpers. Task 3's
local ActivityWatch adapter/counting has passed independent scoped review after
both corrections; included in the reviewed implementation checkpoint. Its focused suite has 74 passing tests;
the full native companion suite has 127 after the timer amendment. See
[ActivityWatch validation](docs/activitywatch-validation.md). Actual game
fullscreen acceptance remains pending. Task 4 enrollment/authentication/pairing and
revocation implementation and tests are complete, with independent review approved: 22 emulator checks, 29 enrollment tests and a synthetic native Windows
vault probe passed. See [enrollment security](docs/enrollment-security.md) for exact
scope and limits. Persistent synchronization, Telegram delivery, the full companion
and deployment remain later checkpoints.

Today/yesterday usage is specified as application names/durations from selected
category intervals; weekly reports remain daily totals. The required
[contract/reader extension](docs/application-usage-amendment.md) now implements active
v2 app × disjoint-category aggregates and selection helpers; independent review is
pending. Archived v1 remains immutable and category-only. Storage/sync and bot
formatting are still pending. Task 4 enrollment/access stays protocol v1. The countdown
uses a 70% #242424 background with opaque white text.

## Structure

- `docs/`: approved requirements, design, plan, and validation evidence.
- `companion/`: Windows companion application.
- `bot/`: Firebase Cloud Functions backend and Telegram bot.

Start with [the user requirements](docs/user-requirements.md) and the
[agreed bot navigation and reminder flow](docs/bot-navigation.md), plus the
[companion interface](docs/companion-navigation.md).


## Technical planning

- [Technical design and decisions](docs/technical-design.md)
- [Phased implementation plan](docs/implementation-plan.md)

The owner approved these documents on 2026-10-27. Windows fullscreen validation
is an explicit release gate.

See [companion setup and the local harness](companion/README.md) and
[Windows evidence and pending acceptance](docs/windows-validation.md).

## Continue on Windows

Read the [Windows session handoff](docs/windows-handoff.md) for setup, source
references, current progress, and the next implementation checkpoint.
