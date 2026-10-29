"""Valid v2 delivery offers for executor tests."""
from datetime import timedelta

from aw_telegram.clock import format_instant, parse_instant

NOW = "2026-10-28T12:00:00.000Z"  # 14:00 Kyiv


def uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def action(n, *, kind="overlay", created=NOW, delay=0, sequence=None, message=None, **options):
    """A notify or dismissible overlay offer; pass dismissible=False, durationSeconds=N for buttonless."""
    start = parse_instant(created)
    target = start + timedelta(minutes=delay)
    expires = target + (timedelta(seconds=5) if delay else timedelta(seconds=60))
    base = dict(message=message or f"Нагадування {n}", countdown=False)
    if kind == "overlay":
        base.update(dismissible=True, repeatEveryMinutes=None)
        if options.get("dismissible") is False:
            base.pop("repeatEveryMinutes")
    base.update(options)
    return dict(id=uid(n), actorId="1", kind=kind, createdAt=created, targetAt=format_instant(target),
                expiresAt=format_instant(expires), options=base, sequence=sequence or n, settingsRevision=0)
