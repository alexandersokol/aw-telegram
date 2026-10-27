"""Shared presentation lifecycle; IDs describe requests, not verified pixels."""
from uuid import uuid4

from PySide6.QtCore import QTimer, Qt, Signal
from PySide6.QtWidgets import QApplication, QWidget


class PresentationSurface(QWidget):
    shown = Signal(str)
    dismissed = Signal(str)
    expired = Signal(str)
    completed = Signal(str, str)

    def __init__(self):
        super().__init__(None, Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint
                         | Qt.WindowType.WindowStaysOnTopHint)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.presentation_id: str | None = None
        self._active = False
        self._presentation_generation = 0
        self._screen = None
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setTimerType(Qt.TimerType.PreciseTimer)
        self._timer.timeout.connect(lambda: self._finish("expired"))
        app = QApplication.instance()
        app.primaryScreenChanged.connect(self._bind_screen)
        app.screenAdded.connect(self._bind_screen)
        app.screenRemoved.connect(self._bind_screen)
        self._bind_screen()

    @property
    def remaining_ms(self):
        return max(0, self._timer.remainingTime())

    def _bind_screen(self, *_):
        screen = QApplication.primaryScreen()
        if self._screen is not screen:
            if self._screen is not None:
                try:
                    for signal in (self._screen.geometryChanged,
                                   self._screen.availableGeometryChanged,
                                   self._screen.logicalDotsPerInchChanged):
                        signal.disconnect(self._position)
                except RuntimeError:  # QScreen may already be removed.
                    pass
            self._screen = screen
            if screen is not None:
                for signal in (screen.geometryChanged, screen.availableGeometryChanged,
                               screen.logicalDotsPerInchChanged):
                    signal.connect(self._position)
        self._position()

    def _position(self, *_):
        raise NotImplementedError

    def _before_show(self):
        pass

    def _present(self, duration_ms, prepare=None):
        if duration_ms is not None and (type(duration_ms) is not int or duration_ms <= 0
                                        or duration_ms > 3_600_000):
            raise ValueError("duration_ms must be 1..3600000")
        self._presentation_generation += 1
        generation = self._presentation_generation
        self._finish("dismissed", "replaced")
        # A retirement callback may synchronously request a newer presentation.
        # That request wins; never overwrite an ID it already published.
        if generation != self._presentation_generation:
            return
        self.presentation_id = str(uuid4())
        identifier = self.presentation_id
        self._active = True
        self._position()
        if duration_ms is not None:
            self._timer.start(duration_ms)
        if prepare is not None:
            prepare()
        self._before_show()
        self.show()
        self.raise_()
        self.update()
        self.shown.emit(identifier)

    def _finish(self, event, reason=None):
        if not self._active:
            return
        identifier = self.presentation_id
        self._active = False
        self._timer.stop()
        self.hide()
        getattr(self, event).emit(identifier)
        self.completed.emit(identifier, reason or event)

    def hide_message(self):
        self._finish("dismissed")

    def clear(self, presentation_id: str) -> bool:
        if not self._active or self.presentation_id != presentation_id:
            return False
        self._finish("dismissed", "cleared")
        return True

    def mousePressEvent(self, event):
        event.accept()

    def mouseReleaseEvent(self, event):
        event.accept()

    def closeEvent(self, event):
        self.hide_message()
        event.accept()
