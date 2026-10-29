"""Review regressions: every receipt the executor emits must be one the backend accepts.

A rejected receipt fails the whole sync and stays queued, so one bad receipt would stop all
synchronization. Rules mirrored from bot/src/actions.ts planActionSync: no status regression
within an occurrence, no second terminal status, nondecreasing event time per action, acceptance
no earlier than the first offer, later occurrences only before the family's Kyiv midnight, and
receipt time inside the retained dates.
"""
from datetime import timedelta

import pytest

from aw_telegram.clock import format_instant, parse_instant
from aw_telegram.models import ActionAck, Settings, validate_action_receipt
from aw_telegram.scheduler import Countdown, Hide, Scheduler
from aw_telegram.storage import LocalStore

from action_fixture import NOW, action, uid
from test_actions import Harness, at

RANK = {"accepted": 0, "presenting": 1, "unconfirmed": 1, "presented": 2}
TERMINAL = {"dismissed", "completed", "replaced", "failed", "expired", "canceled", "skipped"}


@pytest.fixture
def h(tmp_path):
    harness = Harness(tmp_path)
    yield harness
    harness.store.close()


def restart(h, when):
    h.store.close()
    h.store = LocalStore(h.path, now=lambda: format_instant(h.time))
    h.scheduler = Scheduler(h.store)
    h.time = when
    h.scheduler.recover(when)


def assert_backend_acceptable(acks, body):
    """The per-occurrence and per-action ordering rules the backend enforces."""
    last_at, occurrences = None, {}
    for ack in sorted(acks, key=lambda a: a.eventSequence):
        validate_action_receipt(body, ack.to_wire())
        assert last_at is None or ack.at >= last_at, "event time went backwards"
        last_at = ack.at
        previous = occurrences.get(ack.occurrence)
        if previous is not None:
            assert previous not in TERMINAL or ack.status == previous, f"{ack.status} after terminal {previous}"
            assert RANK.get(ack.status, 3) >= RANK.get(previous, 3), f"{ack.status} regresses {previous}"
        occurrences[ack.occurrence] = ack.status
    return [(a.status, a.occurrence) for a in sorted(acks, key=lambda a: a.eventSequence)]


def test_restart_after_a_presented_overlay_completes_it_instead_of_regressing(h):
    h.offer(action(1, repeatEveryMinutes=1))
    h.show()
    restart(h, h.time + timedelta(seconds=20))
    statuses = assert_backend_acceptable(h.acks(1), action(1, repeatEveryMinutes=1))
    assert statuses == [("accepted", 0), ("presented", 0), ("completed", 0)]
    assert all(h.shown(h.tick(h.time + timedelta(minutes=n), resumed=n == 0)) == [] for n in range(0, 5))


def test_restart_after_a_presented_card_completes_it(h):
    h.offer(action(1, kind="notify"))
    h.show()
    restart(h, h.time + timedelta(seconds=3))
    assert assert_backend_acceptable(h.acks(1), action(1, kind="notify"))[-1] == ("completed", 0)


def test_restart_before_presentation_was_recorded_reports_unconfirmed(h):
    h.offer(action(1))
    h.tick()  # the overlay was requested but the app died before presented() committed
    restart(h, h.time + timedelta(seconds=5))
    assert assert_backend_acceptable(h.acks(1), action(1)) == [("accepted", 0), ("unconfirmed", 0)]


def test_a_clear_between_repeats_ends_the_family_without_a_contradicting_receipt(h):
    h.offer(action(1, repeatEveryMinutes=10))
    [overlay] = h.shown(h.show())
    h.scheduler.dismissed(overlay.key, h.time + timedelta(seconds=30))
    h.time += timedelta(minutes=3)
    h.fence(through=1)
    statuses = assert_backend_acceptable(h.acks(1), action(1, repeatEveryMinutes=10))
    assert statuses == [("accepted", 0), ("presented", 0), ("dismissed", 0)]
    assert h.store.open_actions() == []
    assert h.shown(h.tick(h.time + timedelta(minutes=20))) == []


