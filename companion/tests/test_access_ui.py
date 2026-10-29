"""Task 9c: «Доступ батьків» — named pairing keys, the access list and revocation that survives being offline."""
import json
from datetime import datetime, timedelta

import pytest
from PySide6.QtCore import Qt
from PySide6.QtGui import QGuiApplication

from aw_telegram.clock import UTC, format_instant
from aw_telegram.storage import LocalStore
from aw_telegram.transport import DeviceIdentity, EnrollmentError, SyncError, Transport
from aw_telegram.ui.access import AccessPanel, entry_status

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)  # 14:00 Kyiv
DEVICE = "00000000-0000-4000-8000-000000000001"
IDENTITY = DeviceIdentity(DEVICE, "https://backend.example")
KEY_SECRET = "K" * 22


def uuid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def parent(n, name=None):
    return dict(id=f"parent:{100 + n}:{uuid(n)}", name=name or f"Батько {n}", userId=str(100 + n), status="active")


def key(n, status="pending", name=None):
    return dict(id=f"key:{uuid(50 + n)}", name=name or f"Ключ {n}", status=status,
                expiresAt=format_instant(NOW + timedelta(minutes=15)))


def sync_runner(fn, done):
    try:
        done(fn(), None)
    except Exception as error:
        done(None, error)


class Client:
    """The access API as the panel sees it."""
    def __init__(self, parents=(), keys=()):
        self.parents, self.keys = list(parents), list(keys)
        self.offline = False
        self.calls = []

    def _online(self):
        if self.offline:
            raise SyncError(retryable=True)

    def list_all(self):
        self._online()
        return dict(parents=list(self.parents), keys=list(self.keys))

    def create(self, name):
        self._online()
        self.calls.append(("create", name))
        return dict(id=f"key:{uuid(99)}", name=name, secret=KEY_SECRET, expiresAt=format_instant(NOW + timedelta(minutes=15)))

    def revoke(self, access_id):
        self._online()
        self.calls.append(("revoke", access_id))
        self.parents = [p for p in self.parents if p["id"] != access_id]
        self.keys = [k for k in self.keys if k["id"] != access_id]


@pytest.fixture
def store(tmp_path):
    s = LocalStore(tmp_path / "c.sqlite", identity=IDENTITY)
    yield s
    s.close()


def panel(qtbot, store, client, confirm=True):
    asked = []
    widget = AccessPanel(runner=sync_runner, confirm=lambda text: asked.append(text) or confirm, now=lambda: NOW)
    widget.bind(store, client)
    qtbot.addWidget(widget)
    widget.asked = asked
    return widget


def rows(widget):
    return [(widget.table.item(r, 0).text(), widget.table.item(r, 1).text(), widget.table.cellWidget(r, 2) is not None)
            for r in range(widget.table.rowCount())]


# Transport: ten caregivers

def test_access_listing_accepts_ten_caregivers_but_not_eleven():
    def reply(count):
        body = json.dumps(dict(schemaVersion=1, parents=[parent(n) for n in range(count)], keys=[], nextPage=None))
        return lambda *args: (200, body.encode())

    class Vault:
        def load(self, *args): return "A" * 43

    assert len(Transport(Vault(), request=reply(10)).list_access(IDENTITY)["parents"]) == 10
    with pytest.raises(EnrollmentError):
        Transport(Vault(), request=reply(11)).list_access(IDENTITY)


# Store: pending revocations

def test_pending_revocations_persist_validate_and_clear(tmp_path):
    path = tmp_path / "c.sqlite"
    s = LocalStore(path, identity=IDENTITY, now=lambda: format_instant(NOW))
    s.request_revocation(parent(1)["id"], "Мама")
    s.request_revocation(parent(1)["id"], "Мама")
    with pytest.raises(ValueError):
        s.request_revocation("parent:abc", "x")
    s.close()
    s = LocalStore(path, now=lambda: format_instant(NOW))
    try:
        assert s.pending_revocations() == [dict(id=parent(1)["id"], name="Мама", requestedAt=format_instant(NOW))]
        s.revocation_done(parent(1)["id"])
        assert s.pending_revocations() == []
    finally:
        s.close()


