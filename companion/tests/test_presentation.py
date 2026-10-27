"""Real Qt rendering/lifecycle tests; OS calls are isolated at their boundary."""
import pytest
from PySide6.QtCore import QPoint, QRect, Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QApplication, QPushButton, QScrollArea

from aw_telegram.ui.overlay import OverlayWindow
from aw_telegram.ui.notification import NotificationCard
from aw_telegram.ui.countdown import CountdownWindow
from aw_telegram.windows.foreground import ForegroundAdapter
from aw_telegram.windows.foreground import PresentationResult


@pytest.fixture
def overlay(qtbot):
    window = OverlayWindow()
    qtbot.addWidget(window)
    return window


def test_text_opaque_over_dim_background(overlay):
    # Whole-window opacity or painting text with the dim brush breaks this.
    overlay.show_message("MMMM", True, None)
    image = overlay.grab().toImage()
    corner = image.pixelColor(2, 2)
    assert corner.red() == 0
    assert abs(corner.alpha() - 179) <= 1
    center = QRect(image.width() // 4, image.height() // 3,
                   image.width() // 2, image.height() // 3)
    assert any(image.pixelColor(x, y) == QColor(255, 255, 255, 255)
               for y in range(center.top(), center.bottom(), 2)
               for x in range(center.left(), center.right(), 2))
    assert overlay.windowOpacity() == 1.0


def test_primary_monitor_geometry(overlay, qapp):
    overlay.show_message("Текст", True, None)
    assert overlay.geometry() == qapp.primaryScreen().geometry()


def test_display_and_dpi_events_restore_primary_geometry(overlay, qapp):
    # Missing screen/DPI subscriptions would leave the overlay undersized.
    overlay.show_message("Текст", True, None)
    screen = qapp.primaryScreen()
    for signal, argument in ((screen.geometryChanged, screen.geometry()),
                             (screen.logicalDotsPerInchChanged, screen.logicalDotsPerInch()),
                             (qapp.primaryScreenChanged, screen)):
        overlay.setGeometry(10, 10, 100, 100)
        signal.emit(argument)
        assert overlay.geometry() == screen.geometry()


def test_clicks_do_not_pass_through(overlay, qtbot):
    underneath = QPushButton("underneath")
    qtbot.addWidget(underneath)
    underneath.show()
    clicked = []
    underneath.clicked.connect(lambda: clicked.append(True))
    overlay.show_message("Текст", True, None)
    assert not overlay.testAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
    assert not (overlay.windowFlags() & Qt.WindowType.WindowTransparentForInput)
    qtbot.mouseClick(overlay, Qt.MouseButton.LeftButton, pos=QPoint(5, 5))
    assert overlay.isVisible()
    assert clicked == []


@pytest.mark.parametrize("duration", [None, 0, -1, 999, 3_600_001])
def test_buttonless_requires_duration(overlay, duration):
    with pytest.raises(ValueError):
        overlay.show_message("Текст", False, duration)
    assert not overlay.isVisible()


def test_dismiss_signal_once(overlay, qtbot):
    dismissed = []
    overlay.dismissed.connect(dismissed.append)
    overlay.show_message("Текст", True, None)
    action_id = overlay.presentation_id
    qtbot.mouseClick(overlay.dismiss_button, Qt.MouseButton.LeftButton)
    overlay.hide_message()
    assert dismissed == [action_id]
    assert not overlay.isVisible()


def test_dismiss_callback_cannot_relabel_completed_id(overlay):
    completed = []
    overlay.completed.connect(lambda identifier, reason: completed.append((identifier, reason)))
    overlay.show_message("Перше", True, None)
    old_id = overlay.presentation_id
    overlay.dismissed.connect(lambda _: overlay.show_message("Друге", True, None))
    overlay.hide_message()
    assert overlay.presentation_id != old_id
    assert overlay.isVisible()
    assert completed == [(old_id, "dismissed")]
    overlay.dismissed.disconnect()


@pytest.mark.parametrize("signal_name", ["dismissed", "completed"])
def test_reentrant_replacement_terminates_every_shown_id_once(overlay, signal_name):
    # A nested show during retirement must not be silently overwritten by its caller.
    shown, completed = [], []
    overlay.shown.connect(shown.append)
    overlay.completed.connect(lambda identifier, reason: completed.append(identifier))
    overlay.show_message("Перше", True, None)
    first_id = overlay.presentation_id

    def show_during_retirement(identifier, *_):
        if identifier == first_id:
            overlay.show_message("Повідомлення з callback", True, None)

    getattr(overlay, signal_name).connect(show_during_retirement)
    overlay.show_message("Зовнішня заміна", True, None)
    overlay.hide_message()
    assert len(completed) == len(shown)
    assert set(completed) == set(shown)
    assert len(completed) == len(set(completed))


def test_overlay_expiry_does_not_emit_dismissed(overlay, qtbot):
    expired, dismissed, shown = [], [], []
    overlay.expired.connect(expired.append)
    overlay.dismissed.connect(dismissed.append)
    overlay.shown.connect(shown.append)
    overlay.show_message("Текст", False, 1000)
    action_id = overlay.presentation_id
    assert overlay.dismiss_button.isHidden()
    qtbot.waitUntil(lambda: not overlay.isVisible())
    assert expired == shown == [action_id]
    assert dismissed == []


def test_replacement_retires_old_id_and_cancels_old_timer(overlay, qtbot):
    dismissed, expired = [], []
    overlay.dismissed.connect(dismissed.append)
    overlay.expired.connect(expired.append)
    overlay.show_message("Старе", True, 30)
    old_id = overlay.presentation_id
    overlay.show_message("Нове", True, None)
    assert overlay.presentation_id != old_id
    qtbot.wait(60)
    assert overlay.isVisible()
    assert dismissed == [old_id]
    assert expired == []


def test_notification_replacement_and_expiry(qtbot):
    card = NotificationCard()
    qtbot.addWidget(card)
    retired, expired = [], []
    card.dismissed.connect(retired.append)
    card.expired.connect(expired.append)
    card.show_message("Перше", duration_ms=10000)
    old_id = card.presentation_id
    assert card.remaining_ms > 9000
    card.show_message("Друге", duration_ms=30)
    new_id = card.presentation_id
    qtbot.waitUntil(lambda: not card.isVisible())
    assert retired == [old_id]
    assert expired == [new_id]


def test_notification_clear_id_cannot_clear_replacement(qtbot):
    card = NotificationCard()
    qtbot.addWidget(card)
    completed = []
    card.completed.connect(lambda identifier, reason: completed.append((identifier, reason)))
    card.show_message("Перше")
    old_id = card.presentation_id
    card.show_message("Друге")
    new_id = card.presentation_id
    assert not card.clear(old_id)
    assert card.isVisible()
    assert card.clear(new_id)
    assert not card.clear(new_id)
    assert not card.isVisible()
    assert completed == [(old_id, "replaced"), (new_id, "cleared")]


@pytest.mark.parametrize("length", [240, 1000])
def test_notification_all_text_is_accessible_within_primary_screen(qtbot, qapp, length):
    # A fixed-height label must not clip approved messages; overflow must scroll.
    card = NotificationCard()
    qtbot.addWidget(card)
    text = ("Це довге українське повідомлення для перевірки. " * 30)[:length]
    card.show_message(text)
    qapp.processEvents()
    assert card.message.text() == text
    assert qapp.primaryScreen().availableGeometry().contains(card.geometry())
    assert card.message.height() >= card.message.heightForWidth(card.message.width())
    scroll = card.findChild(QScrollArea)
    assert scroll is not None
    if card.message.height() > scroll.viewport().height():
        bar = scroll.verticalScrollBar()
        assert bar.maximum() > 0
        bar.setValue(bar.maximum())
        assert bar.value() == bar.maximum()
        last_line = card.message.mapTo(scroll.viewport(), QPoint(0, card.message.height() - 1))
        assert 0 <= last_line.y() < scroll.viewport().height()


def test_countdown_ceil_seconds_and_expiry(qtbot):
    countdown = CountdownWindow()
    qtbot.addWidget(countdown)
    expired = []
    countdown.expired.connect(expired.append)
    countdown.start_countdown(1020, "Перерва")
    assert "00:02" in countdown.text
    assert countdown.geometry().topLeft() == QApplication.primaryScreen().availableGeometry().topLeft() + QPoint(16, 16)
    action_id = countdown.presentation_id
    qtbot.waitUntil(lambda: not countdown.isVisible(), timeout=2000)
    assert expired == [action_id]


def test_countdown_shown_callback_replacement_keeps_its_own_deadline(qtbot):
    # The outer start must not restart a replacement's timer with its old duration.
    countdown = CountdownWindow()
    qtbot.addWidget(countdown)
    shown, expired = [], []
    countdown.expired.connect(expired.append)

    def replace_once(identifier):
        shown.append(identifier)
        if len(shown) == 1:
            countdown.start_countdown(100, "Нове")

    countdown.shown.connect(replace_once)
    countdown.start_countdown(10000, "Старе")
    assert 0 < countdown.remaining_ms <= 100
    assert countdown.text.startswith("Нове")
    qtbot.waitUntil(lambda: not countdown.isVisible(), timeout=1000)
    assert expired == [shown[1]]


def test_countdown_cleared_in_shown_does_not_restart_hidden_timer(qtbot):
    countdown = CountdownWindow()
    qtbot.addWidget(countdown)
    expired = []
    countdown.expired.connect(expired.append)
    countdown.shown.connect(countdown.clear)
    countdown.start_countdown(100, "Скасовано")
    assert not countdown.isVisible()
    assert countdown.remaining_ms == 0
    qtbot.wait(150)
    assert expired == []


class BlockedDesktop:
    def foreground(self):
        raise OSError("sensitive OS detail must not escape")


def test_foreground_failure_is_unconfirmed():
    result = ForegroundAdapter(native=BlockedDesktop()).reveal_overlay(123)
    assert result.state == "unconfirmed"
    assert result.reason == "windows_request_failed"


def test_overlay_requests_native_presentation_before_show(qtbot):
    class Adapter:
        def reveal_overlay(self, hwnd):
            assert hwnd > 0
            assert not window.isVisible()  # Capture original foreground first.
            return PresentationResult("unconfirmed", "topmost_requested")
    window = OverlayWindow(foreground_adapter=Adapter())
    qtbot.addWidget(window)
    window.show_message("Текст", True, None)
    assert window.presentation_result.state == "unconfirmed"


def test_buttonless_close_is_ignored_until_duration(overlay, qtbot):
    overlay.show_message("Текст", False, 1000)
    overlay.close()
    assert overlay.isVisible()
    qtbot.waitUntil(lambda: not overlay.isVisible())
