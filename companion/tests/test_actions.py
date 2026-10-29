"""Durable offer store and local action executor against a real LocalStore and a fake clock."""
from datetime import datetime, timedelta

import pytest

from aw_telegram.clock import KYIV, UTC, format_instant, parse_instant
from aw_telegram.models import ActionAck, Settings, validate_action_receipt
from aw_telegram.storage import LocalStore
from aw_telegram.windows.foreground import PresentationResult

from action_fixture import NOW, action, uid

SHOWN = PresentationResult("unconfirmed", "topmost_requested")
FAILED = PresentationResult("failed", "invalid_overlay_handle")


def at(clock, date="2026-10-28"):
    return datetime.fromisoformat(f"{date}T{clock}").replace(tzinfo=KYIV).astimezone(UTC)


class Harness:
    def __init__(self, tmp_path):
        from aw_telegram.scheduler import Scheduler
        self.time = parse_instant(NOW)
        self.path = tmp_path / "companion.sqlite"
        self.store = LocalStore(self.path, now=lambda: format_instant(self.time))
        self.scheduler = Scheduler(self.store)
        self.sent = {}

    def settings(self, **fields):
        with self.store._transaction():
            state = self.store._state()
            state["settings"] = Settings(**fields).to_wire()
            self.store._save(state)

    def fence(self, revision=1, through=0, ids=()):
        with self.store._transaction():
            state = self.store._state()
            state.update(cancellationRevision=revision, throughActionSequence=through)
            self.store._save(state)
            for i in ids:
                self.store.connection.execute("insert or ignore into canceled_ids values(?,?)", (i, NOW))
            self.store._cancel_covered(format_instant(self.time))

    def offer(self, *actions):
        self.store.receive_offers(list(actions))

    def tick(self, when=None, resumed=False):
        if when is not None:
            self.time = when
        return self.scheduler.tick(self.time, resumed)

    def show(self, when=None, result=SHOWN, resumed=False):
        commands = self.tick(when, resumed)
        for c in commands:
            if type(c).__name__ == "Presentation" and c.source == "manual":
                self.scheduler.presented(c.key, result, self.time)
        return commands

    def acks(self, n=None):
        acks = [a for a in self.store.pending_acks() if isinstance(a, ActionAck)]
        return [a for a in acks if n is None or a.actionId == uid(n)]

    def statuses(self, n):
        return [(a.status, a.occurrence, a.reason) for a in self.acks(n)]

    @staticmethod
    def shown(commands, kind=None):
        return [c for c in commands if type(c).__name__ == "Presentation" and c.source == "manual" and (kind is None or c.kind == kind)]


@pytest.fixture
def h(tmp_path):
    harness = Harness(tmp_path)
    yield harness
    harness.store.close()


def names(commands):
    return [type(c).__name__ for c in commands]


def test_offers_are_persisted_and_acknowledged_once(h):
    h.offer(action(1))
    h.offer(action(1))
    [ack] = h.acks(1)
    assert (ack.status, ack.eventSequence, ack.acceptedAt, ack.presentedAt) == ("accepted", 1, NOW, None)
    validate_action_receipt(action(1), ack.to_wire())


def test_expired_and_fenced_offers_are_rejected_without_acceptance(h):
    h.time = parse_instant(NOW) + timedelta(seconds=60)
    h.offer(action(1))
    h.fence(through=2)
    later = "2026-10-28T12:01:00.000Z"
    h.offer(action(2, created=later), action(3, created=later))
    assert h.statuses(1) == [("expired", 0, "missed_deadline")]
    assert h.statuses(2) == [("canceled", 0, "canceled")]
    assert [a.status for a in h.acks(3)] == ["accepted"]
    assert all(a.acceptedAt is None for a in h.acks(1) + h.acks(2))
    [shown] = h.shown(h.tick())
    assert shown.key.split(":")[1] == uid(3)


