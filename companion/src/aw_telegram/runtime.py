"""Companion main loop: the IO worker and the GUI-thread presenter, each on its own LocalStore connection.

The worker syncs, polls ActivityWatch and commits summaries; the GUI thread runs the scheduler and
presenter once a second and again right after each committed sync. The two share state only through
SQLite (WAL), never objects, so presentation keeps working offline. Importing this module starts nothing.
"""
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QObject, Qt, Signal

from .aw_reader import AWReader, LocalAWClient
from .scheduler import Scheduler
from .storage import LocalStore, utc_now
from .sync import IOWorker, ReaderAdapter, SyncCoordinator
from .transport import DeviceIdentity, Transport
from .ui.presenter import PolicyPresenter


def build_coordinator(store: LocalStore, on_update, *, aw_port: int, aw_host: str = "127.0.0.1",
                      vault=None, request=None) -> SyncCoordinator:
    """Production IO wiring for a store opened on the worker thread. The ActivityWatch port is
    explicit; an unenrolled store syncs with no identity and stops at CredentialError."""
    binding = store.binding
    transport = Transport(vault, request=request, identity=None if binding is None else DeviceIdentity(**binding))
    adapter = ReaderAdapter(AWReader(client=LocalAWClient(host=aw_host, port=aw_port)))
    return SyncCoordinator(store, transport, adapter.observe, adapter.summarize, on_update=on_update)


class CompanionRuntime(QObject):
    """Create, start and stop on the GUI thread.

    coordinator(store, on_update) builds the worker side around a store the worker opened itself;
    presenter(scheduler) builds the GUI side (default: the real overlay, card and countdown windows).
    """
    synced = Signal()

    def __init__(self, database: Path, coordinator: Callable, *, presenter: Callable = PolicyPresenter,
                 open_store: Callable = LocalStore, clock: Callable[[], str] = utc_now):
        super().__init__()
        self.database = Path(database)
        self._coordinator, self._presenter, self._open, self._clock = coordinator, presenter, open_store, clock
        self.store = self.presenter = self.worker = None

    def start(self) -> None:
        if self.worker is not None:
            raise RuntimeError("runtime has already started")
        self.store = self._open(self.database)
        self.presenter = self._presenter(Scheduler(self.store))
        # Emitted on the worker thread after a committed sync; the tick runs on the GUI thread.
        self.synced.connect(self.presenter.tick, Qt.ConnectionType.QueuedConnection)
        self.presenter.start()
        self.worker = IOWorker(lambda: self._coordinator(self._open(self.database), lambda *_: self.synced.emit()),
                               utc_clock=self._clock)
        self.worker.start()

    def stop(self, timeout: float = 15) -> bool:
        """Stop presenting, then join the worker; True when the worker has exited. Safe to repeat."""
        if self.presenter is not None:
            self.presenter.stop()
            self.synced.disconnect(self.presenter.tick)
            self.presenter = None
        stopped = True if self.worker is None else self.worker.stop(timeout)
        if self.store is not None:
            self.store.close()
            self.store = None
        return stopped
