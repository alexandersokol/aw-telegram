"""«Доступ батьків»: named one-time pairing keys, the access list, and removal.

A new key is shown once as the `/pair` command and never stored; it leaves the screen at «Готово» or at
its expiry. A removal is recorded locally first and shown as waiting until the server confirms it; the
sync worker keeps retrying it while offline (PAIR-03). Network work runs off the GUI thread.
"""
from datetime import datetime

from datetime import timedelta

from PySide6.QtCore import QMimeData, Qt, QTimer
from PySide6.QtGui import QFont, QGuiApplication
from PySide6.QtWidgets import (QAbstractItemView, QGroupBox, QHBoxLayout, QHeaderView, QLabel, QLineEdit,
                               QMessageBox, QPushButton, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget)

from ..clock import KYIV, parse_instant
from ..texts import t
from ..transport import SyncError, Transport
from .i18n import Messages
from .presenter import utc_now
from .settings import ThreadRunner

MAX_CAREGIVERS = 10
KEY_LIFETIME = timedelta(minutes=15)  # PAIR-06; also bounds a laptop clock that runs behind the server
_NO_HISTORY = b"\x00\x00\x00\x00"  # DWORD 0


def copy_secret(text: str) -> None:
    """Copy without Windows clipboard history or cloud clipboard sync."""
    data = QMimeData()
    data.setText(text)
    data.setData('application/x-qt-windows-mime;value="ExcludeClipboardContentFromMonitorProcessing"', _NO_HISTORY)
    data.setData('application/x-qt-windows-mime;value="CanIncludeInClipboardHistory"', _NO_HISTORY)
    data.setData('application/x-qt-windows-mime;value="CanUploadToCloudClipboard"', _NO_HISTORY)
    QGuiApplication.clipboard().setMimeData(data)


class AccessClient:
    """The device's access endpoints; a fresh Transport per call loads the bearer from the vault."""

    def __init__(self, identity):
        self.identity = identity

    def list_all(self) -> dict:
        parents, keys, page = {}, [], None
        for _ in range(20):  # at most 50 keys per page
            result = Transport(identity=self.identity).list_access(self.identity, page)
            parents.update((p["id"], p) for p in result["parents"])
            keys += result["keys"]
            page = result["nextPage"]
            if page is None:
                break
        return dict(parents=list(parents.values()), keys=keys)

    def create(self, name: str) -> dict:
        return Transport(identity=self.identity).create_pair_key(self.identity, name)

    def revoke(self, access_id: str) -> None:
        Transport(identity=self.identity).revoke_access(self.identity, access_id)


def _local_time(instant: str) -> str:
    return parse_instant(instant).astimezone(KYIV).strftime("%H:%M")


def entry_status(entry: dict, now: datetime, pending: bool = False) -> str:
    if pending:
        return t("access.waiting")
    if entry["id"].startswith("parent:"):
        return t("access.parent", user_id=entry["userId"])
    if entry["status"] == "revoked":
        return t("access.key_revoked")
    if entry["status"] == "expired" or parse_instant(entry["expiresAt"]) <= now:
        return t("access.key_expired")
    return t("access.key_pending", time=_local_time(entry["expiresAt"]))


