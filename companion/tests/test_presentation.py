"""Real Qt rendering/lifecycle tests; OS calls are isolated at their boundary."""
import sys

import pytest
from PySide6.QtCore import QPoint, QRect, Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QApplication, QFrame, QPushButton, QScrollArea

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


def test_notification_message_scroll_has_no_frame(qtbot):
    card = NotificationCard()
    qtbot.addWidget(card)
    assert card.message_scroll.frameShape() == QFrame.Shape.NoFrame
    assert card.message_scroll.frameWidth() == 0


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


def test_countdown_ignores_input_while_staying_on_top(qtbot):
    # Removing either input flag would let the countdown intercept interaction.
    countdown = CountdownWindow()
    qtbot.addWidget(countdown)
    countdown.start_countdown(10000)
    assert countdown.windowFlags() & Qt.WindowType.WindowTransparentForInput
    assert countdown.testAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
    assert countdown.windowFlags() & Qt.WindowType.WindowStaysOnTopHint


@pytest.mark.skipif(sys.platform != "win32", reason="Windows native input style")
def test_countdown_native_window_is_input_transparent(qtbot, qapp):
    # Check the actual HWND, not a synthetic Qt click that bypasses hit testing.
    import ctypes
    from ctypes import wintypes

    if qapp.platformName() != "windows":
        pytest.skip("Requires the native Windows Qt platform")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    get_style = (user32.GetWindowLongPtrW if ctypes.sizeof(ctypes.c_void_p) == 8
                 else user32.GetWindowLongW)
    get_style.argtypes = [wintypes.HWND, ctypes.c_int]
    get_style.restype = ctypes.c_ssize_t
    countdown = CountdownWindow()
    qtbot.addWidget(countdown)
    countdown.start_countdown(10000)
    qapp.processEvents()
    # WS_EX_TRANSPARENT enables native click-through for the layered timer.
    assert get_style(wintypes.HWND(int(countdown.winId())), -20) & 0x00000020


def test_countdown_translucent_background_keeps_text_opaque(qtbot):
    # Opaque backgrounds obscure the app; whole-window opacity also fades text.
    countdown = CountdownWindow()
    qtbot.addWidget(countdown)
    countdown.start_countdown(10000, "MMMM")
    image = countdown.grab().toImage()
    for point in (QPoint(2, 2), countdown.label.geometry().topLeft() + QPoint(2, 2)):
        background = image.pixelColor(point)
        assert abs(background.red() - 36) <= 1
        assert abs(background.green() - 36) <= 1
        assert abs(background.blue() - 36) <= 1
        assert abs(background.alpha() - 179) <= 1
    assert any(image.pixelColor(x, y) == QColor(255, 255, 255, 255)
               for y in range(image.height()) for x in range(image.width()))
    assert countdown.windowOpacity() == 1.0


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


class AcceptingDesktop:
    """Boundary fake: Windows accepts the topmost request without proving pixels."""
    def reveal_overlay(self, hwnd):
        return PresentationResult("unconfirmed", "topmost_requested")


@pytest.fixture
def driven(qtbot, tmp_path):
    from datetime import datetime
    from aw_telegram.clock import KYIV, UTC, format_instant
    from aw_telegram.models import ActionAck, EndtimeAck, Settings
    from action_fixture import action
    from aw_telegram.scheduler import Scheduler
    from aw_telegram.storage import LocalStore
    from aw_telegram.ui.presenter import PolicyPresenter
    clock = {"now": None, "mono": 0.0}
    store = LocalStore(tmp_path / "presenter.sqlite",
                       now=lambda: format_instant(clock["now"]) if clock["now"] else "2026-10-28T19:00:00.000Z")
    def settings(**fields):
        with store._transaction():
            state = store._state()
            state["settings"] = Settings(**{"revision": 1, "endtimeEnabled": True, "endtimeGeneration": 1, **fields}).to_wire()
            store._save(state)
    settings()
    overlay, card, countdown = OverlayWindow(foreground_adapter=AcceptingDesktop()), NotificationCard(), CountdownWindow()
    qtbot.addWidget(overlay); qtbot.addWidget(card); qtbot.addWidget(countdown)
    at = lambda local: datetime.fromisoformat("2026-10-28T" + local).replace(tzinfo=KYIV).astimezone(UTC)
    scheduler = Scheduler(store)
    presenter = PolicyPresenter(scheduler, overlay, card, countdown, now=lambda: clock["now"], monotonic=lambda: clock["mono"])
    def tick(local, slept=False):
        if clock["now"] is not None and not slept:
            clock["mono"] += (at(local) - clock["now"]).total_seconds()
        clock["now"] = at(local)
        presenter.tick()
    receipts = lambda: [a for a in store.pending_acks() if isinstance(a, EndtimeAck)]
    statuses = lambda: [(a.status, a.occurrence) for a in store.pending_acks() if isinstance(a, ActionAck)]
    def offer(local, n=1, **options):
        tick(local)
        store.receive_offers([action(n, created=format_instant(at(local)), **options)])
    yield dict(tick=tick, overlay=overlay, card=card, countdown=countdown, scheduler=scheduler, at=at, settings=settings,
               receipts=receipts, statuses=statuses, offer=offer, store=store)
    store.close()


