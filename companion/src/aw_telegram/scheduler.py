"""Local presentation scheduler: one overlay slot (newest due wins), one card slot and one countdown slot.

No Qt. ui.presenter applies the returned commands on the GUI thread and reports results through
presented()/dismissed(). Accepted delivery offers come from LocalStore; every transition's receipt
commits in the same transaction as the scheduler state. A manual family displaced by a newer
overlay, canceled by a fence, skipped in free use or interrupted by a crash is terminal and never
resumes. Endtime and allowance recurrence belong to their daily policies instead; the allowance overlay
has no receipts (Telegram allowance alerts come from the backend's own measurement).
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
import json
from typing import Literal
from uuid import uuid4

from .clock import format_instant, kyiv_date, local_day_bounds, parse_instant, retained_dates
from .models import EndtimeAck
from .policy import (AllowanceState, EndtimeState, allowance_finished, allowance_shown, endtime_finished, endtime_shown,
                     evaluate_allowance, evaluate_endtime)

OVERLAY_TEXT = "Час завершення {time}.\nЧас відкласти ноутбук."
WARNING_TEXT = "Час завершення о {time}: залишилося {minutes} хв."
ALLOWANCE_OVERLAY_TEXT = "Денний час вичерпано.\nБудь ласка, вимкни комп’ютер."
ALLOWANCE_WARNING_TEXT = "Денний час: залишилося {minutes} хв або менше."
NOTIFY_CARD_MS = 10_000
_LIVE = {"waiting", "visible"}


@dataclass(frozen=True)
class Presentation:
    key: str
    source: Literal["endtime", "allowance", "manual"]
    kind: Literal["overlay", "notification"]
    text: str
    dismissible: bool = True
    duration_ms: int | None = None


@dataclass(frozen=True)
class Countdown:
    """Top-left timer until a delayed reminder's target."""
    key: str
    until: datetime
    text: str


@dataclass(frozen=True)
class Hide:
    key: str


def _event(action_id, status, at, occurrence, presented_at=None, reason=None, terminal=True):
    return dict(action_id=action_id, status=status, at=at, occurrence=occurrence, presented_at=presented_at,
                reason=reason, terminal=terminal)


