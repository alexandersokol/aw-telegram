"""Task 11g: the «Мова / Language» setting, its storage and its effect on windows, warnings and Qt's strings."""
from datetime import timedelta

import pytest
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QMessageBox

from aw_telegram import texts
from aw_telegram.clock import UTC, format_instant
from aw_telegram.models import Settings
from aw_telegram.storage import LocalStore
from aw_telegram.transport import DeviceIdentity
from aw_telegram.ui import i18n
from aw_telegram.ui.notification import NotificationCard
from aw_telegram.ui.overlay import OverlayWindow
from aw_telegram.windows import language

from test_allowance import Harness as AllowanceHarness, LIMIT, at as allowance_at, left
from test_scheduler import Harness as EndtimeHarness, at as endtime_at

DEVICE = "00000000-0000-4000-8000-000000000001"
BINDING = DeviceIdentity(DEVICE, "https://backend.example")


class NoSync:
    def __init__(self, store, on_update):
        self.store = store

    def step(self, now, mono):
        pass


def sync_runner(fn, done):
    try:
        done(fn(), None)
    except Exception as error:
        done(None, error)


def make_app(qtbot, path, **options):
    from aw_telegram.main import CompanionApp
    app = CompanionApp(path, NoSync, show=False, runner=sync_runner, **options)
    qtbot.addWidget(app.window)
    app.start()
    return app


@pytest.fixture
def qt_uk_buttons(qapp):
    """Restore the translator state each test found."""
    yield
    i18n.remove_translations(qapp)


# Storage

def test_the_choice_defaults_to_system_and_persists_across_a_restart(tmp_path):
    path = tmp_path / "companion.sqlite"
    store = LocalStore(path)
    assert store.app_config["language"] == "system"
    store.set_language("en")
    store.set_app_config(awHost="::1", awPort=5666)  # another local setting does not reset it
    store.close()
    reopened = LocalStore(path)
    try:
        assert reopened.app_config["language"] == "en" and reopened.app_config["awPort"] == 5666
        with pytest.raises(ValueError):
            reopened.set_language("de")
    finally:
        reopened.close()


# Qt's own strings

def button_texts(qtbot):
    box = QMessageBox(QMessageBox.Icon.Question, "AW Telegram", "?",
                      QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
    qtbot.addWidget(box)
    return sorted(b.text().replace("&", "") for b in box.buttons())


def test_qts_ukrainian_translator_is_installed_only_for_ukrainian(qtbot, qapp, qt_uk_buttons):
    i18n.apply_language(qapp, "en")
    assert button_texts(qtbot) == ["No", "Yes"]
    i18n.apply_language(qapp, "uk")
    assert button_texts(qtbot) == ["Ні", "Так"]
    i18n.apply_language(qapp, "uk")  # applying twice does not stack translators
    i18n.apply_language(qapp, "en")
    assert button_texts(qtbot) == ["No", "Yes"]


# Warnings and status in the chosen language

def test_endtime_warning_and_overlay_render_in_the_chosen_language(tmp_path):
    texts.set_language("en")
    h = EndtimeHarness(tmp_path)
    try:
        [card] = h.tick(endtime_at("20:45:00"), resumed=True)
        assert card.text == "Endtime at 21:00: 15 min left."
        [overlay] = h.overlays(h.show(endtime_at("21:00:00")))
        assert overlay.text == "Endtime 21:00.\nTime to put the laptop away."
    finally:
        h.store.close()
    texts.set_language("uk")
    (tmp_path / "again").mkdir()
    h = EndtimeHarness(tmp_path / "again")
    try:
        assert "15 хв" in h.tick(endtime_at("20:45:00"), resumed=True)[0].text
    finally:
        h.store.close()


def test_allowance_warning_and_overlay_render_in_english(tmp_path):
    texts.set_language("en")
    h = AllowanceHarness(tmp_path)
    try:
        h.used(allowance_at("14:00:00"), left(14))
        [card] = h.show(allowance_at("14:00:00"))
        assert card.text == "Daily time: 15 min or less left."
        h.used(allowance_at("14:14:00"), LIMIT)
        h.playing(allowance_at("14:14:00"))
        [overlay] = h.show(allowance_at("14:14:01"))
        assert overlay.text == "Today's time is used up.\nPlease turn off the computer."
    finally:
        h.store.close()


def test_status_lines_and_durations_render_in_english():
    from datetime import datetime
    from aw_telegram.status import StatusInput, duration, status_lines
    texts.set_language("en")
    assert [duration(n) for n in (0, 30_000, 59 * 60_000, 3_900_000)] == ["0 min", "under 1 min", "59 min", "1 h 05 min"]
    now = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)
    lines = status_lines(StatusInput(
        now=now, enrolled=True, paired=True, settings=Settings(revision=1, selectedPaths=[["Games"]], endtimeEnabled=True),
        used_ms=3_600_000, partial=False, last_sync_at=format_instant(now - timedelta(seconds=1)),
        sync=dict(health=dict(awState="ready", reportError=None), auth_blocked=False)))
    assert lines == ["Server: connected, last sync at 13:59", "ActivityWatch: running",
                     "Today: 1 h 00 min of 4 h 00 min, 3 h 00 min left", "Endtime: on, at 21:00",
                     "Free use: off", "Automatic reminders: active"]
    assert status_lines(StatusInput(now=now, enrolled=False, paired=False, settings=Settings(), used_ms=None,
                                    partial=False, last_sync_at=None, sync=None)) == [
        "Server: this laptop is not connected. Enter the connection code in Settings."]


