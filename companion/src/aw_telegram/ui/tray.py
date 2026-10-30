"""Tray icon: open the window, or quit the companion."""
from PySide6.QtCore import QRectF, Qt, Signal
from PySide6.QtGui import QAction, QColor, QFont, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import QMenu, QSystemTrayIcon

from ..texts import t


def tray_icon() -> QIcon:
    pixmap = QPixmap(64, 64)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setBrush(QColor("#2a7de1"))
    painter.setPen(Qt.PenStyle.NoPen)
    painter.drawEllipse(QRectF(2, 2, 60, 60))
    painter.setPen(QColor("white"))
    painter.setFont(QFont("Segoe UI", 26, QFont.Weight.Bold))
    painter.drawText(QRectF(0, 0, 64, 64), Qt.AlignmentFlag.AlignCenter, "AW")
    painter.end()
    return QIcon(pixmap)


class CompanionTray(QSystemTrayIcon):
    open_requested = Signal()
    quit_requested = Signal()

    def __init__(self):
        super().__init__(tray_icon())
        self.setToolTip("AW Telegram")
        self._menu = QMenu()
        self._open_action = QAction(self._menu)
        self._open_action.triggered.connect(self.open_requested)
        self._quit_action = QAction(self._menu)
        self._quit_action.triggered.connect(self.quit_requested)
        self._menu.addAction(self._open_action)
        self._menu.addSeparator()
        self._menu.addAction(self._quit_action)
        self.setContextMenu(self._menu)
        self.activated.connect(self._activated)
        self.retranslate()

    def retranslate(self) -> None:
        self._open_action.setText(t("tray.open"))
        self._quit_action.setText(t("tray.quit"))

    def _activated(self, reason):
        if reason in (QSystemTrayIcon.ActivationReason.Trigger, QSystemTrayIcon.ActivationReason.DoubleClick):
            self.open_requested.emit()