def test_policy_presenter_shows_warning_cards_then_the_endtime_overlay(driven, qtbot):
    driven["tick"]("20:45:00")
    assert driven["card"].isVisible() and "15 хв" in driven["card"].message.text()
    assert not driven["overlay"].isVisible() and driven["receipts"]() == []
    driven["tick"]("21:00:00")
    assert driven["overlay"].isVisible() and "21:00" in driven["overlay"]._text
    assert driven["overlay"].dismiss_button.isVisible() and len(driven["receipts"]()) == 1


def test_policy_presenter_newest_overlay_replaces_and_dismissal_reports_back(driven, qtbot):
    overlay = driven["overlay"]
    driven["tick"]("21:00:00")
    driven["offer"]("21:00:30", message="Перерва", repeatEveryMinutes=1)
    driven["tick"]("21:00:30")
    assert overlay.isVisible() and overlay._text == "Перерва"
    qtbot.mouseClick(overlay.dismiss_button, Qt.MouseButton.LeftButton)
    assert not overlay.isVisible()
    driven["tick"]("21:01:29")
    assert not overlay.isVisible()
    # The replaced endtime occurrence returns one minute after replacement, newest again.
    driven["tick"]("21:01:30")
    assert overlay.isVisible() and "21:00" in overlay._text
    assert overlay.isVisible() and len(driven["receipts"]()) == 1


def test_policy_presenter_suppression_clears_the_visible_endtime_overlay(driven):
    driven["tick"]("21:00:00")
    driven["settings"](revision=2, freeUseDate="2026-10-28")
    driven["tick"]("21:00:05")
    assert not driven["overlay"].isVisible()
    driven["tick"]("21:05:00")
    assert not driven["overlay"].isVisible()


def test_policy_presenter_treats_a_wall_clock_jump_as_resume(driven):
    driven["tick"]("20:40:00")
    # Sleep across endtime: wall time advances while the monotonic clock does not.
    driven["tick"]("21:10:00", slept=True)
    assert not driven["overlay"].isVisible() and driven["receipts"]() == []
    driven["tick"]("21:11:00")
    assert not driven["overlay"].isVisible()


def test_policy_presenter_runs_manual_cards_and_countdowns_with_receipts(driven, qtbot):
    driven["settings"](revision=1, endtimeEnabled=False)
    driven["offer"]("14:00:00", 1, kind="notify", message="Привіт")
    driven["tick"]("14:00:01")
    assert driven["card"].isVisible() and driven["card"].message.text() == "Привіт"
    driven["offer"]("14:00:02", 2, delay=1, countdown=True, message="Скоро перерва")
    driven["tick"]("14:00:03")
    assert driven["countdown"].isVisible() and driven["countdown"].text.startswith("Скоро перерва")
    qtbot.mouseClick(driven["card"].dismiss_button, Qt.MouseButton.LeftButton)
    driven["tick"]("14:01:02")
    assert not driven["countdown"].isVisible() and driven["overlay"]._text == "Скоро перерва"
    assert driven["statuses"]() == [("accepted", 0), ("presented", 0), ("accepted", 0), ("completed", 0), ("presented", 0)]


def test_policy_presenter_completes_a_buttonless_overlay_at_its_duration(driven, qtbot):
    driven["settings"](revision=1, endtimeEnabled=False)
    driven["offer"]("14:00:00", message="Увага", dismissible=False, durationSeconds=1)
    driven["tick"]("14:00:01")
    assert driven["overlay"].isVisible() and not driven["overlay"].dismiss_button.isVisible()
    qtbot.waitUntil(lambda: not driven["overlay"].isVisible(), timeout=3000)
    assert driven["statuses"]()[-1] == ("completed", 0)


def test_policy_presenter_hides_a_reminder_cleared_by_a_fence(driven):
    driven["settings"](revision=1, endtimeEnabled=False)
    driven["offer"]("14:00:00", message="Перерва")
    driven["tick"]("14:00:01")
    assert driven["overlay"].isVisible()
    store = driven["store"]
    with store._transaction():
        state = store._state()
        state.update(cancellationRevision=1, throughActionSequence=1)
        store._save(state)
        store._cancel_covered(state["lastServerNow"] or "2026-10-28T12:00:01.000Z")
    driven["tick"]("14:00:02")
    assert not driven["overlay"].isVisible() and driven["statuses"]()[-1] == ("canceled", 0)