def test_the_uninstall_report_renders_in_english(tmp_path):
    from aw_telegram.uninstall import uninstall

    class Registry:
        def delete(self, name):
            pass

    class Vault:
        def delete(self, url, device):
            pass

    store = LocalStore(tmp_path / "c.sqlite", identity=BINDING)
    texts.set_language("en")
    try:
        report = uninstall(store, registry=Registry(), vault=Vault(), access=None, revoke_parents=False, data=tmp_path)
    finally:
        store.close()
    assert report[0] == "Autostart turned off."
    assert "revoke-device --project PROJECT --device-id " + DEVICE in report[2]


def test_caregiver_message_text_is_shown_unchanged(qtbot):
    texts.set_language("en")
    message = "Час зробити перерву"
    card = NotificationCard()
    qtbot.addWidget(card)
    card.show_message(message)
    assert card.message.text() == message
    overlay = OverlayWindow()
    qtbot.addWidget(overlay)
    overlay.show_message(message, True, None)
    assert overlay._text == message


def test_own_window_titles_match_in_either_language():
    from aw_telegram.aw_reader import companion_foreground
    for title in ("Нагадування AW Telegram", "AW Telegram reminder", "AW Telegram timer", "Сповіщення AW Telegram"):
        assert companion_foreground(dict(app="python.exe", title=title))
    assert not companion_foreground(dict(app="python.exe", title="Other"))


# Windows and the next overlay

def test_the_next_overlay_and_notification_use_the_current_language(qtbot):
    overlay, card = OverlayWindow(), NotificationCard()
    qtbot.addWidget(overlay)
    qtbot.addWidget(card)
    assert overlay.dismiss_button.text() == "Закрити"
    texts.set_language("en")
    overlay.show_message("x", True, None)
    card.show_message("x")
    assert (overlay.dismiss_button.text(), overlay.windowTitle()) == ("Close", "AW Telegram reminder")
    assert (card.dismiss_button.text(), card.windowTitle()) == ("Close", "AW Telegram notification")


def test_choosing_a_language_applies_at_once_and_survives_a_restart(qtbot, tmp_path, qt_uk_buttons):
    path = tmp_path / "companion.sqlite"
    LocalStore(path, identity=BINDING).close()
    app = make_app(qtbot, path)
    try:
        panel = app.settings_panel
        assert [panel.language.itemText(i) for i in range(3)] == ["Системна / System", "Українська", "English"]
        assert panel.language.currentData() == "system"  # the mocked Windows is Ukrainian
        assert app.window.tabs.tabText(2) == "Налаштування" and panel.version_label.text().startswith("Версія")
        panel.language.setCurrentIndex(2)  # English
        assert texts.language() == "en" and app.runtime.store.app_config["language"] == "en"
        assert [app.window.tabs.tabText(i) for i in range(3)] == ["Status", "Parent access", "Settings"]
        assert panel.server_group.title() == "Server connection"
        assert panel.version_label.text().startswith("Version")
        assert panel.connection_message.text().startswith("Connected to server backend.example")
        assert app.access_panel.create_button.text() == "Create key"
        assert app.access_panel.table.horizontalHeaderItem(1).text() == "Status"
        assert app.tray._quit_action.text() == "Quit"
        assert app.window.status.text().startswith("Server:")
        assert button_texts(qtbot) == ["No", "Yes"]
    finally:
        app.quit()
    app = make_app(qtbot, path)
    try:
        assert texts.language() == "en" and app.settings_panel.language.currentData() == "en"
        assert app.window.tabs.tabText(0) == "Status"
        app.settings_panel.language.setCurrentIndex(1)  # Українська
        assert texts.language() == "uk" and app.window.tabs.tabText(0) == "Стан"
        assert button_texts(qtbot) == ["Ні", "Так"]
    finally:
        app.quit()


def test_system_follows_windows_and_transient_messages_are_translated(qtbot, tmp_path, monkeypatch, qt_uk_buttons):
    monkeypatch.setattr(language, "ui_language_id", lambda: 0x0409)  # en-US
    path = tmp_path / "companion.sqlite"
    app = make_app(qtbot, path, probe=lambda host, port: None)
    try:
        assert texts.language() == "en" and app.window.tabs.tabText(0) == "Status"
        panel = app.settings_panel
        panel.code.setPlainText("nonsense")
        panel.check_button.click()
        assert panel.connection_message.text().startswith("The connection code was not recognised")
        panel.language.setCurrentIndex(1)  # Українська overrides Windows
        assert panel.connection_message.text().startswith("Код підключення не розпізнано")
        panel.language.setCurrentIndex(0)  # back to System: English again
        assert panel.connection_message.text().startswith("The connection code was not recognised")
    finally:
        app.quit()


def test_a_forgotten_enrollment_keeps_the_chosen_language(qtbot, tmp_path, qt_uk_buttons):
    path = tmp_path / "companion.sqlite"
    store = LocalStore(path, identity=BINDING)
    store.set_language("en")
    store.close()
    app = make_app(qtbot, path, confirm=lambda text: True, forget=lambda binding: None, probe=lambda h, p: None)
    try:
        qtbot.mouseClick(app.settings_panel.reconnect_button, Qt.MouseButton.LeftButton)
        assert app.runtime.store.binding is None and app.runtime.store.app_config["language"] == "en"
    finally:
        app.quit()


def test_the_stored_choice_is_read_before_the_store_is_open(tmp_path):
    from aw_telegram.main import saved_language
    path = tmp_path / "companion.sqlite"
    assert saved_language(path) == "system"  # no data yet
    store = LocalStore(path)
    store.set_language("uk")
    store.close()
    assert saved_language(path) == "uk"
    path.write_bytes(b"not a database")
    assert saved_language(path) == "system"
