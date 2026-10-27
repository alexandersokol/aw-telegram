# AW Telegram

A companion in development for ActivityWatch that lets two parents review their child's
Windows laptop activity and send reminders through Telegram.

Requirements and the implementation plan are approved. Task 1's Windows/Qt
presentation shell is implemented with automated tests and desktop visual smoke
evidence. Actual game fullscreen acceptance remains pending. Backend, ActivityWatch
integration, and the full companion are not implemented or deployed.

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
