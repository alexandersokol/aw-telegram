"""«Доступ батьків»: named one-time pairing keys, the access list, and removal.

A new key is shown once as the `/pair` command and never stored; it leaves the screen at «Готово» or at
its expiry. A removal is recorded locally first and shown as waiting until the server confirms it; the
sync worker keeps retrying it while offline (PAIR-03). Network work runs off the GUI thread.
"""
from datetime import datetime

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QFont, QGuiApplication
from PySide6.QtWidgets import (QAbstractItemView, QGroupBox, QHBoxLayout, QHeaderView, QLabel, QLineEdit,
                               QMessageBox, QPushButton, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget)

from ..clock import KYIV, parse_instant
from ..transport import SyncError, Transport
from .presenter import utc_now
from .settings import ThreadRunner

MAX_CAREGIVERS = 10
WAITING = "видалення чекає на підтвердження сервера"


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
        return WAITING
    if entry["id"].startswith("parent:"):
        return f"підключено, Telegram ID {entry['userId']}"
    if entry["status"] == "revoked":
        return "ключ скасовано"
    if entry["status"] == "expired" or parse_instant(entry["expiresAt"]) <= now:
        return "ключ прострочено"
    return f"ключ чекає на підключення до {_local_time(entry['expiresAt'])}"


class AccessPanel(QWidget):
    def __init__(self, *, runner=None, confirm=None, now=utc_now):
        super().__init__()
        self._run = runner or ThreadRunner()
        self._confirm = confirm or self._ask
        self._now = now
        self._store = self._client = None
        self._entries: list[dict] = []
        self._key_expires = None
        self._waiting: set[str] = set()
        layout = QVBoxLayout(self)

        self.message = QLabel()
        self.message.setWordWrap(True)
        self.message.setTextFormat(Qt.TextFormat.PlainText)
        layout.addWidget(self.message)

        create = QHBoxLayout()
        self.name = QLineEdit()
        self.name.setPlaceholderText("Ім’я, наприклад «Мама»")
        self.create_button = QPushButton("Створити ключ")
        self.create_button.clicked.connect(self.create_key)
        create.addWidget(self.name, 1)
        create.addWidget(self.create_button)
        layout.addLayout(create)

        self.key_box = QGroupBox("Новий ключ")
        box = QVBoxLayout(self.key_box)
        self.key_command = QLabel()
        self.key_command.setTextFormat(Qt.TextFormat.PlainText)
        self.key_command.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.key_command.setFont(QFont("Consolas", 12))
        self.key_note = QLabel()
        self.key_note.setWordWrap(True)
        buttons = QHBoxLayout()
        self.copy_button = QPushButton("Копіювати команду")
        self.copy_button.clicked.connect(lambda: QGuiApplication.clipboard().setText(self.key_command.text()))
        self.done_button = QPushButton("Готово")
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
        self.table.setHorizontalHeaderLabels(["Ім’я", "Стан", ""])
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        layout.addWidget(self.table, 1)
        self.refresh_button = QPushButton("Оновити")
        self.refresh_button.clicked.connect(self.refresh)
        layout.addWidget(self.refresh_button, 0, Qt.AlignmentFlag.AlignRight)

    def _ask(self, text: str) -> bool:
        return QMessageBox.question(self, "AW Telegram", text) == QMessageBox.StandardButton.Yes

    def bind(self, store, client) -> None:
        """client is None until the laptop is enrolled."""
        self._store, self._client, self._entries = store, client, []
        enabled = client is not None
        for widget in (self.name, self.create_button, self.refresh_button):
            widget.setEnabled(enabled)
        self.message.setText("" if enabled else "Спочатку підключіть ноутбук у «Налаштування».")
        self._render()
        if enabled:
            self.refresh()

    # Listing
    def refresh(self) -> None:
        if self._client is None:
            return
        self._run(self._client.list_all, self._listed)

    def _listed(self, result, error) -> None:
        if error is not None:
            self.message.setText("Список недоступний: немає зв’язку з сервером.")
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
        rows = [(e, e["id"] in pending) for e in self._entries]
        known = {e["id"] for e in self._entries}
        rows += [(dict(id=i, name=item["name"]), True) for i, item in pending.items() if i not in known]
        self.table.setRowCount(len(rows))
        for row, (entry, waiting) in enumerate(rows):
            self.table.setItem(row, 0, QTableWidgetItem(entry["name"]))
            self.table.setItem(row, 1, QTableWidgetItem(entry_status(entry, now, waiting)))
            self.table.removeCellWidget(row, 2)
            if not waiting and entry.get("status") != "revoked":
                button = QPushButton("Видалити")
                button.clicked.connect(lambda _=False, access_id=entry["id"]: self.remove(access_id))
                self.table.setCellWidget(row, 2, button)
        active = sum(1 for e, waiting in rows if e["id"].startswith("parent:") and not waiting)
        self.capacity.setText("" if active < MAX_CAREGIVERS else
                              f"Підключено {MAX_CAREGIVERS} із {MAX_CAREGIVERS} облікових записів: "
                              "щоб додати новий, спершу видаліть один.")

    # Keys
    def create_key(self) -> None:
        name = self.name.text().strip()
        if not name or len(name) > 80:
            self.message.setText("Введіть ім’я до 80 символів, наприклад «Мама».")
            return
        self.create_button.setEnabled(False)
        self._run(lambda: self._client.create(name), self._created)

    def _created(self, result, error) -> None:
        self.create_button.setEnabled(True)
        if error is not None:
            self.message.setText("Немає зв’язку з сервером. Спробуйте ще раз."
                                 if isinstance(error, SyncError) and error.retryable else "Не вдалося створити ключ.")
            return
        self.name.clear()
        self.message.setText("")
        self.key_command.setText(f"/pair {result['secret']}")
        self.key_note.setText("Надішліть цю команду боту в особистому чаті Telegram. "
                              f"Ключ діє до {_local_time(result['expiresAt'])} і підключає один обліковий запис.")
        self.key_box.setVisible(True)
        self._key_expires = parse_instant(result["expiresAt"])
        remaining = int((self._key_expires - self._now()).total_seconds() * 1000)
        QTimer.singleShot(max(0, remaining) + 500, self.expire_key)
        self.refresh()

    def expire_key(self) -> None:
        if self._key_expires is not None and self._now() >= self._key_expires:
            self._clear_key()

    def _clear_key(self) -> None:
        self.key_command.setText("")
        self.key_note.setText("")
        self.key_box.setVisible(False)
        self._key_expires = None

    # Removal
    def remove(self, access_id: str) -> None:
        entry = next((e for e in self._entries if e["id"] == access_id), None)
        if entry is None:
            return
        name, is_key = entry["name"], access_id.startswith("key:")
        question = (f"Видалити ключ «{name}»? Його більше не можна буде використати." if is_key else
                    f"Видалити доступ «{name}»? Цей обліковий запис Telegram більше не зможе керувати ноутбуком.")
        if not self._confirm(question):
            return
        self._store.request_revocation(access_id, name)  # durable before anything is claimed
        self._render()
        self._run(lambda: self._client.revoke(access_id), lambda _, error: self._removed(access_id, name, is_key, error))

    def _removed(self, access_id, name, is_key, error) -> None:
        if error is not None:
            self.message.setText("Видалення збережено. Його буде надіслано, щойно з’явиться зв’язок із сервером.")
            self._render()
            return
        self._store.revocation_done(access_id)
        self.message.setText(f"Ключ «{name}» видалено." if is_key else f"Доступ «{name}» видалено.")
        self.refresh()
