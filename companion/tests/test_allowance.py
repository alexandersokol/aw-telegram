"""Daily allowance: local 15/10/5 warnings and the repeating expiry overlay gated by counted use."""
from datetime import datetime, timedelta

import pytest

from aw_telegram.clock import KYIV, UTC, format_instant, local_day_bounds
from aw_telegram.counting import category_record
from aw_telegram.models import ActionAck, Settings
from aw_telegram import policy as p
from aw_telegram.scheduler import Hide, Scheduler
from aw_telegram.storage import LocalStore
from aw_telegram.windows.foreground import PresentationResult

from action_fixture import action

SHOWN = PresentationResult("unconfirmed", "topmost_requested")
HOUR, MINUTE = 3_600_000, 60_000
LIMIT = 4 * HOUR


def at(clock, date="2026-10-28"):
    return datetime.fromisoformat(f"{date}T{clock}").replace(tzinfo=KYIV).astimezone(UTC)


def games(**fields):
    return Settings(**{"revision": 1, "selectedPaths": [["Games"]], **fields})


def seen(now, path=("Games",), state="active", owned=None):
    """The IO worker's latest outside observation, optionally refreshed by companion-owned foreground."""
    return dict(observedAt=format_instant(now), state=state, path=None if path is None else list(path),
                ownedAt=None if owned is None else format_instant(owned))


def left(minutes, seconds=0):
    """Used time leaving this much of the default four hours."""
    return LIMIT - minutes * MINUTE - seconds * 1000


def run(settings, steps, state=None):
    """steps: (now, used_ms, activity); shown overlays are reported shown at once."""
    state = state or p.AllowanceState()
    decisions = []
    for now, used, activity in steps:
        state, decision = p.evaluate_allowance(settings, state, used, activity, now)
        if decision.show:
            state = p.allowance_shown(state, now)
        decisions.append(decision)
    return decisions, state


# Pure policy

def test_today_override_applies_only_on_its_own_date():
    settings = games(defaultLimitMs=2 * HOUR, todayOverride=dict(date="2026-10-28", limitMs=3 * HOUR))
    assert p.effective_limit_ms(settings, "2026-10-28") == 3 * HOUR
    assert p.effective_limit_ms(settings, "2026-10-29") == 2 * HOUR


def test_continuous_use_warns_at_each_threshold_inclusive_and_once():
    now = at("14:00:00")
    steps = [(now + timedelta(minutes=n), left(16 - n), seen(now + timedelta(minutes=n))) for n in range(12)]
    decisions, state = run(games(), steps)
    assert [d.warning for d in decisions if d.warning] == ["15m", "10m", "5m"]
    assert [n for n, d in enumerate(decisions) if d.warning] == [1, 6, 11]
    assert state.warned == "5m" and not any(d.show for d in decisions)


def test_catch_up_shows_only_the_most_urgent_warning():
    [first, again], _ = run(games(), [(at("14:00:00"), left(7), None), (at("14:00:01"), left(7), None)])
    assert first.warning == "10m" and again.warning is None and first.remaining_ms == 7 * MINUTE


def test_exhausted_on_first_evaluation_shows_no_card_only_the_overlay():
    [decision], state = run(games(), [(at("14:00:00"), LIMIT + MINUTE, seen(at("13:59:55")))])
    assert decision.warning is None and decision.show and decision.due_at == at("14:00:00")
    assert state.visible and state.warned == "expired"


def test_overlay_waits_for_active_counted_use():
    now = at("14:00:00")
    for activity in (None, seen(now, ("Study",)), seen(now, state="afk", path=None), seen(now - timedelta(seconds=31))):
        [decision], _ = run(games(), [(now, LIMIT, activity)])
        assert not decision.show, activity
    [decision], _ = run(games(), [(now, LIMIT, seen(now - timedelta(seconds=30)))])
    assert decision.show


def test_counted_selection_includes_descendants_and_explicit_uncategorized():
    now = at("14:00:00")
    [decision], _ = run(games(), [(now, LIMIT, seen(now, ("Games", "Shooter")))])
    assert decision.show
    [decision], _ = run(games(), [(now, LIMIT, seen(now, None))])
    assert not decision.show
    [decision], _ = run(games(selectedUncategorized=True), [(now, LIMIT, seen(now, None))])
    assert decision.show


