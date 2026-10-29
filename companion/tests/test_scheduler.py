"""Durable endtime scheduling, receipts and newest-overlay-wins against a real LocalStore."""
from datetime import datetime, timedelta
import importlib
import importlib.util

import pytest

from aw_telegram.clock import KYIV, UTC, format_instant
from aw_telegram.models import Settings, EndtimeAck
from aw_telegram.storage import LocalStore
from aw_telegram.windows.foreground import PresentationResult

from action_fixture import action

SHOWN = PresentationResult("unconfirmed", "topmost_requested")
FAILED = PresentationResult("failed", "invalid_overlay_handle")


def scheduler():
    assert importlib.util.find_spec("aw_telegram.scheduler"), "endtime scheduler is not implemented"
    return importlib.import_module("aw_telegram.scheduler")


def at(clock, date="2026-10-28"):
    return datetime.fromisoformat(f"{date}T{clock}").replace(tzinfo=KYIV).astimezone(UTC)


class Harness:
    def __init__(self, tmp_path, **settings):
        self.path = tmp_path / "companion.sqlite"
        self.open()
        self.settings(**{"revision": 1, "endtimeEnabled": True, "endtimeGeneration": 1, **settings})

    now = "2026-10-28T19:00:00.000Z"

    def open(self):
        self.store = LocalStore(self.path, now=lambda: self.now)
        self.scheduler = scheduler().Scheduler(self.store)

    def restart(self, now):
        self.store.close()
        self.open()
        self.scheduler.recover(now)

    def settings(self, **fields):
        with self.store._transaction():
            state = self.store._state()
            state["settings"] = Settings(**fields).to_wire()
            self.store._save(state)

    def offer(self, n, created, **options):
        """Deliver a manual overlay offer at its creation instant."""
        self.now = format_instant(created)
        self.store.receive_offers([action(n, created=self.now, **options)])

    def tick(self, now, resumed=False):
        return self.scheduler.tick(now, resumed)

    def show(self, now, result=SHOWN, resumed=False):
        """Tick and report every overlay request as shown at the same instant."""
        commands = self.tick(now, resumed)
        for command in self.overlays(commands):
            self.scheduler.presented(command.key, result, now)
        return commands

    @staticmethod
    def overlays(commands):
        return [c for c in commands if getattr(c, "kind", None) == "overlay"]

    def receipts(self):
        return [a for a in self.store.pending_acks() if isinstance(a, EndtimeAck)]


@pytest.fixture
def h(tmp_path):
    harness = Harness(tmp_path)
    yield harness
    harness.store.close()


def test_warning_cards_are_notifications_not_receipts(h):
    commands = h.tick(at("20:45:00"), resumed=True)
    assert [(c.kind, c.source) for c in commands] == [("notification", "endtime")]
    assert "15 хв" in commands[0].text and "21:00" in commands[0].text
    assert h.receipts() == []


def test_first_accepted_overlay_queues_one_durable_receipt_and_repeats_never_add_more(h):
    first = h.overlays(h.show(at("21:00:00"), resumed=True))
    assert len(first) == 1 and first[0].source == "endtime" and first[0].dismissible and "21:00" in first[0].text
    [receipt] = h.receipts()
    assert receipt.to_wire() | {"id": None} == dict(id=None, kind="endtime", date="2026-10-28", settingsRevision=1,
        endtimeLocalTime="21:00", endtimeGeneration=1, presentedAt="2026-10-28T19:00:00.000Z")
    h.scheduler.dismissed(first[0].key, at("21:00:30"))
    assert h.overlays(h.tick(at("21:01:29"))) == []
    assert len(h.overlays(h.show(at("21:01:30")))) == 1
    assert len(h.receipts()) == 1


def test_failed_presentation_retries_without_a_false_receipt(h):
    h.show(at("21:00:00"), FAILED, resumed=True)
    assert h.receipts() == []
    assert h.overlays(h.tick(at("21:00:59"))) == []
    h.show(at("21:01:00"))
    [receipt] = h.receipts()
    assert receipt.presentedAt == format_instant(at("21:01:00"))


def test_later_same_day_generation_earns_a_second_receipt_and_hides_the_old_overlay(h):
    [overlay] = h.overlays(h.show(at("21:00:00"), resumed=True))
    h.settings(revision=2, endtimeEnabled=True, endtimeGeneration=2, endtimeLocalTime="21:30")
    commands = h.tick(at("21:10:00"))
    assert [c.key for c in commands if type(c).__name__ == "Hide"] == [overlay.key]
    h.show(at("21:30:00"))
    assert [(r.endtimeGeneration, r.settingsRevision, r.endtimeLocalTime) for r in h.receipts()] == [(1, 1, "21:00"), (2, 2, "21:30")]


def test_unrelated_settings_revision_keeps_one_receipt_per_generation(h):
    [overlay] = h.overlays(h.show(at("21:00:00"), resumed=True))
    h.scheduler.dismissed(overlay.key, at("21:00:05"))
    h.settings(revision=2, endtimeEnabled=True, endtimeGeneration=1, defaultLimitMs=1234)
    h.show(at("21:01:05"))
    assert len(h.receipts()) == 1


