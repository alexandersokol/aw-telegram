"""GUI-thread driver applying scheduler commands to the overlay, notification card and countdown windows."""
from datetime import datetime, timezone
import time

from PySide6.QtCore import QObject, QTimer

from ..scheduler import Countdown, Hide
from .countdown import CountdownWindow
from .notification import NotificationCard
from .overlay import OverlayWindow

WARNING_CARD_MS = 10_000
RESUME_DRIFT_S = 2.0
MAX_COUNTDOWN_MS = 86_340_000


def utc_now() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(microsecond=now.microsecond // 1000 * 1000)


class PolicyPresenter(QObject):
    """Ticks once a second. A wall-clock jump against the monotonic clock (sleep, clock
    change) or the first tick after start is reported to the scheduler as a resume."""

    def __init__(self, scheduler, overlay=None, notification=None, countdown=None, now=utc_now,
                 monotonic=time.monotonic, interval_ms=1000):
        super().__init__()
        self.scheduler = scheduler
        self.overlay = overlay or OverlayWindow()
        self.notification = notification or NotificationCard()
        self.countdown = countdown or CountdownWindow()
        self._now, self._monotonic = now, monotonic
        self._keys: dict[str, str] = {}  # widget presentation ID -> scheduler key, across all three widgets
        self._last: tuple[datetime, float] | None = None
        self.overlay.completed.connect(self._completed)
        self.notification.completed.connect(self._completed)
        self.countdown.completed.connect(lambda presentation_id, _reason: self._keys.pop(presentation_id, None))
        self._timer = QTimer(self)
        self._timer.setInterval(interval_ms)
        self._timer.timeout.connect(self.tick)

    def start(self) -> None:
        self.scheduler.recover(self._now())
        self._last = None
        self._timer.start()
        self.tick()

    def stop(self) -> None:
        self._timer.stop()

    def tick(self) -> None:
        wall, mono = self._now(), self._monotonic()
        resumed = self._last is None or abs((wall - self._last[0]).total_seconds() - (mono - self._last[1])) > RESUME_DRIFT_S
        self._last = (wall, mono)
        self.apply(self.scheduler.tick(wall, resumed), wall)

    def apply(self, commands, now: datetime) -> None:
        for command in commands:
            if isinstance(command, Hide):
                for presentation_id, key in list(self._keys.items()):
                    if key == command.key:
                        for widget in (self.overlay, self.notification, self.countdown):
                            widget.clear(presentation_id)
            elif isinstance(command, Countdown):
                remaining = int((command.until - now).total_seconds() * 1000)
                if remaining > 0:
                    self.countdown.start_countdown(min(remaining, MAX_COUNTDOWN_MS), command.text)
                    self._keys[self.countdown.presentation_id] = command.key
            elif command.kind == "notification":
                # Showing over a visible card retires it as `replaced`; for a manual card the scheduler already did.
                self.notification.show_message(command.text, command.duration_ms or WARNING_CARD_MS)
                self._keys[self.notification.presentation_id] = command.key
                if command.source == "manual":
                    self.scheduler.presented(command.key, None, now)
            else:
                # Showing over an active overlay retires it as `replaced`; the scheduler already did.
                self.overlay.show_message(command.text, command.dismissible, command.duration_ms)
                self._keys[self.overlay.presentation_id] = command.key
                self.scheduler.presented(command.key, self.overlay.presentation_result, now)

    def _completed(self, presentation_id: str, reason: str) -> None:
        key = self._keys.pop(presentation_id, None)
        # Replacement and clearing were decided by the scheduler; only user/duration ends report back.
        if key is not None and reason in ("dismissed", "expired") and not key.startswith("endtime-warning:"):
            self.scheduler.dismissed(key, self._now(), reason)
