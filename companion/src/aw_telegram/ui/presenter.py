"""GUI-thread driver applying scheduler commands to the real overlay and notification windows."""
from datetime import datetime, timezone
import time

from PySide6.QtCore import QObject, QTimer

from ..scheduler import Hide
from .notification import NotificationCard
from .overlay import OverlayWindow

WARNING_CARD_MS = 10_000
RESUME_DRIFT_S = 2.0


def utc_now() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(microsecond=now.microsecond // 1000 * 1000)


class PolicyPresenter(QObject):
    """Ticks once a second. A wall-clock jump against the monotonic clock (sleep, clock
    change) or the first tick after start is reported to the scheduler as a resume."""

    def __init__(self, scheduler, overlay=None, notification=None, now=utc_now, monotonic=time.monotonic,
                 interval_ms=1000):
        super().__init__()
        self.scheduler = scheduler
        self.overlay = overlay or OverlayWindow()
        self.notification = notification or NotificationCard()
        self._now, self._monotonic = now, monotonic
        self._keys: dict[str, str] = {}  # widget presentation ID -> scheduler key
        self._last: tuple[datetime, float] | None = None
        self.overlay.completed.connect(self._completed)
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
                        self.overlay.clear(presentation_id)
            elif command.kind == "notification":
                self.notification.show_message(command.text, WARNING_CARD_MS)
            else:
                # Showing over an active overlay retires it as `replaced`; the scheduler already did.
                self.overlay.show_message(command.text, command.dismissible, command.duration_ms)
                self._keys[self.overlay.presentation_id] = command.key
                self.scheduler.presented(command.key, self.overlay.presentation_result, now)

    def _completed(self, presentation_id: str, reason: str) -> None:
        key = self._keys.pop(presentation_id, None)
        # Replacement and clearing were decided by the scheduler; only user/duration ends report back.
        if key is not None and reason in ("dismissed", "expired"):
            self.scheduler.dismissed(key, self._now())