# Sync worker retries revocations

def test_the_sync_worker_sends_pending_revocations_once_online(store):
    from aw_telegram.sync import SyncCoordinator
    from aw_telegram import models
    store.request_revocation(parent(1)["id"], "Мама")
    calls, updates = [], []

    class Network:
        identity = IDENTITY
        fail = True

        def sync(self, request):
            if self.fail:
                raise SyncError(retryable=True)
            return models.SyncResponse.from_wire(dict(schemaVersion=2, requestSequence=request.sequence,
                serverNow="2026-10-28T12:00:00.000Z", collectionStartedAt=None, settings=models.Settings().to_wire(),
                cancellations=dict(revision=0, throughActionSequence=0, canceledIds=[]), deliveryOffers=[],
                acknowledgedAckIds=[a["id"] for a in request.acks], summaryReceipts=[]))

        def revoke_access(self, identity, access_id):
            calls.append((identity, access_id))

    network = Network()
    coordinator = SyncCoordinator(store, network, None, None, jitter=lambda: 1.0,
                                  on_update=lambda *args: updates.append(args))
    coordinator.step("2026-10-28T12:00:00.000Z", 0)
    assert calls == [] and store.pending_revocations()  # offline: kept for later
    network.fail = False
    coordinator.step("2026-10-28T12:00:00.000Z", 1000)
    assert calls == [(IDENTITY, parent(1)["id"])] and store.pending_revocations() == [] and updates


# Panel

def test_unenrolled_laptop_explains_where_to_start(qtbot, store):
    widget = AccessPanel(runner=sync_runner, confirm=lambda text: True, now=lambda: NOW)
    qtbot.addWidget(widget)
    widget.bind(store, None)
    assert widget.message.text() == "Спочатку підключіть ноутбук у «Налаштування»."
    assert not widget.create_button.isEnabled()


def test_a_new_key_shows_the_pair_command_once_and_is_never_stored(qtbot, store):
    client = Client()
    widget = panel(qtbot, store, client)
    widget.name.setText("  Мама  ")
    qtbot.mouseClick(widget.create_button, Qt.MouseButton.LeftButton)
    assert client.calls == [("create", "Мама")]
    assert widget.key_command.text() == f"/pair {KEY_SECRET}"
    assert widget.key_note.text() == ("Надішліть цю команду боту в особистому чаті Telegram. "
                                      "Ключ діє до 14:15 і підключає один обліковий запис.")
    qtbot.mouseClick(widget.copy_button, Qt.MouseButton.LeftButton)
    assert QGuiApplication.clipboard().text() == f"/pair {KEY_SECRET}"
    assert KEY_SECRET not in json.dumps(store._state(), ensure_ascii=False)
    qtbot.mouseClick(widget.done_button, Qt.MouseButton.LeftButton)
    assert widget.key_command.text() == "" and widget.key_box.isHidden() and widget.name.text() == ""


def test_the_shown_key_disappears_when_it_expires(qtbot, store):
    clock = {"now": NOW}
    widget = AccessPanel(runner=sync_runner, confirm=lambda text: True, now=lambda: clock["now"])
    qtbot.addWidget(widget)
    widget.bind(store, Client())
    widget.name.setText("Тато")
    qtbot.mouseClick(widget.create_button, Qt.MouseButton.LeftButton)
    clock["now"] = NOW + timedelta(minutes=15)
    widget.expire_key()
    assert widget.key_command.text() == "" and widget.key_box.isHidden()


@pytest.mark.parametrize("name", ["", "   ", "x" * 81])
def test_invalid_names_are_explained(qtbot, store, name):
    client = Client()
    widget = panel(qtbot, store, client)
    widget.name.setText(name)
    qtbot.mouseClick(widget.create_button, Qt.MouseButton.LeftButton)
    assert client.calls == [] and widget.message.text() == "Введіть ім’я до 80 символів, наприклад «Мама»."


