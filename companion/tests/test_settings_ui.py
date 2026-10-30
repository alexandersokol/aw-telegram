"""Task 9b: enrollment wizard and «Налаштування» (ActivityWatch address, autostart)."""
import json

import pytest
from PySide6.QtCore import Qt

from aw_telegram.aw_reader import AWCapabilities
from aw_telegram.storage import LocalStore
from aw_telegram.transport import DeviceIdentity, EnrollmentError, SyncError
from aw_telegram.ui.settings import SettingsPanel, aw_message, enrollment_error, parse_bundle

DEVICE = "00000000-0000-4000-8000-000000000001"
SECRET = "E" * 43
CODE = json.dumps({"backendUrl": "https://Backend.Example/", "secret": SECRET})
INFO = ("browser_enrichment_unavailable", "browser_local_settings_unavailable", "ui_build_presets_unverified")
READY = AWCapabilities(True, "laptop", "0.14.1", "window", "afk", True, "server", False, INFO)


def sync_runner(fn, done):
    """Runs background work inline so tests stay deterministic."""
    try:
        done(fn(), None)
    except Exception as error:
        done(None, error)


class Registry:
    def __init__(self):
        self.values = {}

    def get(self, name):
        return self.values.get(name)

    def set(self, name, value):
        self.values[name] = value

    def delete(self, name):
        self.values.pop(name, None)


def panel(qtbot, **options):
    calls = dict(enroll=[], enrolled=[], aw=[], probe=[])

    def enroll(bundle, host):
        calls["enroll"].append((bundle.backendUrl, host))
        result = options.get("enroll_result", DeviceIdentity(DEVICE, "https://backend.example"))
        if isinstance(result, Exception):
            raise result
        return result

    def probe(host, port):
        calls["probe"].append((host, port))
        return options.get("probe_result", READY)

    widget = SettingsPanel(enroll=enroll, probe=probe, on_enrolled=calls["enrolled"].append,
                           on_aw_changed=lambda host, port: calls["aw"].append((host, port)),
                           executable=options.get("executable"), registry=options.get("registry", Registry()),
                           runner=sync_runner)
    widget.set_state(options.get("binding"), options.get("config", {"awHost": "127.0.0.1", "awPort": 5600}))
    qtbot.addWidget(widget)
    return widget, calls


# Enrollment code

def test_bundle_is_the_owner_cli_output_and_shows_its_canonical_host():
    bundle, host = parse_bundle("  " + CODE + "\n")
    assert (bundle.backendUrl, bundle.secret, host) == ("https://Backend.Example/", SECRET, "backend.example")


@pytest.mark.parametrize("text", ["", "abc", "[]", json.dumps({"backendUrl": "https://x.example"}),
                                  json.dumps({"backendUrl": "https://x.example", "secret": SECRET, "extra": 1}),
                                  json.dumps({"backendUrl": "https://x.example", "secret": 5})])
def test_unrecognized_codes_are_rejected_in_ukrainian(text):
    with pytest.raises(ValueError, match="Код підключення не розпізнано"):
        parse_bundle(text)


def test_non_https_backend_is_rejected():
    with pytest.raises(ValueError, match="https://"):
        parse_bundle(json.dumps({"backendUrl": "http://backend.example", "secret": SECRET}))


def test_connecting_needs_an_explicit_confirmation_of_the_host(qtbot):
    widget, calls = panel(qtbot)
    assert widget.connect_button.isHidden()
    widget.code.setPlainText(CODE)
    qtbot.mouseClick(widget.check_button, Qt.MouseButton.LeftButton)
    assert "backend.example" in widget.connection_message.text() and not widget.connect_button.isHidden()
    assert calls["enroll"] == []  # nothing is sent before the owner confirms the host
    qtbot.mouseClick(widget.connect_button, Qt.MouseButton.LeftButton)
    assert calls["enroll"] == [("https://Backend.Example/", "backend.example")]
    assert calls["enrolled"] == [DeviceIdentity(DEVICE, "https://backend.example")]
    assert widget.code.toPlainText() == ""  # the one-time secret never stays on screen
    assert calls["probe"] == [("127.0.0.1", 5600)]  # ActivityWatch is checked right after connecting


def test_editing_the_code_withdraws_the_confirmation(qtbot):
    widget, calls = panel(qtbot)
    widget.code.setPlainText(CODE)
    qtbot.mouseClick(widget.check_button, Qt.MouseButton.LeftButton)
    widget.code.setPlainText(CODE.replace("Backend", "Other"))
    assert widget.connect_button.isHidden()