class Scheduler:
    """Use on one thread with its own LocalStore connection."""

    def __init__(self, store):
        self.store = store

    def _load(self) -> dict:
        value = self.store.overlay_state() or {}
        endtime = EndtimeState.from_json(value["endtime"]) if "endtime" in value else EndtimeState()
        allowance = AllowanceState.from_json(value["allowance"]) if "allowance" in value else AllowanceState()
        return dict(endtime=endtime, allowance=allowance, visible=value.get("visible"), sequence=value.get("sequence", 0),
                    manual=value.get("manual", {}), card=value.get("card"), countdown=value.get("countdown"))

    @staticmethod
    def _value(state: dict) -> dict:
        return {**state, "endtime": state["endtime"].to_json(), "allowance": state["allowance"].to_json()}

    def _save(self, state: dict, before: str | None = None, receipt: EndtimeAck | None = None, events=()) -> None:
        value = self._value(state)
        if receipt is None and not events and before == json.dumps(value, sort_keys=True):
            return  # most ticks change nothing
        self.store.commit_overlay_state(value, receipt, events)

    @classmethod
    def _snapshot(cls, state: dict) -> str:
        return json.dumps(cls._value(state), sort_keys=True)

    @staticmethod
    def _family_of(action: dict, occurrence: int, sequence: int) -> dict:
        options = action["options"]
        return dict(kind=action["kind"], text=options["message"], countdown=options["countdown"],
            target=action["targetAt"], expires=action["expiresAt"], date=kyiv_date(parse_instant(action["targetAt"])),
            repeat=options.get("repeatEveryMinutes"), dismissible=options.get("dismissible", True),
            duration=options["durationSeconds"] * 1000 if "durationSeconds" in options else None,
            immediate=action["targetAt"] == action["createdAt"], due=action["targetAt"], occurrence=occurrence,
            sequence=sequence, state="waiting")

    def _import(self, state: dict, commands: list, now: datetime) -> None:
        """Adopt newly accepted actions; drop families the store made terminal (cancellation fences)."""
        open_ids = set()
        for row in self.store.open_actions():
            action = row["action"]
            open_ids.add(action["id"])
            if action["id"] not in state["manual"]:
                state["sequence"] += 1
                state["manual"][action["id"]] = self._family_of(action, row["occurrence"], state["sequence"])
        for action_id, family in state["manual"].items():
            if family["state"] in _LIVE and action_id not in open_ids:
                family["state"] = "done"
                for slot, key in (("visible", self._overlay_key(action_id, family)), ("card", f"notify:{action_id}")):
                    if state[slot] == key:
                        commands.append(Hide(key))
                        state[slot] = None

    @staticmethod
    def _overlay_key(action_id: str, family: dict) -> str:
        return f"manual:{action_id}:{family['sequence']}"

    def tick(self, now: datetime, resumed: bool = False) -> list[Presentation | Countdown | Hide]:
        state = self._load()
        before = self._snapshot(state)
        settings = self.store.settings
        commands: list = []
        events: list = []
        self._import(state, commands, now)
        state["endtime"], decision = evaluate_endtime(settings, state["endtime"], now, resumed)
        state["allowance"], verdict = evaluate_allowance(settings, state["allowance"],
            self.store.selected_usage(kyiv_date(now)), self.store.activity, now)
        endtime, allowance = state["endtime"], state["allowance"]
        visible = state["visible"]
        for hide, prefix in ((decision.hide, "endtime:"), (verdict.hide, "allowance:")):
            if hide and visible and visible.startswith(prefix):
                commands.append(Hide(visible))
                visible = None
        if decision.warning:
            self._warning(state, events, commands, now, Presentation(
                f"endtime-warning:{endtime.date}:{endtime.generation}:{decision.warning}", "endtime", "notification",
                WARNING_TEXT.format(time=settings.endtimeLocalTime, minutes=decision.warning.removesuffix("m"))))
        if verdict.warning:
            self._warning(state, events, commands, now, Presentation(
                f"allowance-warning:{allowance.date}:{verdict.warning}", "allowance", "notification",
                ALLOWANCE_WARNING_TEXT.format(minutes=verdict.warning.removesuffix("m"))))
        overlays, cards = [], []
        if decision.show:
            state["sequence"] += 1
            overlays.append((decision.due_at, state["sequence"], None, Presentation(
                f"endtime:{endtime.date}:{endtime.generation}:{state['sequence']}", "endtime", "overlay",
                OVERLAY_TEXT.format(time=settings.endtimeLocalTime))))
        if verdict.show:
            state["sequence"] += 1
            overlays.append((verdict.due_at, state["sequence"], None, Presentation(
                f"allowance:{allowance.date}:{state['sequence']}", "allowance", "overlay", ALLOWANCE_OVERLAY_TEXT)))
        free = settings.freeUseDate == kyiv_date(now)
        for action_id, family in state["manual"].items():
            midnight = local_day_bounds(family["date"])[1]
            if family["state"] == "visible" and family["repeat"] and now >= midnight:
                # A repeat family stops at its Kyiv midnight, removing any visible instance.
                key = self._overlay_key(action_id, family)
                if visible == key:
                    commands.append(Hide(key))
                    visible = None
                events.append(_event(action_id, "completed", now, family["occurrence"]))
                family["state"] = "done"
            if family["state"] != "waiting" or parse_instant(family["due"]) > now:
                continue
            due, occurrence = parse_instant(family["due"]), family["occurrence"]
            if occurrence == 0:
                expires = parse_instant(family["expires"])
                late = now >= expires if family["immediate"] else now > expires
            else:
                late = due >= midnight
            if late and occurrence:
                family["state"] = "done"  # the family ended at midnight; the backend closes it there too
            elif late:
                events.append(_event(action_id, "expired", now, 0, reason="missed_deadline"))
                family["state"] = "done"
            elif free:
                events.append(_event(action_id, "skipped", now, occurrence, reason="free_use"))
                family["state"] = "done"
            elif family["kind"] == "overlay":
                overlays.append((due, family["sequence"], action_id, Presentation(self._overlay_key(action_id, family),
                    "manual", "overlay", family["text"], family["dismissible"], family["duration"])))
            else:
                cards.append((due, family["sequence"], action_id))
        if overlays:
            # Newest due instant wins; equal instants fall back to the later durable sequence.
            overlays.sort(key=lambda c: (c[0], c[1]))
            *older, (_, _, newest_id, newest) = overlays
            for _, _, action_id, presentation in older:
                self._retire(state, presentation.key, action_id, now, events)
            if visible:
                commands.append(Hide(visible))
                self._retire(state, visible, self._family(visible), now, events)
            visible = newest.key
            if newest.source == "endtime":
                state["endtime"] = endtime_shown(state["endtime"])
            elif newest.source == "allowance":
                state["allowance"] = allowance_shown(state["allowance"], now)
            else:
                state["manual"][newest_id]["state"] = "visible"
            commands.append(newest)
        if cards:
            cards.sort()
            *older, (_, _, newest_id) = cards
            for _, _, action_id in older:  # never shown: a newer card was due in the same tick
                events.append(_event(action_id, "replaced", now, 0, reason="replaced"))
                state["manual"][action_id]["state"] = "done"
            if state["card"]:  # the visible card gives up its slot
                shown = self._family(state["card"])
                events.append(_event(shown, "replaced", now, state["manual"][shown]["occurrence"], reason="replaced"))
                state["manual"][shown]["state"] = "done"
            state["manual"][newest_id]["state"] = "visible"
            state["card"] = f"notify:{newest_id}"
            commands.append(Presentation(state["card"], "manual", "notification", state["manual"][newest_id]["text"],
                                         duration_ms=NOTIFY_CARD_MS))
        self._countdown(state, commands, now)
        dates = retained_dates(now)
        state["manual"] = {k: f for k, f in state["manual"].items() if f["date"] in dates or f["state"] in _LIVE}
        state["visible"] = visible
        self._save(state, before, events=events)
        return commands

    def _warning(self, state: dict, events: list, commands: list, now: datetime, card: Presentation) -> None:
        """A policy warning card takes the slot from a manual card."""
        if state["card"]:
            shown = self._family(state["card"])
            events.append(_event(shown, "replaced", now, state["manual"][shown]["occurrence"], reason="replaced"))
            state["manual"][shown]["state"], state["card"] = "done", None
        commands.append(card)

    def _countdown(self, state: dict, commands: list, now: datetime) -> None:
        """Show the nearest waiting delayed reminder that asked for a countdown, if any."""
        waiting = [(f["target"], action_id) for action_id, f in state["manual"].items()
                   if f["state"] == "waiting" and f["countdown"] and f["occurrence"] == 0 and parse_instant(f["target"]) > now]
        wanted = f"countdown:{min(waiting)[1]}" if waiting else None
        if wanted == state["countdown"]:
            return
        if state["countdown"]:
            commands.append(Hide(state["countdown"]))
        if wanted:
            family = state["manual"][wanted.split(":", 1)[1]]
            commands.append(Countdown(wanted, parse_instant(family["target"]), family["text"]))
        state["countdown"] = wanted

    @staticmethod
    def _family(key: str) -> str | None:
        return key.split(":")[1] if key.startswith(("manual:", "notify:")) else None

    @staticmethod
    def _retire(state: dict, key: str, action_id: str | None, now: datetime, events: list) -> None:
        """Terminal replacement: a manual family ends; the endtime and allowance policies own their next occurrence."""
        if key.startswith("endtime:"):
            state["endtime"] = endtime_finished(state["endtime"], now)
        elif key.startswith("allowance:"):
            state["allowance"] = allowance_finished(state["allowance"], now)
        else:
            family = state["manual"][action_id]
            events.append(_event(action_id, "replaced", now, family["occurrence"], reason="replaced"))
            family["state"] = "done"

    def presented(self, key: str, result, at: datetime) -> None:
        """An accepted show request (any state except failed) counts as presented; a card has no native result."""
        state = self._load()
        failed = result is not None and result.state == "failed"
        receipt, events = None, []
        if key.startswith("notify:") and state["card"] == key:
            family = state["manual"][self._family(key)]
            events.append(_event(self._family(key), "failed" if failed else "presented", at, family["occurrence"],
                None if failed else at, "presentation_failed" if failed else None, failed))
            if failed:
                family["state"], state["card"] = "done", None
        elif state["visible"] != key:
            return
        elif key.startswith("endtime:"):
            if failed:
                state.update(endtime=endtime_finished(state["endtime"], at), visible=None)
            else:
                receipt = self._receipt(key, at)
        elif key.startswith("allowance:"):
            if not failed:
                return
            state.update(allowance=allowance_finished(state["allowance"], at), visible=None)
        else:
            action_id = self._family(key)
            family = state["manual"][action_id]
            events.append(_event(action_id, "failed" if failed else "presented", at, family["occurrence"],
                None if failed else at, "presentation_failed" if failed else None, failed))
            if failed:
                family["state"], state["visible"] = "done", None
        self._save(state, receipt=receipt, events=events)

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

    def dismissed(self, key: str, now: datetime, reason: str = "dismissed") -> None:
        """reason: dismissed (button), expired (duration elapsed) or replaced (a newer card took the slot)."""
        state = self._load()
        events = []
        if key.startswith("notify:"):
            if state["card"] != key:
                return
            action_id = self._family(key)
            family = state["manual"][action_id]
            # A notification card cannot be "dismissed" on the wire: closing or expiry completes it.
            events.append(_event(action_id, "replaced" if reason == "replaced" else "completed", now, family["occurrence"],
                                 reason="replaced" if reason == "replaced" else None))
            family["state"], state["card"] = "done", None
            self._save(state, events=events)
            return
        if state["visible"] != key:
            return
        state["visible"] = None
        if key.startswith("endtime:"):
            state["endtime"] = endtime_finished(state["endtime"], now)
        elif key.startswith("allowance:"):
            state["allowance"] = allowance_finished(state["allowance"], now)
        else:
            action_id = self._family(key)
            family = state["manual"][action_id]
            if reason == "expired":
                events.append(_event(action_id, "completed", now, family["occurrence"]))  # buttonless duration
                family["state"] = "done"
            else:
                following = now + timedelta(minutes=family["repeat"]) if family["repeat"] else None
                repeats = following is not None and following < local_day_bounds(family["date"])[1]
                events.append(_event(action_id, "dismissed", now, family["occurrence"], terminal=not repeats))
                if repeats:
                    state["sequence"] += 1
                    family.update(state="waiting", due=format_instant(following), occurrence=family["occurrence"] + 1,
                                  sequence=state["sequence"])
                else:
                    family["state"] = "done"  # once, or a repeat family ends at its Kyiv midnight
        self._save(state, events=events)

    def recover(self, now: datetime) -> None:
        """After restart nothing is on screen; never replay a possibly shown presentation."""
        state = self._load()
        events = []
        key = state["visible"]
        policy = key is not None and key.startswith(("endtime:", "allowance:"))
        if policy:
            self._retire(state, key, None, now, [])
        for slot_key in (None if policy else key, state["card"]):
            if slot_key:
                action_id = self._family(slot_key)
                family = state["manual"][action_id]
                events.append(_event(action_id, "unconfirmed", now, family["occurrence"], reason="crash_during_presentation"))
                family["state"] = "done"
        state.update(visible=None, card=None, countdown=None)  # the countdown widget is reissued on the next tick
        self._save(state, events=events)
