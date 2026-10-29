"""Pure Kyiv endtime policy: warnings, due/skip, suppression and generation edits."""
from datetime import datetime, timedelta
import importlib
import importlib.util

import pytest

from aw_telegram.clock import KYIV, UTC, endtime_at, format_instant
from aw_telegram.models import Settings


def policy():
    assert importlib.util.find_spec("aw_telegram.policy"), "endtime policy is not implemented"
    return importlib.import_module("aw_telegram.policy")


def at(clock, date="2026-10-28"):
    return datetime.fromisoformat(f"{date}T{clock}").replace(tzinfo=KYIV).astimezone(UTC)


def enabled(**fields):
    return Settings(**{"revision": 1, "endtimeEnabled": True, "endtimeGeneration": 1, **fields})


def run(settings, times, state=None, resumed_first=True):
    """Evaluate in order; returns per-time decisions and final state, reporting shown overlays."""
    p = policy()
    state = state or p.EndtimeState()
    decisions = []
    for index, now in enumerate(times):
        state, decision = p.evaluate_endtime(settings, state, now, resumed=resumed_first and index == 0)
        if decision.show:
            state = p.endtime_shown(state)
        decisions.append(decision)
    return decisions, state


def minutes(start, end, date="2026-10-28"):
    first, last = at(start, date), at(end, date)
    return [first + timedelta(minutes=n) for n in range(int((last - first) / timedelta(minutes=1)) + 1)]


def test_continuous_operation_warns_once_at_each_threshold_then_shows_at_endtime():
    decisions, _ = run(enabled(), minutes("20:40:00", "21:00:00"))
    warnings = [(t, d.warning) for t, d in zip(minutes("20:40:00", "21:00:00"), decisions) if d.warning]
    assert warnings == [(at("20:45:00"), "15m"), (at("20:50:00"), "10m"), (at("20:55:00"), "5m")]
    assert [d.show for d in decisions].count(True) == 1 and decisions[-1].show


def test_startup_catch_up_shows_only_the_most_urgent_crossed_warning():
    decisions, _ = run(enabled(), [at("20:52:00"), at("20:53:00"), at("20:55:00")])
    assert [d.warning for d in decisions] == ["10m", None, "5m"]


def test_resume_after_endtime_skips_date():
    decisions, state = run(enabled(), [at("21:00:00.001"), at("21:30:00"), at("23:59:59")])
    assert not any(d.show or d.warning for d in decisions) and state.skipped
    tomorrow, _ = run(enabled(), minutes("20:45:00", "21:00:00", "2026-10-29"), state, resumed_first=False)
    assert tomorrow[0].warning == "15m" and tomorrow[-1].show


def test_resumed_continuous_state_still_skips_a_missed_endtime():
    _, state = run(enabled(), [at("20:50:00")])
    decisions, state = run(enabled(), [at("21:05:00")], state, resumed_first=True)
    assert not decisions[0].show and state.skipped


def test_evaluation_exactly_at_endtime_is_due_not_late():
    decisions, _ = run(enabled(), [at("21:00:00")])
    assert decisions[0].show and decisions[0].warning is None


def test_disabled_default_never_warns_or_shows():
    decisions, _ = run(Settings(), minutes("20:40:00", "21:05:00"))
    assert not any(d.show or d.warning or d.hide for d in decisions)


@pytest.mark.parametrize("field", ["freeUseDate", "suppressedDate"])
def test_free_use_and_clear_all_silence_warnings_and_overlay(field):
    decisions, _ = run(enabled(**{field: "2026-10-28"}), minutes("20:40:00", "21:05:00"))
    assert not any(d.show or d.warning for d in decisions)
    # Another date's suppression has no effect.
    decisions, _ = run(enabled(**{field: "2026-10-27"}), [at("20:46:00")])
    assert decisions[0].warning == "15m"


@pytest.mark.parametrize("field", ["freeUseDate", "suppressedDate"])
def test_suppression_removes_a_visible_overlay_and_ending_it_later_skips_the_date(field):
    p = policy()
    _, state = run(enabled(), [at("21:00:00")])
    assert state.visible
    state, decision = p.evaluate_endtime(enabled(**{field: "2026-10-28"}), state, at("21:00:30"))
    assert decision.hide and not decision.show and not state.visible
    state, decision = p.evaluate_endtime(enabled(), state, at("21:10:00"))
    assert not decision.show and state.skipped