@pytest.mark.parametrize("error, keeps_code, text", [
    (SyncError(retryable=True), True, "Немає зв’язку з сервером"),
    (SyncError(retryable=False), False, "Код недійсний, прострочений або вже використаний"),
    (EnrollmentError("Credential storage failed; ask the owner to revoke the orphan enrollment and issue a new one"),
     False, "скасувати це підключення"),
    (EnrollmentError("Invalid enrollment response; owner recovery may be required"), False, "скасувати це підключення"),
])
def test_enrollment_failures_are_actionable(qtbot, error, keeps_code, text):
    widget, calls = panel(qtbot, enroll_result=error)
    widget.code.setPlainText(CODE)
    qtbot.mouseClick(widget.check_button, Qt.MouseButton.LeftButton)
    qtbot.mouseClick(widget.connect_button, Qt.MouseButton.LeftButton)
    assert text in widget.connection_message.text() and calls["enrolled"] == []
    assert (widget.code.toPlainText() == CODE) is keeps_code
    assert SECRET not in widget.connection_message.text()


def test_enrollment_error_text_never_echoes_details():
    assert SECRET not in enrollment_error(EnrollmentError(f"boom {SECRET}"))


def test_an_enrolled_laptop_shows_its_server_instead_of_the_wizard(qtbot):
    widget, _ = panel(qtbot, binding=dict(deviceId=DEVICE, backendUrl="https://backend.example"))
    assert widget.code.isHidden() and widget.check_button.isHidden()
    assert widget.connection_message.text() == "Підключено до сервера backend.example. Ноутбук: 00000000…"


# ActivityWatch

def test_saving_the_activitywatch_address_applies_and_checks_it(qtbot):
    widget, calls = panel(qtbot, binding=dict(deviceId=DEVICE, backendUrl="https://backend.example"))
    widget.aw_port.setValue(5666)
    qtbot.mouseClick(widget.aw_save, Qt.MouseButton.LeftButton)
    assert calls["aw"] == [("127.0.0.1", 5666)] and calls["probe"] == [("127.0.0.1", 5666)]
    assert widget.aw_message.text() == "ActivityWatch працює (laptop, версія 0.14.1)."


def test_activitywatch_check_explains_what_is_missing():
    down = AWCapabilities(False, None, None, None, None, False, None, False, ("unreachable",))
    assert aw_message(down, "127.0.0.1", 5600) == \
        "ActivityWatch не відповідає за адресою 127.0.0.1:5600. Запустіть ActivityWatch або перевірте порт."
    no_window = AWCapabilities(True, "laptop", "0.14.1", None, "afk", True, "server", False, ("missing_window",) + INFO)
    assert "aw-watcher-window" in aw_message(no_window, "127.0.0.1", 5600)
    no_categories = AWCapabilities(True, "laptop", "0.14.1", "window", "afk", False, None, False,
                                   ("missing_category_settings",) + INFO)
    assert "категорії" in aw_message(no_categories, "127.0.0.1", 5600)


# Autostart

def test_autostart_follows_the_installed_executable(qtbot):
    registry, exe = Registry(), r"C:\Program Files\AW Telegram\aw-telegram.exe"
    widget, _ = panel(qtbot, executable=exe, registry=registry)
    assert widget.autostart.isEnabled() and not widget.autostart.isChecked()
    widget.autostart.setChecked(True)
    assert registry.values == {"AW Telegram": f'"{exe}" --background'}
    widget.autostart.setChecked(False)
    assert registry.values == {}


def test_autostart_is_unavailable_when_not_installed(qtbot):
    widget, _ = panel(qtbot, executable=None)
    assert not widget.autostart.isEnabled() and "встановленій версії" in widget.autostart_note.text()


# Store

def test_store_binds_once_and_validates_the_activitywatch_address(tmp_path):
    store = LocalStore(tmp_path / "c.sqlite")
    try:
        identity = DeviceIdentity(DEVICE, "https://backend.example")
        store.bind(identity)
        store.bind(identity)
        with pytest.raises(ValueError):
            store.bind(DeviceIdentity("00000000-0000-4000-8000-000000000002", "https://backend.example"))
        store.set_app_config(awHost="::1", awPort=5666)
        assert store.app_config == {"awHost": "::1", "awPort": 5666, "language": "system"}
        for bad in (dict(awHost="10.0.0.1", awPort=5600), dict(awHost="127.0.0.1", awPort=0),
                    dict(awHost="127.0.0.1", awPort="5600")):
            with pytest.raises(ValueError):
                store.set_app_config(**bad)
    finally:
        store.close()


# Application wiring

