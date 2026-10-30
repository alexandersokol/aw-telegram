"""Companion-controlled card, independent of Windows toast settings."""
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QFrame, QLabel, QPushButton, QScrollArea, QVBoxLayout

from ._surface import PresentationSurface


class NotificationCard(PresentationSurface):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Сповіщення AW Telegram")
        self.setAccessibleName("Сповіщення AW Telegram")
        self.setStyleSheet("background: #242424; color: white; font-size: 18px;")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        self.message = QLabel()
        self.message.setTextFormat(Qt.TextFormat.PlainText)
        self.message.setWordWrap(True)
        self.message.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.message_scroll = QScrollArea()
        self.message_scroll.setWidget(self.message)
        self.message_scroll.setWidgetResizable(False)
        self.message_scroll.setFrameShape(QFrame.Shape.NoFrame)
        layout.addWidget(self.message_scroll, 1)
        self.dismiss_button = QPushButton("Закрити")
        self.dismiss_button.clicked.connect(self.hide_message)
        layout.addWidget(self.dismiss_button)
        self._position()

    def show_message(self, text: str, duration_ms: int = 10_000) -> None:
        if type(duration_ms) is not int or not 1 <= duration_ms <= 3_600_000:
            raise ValueError("duration_ms must be 1..3600000")
        self.message.setText(text)
        self._present(duration_ms)

    def _position(self, *_):
        if self._screen is not None:
            rect = self._screen.availableGeometry()
            width = min(400, max(1, rect.width() - 32))
            height = min(240, max(1, rect.height() - 32))
            if hasattr(self, "message_scroll"):
                layout = self.layout()
                margins = layout.contentsMargins()
                frame = 2 * self.message_scroll.frameWidth()
                # Reserve a scrollbar gutter before measuring to avoid reflow loops.
                viewport_width = max(1, width - margins.left() - margins.right()
                                     - frame - self.message_scroll.verticalScrollBar().sizeHint().width())
                # A single long token may need horizontal scrolling; never clip it.
                content_width = max(viewport_width, self.message.minimumSizeHint().width())
                content_height = max(1, self.message.heightForWidth(content_width))
                self.message.resize(content_width, content_height)
                overhead = margins.top() + margins.bottom() + layout.spacing() + frame
                overhead += self.dismiss_button.sizeHint().height()
                if content_width > viewport_width:
                    overhead += self.message_scroll.horizontalScrollBar().sizeHint().height()
                height = min(content_height + overhead, 420, max(1, rect.height() - 32))
            self.setGeometry(rect.right() - width - 15, rect.top() + 16,
                             width, height)
