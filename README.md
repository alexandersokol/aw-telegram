# AW Telegram

A planned companion for ActivityWatch that lets two parents review their child's
Windows laptop activity and send reminders through Telegram.

Requirements and the implementation plan are approved. No application code has
been implemented or deployed yet. This is a standalone repository.

## Structure

- `docs/`: user requirements and, later, design and setup documentation.
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

## Continue on Windows

Read the [Windows session handoff](docs/windows-handoff.md) for setup, source
references, current progress, and the next implementation checkpoint.
