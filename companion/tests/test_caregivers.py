"""ACCESS-08: while no caregiver is paired every laptop rule pauses; pairing again resumes at once."""
from datetime import timedelta

from aw_telegram import models
from aw_telegram import policy as p
from aw_telegram.clock import format_instant
from aw_telegram.models import ActionAck, Settings
from aw_telegram.scheduler import Hide
from aw_telegram.status import StatusInput, status_lines

from action_fixture import action
from test_allowance import LIMIT, Harness, at, games, seen
from test_sync import HEALTH, pair, response, store


def caregivers(store_, count):
    with store_._transaction():
        state = store_._state()
        state["activeCaregivers"] = count
        store_._save(state)


# Policies

def test_allowance_pauses_without_caregivers_and_resumes_from_todays_usage():
    now = at("14:00:00")
    state, decision = p.evaluate_allowance(games(), p.AllowanceState(), LIMIT - 7 * 60_000, None, now, paused=True)
    assert decision.warning is None and state.warned is None
    state, decision = p.evaluate_allowance(games(), state, LIMIT, seen(now), now, paused=True)
    assert not decision.show
    later = now + timedelta(seconds=5)
    state, decision = p.evaluate_allowance(games(), state, LIMIT, seen(later), later)
    assert decision.show and decision.due_at == later  # resumes at once, like free use ending


def test_endtime_pauses_without_caregivers_and_resumes_only_before_its_time():
    settings = Settings(revision=1, endtimeEnabled=True, endtimeGeneration=1)
    state, decision = p.evaluate_endtime(settings, p.EndtimeState(), at("20:45:00"), resumed=True, paused=True)
    assert decision.warning is None and not decision.show
    state, decision = p.evaluate_endtime(settings, state, at("20:50:00"))
    assert decision.warning == "10m"  # pairing again before endtime: normal rules resume
    state, decision = p.evaluate_endtime(settings, p.EndtimeState(), at("21:00:00"), resumed=True, paused=True)
    state, decision = p.evaluate_endtime(settings, state, at("21:05:00"))
    assert not decision.show  # first eligible after its time: today's endtime is skipped


# Store

def test_a_sync_with_no_caregivers_ends_every_open_reminder(tmp_path):
    s = store(tmp_path)
    try:
        pair(s)
        assert s.active_caregivers == 1
        s.receive_offers([action(1), action(2, repeatEveryMinutes=10)])
        with s._transaction():  # action 2 was shown and dismissed; its next repeat is waiting
            s._action_event(action(2)["id"], "presented", "2026-10-28T12:00:00.000Z", 0, "2026-10-28T12:00:00.000Z", None, False)
            s._action_event(action(2)["id"], "dismissed", "2026-10-28T12:00:00.000Z", 0, None, None, False)
        s.apply_sync(response(s.prepare_request(HEALTH), caregivers=0))
        assert s.active_caregivers == 0 and s.open_actions() == []
        statuses = {(a.actionId[-1], a.status) for a in s.pending_acks() if isinstance(a, ActionAck)}
        assert ("1", "canceled") in statuses and ("2", "canceled") not in statuses  # ended locally between repeats
    finally:
        s.close()


def test_an_older_response_cannot_change_the_caregiver_count(tmp_path):
    s = store(tmp_path)
    try:
        pair(s)
        older, newer = s.prepare_request(HEALTH), s.prepare_request(HEALTH)
        s.apply_sync(response(newer, caregivers=0))
        s.apply_sync(response(older, caregivers=2))
        assert s.active_caregivers == 0
    finally:
        s.close()


def test_the_contract_requires_the_count():
    import pytest
    body = response(type("R", (), {"sequence": 1, "acks": []})())
    models.SyncResponse.from_wire(body)
    for bad in ({k: v for k, v in body.items() if k != "activeCaregivers"}, {**body, "activeCaregivers": 11}):
        with pytest.raises(ValueError):
            models.SyncResponse.from_wire(bad)


# Scheduler

def test_the_visible_overlay_hides_while_nobody_is_paired(tmp_path):
    h = Harness(tmp_path)
    try:
        h.used(at("14:00:00"), LIMIT)
        h.playing(at("14:00:00"))
        [overlay] = h.show(at("14:00:01"))
        caregivers(h.store, 0)
        assert h.show(at("14:00:02")) == [Hide(overlay.key)]
        h.playing(at("14:00:10"))
        assert h.show(at("14:00:11")) == []
        caregivers(h.store, 1)
        [again] = h.show(at("14:00:12"))
        assert again.source == "allowance"
    finally:
        h.store.close()


# Status

def test_status_explains_the_pause():
    from datetime import datetime
    from aw_telegram.clock import UTC
    now = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)
    lines = status_lines(StatusInput(now=now, enrolled=True, paired=True, settings=games(), used_ms=0, partial=False,
        last_sync_at=format_instant(now), sync=None, caregivers=0))
    assert lines[1] == ("Батьки: зараз ніхто не під’єднаний. Обмеження й нагадування призупинено, доки хтось "
                        "не під’єднається в «Доступ батьків».")