def test_own_foreground_keeps_the_overlay_but_afk_and_schoolwork_hide_it():
    shown = at("14:00:00")
    _, state = run(games(), [(shown, LIMIT, seen(shown))])
    # Our overlay owns the foreground: the last outside observation stays authoritative while refreshed.
    later = shown + timedelta(minutes=5)
    [decision], state = run(games(), [(later, LIMIT, seen(shown, owned=later - timedelta(seconds=5)))], state)
    assert not decision.hide and state.visible
    [decision], state = run(games(), [(later, LIMIT, seen(later - timedelta(seconds=2), state="afk", path=None))], state)
    assert decision.hide and not state.visible and state.next_due is None
    # Active return to a counted app shows it again at once.
    back = later + timedelta(seconds=40)
    [decision], state = run(games(), [(back, LIMIT, seen(back))], state)
    assert decision.show and decision.due_at == back
    switched = back + timedelta(seconds=20)
    [decision], state = run(games(), [(switched, LIMIT, seen(switched, ("Study",)))], state)
    assert decision.hide and not state.visible


def test_switch_evidence_from_our_own_focus_change_does_not_hide_the_overlay():
    shown = at("14:00:00")
    _, state = run(games(), [(shown, LIMIT, seen(shown - timedelta(seconds=8)))])
    # Minimizing the game briefly focused the desktop; that is our doing, not the child's switch.
    [decision], state = run(games(), [(shown + timedelta(seconds=6), LIMIT,
                                       seen(shown + timedelta(seconds=4), ("Shell",)))], state)
    assert not decision.hide and state.visible
    [decision], state = run(games(), [(shown + timedelta(seconds=16), LIMIT,
                                       seen(shown + timedelta(seconds=14), ("Shell",)))], state)
    assert decision.hide


def test_stale_evidence_hides_only_after_a_full_freshness_window():
    shown = at("14:00:00")
    _, state = run(games(), [(shown, LIMIT, seen(shown - timedelta(seconds=28)))])
    [decision], state = run(games(), [(shown + timedelta(seconds=5), LIMIT, seen(shown - timedelta(seconds=28)))], state)
    assert not decision.hide
    [decision], state = run(games(), [(shown + timedelta(seconds=30), LIMIT, seen(shown - timedelta(seconds=28)))], state)
    assert decision.hide


def test_dismissal_repeats_one_minute_later_only_during_counted_use():
    shown = at("14:00:00")
    _, state = run(games(), [(shown, LIMIT, seen(shown))])
    state = p.allowance_finished(state, shown + timedelta(seconds=10))
    due = shown + timedelta(seconds=70)
    [early, paused, repeat], state = run(games(), [
        (due - timedelta(seconds=1), LIMIT, seen(due - timedelta(seconds=1))),
        (due + timedelta(seconds=5), LIMIT, seen(due + timedelta(seconds=5), ("Study",))),
        (due + timedelta(seconds=20), LIMIT, seen(due + timedelta(seconds=20)))], state)
    assert not early.show and not paused.show
    assert repeat.show and repeat.due_at == due


def test_more_time_hides_the_overlay_and_rearms_warnings():
    shown = at("14:00:00")
    _, state = run(games(), [(shown, LIMIT, seen(shown))])
    more = games(revision=2, todayOverride=dict(date="2026-10-28", limitMs=LIMIT + 30 * MINUTE))
    [decision], state = run(more, [(shown + timedelta(seconds=30), LIMIT, seen(shown + timedelta(seconds=30)))], state)
    assert decision.hide and not state.visible and state.warned is None and decision.warning is None
    [decision], state = run(more, [(shown + timedelta(minutes=16), LIMIT + 15 * MINUTE, None)], state)
    assert decision.warning == "15m"


def test_less_time_makes_the_overlay_due_immediately():
    now = at("14:00:00")
    less = games(revision=2, todayOverride=dict(date="2026-10-28", limitMs=HOUR))
    [decision], _ = run(less, [(now, 2 * HOUR, seen(now))])
    assert decision.show and decision.warning is None