@pytest.mark.parametrize("field", ["freeUseDate", "suppressedDate"])
def test_suppression_hides_the_visible_overlay_and_stops_recurrence(h, field):
    [overlay] = h.overlays(h.show(at("21:00:00"), resumed=True))
    h.settings(revision=2, endtimeEnabled=True, endtimeGeneration=1, **{field: "2026-10-28"})
    assert [c.key for c in h.tick(at("21:00:10")) if type(c).__name__ == "Hide"] == [overlay.key]
    assert all(h.overlays(h.tick(at("21:00:10") + timedelta(minutes=n))) == [] for n in range(1, 30))


def test_restart_preserves_warning_state_and_continues_a_started_cycle(h):
    h.tick(at("20:46:00"), resumed=True)
    h.restart(at("20:47:00"))
    assert h.tick(at("20:47:00"), resumed=True) == []
    [overlay] = h.overlays(h.show(at("21:00:00")))
    # A crash while the overlay was up cannot replay it as the same presentation.
    h.restart(at("21:03:00"))
    assert h.overlays(h.tick(at("21:03:59"), resumed=True)) == []
    [again] = h.overlays(h.show(at("21:04:00")))
    assert again.key != overlay.key and len(h.receipts()) == 1


def test_restart_after_a_missed_endtime_skips_the_date(h):
    h.tick(at("20:40:00"), resumed=True)
    h.restart(at("21:00:01"))
    assert all(h.tick(at("21:00:01") + timedelta(minutes=n), resumed=n == 0) == [] for n in range(0, 120))
    assert h.receipts() == []


def test_newest_overlay_wins_without_resurrection(h):
    h.offer(1, at("20:59:00"), message="Перерва", repeatEveryMinutes=1)
    [manual] = h.overlays(h.show(at("20:59:00"), resumed=True))
    assert manual.source == "manual"
    commands = h.show(at("21:00:00"))
    assert [type(c).__name__ for c in commands] == ["Hide", "Presentation"] and commands[0].key == manual.key
    endtime = commands[1]
    h.scheduler.dismissed(endtime.key, at("21:00:10"))
    # The replaced manual family would otherwise have recurred at 21:01.
    assert h.overlays(h.tick(at("21:01:00"))) == []
    [endtime] = h.overlays(h.show(at("21:01:10")))
    h.offer(2, at("21:01:30"), message="Ще одне")
    commands = h.show(at("21:01:30"))
    assert [c.key for c in commands if type(c).__name__ == "Hide"] == [endtime.key]
    [m2] = h.overlays(commands)
    assert m2.source == "manual" and m2.text == "Ще одне"
    # The displaced endtime occurrence returns as newest one minute later and replaces m2.
    commands = h.show(at("21:02:30"))
    assert [c.key for c in commands if type(c).__name__ == "Hide"] == [m2.key] and h.overlays(commands)[0].source == "endtime"
    h.restart(at("21:02:40"))
    # Offers of the same actions arriving again are known and never re-run.
    h.offer(1, at("21:02:50"), message="Перерва", repeatEveryMinutes=1)
    h.offer(2, at("21:02:50"), message="Ще одне")
    shown = [c for n in range(0, 10) for c in h.overlays(h.show(at("21:02:40") + timedelta(minutes=n)))]
    assert {c.source for c in shown} == {"endtime"}
    assert len(h.receipts()) == 1


def test_equal_due_instants_show_only_the_newest_overlay(h):
    h.offer(1, at("21:00:00"), message="Перерва")
    commands = h.show(at("21:00:00"), resumed=True)
    assert [(type(c).__name__, getattr(c, "source", None)) for c in commands] == [("Presentation", "endtime")]
    assert all(c.source != "manual" for n in range(1, 5) for c in h.overlays(h.tick(at("21:00:00") + timedelta(minutes=n))))


def test_midnight_hides_the_overlay_and_receipts_prune_with_retention(h):
    [overlay] = h.overlays(h.show(at("21:00:00"), resumed=True))
    commands = h.tick(at("00:00:00", "2026-10-29"))
    assert [c.key for c in commands if type(c).__name__ == "Hide"] == [overlay.key] and h.overlays(commands) == []
    h.store.prune("2026-11-05T12:00:00.000Z")
    assert h.store.connection.execute("select count(*) from endtime_receipts").fetchone()[0] == 0


def test_stale_results_and_dismissals_are_ignored(h):
    [overlay] = h.overlays(h.tick(at("21:00:00"), resumed=True))
    h.scheduler.presented("endtime:other", SHOWN, at("21:00:00"))
    h.scheduler.dismissed("endtime:other", at("21:00:01"))
    assert h.receipts() == []
    h.scheduler.presented(overlay.key, SHOWN, at("21:00:00"))
    h.scheduler.presented(overlay.key, SHOWN, at("21:00:00"))
    assert len(h.receipts()) == 1