def test_acceptance_is_no_earlier_than_the_delivering_response(h):
    # The laptop runs 1 s behind; the server first offered the action 10 s after creating it.
    created = "2026-10-28T11:59:50.000Z"
    h.time = parse_instant(NOW) - timedelta(seconds=1)
    h.store.receive_offers([action(1, created=created)], server_now=NOW)
    [ack] = h.acks(1)
    assert ack.acceptedAt == NOW and ack.at == NOW


def test_a_visible_repeat_at_midnight_ends_without_a_late_receipt(h):
    body = action(1, created="2026-10-28T21:50:00.000Z", repeatEveryMinutes=1)
    h.time = parse_instant(body["createdAt"])
    h.offer(body)
    [first] = h.shown(h.show())
    h.scheduler.dismissed(first.key, at("23:58:50"))
    [second] = h.shown(h.show(at("23:59:50")))
    commands = h.tick(at("00:00:00.500", "2026-10-29"))
    assert Hide(second.key) in commands
    assert assert_backend_acceptable(h.acks(1), body)[-1] == ("presented", 1)
    assert h.store.open_actions() == []


def test_waking_after_midnight_never_shows_yesterdays_repeat(h):
    body = action(1, created="2026-10-28T21:50:00.000Z", repeatEveryMinutes=1)
    h.time = parse_instant(body["createdAt"])
    h.offer(body)
    [first] = h.shown(h.show())
    h.scheduler.dismissed(first.key, at("23:58:59.500"))  # next repeat due 23:59:59.500
    assert h.shown(h.show(at("00:30:00", "2026-10-29"), resumed=True)) == []
    assert assert_backend_acceptable(h.acks(1), body)[-1] == ("dismissed", 0)
    assert h.store.open_actions() == []


def test_a_dismissal_just_after_midnight_sends_no_late_receipt(h):
    body = action(1, created="2026-10-28T21:50:00.000Z", repeatEveryMinutes=1)
    h.time = parse_instant(body["createdAt"])
    h.offer(body)
    [first] = h.shown(h.show())
    h.scheduler.dismissed(first.key, at("23:58:00"))
    [second] = h.shown(h.show(at("23:59:30")))
    h.scheduler.dismissed(second.key, at("00:00:00.200", "2026-10-29"))
    assert assert_backend_acceptable(h.acks(1), body)[-1] == ("presented", 1)
    assert h.store.open_actions() == []


def test_event_time_never_goes_backwards_after_a_clock_correction(h):
    h.offer(action(1))
    [overlay] = h.shown(h.show(h.time + timedelta(seconds=20)))
    h.scheduler.dismissed(overlay.key, parse_instant(NOW) + timedelta(seconds=5))  # clock stepped back
    acks = h.acks(1)
    assert_backend_acceptable(acks, action(1))
    assert [a.eventSequence for a in h.store.pending_acks() if isinstance(a, ActionAck)] == [1, 2, 3]


def test_receipts_outside_the_retained_dates_are_dropped(h):
    h.offer(action(1))
    h.show()
    h.store.prune("2026-11-05T12:00:00.000Z")
    assert h.acks(1) == []


def test_free_use_hides_the_countdown_and_keeps_its_deadline(h):
    h.offer(action(1, delay=15, countdown=True))
    [countdown] = [c for c in h.tick() if isinstance(c, Countdown)]
    h.settings(revision=1, freeUseDate="2026-10-28")
    assert h.tick(at("14:01:00")) == [Hide(countdown.key)]
    h.settings(revision=2)
    [again] = [c for c in h.tick(at("14:02:00")) if isinstance(c, Countdown)]
    assert again.until == at("14:15:00")


def test_free_use_removes_a_visible_reminder_and_card(h):
    h.offer(action(1), action(2, kind="notify"))
    commands = h.show()
    assert len(h.shown(commands)) == 2
    h.settings(revision=1, freeUseDate="2026-10-28")
    commands = h.tick(h.time + timedelta(seconds=1))
    assert sorted(c.key for c in commands if isinstance(c, Hide)) == sorted(
        [f"manual:{uid(1)}:1", f"notify:{uid(2)}"])
    assert assert_backend_acceptable(h.acks(1), action(1))[-1] == ("skipped", 0)
    assert assert_backend_acceptable(h.acks(2), action(2, kind="notify"))[-1] == ("skipped", 0)
    assert h.acks(1)[-1].reason == "free_use"
