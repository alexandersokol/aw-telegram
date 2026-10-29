"""One overlay slot with newest-due-wins, offline endtime policy and durable receipts.

No Qt. ui.presenter applies the returned commands on the GUI thread and reports
results through presented()/dismissed(). Manual overlay families are registered by
the local action executor (base Task 8); a family displaced by a newer overlay is
terminally replaced and never resumes, even if it is registered again after restart.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
import json
from typing import Literal
from uuid import uuid4

from .clock import format_instant, kyiv_date, local_day_bounds, parse_instant, retained_dates
from .models import EndtimeAck
from .policy import EndtimeState, endtime_finished, endtime_shown, evaluate_endtime

OVERLAY_TEXT = "Час завершення {time}.\nЧас відкласти ноутбук."
WARNING_TEXT = "Час завершення о {time}: залишилося {minutes} хв."
_TERMINAL = {"replaced", "finished", "failed", "unconfirmed"}


@dataclass(frozen=True)
class Presentation:
    key: str
    source: Literal["endtime", "manual"]
    kind: Literal["overlay", "notification"]
    text: str
    dismissible: bool = True
    duration_ms: int | None = None


@dataclass(frozen=True)
class Hide:
    key: str


class Scheduler:
    """Use on one thread with its own LocalStore connection."""

    def __init__(self, store):
        self.store = store

    def _load(self) -> dict:
        value = self.store.overlay_state() or {}
        endtime = EndtimeState.from_json(value["endtime"]) if "endtime" in value else EndtimeState()
        return dict(endtime=endtime, visible=value.get("visible"), sequence=value.get("sequence", 0),
                    manual=value.get("manual", {}))

    def _save(self, state: dict, before: str | None = None, receipt: EndtimeAck | None = None) -> None:
        value = {**state, "endtime": state["endtime"].to_json()}
        if receipt is None and before == json.dumps(value, sort_keys=True):
            return  # most ticks change nothing
        self.store.commit_overlay_state(value, receipt)

    @staticmethod
    def _snapshot(state: dict) -> str:
        return json.dumps({**state, "endtime": state["endtime"].to_json()}, sort_keys=True)

    def add_manual(self, action_id: str, text: str, due_at: datetime, repeat_minutes: int | None = None,
                   dismissible: bool = True, duration_ms: int | None = None) -> None:
        state = self._load()
        if action_id in state["manual"]:
            return  # idempotent; a terminal family stays terminal
        state["sequence"] += 1
        state["manual"][action_id] = dict(text=text, due=format_instant(due_at), date=kyiv_date(due_at),
            repeat=repeat_minutes, dismissible=dismissible, duration=duration_ms,
            sequence=state["sequence"], state="pending")
        self._save(state)

    def tick(self, now: datetime, resumed: bool = False) -> list[Presentation | Hide]:
        state = self._load()
        before = self._snapshot(state)
        settings = self.store.settings
        endtime, decision = evaluate_endtime(settings, state["endtime"], now, resumed)
        commands: list[Presentation | Hide] = []
        visible = state["visible"]
        if decision.hide and visible and visible.startswith("endtime:"):
            commands.append(Hide(visible))
            visible = None
        if decision.warning:
            commands.append(Presentation(f"endtime-warning:{endtime.date}:{endtime.generation}:{decision.warning}",
                "endtime", "notification", WARNING_TEXT.format(time=settings.endtimeLocalTime,
                                                              minutes=decision.warning.removesuffix("m"))))
        candidates = []
        if decision.show:
            state["sequence"] += 1
            candidates.append((decision.due_at, state["sequence"], None, Presentation(
                f"endtime:{endtime.date}:{endtime.generation}:{state['sequence']}", "endtime", "overlay",
                OVERLAY_TEXT.format(time=settings.endtimeLocalTime))))
        for action_id, family in state["manual"].items():
            if family["state"] == "pending" and parse_instant(family["due"]) <= now:
                candidates.append((parse_instant(family["due"]), family["sequence"], action_id, Presentation(
                    f"manual:{action_id}:{family['sequence']}", "manual", "overlay", family["text"],
                    family["dismissible"], family["duration"])))
        if candidates:
            # Newest due instant wins; equal instants fall back to the later durable sequence.
            candidates.sort(key=lambda c: (c[0], c[1]))
            *older, (_, _, newest_id, newest) = candidates
            for _, _, action_id, presentation in older:
                endtime = self._retire(state, endtime, presentation.key, action_id, now)
            if visible:
                commands.append(Hide(visible))
                endtime = self._retire(state, endtime, visible, self._family(visible), now)
            visible = newest.key
            if newest_id is None:
                endtime = endtime_shown(endtime)
            else:
                state["manual"][newest_id]["state"] = "visible"
            commands.append(newest)
        dates = retained_dates(now)
        state["manual"] = {k: f for k, f in state["manual"].items() if f["date"] in dates or f["state"] not in _TERMINAL}
        state.update(endtime=endtime, visible=visible)
        self._save(state, before)
        return commands

    @staticmethod
    def _family(key: str) -> str | None:
        return key.split(":")[1] if key.startswith("manual:") else None

    @staticmethod
    def _retire(state: dict, endtime: EndtimeState, key: str, action_id: str | None, now: datetime) -> EndtimeState:
        """Terminal replacement: a manual family ends; endtime policy owns its next occurrence."""
        if action_id is None:
            return endtime_finished(endtime, now) if key.startswith("endtime:") else endtime
        state["manual"][action_id]["state"] = "replaced"
        return endtime

    def presented(self, key: str, result, at: datetime) -> None:
        """An accepted show request (any state except failed) counts as presented."""
        state = self._load()
        if state["visible"] != key:
            return
        failed = result.state == "failed"
        receipt = None
        if key.startswith("endtime:"):
            if failed:
                state.update(endtime=endtime_finished(state["endtime"], at), visible=None)
            else:
                receipt = self._receipt(key, at)
        elif failed:
            state["manual"][self._family(key)]["state"] = "failed"
            state["visible"] = None
        self._save(state, receipt=receipt)

    def _receipt(self, key: str, at: datetime) -> EndtimeAck | None:
        _, date, generation, _ = key.split(":")
        settings = self.store.settings
        if not settings.endtimeEnabled or settings.endtimeGeneration != int(generation):
            return None
        try:
            return EndtimeAck(id=str(uuid4()), kind="endtime", date=date, settingsRevision=settings.revision,
                endtimeLocalTime=settings.endtimeLocalTime, endtimeGeneration=settings.endtimeGeneration,
                presentedAt=format_instant(at))
        except ValueError:
            return None  # e.g. presented after its Kyiv date ended

    def dismissed(self, key: str, now: datetime) -> None:
        state = self._load()
        if state["visible"] != key:
            return
        state["visible"] = None
        if key.startswith("endtime:"):
            state["endtime"] = endtime_finished(state["endtime"], now)
        else:
            family = state["manual"][self._family(key)]
            following = now + timedelta(minutes=family["repeat"]) if family["repeat"] else None
            if following is None or following >= local_day_bounds(family["date"])[1]:
                family["state"] = "finished"  # once, or a repeat family ends at its Kyiv midnight
            else:
                state["sequence"] += 1
                family.update(state="pending", due=format_instant(following), sequence=state["sequence"])
        self._save(state)

    def recover(self, now: datetime) -> None:
        """After restart nothing is on screen; never replay a possibly shown presentation."""
        state = self._load()
        key = state["visible"]
        if key is None:
            return
        if key.startswith("endtime:"):
            state["endtime"] = endtime_finished(state["endtime"], now)
        else:
            state["manual"][self._family(key)]["state"] = "unconfirmed"
        state["visible"] = None
        self._save(state)
