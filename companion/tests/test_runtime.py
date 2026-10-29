"""Companion main loop: IO worker and GUI presenter on separate store connections."""
import sqlite3
import threading
from types import SimpleNamespace

import pytest

from aw_telegram.models import ActionAck
from aw_telegram.runtime import CompanionRuntime, build_coordinator
from aw_telegram.storage import LocalStore
from aw_telegram.sync import IOWorker
from aw_telegram.transport import DeviceIdentity
from aw_telegram.ui.countdown import CountdownWindow
from aw_telegram.ui.notification import NotificationCard
from aw_telegram.ui.overlay import OverlayWindow
from aw_telegram.ui.presenter import PolicyPresenter
from aw_telegram.windows.foreground import PresentationResult

from action_fixture import action

DEVICE = "00000000-0000-4000-8000-000000000001"


class AcceptingDesktop:
    def reveal_overlay(self, hwnd):
        return PresentationResult("unconfirmed", "topmost_requested")


class RecordingPresenter(PolicyPresenter):
    def tick(self):
        self.ticks.append(threading.get_ident())
        super().tick()


def test_a_sync_on_the_worker_reaches_the_screen_at_once_through_sqlite(qtbot, tmp_path):
    coordinators = []

    class Coordinator:
        """Delivers one offer from the worker thread, as an applied sync would."""
        def __init__(self, store, on_update):
            self.store, self.on_update, self.thread, self.sent = store, on_update, threading.get_ident(), False
            coordinators.append(self)

        def step(self, now, mono):
            if not self.sent:
                self.sent = True
                self.store.receive_offers([action(1, created=now, message="Перерва")])
                self.on_update(self.store.settings, self.store.cancellations)

    def presenter(scheduler):
        overlay, card, countdown = OverlayWindow(foreground_adapter=AcceptingDesktop()), NotificationCard(), CountdownWindow()
        for widget in (overlay, card, countdown):
            qtbot.addWidget(widget)
        # A minute-long timer: only the queued post-sync tick can show the offer within the wait.
        result = RecordingPresenter(scheduler, overlay, card, countdown, interval_ms=60_000)
        result.ticks = []
        return result

    runtime = CompanionRuntime(tmp_path / "companion.sqlite", Coordinator, presenter=presenter)
    runtime.start()
    gui = runtime.store
    try:
        qtbot.waitUntil(lambda: runtime.presenter.overlay.isVisible(), timeout=3000)
        assert runtime.presenter.overlay._text == "Перерва"
        main = threading.get_ident()
        assert coordinators[0].thread != main and set(runtime.presenter.ticks) == {main}
        assert [a.status for a in runtime.store.pending_acks() if isinstance(a, ActionAck)] == ["accepted", "presented"]
    finally:
        assert runtime.stop()
    with pytest.raises(sqlite3.ProgrammingError):
        coordinators[0].store.settings  # the worker closed its own connection
    with pytest.raises(sqlite3.ProgrammingError):
        gui.settings


def test_runtime_starts_once_and_stop_is_idempotent(qtbot, tmp_path):
    class Idle:
        def __init__(self, store, on_update):
            self.store = store

        def step(self, now, mono):
            pass

    def presenter(scheduler):
        widgets = OverlayWindow(foreground_adapter=AcceptingDesktop()), NotificationCard(), CountdownWindow()
        for widget in widgets:
            qtbot.addWidget(widget)
        return PolicyPresenter(scheduler, *widgets)

    runtime = CompanionRuntime(tmp_path / "companion.sqlite", Idle, presenter=presenter)
    runtime.start()
    with pytest.raises(RuntimeError):
        runtime.start()
    assert runtime.stop() and runtime.stop()


def test_io_worker_survives_an_unexpected_step_failure():
    calls = []

    class Flaky:
        store = SimpleNamespace(close=lambda: calls.append("closed"))

        def step(self, now, mono):
            calls.append("step")
            if calls.count("step") == 1:
                raise sqlite3.OperationalError("database is locked")

    worker = IOWorker(Flaky, utc_clock=lambda: "2026-10-28T12:00:00.000Z", retry_delay=0.01)
    worker.start()
    deadline = threading.Event()
    for _ in range(200):
        if calls.count("step") >= 3:
            break
        deadline.wait(0.01)
    assert worker.stop()
    assert calls.count("step") >= 3 and worker.failures == 1 and calls[-1] == "closed"


def test_io_worker_reports_a_store_that_cannot_open():
    def broken():
        raise sqlite3.OperationalError("unable to open database file")

    worker = IOWorker(broken, utc_clock=lambda: "2026-10-28T12:00:00.000Z")
    worker.start()
    assert worker.stop() and worker.startup_failed


class Vault:
    def load(self, backend_url, device_id):
        return "A" * 43

    def store(self, *args):
        raise AssertionError("the runtime never writes credentials")


def test_production_wiring_uses_the_bound_identity_and_explicit_loopback(tmp_path):
    identity = DeviceIdentity(DEVICE, "https://backend.example")
    store = LocalStore(tmp_path / "bound.sqlite", identity=identity)
    try:
        assert store.binding == dict(deviceId=DEVICE, backendUrl="https://backend.example")
        coordinator = build_coordinator(store, lambda *_: None, aw_port=5666, vault=Vault())
        assert coordinator.transport.identity == identity
        client = coordinator.observe.__self__.reader.client
        assert (client.host, client.port) == ("127.0.0.1", 5666)
    finally:
        store.close()
    unbound = LocalStore(tmp_path / "unbound.sqlite")
    try:
        assert build_coordinator(unbound, None, aw_port=5600, vault=Vault()).transport.identity is None
        with pytest.raises(TypeError):
            build_coordinator(unbound, None, vault=Vault())  # no implicit ActivityWatch port
    finally:
        unbound.close()