@pytest.mark.parametrize("field", ["freeUseDate", "suppressedDate"])
def test_free_use_and_clear_all_silence_and_resume_from_todays_usage(field):
    now = at("14:00:00")
    _, state = run(games(), [(now, LIMIT, seen(now))])
    quiet = games(revision=2, **{field: "2026-10-28"})
    [hidden, silent], state = run(quiet, [(now + timedelta(seconds=10), LIMIT, seen(now + timedelta(seconds=10))),
                                          (now + timedelta(minutes=2), LIMIT, seen(now + timedelta(minutes=2)))], state)
    assert hidden.hide and not silent.show and not state.visible
    resumed = now + timedelta(minutes=3)
    [decision], _ = run(games(revision=3), [(resumed, LIMIT, seen(resumed))], state)
    assert decision.show and decision.due_at == resumed


def test_warnings_held_during_free_use_catch_up_once_afterwards():
    now = at("14:00:00")
    quiet = games(freeUseDate="2026-10-28")
    decisions, state = run(quiet, [(now + timedelta(minutes=n), left(16 - n), None) for n in range(14)])
    assert not any(d.warning for d in decisions) and state.warned is None
    [decision], _ = run(games(revision=2), [(now + timedelta(minutes=14), left(2), None)], state)
    assert decision.warning == "5m"


def test_midnight_hides_and_starts_a_fresh_day():
    late = at("23:59:50")
    _, state = run(games(), [(late, LIMIT, seen(late))])
    after = local_day_bounds("2026-10-28")[1] + timedelta(seconds=5)
    [decision], state = run(games(), [(after, None, seen(after))], state)
    assert decision.hide and state.date == "2026-10-29" and not state.visible and state.warned is None


def test_unknown_usage_changes_nothing():
    now = at("14:00:00")
    [decision], state = run(games(), [(now, None, seen(now))])
    assert decision == p.AllowanceDecision() and state.warned is None


def test_state_round_trips_and_rejects_corruption():
    state = p.allowance_shown(p.AllowanceState(date="2026-10-28", warned="expired"), at("14:00:00"))
    assert p.AllowanceState.from_json(state.to_json()) == state
    with pytest.raises(ValueError):
        p.AllowanceState.from_json({**state.to_json(), "warned": "1m"})


# Scheduler and store integration

class Harness:
    def __init__(self, tmp_path):
        self.now = format_instant(at("14:00:00"))
        self.store = LocalStore(tmp_path / "allowance.sqlite", now=lambda: self.now)
        self.scheduler = Scheduler(self.store)
        with self.store._transaction():
            state = self.store._state()
            state["collectionStartedAt"] = format_instant(local_day_bounds("2026-10-28")[0])
            state["settings"] = games().to_wire()
            self.store._save(state)

    def used(self, now, total):
        """Commit today's measured usage through `now`, all in a counted category."""
        self.now = format_instant(now)
        leaf = dict(category=dict(id='["Games"]', path=["Games"]), totalMs=total)
        self.store.commit_day(dict(date="2026-10-28", leafTotalsMs=[leaf],
            appLeafTotalsMs=[dict(app="game.exe", categoryId='["Games"]', totalMs=total)], totalActiveMs=total,
            selectedTotalMs=total, settingsRevision=1, rulesRevision="r1",
            availableFrom=format_instant(local_day_bounds("2026-10-28")[0]), availableThrough=self.now,
            partial=False, sequence=0), self.now)

    def playing(self, now, path=("Games",), state="active"):
        self.now = format_instant(now)
        live = dict(observedAt=self.now, state=state, app=None if state == "afk" else "game.exe", title=None,
                    category=None if state == "afk" else category_record(None if path is None else tuple(path)), rulesRevision="r1",
                    categoryCatalog=[])
        self.store.record_activity(live)

    def show(self, now):
        self.now = format_instant(now)
        commands = self.scheduler.tick(now)
        for command in commands:
            if getattr(command, "kind", None) == "overlay":
                self.scheduler.presented(command.key, SHOWN, now)
        return commands

    def statuses(self):
        return [a.status for a in self.store.pending_acks() if isinstance(a, ActionAck)]


@pytest.fixture
def h(tmp_path):
    harness = Harness(tmp_path)
    yield harness
    harness.store.close()


