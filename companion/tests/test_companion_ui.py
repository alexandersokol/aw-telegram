"""Task 9a: status text, startup entry, single instance, window and tray."""
import threading
from datetime import datetime, timedelta

import pytest
from PySide6.QtWidgets import QApplication

from aw_telegram.clock import KYIV, UTC, format_instant
from aw_telegram.models import Settings
from aw_telegram.status import StatusInput, duration, status_lines

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)  # 14:00 Kyiv
HOUR = 3_600_000
GAMES = dict(revision=1, selectedPaths=[["Games"]])


def status(**fields):
    base = dict(now=NOW, enrolled=True, paired=True, settings=Settings(**GAMES), used_ms=HOUR, partial=False,
                last_sync_at=format_instant(NOW - timedelta(seconds=20)),
                sync=dict(health=dict(awState="ready", reportError=None), auth_blocked=False))
    return status_lines(StatusInput(**{**base, **fields}))


def line(lines, prefix):
    return next(l for l in lines if l.startswith(prefix))


# Status

def test_duration_matches_the_bot():
    assert [duration(n) for n in (0, 30_000, 60_000, 59 * 60_000, HOUR + 5 * 60_000)] == [
        "0 хв", "менше 1 хв", "1 хв", "59 хв", "1 год 05 хв"]


def test_healthy_status_shows_sync_usage_endtime_and_modes():
    lines = status(settings=Settings(**GAMES, endtimeEnabled=True, endtimeLocalTime="21:30"))
    assert lines == [
        "Сервер: на зв’язку, остання синхронізація о 13:59",
        "ActivityWatch: працює",
        "Сьогодні: 1 год 00 хв з 4 год 00 хв, залишилось 3 год 00 хв",
        "Час завершення: увімкнено, о 21:30",
        "Вільний режим: вимкнено",
        "Автоматичні нагадування: активні",
    ]


def test_missing_data_is_not_zero_usage():
    lines = status(used_ms=None, sync=dict(health=dict(awState="unavailable", reportError=None), auth_blocked=False))
    assert line(lines, "ActivityWatch") == "ActivityWatch: недоступний"
    assert line(lines, "Сьогодні") == "Сьогодні: даних немає"
    lines = status(used_ms=0, partial=True, sync=dict(health=dict(awState="stale", reportError=None), auth_blocked=False))
    assert line(lines, "Сьогодні") == "Сьогодні: 0 хв з 4 год 00 хв, залишилось 4 год 00 хв (неповні дані)"
    assert line(lines, "ActivityWatch") == "ActivityWatch: дані застаріли"


def test_no_selected_category_guides_to_the_bot():
    lines = status(settings=Settings(revision=1))
    assert line(lines, "Сьогодні") == "Сьогодні: для обліку не вибрано жодної категорії. Оберіть їх у Telegram: /categories."


def test_over_limit_free_use_and_suppression():
    lines = status(used_ms=5 * HOUR)
    assert line(lines, "Сьогодні") == "Сьогодні: 5 год 00 хв з 4 год 00 хв, перевищено на 1 год 00 хв"
    lines = status(settings=Settings(**GAMES, freeUseDate="2026-10-28", suppressedDate="2026-10-28"))
    assert line(lines, "Сьогодні") == "Сьогодні: 1 год 00 хв, вільний режим"
    assert line(lines, "Вільний режим") == "Вільний режим: увімкнено до опівночі"
    assert line(lines, "Автоматичні нагадування") == "Автоматичні нагадування: вимкнено до опівночі"


def test_connection_states():
    assert line(status(last_sync_at=format_instant(NOW - timedelta(minutes=5))), "Сервер") == \
        "Сервер: немає зв’язку, остання синхронізація о 13:55"
    assert line(status(last_sync_at=format_instant(NOW - timedelta(days=1))), "Сервер") == \
        "Сервер: немає зв’язку, остання синхронізація 27.10 о 14:00"
    assert line(status(last_sync_at=None), "Сервер") == "Сервер: ще не синхронізувався"
    assert line(status(sync=dict(health=dict(awState="ready", reportError=None), auth_blocked=True)), "Сервер") == \
        "Сервер: доступ ноутбука відхилено. Попросіть власника видати новий код підключення."
    assert status(enrolled=False, paired=False, last_sync_at=None, sync=None) == [
        "Сервер: ноутбук не підключено. Введіть код підключення в «Налаштування».",
    ]
    lines = status(paired=False, used_ms=None)
    assert line(lines, "Батьки") == "Батьки: ще ніхто не під’єднався. Створіть ключ у «Доступ батьків»."
    assert line(lines, "ActivityWatch") == "ActivityWatch: облік почнеться після першого під’єднання батьків"


