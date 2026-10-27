"""Monotonic local countdown; scheduling and persistence belong to later tasks."""
import math

from PySide6.QtCore import QElapsedTimer, QTimer, Qt
from PySide6.QtWidgets import QLabel, QVBoxLayout

from ._surface import PresentationSurface


class CountdownWindow(PresentationSurface):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Таймер AW Telegram")
        self.setAccessibleName("Таймер AW Telegram")
        self.setStyleSheet("background: #242424; color: white; font-size: 22px;")
        layout = QVBoxLayout(self)
        self.label = QLabel()
        self.label.setTextFormat(Qt.TextFormat.PlainText)
        self.label.setWordWrap(True)
        layout.addWidget(self.label)
        self._elapsed = QElapsedTimer()
        self._ticks = QTimer(self)
        self._ticks.setInterval(50)
        self._ticks.timeout.connect(self._update_text)
        self.dismissed.connect(self._ticks.stop)
        self.expired.connect(self._ticks.stop)

    @property
    def text(self):
        return self.label.text()

    def start_countdown(self, duration_ms: int, text: str = "До нагадування") -> None:
        if type(duration_ms) is not int or not 1 <= duration_ms <= 86_340_000:
            raise ValueError("duration_ms must be 1..86340000")
        def prepare():
            self._caption = text
            self._duration = duration_ms
            self._elapsed.start()
            self._timer.start(duration_ms)
            self._update_text()
            self._ticks.start()

        # Initialize all state before publishing shown: callbacks may replace/clear.
        # Timers may be up to 1439 minutes; the shared lifecycle bounds cards/overlays.
        self._present(None, prepare=prepare)

    def _update_text(self):
        seconds = math.ceil(max(0, self._duration - self._elapsed.elapsed()) / 1000)
        hours, rest = divmod(seconds, 3600)
        minutes, seconds = divmod(rest, 60)
        clock = f"{hours:02}:{minutes:02}:{seconds:02}" if hours else f"{minutes:02}:{seconds:02}"
        self.label.setText(f"{self._caption}\n{clock}")

    def _position(self, *_):
        if self._screen is not None:
            rect = self._screen.availableGeometry()
            self.setGeometry(rect.left() + 16, rect.top() + 16,
                             min(300, max(1, rect.width() - 32)), 100)
