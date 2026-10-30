"""Primary-monitor dimming overlay with opaque text and click capture."""
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QFont, QPainter
from PySide6.QtWidgets import QPushButton

from ._surface import PresentationSurface
from ..texts import t
from ..windows.foreground import ForegroundAdapter


class OverlayWindow(PresentationSurface):
    def __init__(self, foreground_adapter=None):
        self._text = ""
        self._dismissible = True
        self._foreground_adapter = foreground_adapter or ForegroundAdapter()
        self.presentation_result = None
        super().__init__()
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.dismiss_button = QPushButton(self)
        self.dismiss_button.setFixedSize(160, 48)
        self.dismiss_button.setStyleSheet(
            "QPushButton {color: white; background: #333; border: 1px solid white;"
            "border-radius: 6px; font-size: 20px;}"
            "QPushButton:focus {border: 3px solid white;}")
        self.dismiss_button.clicked.connect(self.hide_message)
        self.retranslate()
        self._position()

    def retranslate(self) -> None:
        self.setWindowTitle(t("overlay.title"))
        self.setAccessibleName(t("overlay.title"))
        self.dismiss_button.setText(t("overlay.dismiss"))

    def _before_show(self):
        self.presentation_result = self._foreground_adapter.reveal_overlay(int(self.winId()))

    def show_message(self, text: str, dismissible: bool, duration_ms: int | None) -> None:
        if not dismissible and (type(duration_ms) is not int
                                or not 1000 <= duration_ms <= 3_600_000):
            raise ValueError("buttonless overlay requires 1000..3600000 ms")
        # Validate before retiring the existing presentation.
        if duration_ms is not None and (type(duration_ms) is not int
                                        or not 1 <= duration_ms <= 3_600_000):
            raise ValueError("duration_ms must be 1..3600000")
        self.retranslate()
        self._text = text
        self._dismissible = dismissible
        self.dismiss_button.setVisible(dismissible)
        self._present(duration_ms)

    def _position(self, *_):
        if self._screen is not None:
            self.setGeometry(self._screen.geometry())
        if hasattr(self, "dismiss_button"):
            self.dismiss_button.move((self.width() - 160) // 2,
                                     max(0, self.height() - 48 - 32))
        self.update()

    def resizeEvent(self, event):
        if hasattr(self, "dismiss_button"):
            self.dismiss_button.move((self.width() - 160) // 2,
                                     max(0, self.height() - 80))
        super().resizeEvent(event)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(0, 0, 0, 179))
        painter.setPen(QColor(255, 255, 255, 255))
        font = QFont(self.font())
        font.setPointSize(32)
        painter.setFont(font)
        # Symmetric margins preserve vertical centering and leave button clearance.
        text_rect = self.rect().adjusted(48, 112, -48, -112)
        painter.drawText(text_rect, Qt.AlignmentFlag.AlignCenter
                         | Qt.TextFlag.TextWordWrap, self._text)

    def closeEvent(self, event):
        if self._active and not self._dismissible:
            event.ignore()
        else:
            super().closeEvent(event)
