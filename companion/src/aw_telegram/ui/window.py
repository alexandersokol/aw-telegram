"""Small companion window: «Стан», «Доступ батьків», «Налаштування». Closing it keeps the tray app running."""
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QLabel, QTabWidget, QVBoxLayout, QWidget

SECTIONS = ("status", "access", "settings")


class CompanionWindow(QWidget):
    def __init__(self, settings: QWidget | None = None):
        super().__init__()
        QApplication.setQuitOnLastWindowClosed(False)  # a tray app: background work outlives the window
        self.setWindowTitle("AW Telegram")
        self.resize(520, 420)
        layout = QVBoxLayout(self)
        self.tabs = QTabWidget()
        layout.addWidget(self.tabs)
        self.status = QLabel()
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.status.setWordWrap(True)
        self.status.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.status.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.access = QWidget()
        self.settings_panel = settings or QWidget()
        for widget, title in ((self._page(self.status), "Стан"), (self.access, "Доступ батьків"),
                              (self.settings_panel, "Налаштування")):
            self.tabs.addTab(widget, title)

    @staticmethod
    def _page(content: QWidget) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.addWidget(content)
        return page

    def show_section(self, name: str) -> None:
        self.tabs.setCurrentIndex(SECTIONS.index(name))

    def set_status(self, lines: list[str]) -> None:
        self.status.setText("\n".join(lines))

    def closeEvent(self, event):
        event.ignore()
        self.hide()