def test_immediate_overlay_is_shown_once_and_dismissal_completes_it(h):
    h.offer(action(1))
    [overlay] = h.shown(h.show())
    assert (overlay.kind, overlay.text, overlay.dismissible) == ("overlay", "Нагадування 1", True)
    h.scheduler.dismissed(overlay.key, h.time + timedelta(seconds=9))
    assert h.statuses(1) == [("accepted", 0, None), ("presented", 0, None), ("dismissed", 0, None)]
    assert all(h.shown(h.tick(h.time + timedelta(minutes=n))) == [] for n in range(1, 5))
    for ack in h.acks(1):
        validate_action_receipt(action(1), ack.to_wire())


def test_failed_presentation_is_terminal(h):
    h.offer(action(1))
    h.show(result=FAILED)
    assert h.statuses(1)[-1] == ("failed", 0, "presentation_failed")
    assert h.shown(h.tick(h.time + timedelta(seconds=1))) == []


def test_delayed_overlay_counts_down_then_shows_within_the_five_second_tolerance(h):
    h.offer(action(1, delay=15, countdown=True))
    [countdown] = [c for c in h.tick() if type(c).__name__ == "Countdown"]
    assert countdown.until == at("14:15:00") and countdown.text == "Нагадування 1"
    assert h.tick(h.time + timedelta(seconds=30)) == []  # unchanged countdown is not reissued
    commands = h.show(at("14:15:04.999"))
    assert "Hide" in names(commands) and len(h.shown(commands)) == 1
    assert h.statuses(1)[-1] == ("presented", 0, None)


@pytest.mark.parametrize("resumed", [False, True])
def test_waking_past_the_delayed_deadline_expires_without_display(h, resumed):
    h.offer(action(1, delay=15, countdown=True))
    h.tick()
    commands = h.tick(at("14:15:05.001"), resumed=resumed)
    assert h.shown(commands) == [] and "Hide" in names(commands)
    assert h.statuses(1)[-1] == ("expired", 0, "missed_deadline")


def test_waking_before_the_target_resumes_the_countdown(h):
    h.offer(action(1, delay=15, countdown=True))
    h.tick()
    h.store.close()
    h.store = LocalStore(h.path, now=lambda: format_instant(h.time))
    from aw_telegram.scheduler import Scheduler
    h.scheduler = Scheduler(h.store)
    h.scheduler.recover(at("14:10:00"))
    [countdown] = [c for c in h.tick(at("14:10:00"), resumed=True) if type(c).__name__ == "Countdown"]
    assert countdown.until == at("14:15:00")


def test_repeating_overlay_returns_after_its_interval_until_midnight(h):
    h.offer(action(1, repeatEveryMinutes=2))
    [first] = h.shown(h.show())
    h.scheduler.dismissed(first.key, at("14:00:10"))
    assert h.shown(h.tick(at("14:02:09"))) == []
    [second] = h.shown(h.show(at("14:02:10")))
    assert second.key != first.key
    h.scheduler.dismissed(second.key, at("23:58:30"))
    assert h.shown(h.tick(at("00:00:30", "2026-10-29"))) == []
    assert h.statuses(1) == [("accepted", 0, None), ("presented", 0, None), ("dismissed", 0, None),
                             ("presented", 1, None), ("dismissed", 1, None)]
    for ack in h.acks(1):
        validate_action_receipt(action(1, repeatEveryMinutes=2), ack.to_wire())


def test_midnight_removes_a_visible_repeat(h):
    h.offer(action(1, created="2026-10-28T21:59:30.000Z", repeatEveryMinutes=5))
    h.time = parse_instant("2026-10-28T21:59:30.000Z")
    [overlay] = h.shown(h.show())
    commands = h.tick(at("00:00:00", "2026-10-29"))
    assert [c.key for c in commands if type(c).__name__ == "Hide"] == [overlay.key]
    assert h.statuses(1)[-1] == ("completed", 0, None)


def test_buttonless_overlay_completes_at_its_duration(h):
    h.offer(action(1, message="Увага", dismissible=False, durationSeconds=30))
    [overlay] = h.shown(h.show())
    assert (overlay.dismissible, overlay.duration_ms) == (False, 30000)
    h.scheduler.dismissed(overlay.key, h.time + timedelta(seconds=30), reason="expired")
    assert h.statuses(1)[-1] == ("completed", 0, None)