def test_enrolling_binds_the_store_and_restarts_sync(qtbot, tmp_path):
    from aw_telegram.main import CompanionApp

    class Coordinator:
        def __init__(self, store, on_update):
            self.store, self.binding = store, store.binding

        def step(self, now, mono):
            pass

    app = CompanionApp(tmp_path / "companion.sqlite", Coordinator, show=False,
                       enroll=lambda bundle, host: DeviceIdentity(DEVICE, "https://backend.example"),
                       probe=lambda host, port: READY, runner=sync_runner)
    qtbot.addWidget(app.window)
    app.start()
    try:
        first = app.runtime.worker
        settings = app.window.settings_panel
        settings.code.setPlainText(CODE)
        qtbot.mouseClick(settings.check_button, Qt.MouseButton.LeftButton)
        qtbot.mouseClick(settings.connect_button, Qt.MouseButton.LeftButton)
        assert app.runtime.store.binding == dict(deviceId=DEVICE, backendUrl="https://backend.example")
        qtbot.waitUntil(lambda: app.runtime.worker is not first, timeout=3000)
        assert not first._thread.is_alive()
        assert app.window.status.text().startswith("Сервер: ще не синхронізувався")
        settings.aw_port.setValue(5666)
        qtbot.mouseClick(settings.aw_save, Qt.MouseButton.LeftButton)
        assert app.runtime.store.app_config["awPort"] == 5666
    finally:
        assert app.quit()


def test_thread_runner_works_off_the_gui_thread_and_reports_back_on_it(qtbot):
    import threading
    from aw_telegram.ui.settings import ThreadRunner
    runner, seen = ThreadRunner(), []
    runner(lambda: threading.get_ident(), lambda result, error: seen.append((result, error, threading.get_ident())))
    runner(lambda: 1 / 0, lambda result, error: seen.append((result, type(error), threading.get_ident())))
    qtbot.waitUntil(lambda: len(seen) == 2, timeout=3000)
    main = threading.get_ident()
    worker = next(s for s in seen if s[1] is None)
    assert worker[0] != main and all(s[2] == main for s in seen)
    assert any(s[1] is ZeroDivisionError for s in seen)


def test_reconnecting_retires_the_old_enrollment_without_deleting_data(qtbot, tmp_path):
    from aw_telegram.main import CompanionApp

    class Coordinator:
        def __init__(self, store, on_update):
            self.store = store

        def step(self, now, mono):
            pass

    path = tmp_path / "companion.sqlite"
    LocalStore(path, identity=DeviceIdentity(DEVICE, "https://backend.example")).close()
    forgotten, answers = [], [False, True]
    app = CompanionApp(path, Coordinator, show=False, runner=sync_runner, probe=lambda host, port: READY,
                       confirm=lambda text: answers.pop(0), forget=forgotten.append)
    qtbot.addWidget(app.window)
    app.start()
    try:
        panel = app.window.settings_panel
        assert not panel.reconnect_button.isHidden()
        qtbot.mouseClick(panel.reconnect_button, Qt.MouseButton.LeftButton)  # declined
        assert app.runtime.store.binding is not None and forgotten == []
        qtbot.mouseClick(panel.reconnect_button, Qt.MouseButton.LeftButton)
        assert app.runtime.store.binding is None and not panel.code.isHidden()
        assert forgotten == [dict(deviceId=DEVICE, backendUrl="https://backend.example")]
        retired = [p.name for p in tmp_path.iterdir() if "retired" in p.name]
        assert any(name.endswith(".sqlite") for name in retired)
        assert app.window.tabs.currentIndex() == 2
    finally:
        assert app.quit()


def test_a_mistyped_secret_is_caught_before_sending():
    with pytest.raises(ValueError, match="Код підключення не розпізнано"):
        parse_bundle(json.dumps({"backendUrl": "https://backend.example", "secret": "short"}))


def test_a_failed_local_bind_does_not_claim_success(qtbot):
    widget, calls = panel(qtbot)
    widget._on_enrolled = lambda identity: (_ for _ in ()).throw(OSError("database is locked"))
    widget.code.setPlainText(CODE)
    qtbot.mouseClick(widget.check_button, Qt.MouseButton.LeftButton)
    qtbot.mouseClick(widget.connect_button, Qt.MouseButton.LeftButton)
    assert "не зміг зберегти підключення" in widget.connection_message.text() and calls["probe"] == []


def test_vault_failure_during_sync_is_transient_not_a_rejection():
    from aw_telegram.models import SyncRequest, minimal_health
    from aw_telegram.transport import Transport

    class Vault:
        def load(self, *args):
            raise OSError("vault")

    request = SyncRequest(schemaVersion=2, sequence=1, acks=[], health=minimal_health("2026-10-28T12:00:00.000Z"))
    with pytest.raises(SyncError) as raised:
        Transport(Vault(), identity=DeviceIdentity(DEVICE, "https://backend.example"), request=lambda *a: 1 / 0).sync(request)
    assert raised.value.retryable and raised.value.reason == "vault" and type(raised.value) is SyncError


def test_settings_shows_the_app_version(qtbot, monkeypatch):
    from aw_telegram import _version
    assert panel(qtbot)[0].version_label.text() == "Версія 0.0.0-dev"
    monkeypatch.setattr(_version, "VERSION", "1.0.7")
    assert panel(qtbot)[0].version_label.text() == "Версія 1.0.7"