def test_list_shows_ten_caregivers_and_key_states(qtbot, store):
    client = Client([parent(n) for n in range(10)], [key(1), key(2, "expired"), key(3, "revoked")])
    widget = panel(qtbot, store, client)
    shown = rows(widget)
    assert len(shown) == 13
    assert shown[0] == ("Батько 0", "підключено, Telegram ID 100", True)
    assert shown[10:] == [("Ключ 1", "ключ чекає на підключення до 14:15", True),
                          ("Ключ 2", "ключ прострочено", True), ("Ключ 3", "ключ скасовано", False)]


def test_removing_access_asks_first_and_reports_only_what_the_server_confirmed(qtbot, store):
    client = Client([parent(1, "Мама"), parent(2, "Тато")])
    widget = panel(qtbot, store, client)
    widget.remove(parent(1)["id"])
    assert widget.asked == ["Видалити доступ «Мама»? Цей обліковий запис Telegram більше не зможе керувати ноутбуком."]
    assert client.calls == [("revoke", parent(1)["id"])] and store.pending_revocations() == []
    assert [r[0] for r in rows(widget)] == ["Тато"] and widget.message.text() == "Доступ «Мама» видалено."


def test_removing_while_offline_waits_for_the_server(qtbot, store):
    client = Client([parent(1, "Мама")])
    widget = panel(qtbot, store, client)
    client.offline = True
    widget.remove(parent(1)["id"])
    assert store.pending_revocations()[0]["id"] == parent(1)["id"]
    assert widget.message.text() == "Видалення збережено. Його буде надіслано, щойно з’явиться зв’язок із сервером."
    assert rows(widget) == [("Мама", "видалення чекає на підтвердження сервера", False)]
    widget.refresh()  # still offline: the list is unavailable but the pending removal stays visible
    assert widget.message.text() == "Список недоступний: немає зв’язку з сервером."
    assert rows(widget) == [("Мама", "видалення чекає на підтвердження сервера", False)]


def test_declining_the_confirmation_changes_nothing(qtbot, store):
    client = Client([parent(1, "Мама")])
    widget = panel(qtbot, store, client, confirm=False)
    widget.remove(parent(1)["id"])
    assert client.calls == [] and store.pending_revocations() == []


def test_entry_status_text():
    assert entry_status(key(1, "pending"), NOW, pending=True) == "видалення чекає на підтвердження сервера"
    assert entry_status(dict(key(1), expiresAt=format_instant(NOW - timedelta(seconds=1))), NOW) == "ключ прострочено"


# Application wiring

def test_the_app_binds_access_to_the_enrolled_identity(qtbot, tmp_path):
    from aw_telegram.main import CompanionApp, access_client

    class Coordinator:
        def __init__(self, store, on_update):
            self.store = store

        def step(self, now, mono):
            pass

    path = tmp_path / "companion.sqlite"
    LocalStore(path, identity=IDENTITY).close()
    app = CompanionApp(path, Coordinator, show=False, runner=sync_runner,
                       access=lambda binding: Client([parent(1, "Мама")]) if binding else None)
    qtbot.addWidget(app.window)
    app.start()
    try:
        app.window.show_section("access")
        assert [r[0] for r in rows(app.access_panel)] == ["Мама"]
    finally:
        assert app.quit()
    assert access_client(None) is None
    assert access_client(dict(deviceId=DEVICE, backendUrl="https://backend.example")).identity == IDENTITY


def test_a_removal_the_sync_worker_sent_updates_the_open_list(qtbot, store):
    client = Client([parent(1, "Мама"), parent(2, "Тато")])
    widget = panel(qtbot, store, client)
    client.offline = True
    widget.remove(parent(1)["id"])
    client.offline = False
    client.revoke(parent(1)["id"])  # the worker sent it after the next successful sync
    store.revocation_done(parent(1)["id"])
    widget.synced()
    assert rows(widget) == [("Тато", "підключено, Telegram ID 102", True)]
