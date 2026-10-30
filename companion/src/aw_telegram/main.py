"""Companion entry point: one tray instance per Windows user running the sync and presentation loop."""
import getpass
import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtWidgets import QApplication, QMessageBox

from . import _version
from .aw_reader import AWReader, LocalAWClient
from .runtime import CompanionRuntime, build_coordinator
from .single_instance import SingleInstance
from .status import read_status, status_lines
from .transport import Transport
from .transport import DeviceIdentity
from .ui.access import AccessClient, AccessPanel
from .ui.i18n import install_translations
from .ui.presenter import utc_now
from .ui.settings import SettingsPanel
from .ui.tray import CompanionTray
from .ui.window import CompanionWindow


def data_directory() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    return (Path(base) if base else Path.home() / "AppData" / "Local") / "AW Telegram"


def instance_name() -> str:
    return "aw-telegram-" + hashlib.sha256(getpass.getuser().encode("utf-8")).hexdigest()[:16]


def production_coordinator(store, on_update):
    """Runs on the IO worker thread with the worker's own store connection."""
    config = store.app_config
    return build_coordinator(store, on_update, aw_host=config["awHost"], aw_port=config["awPort"])


def enroll(bundle, host):
    """Exchange the one-time code; only the host the owner confirmed on screen is accepted."""
    return Transport(accept_host=lambda candidate: candidate == host).enroll(bundle)


def probe(host, port):
    return AWReader(client=LocalAWClient(host=host, port=port)).probe()


def access_client(binding: dict | None):
    return None if binding is None else AccessClient(DeviceIdentity(**binding))


def forget_credential(binding: dict) -> None:
    from .credentials import WindowsVault
    WindowsVault().delete(binding["backendUrl"], binding["deviceId"])


def installed_executable() -> str | None:
    """The packaged .exe; autostart is offered only for an installed build."""
    return sys.executable if getattr(sys, "frozen", False) else None


class CompanionApp(QObject):
    """Window, tray and runtime. Create, start and quit on the GUI thread."""
    finished = Signal()

    def __init__(self, database: Path, coordinator=production_coordinator, *, presenter_factory=None,
                 show: bool = True, background: bool = False, enroll=enroll, probe=probe, runner=None,
                 executable=None, registry=None, access=access_client, confirm=None, forget=forget_credential):
        super().__init__()
        self.database, self._forget = Path(database), forget
        options = {} if presenter_factory is None else {"presenter": presenter_factory}
        self._make_runtime = lambda: CompanionRuntime(self.database, coordinator, **options)
        self.runtime = self._make_runtime()
        self.settings_panel = SettingsPanel(enroll=enroll, probe=probe, on_enrolled=self._enrolled,
                                            on_aw_changed=self._aw_changed, executable=executable,
                                            registry=registry, runner=runner, on_reset=self._reset_enrollment,
                                            confirm=confirm)
        self._access = access
        self.access_panel = AccessPanel(runner=runner)
        self.window = CompanionWindow(settings=self.settings_panel, access=self.access_panel)
        self.window.tabs.currentChanged.connect(self._section_changed)
        self.runtime.synced.connect(self._synced, Qt.ConnectionType.QueuedConnection)
        self.tray = CompanionTray()
        self._show, self._background = show, background
        self.tray.open_requested.connect(self.open)
        self.tray.quit_requested.connect(self.quit)
        self._timer = QTimer(self)
        self._timer.setInterval(1000)
        self._timer.timeout.connect(self._tick)

    def start(self) -> None:
        self.runtime.start()
        self._timer.start()
        self._settings_state()
        self.refresh()
        enrolled = self.runtime.store.binding is not None
        if not enrolled:
            self.window.show_section("settings")  # setup comes first, even when started in the background
        if not self._show:
            return
        self.tray.show()
        if not enrolled or not self._background:
            self.open()

    def _settings_state(self) -> None:
        store = self.runtime.store
        self.settings_panel.set_state(store.binding, store.app_config)
        self.access_panel.bind(store, self._access(store.binding))

    def _synced(self) -> None:
        if self.runtime.store is not None:
            self.access_panel.synced()

    def _section_changed(self, index: int) -> None:
        if self.window.tabs.widget(index) is self.access_panel:
            self.access_panel.refresh()

    def _enrolled(self, identity) -> None:
        self.runtime.store.bind(identity)
        self.runtime.restart_sync()  # the next worker builds its transport from the binding
        self._settings_state()
        self.refresh()

    def _reset_enrollment(self) -> None:
        """Forget this enrollment for a new code: the old database is kept under a dated name, never deleted."""
        binding = self.runtime.store.binding
        stopped = self.runtime.stop()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        moved = stopped
        if stopped:
            try:
                for suffix in ("", "-wal", "-shm"):
                    source = Path(str(self.database) + suffix)
                    if source.exists():
                        source.rename(self.database.with_name(f"{self.database.stem}-retired-{stamp}{self.database.suffix}{suffix}"))
            except OSError:
                moved = False
        if moved and binding is not None:
            try:
                self._forget(binding)  # best effort: the server-side identity is retired by the owner
            except Exception:
                pass
        self.runtime = self._make_runtime()
        self.runtime.synced.connect(self._synced, Qt.ConnectionType.QueuedConnection)
        self.runtime.start()
        self._settings_state()
        self.refresh()
        self.window.show_section("settings")
        if not moved:
            self.settings_panel.connection_message.setText(
                "Не вдалося звільнити файл даних. Закрийте програму через «Вийти» і спробуйте ще раз.")

    def _aw_changed(self, host: str, port: int) -> None:
        self.runtime.store.set_app_config(awHost=host, awPort=port)
        self.runtime.restart_sync()

    def _tick(self) -> None:
        if self.window.isVisible():  # no status reads while only the tray icon is showing
            self.refresh()

    def refresh(self) -> None:
        store, worker = self.runtime.store, self.runtime.worker
        if store is None:
            return
        sync = None if worker is None else worker.status
        if worker is not None and worker.startup_failed:
            sync = dict(health={}, auth_blocked=False, last_error="startup_failed")
        self.window.set_status(status_lines(read_status(store, sync, utc_now())))

    def open(self) -> None:
        self.refresh()
        self.window.show()
        self.window.raise_()
        self.window.activateWindow()

    def quit(self) -> bool:
        """Stop presenting and syncing; True when the IO worker exited in time."""
        self._timer.stop()
        self.tray.hide()
        self.window.hide()
        stopped = self.runtime.stop()
        self.finished.emit()
        return stopped