def test_notification_cards_complete_and_report_replacement(h):
    h.offer(action(1, kind="notify"))
    [card] = h.shown(h.show(), "notification")
    h.offer(action(2, kind="notify"))
    [newer] = h.shown(h.show(h.time + timedelta(seconds=2)), "notification")
    h.scheduler.dismissed(card.key, h.time, reason="replaced")
    h.scheduler.dismissed(newer.key, h.time + timedelta(seconds=10), reason="expired")
    assert h.statuses(1)[-1] == ("replaced", 0, "replaced")
    assert h.statuses(2)[-1] == ("completed", 0, None)


def test_timers_due_during_free_use_are_skipped_not_replayed(h):
    h.offer(action(1, delay=10))
    h.settings(revision=1, freeUseDate="2026-10-28")
    assert h.shown(h.tick(at("14:10:00"))) == []
    assert h.statuses(1)[-1] == ("skipped", 0, "free_use")
    h.settings(revision=2)
    assert h.shown(h.tick(at("14:10:02"))) == []


def test_cancellation_fence_cancels_waiting_and_visible_actions(h):
    h.offer(action(1), action(2, delay=30, countdown=True))
    [overlay] = h.shown(h.show())
    h.fence(through=2)
    commands = h.tick(h.time + timedelta(seconds=1))
    assert sorted(c.key for c in commands if type(c).__name__ == "Hide") == sorted([overlay.key, f"countdown:{uid(2)}"])
    assert h.statuses(1)[-1] == ("canceled", 0, "canceled") and h.statuses(2)[-1] == ("canceled", 0, "canceled")
    assert h.acks(1)[-1].acceptedAt == NOW
    assert h.shown(h.tick(at("14:30:00"))) == []


def test_newest_due_overlay_replaces_a_manual_family_terminally(h):
    h.offer(action(1, repeatEveryMinutes=1))
    [first] = h.shown(h.show())
    h.offer(action(2, created="2026-10-28T12:00:30.000Z"))
    commands = h.show(h.time + timedelta(seconds=30))
    assert [c.key for c in commands if type(c).__name__ == "Hide"] == [first.key]
    assert h.statuses(1)[-1] == ("replaced", 0, "replaced")
    second = h.shown(commands)[0]
    h.scheduler.dismissed(second.key, h.time + timedelta(seconds=5))
    assert all(h.shown(h.tick(h.time + timedelta(minutes=n))) == [] for n in range(1, 5))


def test_restart_after_a_visible_overlay_completes_it_without_replay(h):
    h.offer(action(1, repeatEveryMinutes=1))
    h.show()
    h.store.close()
    h.store = LocalStore(h.path, now=lambda: format_instant(h.time))
    from aw_telegram.scheduler import Scheduler
    h.scheduler = Scheduler(h.store)
    h.scheduler.recover(h.time + timedelta(seconds=20))
    assert h.statuses(1)[-1] == ("completed", 0, None)  # presented before the restart
    assert all(h.shown(h.tick(h.time + timedelta(minutes=n), resumed=n == 0)) == [] for n in range(0, 5))
    h.offer(action(1, repeatEveryMinutes=1))
    assert len(h.acks(1)) == 3


def test_terminal_actions_prune_with_retention(h):
    h.offer(action(1))
    h.show()
    h.store.prune("2026-11-05T12:00:00.000Z")
    assert h.store.connection.execute("select count(*) from actions").fetchone()[0] == 0


def test_a_laptop_clock_behind_the_server_never_records_acceptance_before_creation(h):
    h.time = parse_instant(NOW) - timedelta(seconds=3)
    h.offer(action(1))
    [ack] = h.acks(1)
    assert ack.acceptedAt == NOW
    assert h.shown(h.tick()) == []  # not due until the laptop clock reaches the target
    assert len(h.shown(h.show(parse_instant(NOW)))) == 1
    for receipt in h.acks(1):
        validate_action_receipt(action(1), receipt.to_wire())
