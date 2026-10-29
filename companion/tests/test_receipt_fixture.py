"""Companion receipt sequences for the backend replay test (bot/tests/receipt-replay.test.ts).

Each scenario runs the real Scheduler and LocalStore and records the receipts each sync would carry.
The committed contracts/fixtures/action-receipts.json must match; regenerate it with
AW_TELEGRAM_REGENERATE_FIXTURES=1 after an intended change, then run the bot replay test.
"""
import json
import os
from datetime import timedelta
from pathlib import Path

from aw_telegram.clock import format_instant, parse_instant
from aw_telegram.models import ActionAck, Settings

from action_fixture import NOW, action
from test_action_receipts import restart
from test_actions import Harness, at

FIXTURE = Path(__file__).parents[2] / "contracts/fixtures/action-receipts.json"


class Recorder:
    """Drives a Harness and records, per backend sync, the receipts queued since the previous one."""

    def __init__(self, tmp_path, body, offered_at=None, laptop_offset=timedelta(0)):
        self.h = Harness(tmp_path)
        self.body, self.steps, self.sent = body, [], set()
        self.offered_at = offered_at or body["createdAt"]
        self.h.time = parse_instant(self.offered_at) + laptop_offset
        self.h.store.receive_offers([body], server_now=self.offered_at)

    def sync(self, server_now, clear=None):
        acks = [a for a in self.h.store.pending_acks() if isinstance(a, ActionAck) and a.id not in self.sent]
        self.sent.update(a.id for a in acks)
        step = dict(serverNow=format_instant(server_now), acks=[a.to_wire() for a in acks])
        if clear:
            step["clear"] = clear
        self.steps.append(step)

    def scenario(self, name):
        self.h.store.close()
        return dict(name=name, action=self.body, offeredAt=self.offered_at, steps=self.steps)


def restart_after_presented_overlay(tmp):
    r = Recorder(tmp, action(1, repeatEveryMinutes=1))
    r.h.show()
    r.sync(parse_instant(NOW) + timedelta(seconds=1))
    restart(r.h, parse_instant(NOW) + timedelta(seconds=20))
    r.sync(parse_instant(NOW) + timedelta(seconds=21))
    return r.scenario("restart after a presented repeating overlay")


def restart_after_presented_card(tmp):
    r = Recorder(tmp, action(1, kind="notify"))
    r.h.show()
    restart(r.h, parse_instant(NOW) + timedelta(seconds=3))
    r.sync(parse_instant(NOW) + timedelta(seconds=4))
    return r.scenario("restart after a presented card")


def clear_between_repeats(tmp):
    r = Recorder(tmp, action(1, repeatEveryMinutes=10))
    [overlay] = r.h.shown(r.h.show())
    r.h.scheduler.dismissed(overlay.key, parse_instant(NOW) + timedelta(seconds=30))
    r.sync(parse_instant(NOW) + timedelta(seconds=31))
    cleared = parse_instant(NOW) + timedelta(minutes=3)
    r.h.time = cleared + timedelta(seconds=1)
    r.h.fence(through=1)  # the companion learns the fence from the clearing sync's response
    r.sync(cleared, clear="manual")
    r.h.tick(cleared + timedelta(minutes=20))
    r.sync(cleared + timedelta(minutes=21))
    return r.scenario("clear between repeats")


def slow_laptop_clock(tmp):
    body = action(1, created="2026-10-28T11:59:50.000Z")
    r = Recorder(tmp, body, offered_at=NOW, laptop_offset=timedelta(seconds=-1))
    [overlay] = r.h.shown(r.h.show())
    r.h.scheduler.dismissed(overlay.key, parse_instant(NOW) + timedelta(seconds=4))
    r.sync(parse_instant(NOW) + timedelta(seconds=6))
    return r.scenario("laptop clock behind a later first offer")


def clock_corrected_backwards(tmp):
    r = Recorder(tmp, action(1))
    [overlay] = r.h.shown(r.h.show(parse_instant(NOW) + timedelta(seconds=20)))
    r.h.scheduler.dismissed(overlay.key, parse_instant(NOW) + timedelta(seconds=5))
    r.sync(parse_instant(NOW) + timedelta(seconds=21))
    return r.scenario("clock corrected backwards")


def _midnight_family(tmp):
    r = Recorder(tmp, action(1, created="2026-10-28T21:50:00.000Z", repeatEveryMinutes=1))
    [first] = r.h.shown(r.h.show())
    return r, first


def repeat_visible_at_midnight(tmp):
    r, first = _midnight_family(tmp)
    r.h.scheduler.dismissed(first.key, at("23:58:50"))
    r.h.show(at("23:59:50"))
    r.sync(at("23:59:55"))
    r.h.tick(at("00:00:00.500", "2026-10-29"))
    r.sync(at("00:00:01", "2026-10-29"))
    return r.scenario("repeat visible at Kyiv midnight")


def asleep_across_midnight(tmp):
    r, first = _midnight_family(tmp)
    r.h.scheduler.dismissed(first.key, at("23:58:59.500"))
    r.sync(at("23:59:00"))
    r.h.show(at("00:30:00", "2026-10-29"), resumed=True)
    r.sync(at("00:30:01", "2026-10-29"))
    return r.scenario("asleep across midnight between repeats")


def dismissed_just_after_midnight(tmp):
    r, first = _midnight_family(tmp)
    r.h.scheduler.dismissed(first.key, at("23:58:00"))
    [second] = r.h.shown(r.h.show(at("23:59:30")))
    r.h.scheduler.dismissed(second.key, at("00:00:00.200", "2026-10-29"))
    r.sync(at("00:00:01", "2026-10-29"))
    return r.scenario("repeat dismissed just after midnight")


def free_use_hides_visible(tmp):
    r = Recorder(tmp, action(1))
    r.h.show()
    r.h.settings(revision=1, freeUseDate="2026-10-28")
    r.h.tick(parse_instant(NOW) + timedelta(seconds=2))
    r.sync(parse_instant(NOW) + timedelta(seconds=3))
    return r.scenario("free use removes a visible overlay")


SCENARIOS = [restart_after_presented_overlay, restart_after_presented_card, clear_between_repeats, slow_laptop_clock,
             clock_corrected_backwards, repeat_visible_at_midnight, asleep_across_midnight,
             dismissed_just_after_midnight, free_use_hides_visible]


def generate(tmp_path) -> dict:
    scenarios = []
    for index, build in enumerate(SCENARIOS):
        directory = tmp_path / build.__name__
        directory.mkdir()
        scenario = build(directory)
        n = 0
        for step in scenario["steps"]:
            for ack in step["acks"]:  # deterministic receipt IDs so the fixture is stable
                n += 1
                ack["id"] = f"00000000-0000-4000-9000-{index:04d}{n:08d}"
        scenarios.append(scenario)
    return dict(note="Generated by companion/tests/test_receipt_fixture.py; replayed by bot/tests/receipt-replay.test.ts.",
                scenarios=scenarios)


def test_receipt_fixture_matches_the_companion(tmp_path):
    generated = json.dumps(generate(tmp_path), ensure_ascii=False, indent=1) + "\n"
    if os.environ.get("AW_TELEGRAM_REGENERATE_FIXTURES") == "1":
        FIXTURE.write_text(generated, encoding="utf-8", newline="\n")
    assert FIXTURE.exists() and FIXTURE.read_text(encoding="utf-8") == generated, (
        "companion receipts changed: regenerate with AW_TELEGRAM_REGENERATE_FIXTURES=1 and rerun the bot replay test")