def self_check() -> dict:
    """What a frozen build must carry: contract schemas, the Kyiv timezone, the Windows vault and Qt. Also names the build."""
    from .clock import endtime_at
    from .credentials import WindowsVault
    from .models import Settings
    report = {}
    def translations():
        if not install_translations(QApplication.instance() or QApplication([])):
            raise FileNotFoundError("qtbase_uk")

    for name, check in (("schemas", lambda: Settings().to_wire()), ("timezone", lambda: endtime_at("2026-10-28", "21:00")),
                        ("vault", WindowsVault), ("qt", lambda: QApplication.instance() or QApplication([])),
                        ("translations", translations)):
        try:
            check()
            report[name] = "ok"
        except Exception as error:
            report[name] = type(error).__name__
    report["version"] = _version.VERSION  # a label, not a check: the release job compares it with the stamped version
    return report


def _uninstall(app: QApplication) -> int:
    from .credentials import WindowsVault
    from .storage import LocalStore
    from .uninstall import uninstall
    title = "AW Telegram"
    guard = SingleInstance(instance_name())
    if not guard.acquire():
        QMessageBox.warning(None, title, "Спершу закрийте AW Telegram: значок у треї → «Вийти».")
        return 1
    store = None
    try:
        yes = QMessageBox.StandardButton.Yes
        if QMessageBox.question(None, title, "Вимкнути AW Telegram на цьому ноутбуці? Автозапуск буде вимкнено, "
                                "а облікові дані ноутбука видалено з Windows.") != yes:
            return 0
        revoke = QMessageBox.question(None, title, "Також видалити доступ усіх батьків? Потрібен зв’язок із сервером.") == yes
        directory = data_directory()
        database = directory / "companion.sqlite"
        store = LocalStore(database) if database.exists() else None
        try:
            vault = WindowsVault()
        except Exception:
            vault = None  # reported as not deleted
        report = uninstall(store, registry=None, vault=vault, access=access_client(store.binding if store else None),
                           revoke_parents=revoke, data=directory)
        QMessageBox.information(None, title, "\n\n".join(report))
        return 0
    finally:
        if store is not None:
            store.close()
        guard.release()


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv if argv is None else argv
    app = QApplication(argv)
    app.setApplicationName("AW Telegram")
    app.setQuitOnLastWindowClosed(False)
    install_translations(app)  # Qt's own buttons and menus in Ukrainian (LANG-01)
    if "--self-check" in argv:  # packaging check: writes a JSON report to the given path
        if argv.index("--self-check") + 1 >= len(argv):
            return 2
        report = self_check()
        Path(argv[argv.index("--self-check") + 1]).write_text(json.dumps(report), encoding="utf-8")
        return 0 if {v for k, v in report.items() if k != "version"} == {"ok"} else 1
    if "--uninstall" in argv:
        return _uninstall(app)
    guard = SingleInstance(instance_name())
    if not guard.acquire():
        return 0  # the running instance opens its window
    directory = data_directory()
    directory.mkdir(parents=True, exist_ok=True)
    companion = CompanionApp(directory / "companion.sqlite", background="--background" in argv,
                             executable=installed_executable())
    guard.activated.connect(companion.open)
    companion.finished.connect(app.quit)
    try:
        companion.start()
    except Exception:
        # e.g. an unreadable or newer local database: a Ukrainian message instead of a frozen-app traceback
        QMessageBox.critical(None, "AW Telegram", "Не вдалося запустити AW Telegram: не відкриваються локальні дані "
                             f"в {directory}. Перезапустіть комп’ютер; якщо не допоможе, зверніться до власника.")
        guard.release()
        return 1
    try:
        return app.exec()
    finally:
        if companion.runtime.presenter is not None:
            companion.quit()
        guard.release()


if __name__ == "__main__":
    raise SystemExit(main())