class AccessPanel(QWidget):
    def __init__(self, *, runner=None, confirm=None, now=utc_now):
        super().__init__()
        self._run = runner or ThreadRunner()
        self._confirm = confirm or self._ask
        self._messages = Messages()
        self._now = now
        self._store = self._client = None
        self._entries: list[dict] = []
        self._key_expires = None
        self._waiting: set[str] = set()
        self._generation = 0  # only the latest listing request may update the table
        layout = QVBoxLayout(self)

        self.message = QLabel()
        self.message.setWordWrap(True)
        self.message.setTextFormat(Qt.TextFormat.PlainText)
        layout.addWidget(self.message)

        create = QHBoxLayout()
        self.name = QLineEdit()
        self.create_button = QPushButton()
        self.create_button.clicked.connect(self.create_key)
        create.addWidget(self.name, 1)
        create.addWidget(self.create_button)
        layout.addLayout(create)

        self.key_box = QGroupBox()
        box = QVBoxLayout(self.key_box)
        self.key_command = QLabel()
        self.key_command.setTextFormat(Qt.TextFormat.PlainText)
        self.key_command.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.key_command.setFont(QFont("Consolas", 12))
        self.key_note = QLabel()
        self.key_note.setWordWrap(True)
        buttons = QHBoxLayout()
        self.copy_button = QPushButton()
        self.copy_button.clicked.connect(lambda: copy_secret(self.key_command.text()))
        self.done_button = QPushButton()
        self.done_button.clicked.connect(self._clear_key)
        buttons.addWidget(self.copy_button)
        buttons.addWidget(self.done_button)
        buttons.addStretch()
        box.addWidget(self.key_command)
        box.addWidget(self.key_note)
        box.addLayout(buttons)
        self.key_box.setVisible(False)
        layout.addWidget(self.key_box)

        self.capacity = QLabel()
        self.capacity.setWordWrap(True)
        layout.addWidget(self.capacity)
        self.table = QTableWidget(0, 3)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        layout.addWidget(self.table, 1)
        self.refresh_button = QPushButton()
        self.refresh_button.clicked.connect(self.refresh)
        layout.addWidget(self.refresh_button, 0, Qt.AlignmentFlag.AlignRight)
        self.retranslate()

    def retranslate(self) -> None:
        """Static texts, the table and every remembered message, in the current language."""
        self.name.setPlaceholderText(t("access.name_hint"))
        self.create_button.setText(t("access.create"))
        self.key_box.setTitle(t("access.new_key"))
        self.copy_button.setText(t("access.copy"))
        self.done_button.setText(t("access.done"))
        self.table.setHorizontalHeaderLabels([t("access.header_name"), t("access.header_state"), ""])
        self.refresh_button.setText(t("access.refresh"))
        self._messages.retranslate()
        self._render()

    def _ask(self, text: str) -> bool:
        return QMessageBox.question(self, "AW Telegram", text) == QMessageBox.StandardButton.Yes

    def bind(self, store, client) -> None:
        """client is None until the laptop is enrolled."""
        self._store, self._client, self._entries = store, client, []
        enabled = client is not None
        for widget in (self.name, self.create_button, self.refresh_button):
            widget.setEnabled(enabled)
        if enabled:
            self._messages.clear(self.message)
        else:
            self._messages.say(self.message, lambda: t("access.connect_first"))
        self._render()
        if enabled:
            self.refresh()

    # Listing
    def refresh(self) -> None:
        if self._client is None:
            return
        self._generation += 1
        generation, client = self._generation, self._client
        self._run(client.list_all, lambda result, error: self._listed(result, error, generation, client))

    def _listed(self, result, error, generation=None, client=None) -> None:
        if generation is not None and (generation != self._generation or client is not self._client):
            return  # a newer refresh or a rebind superseded this answer
        if error is not None:
            self._messages.say(self.message, lambda: t("access.list_failed"))
        else:
            self._entries = result["parents"] + result["keys"]
        self._render()

    def synced(self) -> None:
        """After each committed sync: the worker may have sent a removal that was waiting."""
        if self._store is not None and {i["id"] for i in self._store.pending_revocations()} != self._waiting:
            self.refresh()

    def _render(self) -> None:
        pending = {item["id"]: item for item in (self._store.pending_revocations() if self._store else [])}
        self._waiting = set(pending)
        now = self._now()
        rows = [(e, e["id"] in pending) for e in self._entries if e.get("status") != "revoked"]  # revoked keys are history
        known = {e["id"] for e in self._entries}
        rows += [(dict(id=i, name=item["name"]), True) for i, item in pending.items() if i not in known]
        self.table.setRowCount(len(rows))
        for row, (entry, waiting) in enumerate(rows):
            self.table.setItem(row, 0, QTableWidgetItem(entry["name"]))
            self.table.setItem(row, 1, QTableWidgetItem(entry_status(entry, now, waiting)))
            self.table.removeCellWidget(row, 2)
            if not waiting and entry.get("status") != "revoked":
                button = QPushButton(t("access.remove"))
                button.clicked.connect(lambda _=False, access_id=entry["id"]: self.remove(access_id))
                self.table.setCellWidget(row, 2, button)
        active = sum(1 for e, waiting in rows if e["id"].startswith("parent:") and not waiting)
        full = active >= MAX_CAREGIVERS
        self.capacity.setText(t("access.full", max=MAX_CAREGIVERS) if full else "")
        self.create_button.setEnabled(self._client is not None and not full)  # a new key could not pair

    # Keys
    def create_key(self) -> None:
        name = self.name.text().strip()
        if not name or len(name) > 80:
            self._messages.say(self.message, lambda: t("access.name_invalid"))
            return
        self.create_button.setEnabled(False)
        self._run(lambda: self._client.create(name), self._created)

    def _created(self, result, error) -> None:
        self.create_button.setEnabled(True)
        if error is not None:
            offline = isinstance(error, SyncError) and error.retryable
            self._messages.say(self.message, lambda: t("access.create_offline" if offline else "access.create_failed"))
            return
        self.name.clear()
        self._messages.clear(self.message)
        self.key_command.setText(f"/pair {result['secret']}")
        # A laptop clock ahead of the server must not hide the key at once, nor one behind keep it too long.
        now = self._now()
        self._key_expires = min(parse_instant(result["expiresAt"]), now + KEY_LIFETIME)
        if self._key_expires <= now:
            self._key_expires = now + KEY_LIFETIME
        local = self._key_expires.astimezone(KYIV).strftime("%H:%M")
        self._messages.say(self.key_note, lambda: t("access.key_note", time=local))
        self.key_box.setVisible(True)
        remaining = int((self._key_expires - now).total_seconds() * 1000)
        QTimer.singleShot(min(max(0, remaining), int(KEY_LIFETIME.total_seconds() * 1000)) + 500, self.expire_key)
        self.refresh()

    def expire_key(self) -> None:
        if self._key_expires is not None and self._now() >= self._key_expires:
            self._clear_key()

    def _clear_key(self) -> None:
        clipboard = QGuiApplication.clipboard()
        if self.key_command.text() and clipboard.text() == self.key_command.text():
            clipboard.clear()
        self.key_command.setText("")
        self._messages.clear(self.key_note)
        self.key_box.setVisible(False)
        self._key_expires = None

    # Removal
    def remove(self, access_id: str) -> None:
        entry = next((e for e in self._entries if e["id"] == access_id), None)
        if entry is None:
            return
        name, is_key = entry["name"], access_id.startswith("key:")
        question = t("access.remove_key_confirm" if is_key else "access.remove_parent_confirm", name=name)
        if not self._confirm(question):
            return
        self._store.request_revocation(access_id, name)  # durable before anything is claimed
        self._render()
        self._run(lambda: self._client.revoke(access_id), lambda _, error: self._removed(access_id, name, is_key, error))

    def _removed(self, access_id, name, is_key, error) -> None:
        if error is not None:
            self._messages.say(self.message, lambda: t("access.remove_saved"))
            self._render()
            return
        self._store.revocation_done(access_id)
        # A key redeemed meanwhile is a paired parent now; the refreshed list shows it.
        self._messages.say(self.message, lambda: t("access.key_removed" if is_key else "access.parent_removed", name=name))
        self.refresh()
