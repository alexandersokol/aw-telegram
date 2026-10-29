"""Companion entry point: one tray instance per Windows user running the sync and presentation loop."""
import getpass
import hashlib
import os
import sys
from pathlib import Path

from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtWidgets import QApplication

from .aw_reader import AWReader, LocalAWClient
from .runtime import CompanionRuntime, build_coordinator
from .single_instance import SingleInstance
from .status import read_status, status_lines
from .transport import Transport
from .transport import DeviceIdentity
from .ui.access import AccessClient, AccessPanel
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


def installed_executable() -> str | None:
    """The packaged .exe; autostart is offered only for an installed build."""
    return sys.executable if getattr(sys, "frozen", False) else None


class CompanionApp(QObject):
    """Window, tray and runtime. Create, start and quit on the GUI thread."""
    finished = Signal()

    def __init__(self, database: Path, coordinator=production_coordinator, *, presenter_factory=None,
                 show: bool = True, background: bool = False, enroll=enroll, probe=probe, runner=None,
                 executable=None, registry=None, access=access_client):
        super().__init__()
        options = {} if presenter_factory is None else {"presenter": presenter_factory}
        self.runtime = CompanionRuntime(database, coordinator, **options)
        self.settings_panel = SettingsPanel(enroll=enroll, probe=probe, on_enrolled=self._enrolled,
                                            on_aw_changed=self._aw_changed, executable=executable,
                                            registry=registry, runner=runner)
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
        self._timer.timeout.connect(self.refresh)

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
        self.runtime.restart_sync()  # the worker builds its transport from the binding
        self._settings_state()
        self.refresh()

    def _aw_changed(self, host: str, port: int) -> None:
        self.runtime.store.set_app_config(awHost=host, awPort=port)
        self.runtime.restart_sync()

    def refresh(self) -> None:
        store, worker = self.runtime.store, self.runtime.worker
        if store is None:
            return
        self.window.set_status(status_lines(read_status(store, None if worker is None else worker.status, utc_now())))

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


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv if argv is None else argv
    app = QApplication(argv)
    app.setApplicationName("AW Telegram")
    app.setQuitOnLastWindowClosed(False)
    guard = SingleInstance(instance_name())
    if not guard.acquire():
        return 0  # the running instance opens its window
    directory = data_directory()
    directory.mkdir(parents=True, exist_ok=True)
    companion = CompanionApp(directory / "companion.sqlite", background="--background" in argv,
                             executable=installed_executable())
    guard.activated.connect(companion.open)
    companion.finished.connect(app.quit)
    companion.start()
    try:
        return app.exec()
    finally:
        if companion.runtime.presenter is not None:
            companion.quit()
        guard.release()


if __name__ == "__main__":
    raise SystemExit(main())
