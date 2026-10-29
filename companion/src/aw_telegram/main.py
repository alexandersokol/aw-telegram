"""Companion entry point: one tray instance per Windows user running the sync and presentation loop."""
import getpass
import hashlib
import os
import sys
from pathlib import Path

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtWidgets import QApplication

from .runtime import CompanionRuntime, build_coordinator
from .single_instance import SingleInstance
from .status import read_status, status_lines
from .ui.presenter import utc_now
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


class CompanionApp(QObject):
    """Window, tray and runtime. Create, start and quit on the GUI thread."""
    finished = Signal()

    def __init__(self, database: Path, coordinator=production_coordinator, *, presenter_factory=None,
                 show: bool = True, background: bool = False):
        super().__init__()
        options = {} if presenter_factory is None else {"presenter": presenter_factory}
        self.runtime = CompanionRuntime(database, coordinator, **options)
        self.window = CompanionWindow()
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
        self.refresh()
        enrolled = self.runtime.store.binding is not None
        if not enrolled:
            self.window.show_section("settings")  # setup comes first, even when started in the background
        if not self._show:
            return
        self.tray.show()
        if not enrolled or not self._background:
            self.open()

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
    companion = CompanionApp(directory / "companion.sqlite", background="--background" in argv)
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