def test_report_capacity_is_explained():
    lines = status(sync=dict(health=dict(awState="ready", reportError="report_capacity_exceeded"), auth_blocked=False))
    assert line(lines, "ActivityWatch") == "ActivityWatch: працює (звіт завеликий, надіслано останні дані)"


# Startup entry

class Registry:
    def __init__(self):
        self.values = {}

    def set(self, name, value):
        self.values[name] = value

    def delete(self, name):
        self.values.pop(name, None)

    def get(self, name):
        return self.values.get(name)


def test_startup_entry_quotes_the_executable_and_removes_cleanly():
    from aw_telegram.windows.startup import RUN_VALUE, set_startup, startup_enabled
    registry, exe = Registry(), r"C:\Program Files\AW Telegram\aw-telegram.exe"
    set_startup(True, exe, registry)
    assert registry.values == {RUN_VALUE: '"C:\\Program Files\\AW Telegram\\aw-telegram.exe" --background'}
    assert startup_enabled(exe, registry)
    assert not startup_enabled(r"C:\Other\aw-telegram.exe", registry)
    set_startup(False, exe, registry)
    set_startup(False, exe, registry)
    assert registry.values == {}
    for bad in ("aw-telegram.exe", 'C:\\a"b.exe', ""):
        with pytest.raises(ValueError):
            set_startup(True, bad, registry)


# Single instance

def test_a_second_instance_hands_over_and_exits(qtbot):
    from aw_telegram.single_instance import SingleInstance
    name = f"aw-telegram-test-{threading.get_ident()}-{datetime.now().timestamp()}"
    first, second = SingleInstance(name), SingleInstance(name)
    try:
        assert first.acquire()
        with qtbot.waitSignal(first.activated, timeout=3000):
            assert not second.acquire()
    finally:
        first.release()
        second.release()
    third = SingleInstance(name)
    try:
        assert third.acquire()  # released names are reusable
    finally:
        third.release()


# Window and tray

def test_window_has_three_sections_and_closing_keeps_running(qtbot):
    from aw_telegram.ui.window import CompanionWindow
    window = CompanionWindow()
    qtbot.addWidget(window)
    assert [window.tabs.tabText(i) for i in range(window.tabs.count())] == ["Стан", "Доступ батьків", "Налаштування"]
    window.show_section("settings")
    assert window.tabs.currentIndex() == 2
    window.set_status(["Сервер: ще не синхронізувався", "ActivityWatch: працює"])
    assert window.status.text() == "Сервер: ще не синхронізувався\nActivityWatch: працює"
    window.show()
    window.close()
    assert not window.isVisible() and not QApplication.quitOnLastWindowClosed()


def test_tray_menu_opens_the_window_and_quits(qtbot):
    from aw_telegram.ui.tray import CompanionTray
    tray = CompanionTray()
    labels = [a.text() for a in tray.contextMenu().actions() if not a.isSeparator()]
    assert labels == ["Відкрити", "Вийти"]
    with qtbot.waitSignal(tray.open_requested, timeout=1000):
        tray.contextMenu().actions()[0].trigger()
    with qtbot.waitSignal(tray.quit_requested, timeout=1000):
        tray.contextMenu().actions()[-1].trigger()
    assert not tray.icon().isNull() and tray.toolTip() == "AW Telegram"


# Application wiring

def test_app_runs_the_runtime_refreshes_status_and_quits_cleanly(qtbot, tmp_path):
    from aw_telegram.main import CompanionApp
    steps = []

    class Coordinator:
        def __init__(self, store, on_update):
            self.store = store

        def step(self, now, mono):
            steps.append(now)

        def snapshot(self):
            return dict(health=dict(awState="ready", reportError=None), auth_blocked=False, last_error=None)

    app = CompanionApp(tmp_path / "companion.sqlite", Coordinator, presenter_factory=None, show=False)
    qtbot.addWidget(app.window)
    app.start()
    try:
        qtbot.waitUntil(lambda: bool(steps), timeout=3000)
        app.refresh()
        assert app.window.status.text().startswith("Сервер: ноутбук не підключено")
        assert app.window.tabs.currentIndex() == 2  # not enrolled: setup comes first
    finally:
        assert app.quit()
    assert app.runtime.worker is None or not app.runtime.worker._thread.is_alive()