def test_scheduler_warns_then_shows_the_dismissible_expiry_overlay(h):
    h.used(at("14:00:00"), left(14))
    [card] = h.show(at("14:00:00"))
    assert (card.kind, card.source, card.key) == ("notification", "allowance", "allowance-warning:2026-10-28:15m")
    assert "15 хв" in card.text
    h.used(at("14:14:00"), LIMIT)
    h.playing(at("14:14:00"))
    [overlay] = h.show(at("14:14:01"))
    assert (overlay.kind, overlay.source, overlay.dismissible, overlay.duration_ms) == ("overlay", "allowance", True, None)
    assert "вичерпано" in overlay.text
    h.scheduler.dismissed(overlay.key, at("14:14:10"))
    h.playing(at("14:15:05"))
    assert h.show(at("14:15:09")) == []
    [again] = h.show(at("14:15:10"))
    assert again.key != overlay.key and again.source == "allowance"


def test_scheduler_hides_on_schoolwork_without_receipts_and_returns(h):
    h.used(at("14:00:00"), LIMIT)
    h.playing(at("14:00:00"))
    [overlay] = h.show(at("14:00:01"))
    h.playing(at("14:00:20"), ("Study",))
    assert h.show(at("14:00:21")) == [Hide(overlay.key)]
    h.playing(at("14:00:40"))
    [again] = h.show(at("14:00:41"))
    assert again.source == "allowance" and h.statuses() == []


def test_own_foreground_refresh_keeps_the_overlay(h):
    h.used(at("14:00:00"), LIMIT)
    h.playing(at("14:00:00"))
    assert len(h.show(at("14:00:01"))) == 1
    for n in range(1, 13):
        h.now = format_instant(at("14:00:01") + timedelta(seconds=10 * n))
        h.store.record_activity(None, owned_at=h.now)
        assert h.show(at("14:00:02") + timedelta(seconds=10 * n)) == []


def test_expiry_overlay_replaces_a_manual_overlay_as_newest_due(h):
    h.offer = lambda n, created: h.store.receive_offers([action(n, created=format_instant(created))])
    h.now = format_instant(at("14:00:00"))
    h.offer(1, at("14:00:00"))
    [manual] = h.show(at("14:00:00"))
    h.used(at("14:00:30"), LIMIT)
    h.playing(at("14:00:30"))
    commands = h.show(at("14:00:31"))
    assert commands[0] == Hide(manual.key) and commands[1].source == "allowance"
    assert h.statuses() == ["accepted", "presented", "replaced"]


def test_free_use_hides_the_overlay_and_restart_waits_a_minute(h):
    h.used(at("14:00:00"), LIMIT)
    h.playing(at("14:00:00"))
    [overlay] = h.show(at("14:00:01"))
    h.scheduler.recover(at("14:00:30"))  # restart while it was on screen
    h.playing(at("14:01:25"))
    assert h.show(at("14:01:29")) == []
    assert len(h.show(at("14:01:30"))) == 1
    with h.store._transaction():
        state = h.store._state()
        state["settings"] = games(revision=2, freeUseDate="2026-10-28").to_wire()
        h.store._save(state)
    assert [type(c) for c in h.show(at("14:01:31"))] == [Hide]


# Activity record written by the IO worker

def test_activity_record_keeps_the_outside_observation_through_own_foreground(h):
    h.playing(at("14:00:00"))
    h.now = format_instant(at("14:00:10"))
    h.store.record_activity(None, owned_at=h.now)
    h.store.record_activity(None)  # an unknown observation is not evidence of anything
    assert h.store.activity == dict(observedAt=format_instant(at("14:00:00")), state="active", path=["Games"],
                                    ownedAt=format_instant(at("14:00:10")))
    h.playing(at("14:00:20"), None, "afk")
    assert h.store.activity == dict(observedAt=format_instant(at("14:00:20")), state="afk", path=None, ownedAt=None)


def test_activity_record_ignores_unknown_and_future_observations(h):
    h.store.record_activity(dict(observedAt=h.now, state="unknown", app=None, title=None, category=None,
                                 rulesRevision=None, categoryCatalog=[]))
    assert h.store.activity is None
    with pytest.raises(ValueError):
        h.store.record_activity(None, owned_at=format_instant(at("14:00:01")))