def test_suppression_ending_before_endtime_catches_up_one_warning():
    p = policy()
    _, state = run(enabled(freeUseDate="2026-10-28"), [at("20:30:00"), at("20:49:00")])
    state, decision = p.evaluate_endtime(enabled(), state, at("20:51:00"))
    assert decision.warning == "10m"


def test_future_same_day_time_edit_hides_the_overlay_and_restarts_warnings():
    p = policy()
    _, state = run(enabled(), [at("21:00:00")])
    later = enabled(revision=2, endtimeGeneration=2, endtimeLocalTime="21:30")
    state, decision = p.evaluate_endtime(later, state, at("21:16:00"))
    assert decision.hide and decision.warning == "15m" and not decision.show
    decisions, _ = run(later, minutes("21:17:00", "21:30:00"), state, resumed_first=False)
    assert [d.warning for d in decisions if d.warning] == ["10m", "5m"] and decisions[-1].show


def test_past_same_day_time_edit_skips_today():
    p = policy()
    _, state = run(enabled(), [at("20:00:00")])
    earlier = enabled(revision=2, endtimeGeneration=2, endtimeLocalTime="19:30")
    state, decision = p.evaluate_endtime(earlier, state, at("20:01:00"))
    assert not decision.show and state.skipped


def test_turning_endtime_off_hides_the_overlay_and_cancels_recurrence():
    p = policy()
    _, state = run(enabled(), [at("21:00:00")])
    state, decision = p.evaluate_endtime(enabled(revision=2, endtimeGeneration=2, endtimeEnabled=False), state, at("21:00:10"))
    assert decision.hide and not state.visible and state.next_due is None


def test_unrelated_settings_revision_keeps_generation_state():
    p = policy()
    _, state = run(enabled(), [at("20:46:00")])
    state, decision = p.evaluate_endtime(enabled(revision=5, defaultLimitMs=1234), state, at("20:47:00"))
    assert decision.warning is None and state.warned == "15m"


def test_dismissal_schedules_one_minute_recurrence_until_midnight():
    p = policy()
    _, state = run(enabled(), [at("21:00:00")])
    state = p.endtime_finished(state, at("21:00:20"))
    state, decision = p.evaluate_endtime(enabled(), state, at("21:01:19.999"))
    assert not decision.show and decision.wake_at == at("21:01:20")
    state, decision = p.evaluate_endtime(enabled(), state, at("21:01:20"))
    assert decision.show and decision.due_at == at("21:01:20")


def test_midnight_hides_the_overlay_and_starts_a_new_date():
    p = policy()
    _, state = run(enabled(), [at("21:00:00")])
    state, decision = p.evaluate_endtime(enabled(), state, at("00:00:00", "2026-10-29"))
    assert decision.hide and not decision.show and state.date == "2026-10-29" and not state.started
    assert decision.wake_at == at("20:45:00", "2026-10-29")


def test_restart_during_a_started_cycle_continues_recurrence():
    p = policy()
    _, state = run(enabled(), [at("21:00:00")])
    state = p.endtime_finished(state, at("21:00:30"))
    restored = p.EndtimeState.from_json(state.to_json())
    restored, decision = p.evaluate_endtime(enabled(), restored, at("21:05:00"), resumed=True)
    assert decision.show and not restored.skipped


def test_backward_clock_change_does_not_repeat_a_warning():
    decisions, _ = run(enabled(), [at("20:50:00"), at("20:46:00"), at("20:51:00")])
    assert [d.warning for d in decisions] == ["10m", None, None]


@pytest.mark.parametrize("date,local", [("2026-03-29", "03:30"), ("2026-10-25", "03:30"), ("2026-10-25", "00:15")])
def test_dst_dates_resolve_thresholds_from_the_endtime_instant(date, local):
    end = endtime_at(date, local)
    times = [end - timedelta(minutes=15), end - timedelta(minutes=10), end - timedelta(minutes=5), end]
    decisions, _ = run(enabled(endtimeLocalTime=local), times)
    assert [d.warning for d in decisions] == ["15m", "10m", "5m", None] and decisions[-1].show


def test_state_round_trips_and_rejects_unknown_fields():
    p = policy()
    _, state = run(enabled(), [at("21:00:00")])
    assert p.EndtimeState.from_json(state.to_json()) == state
    with pytest.raises((TypeError, ValueError)):
        p.EndtimeState.from_json({**state.to_json(), "extra": 1})
    assert format_instant(at("21:00:00")) == "2026-10-28T19:00:00.000Z"
