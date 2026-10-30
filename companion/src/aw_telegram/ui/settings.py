"""«Налаштування»: one-time enrollment, the ActivityWatch address and autostart.

The enrollment code is the owner CLI's one-line JSON bundle. Its canonical HTTPS host is shown for explicit
confirmation before anything is sent; the one-time secret is cleared from the screen after use and never
logged or persisted. Network, vault and probe work runs off the GUI thread through `runner`.
"""
import json
import threading
from urllib.parse import urlsplit

from PySide6.QtCore import QObject, Qt, Signal
from PySide6.QtWidgets import (QCheckBox, QComboBox, QFormLayout, QGroupBox, QHBoxLayout, QLabel, QMessageBox,
                               QPlainTextEdit, QPushButton, QSpinBox, QVBoxLayout, QWidget)

from .. import _version
from ..credentials import CredentialError as VaultUnavailable
from ..transport import EnrollmentBundle, EnrollmentError, SyncError, _secret, canonical_backend
from ..windows.startup import set_startup, startup_enabled

UNRECOGNIZED = "Код підключення не розпізнано. Вставте повністю рядок, який видала команда власника."
INFORMATIONAL = {"browser_enrichment_unavailable", "browser_local_settings_unavailable", "ui_build_presets_unverified"}
AW_HOSTS = ("127.0.0.1", "::1")


def parse_bundle(text: str) -> tuple[EnrollmentBundle, str]:
    """(bundle, canonical host) from the owner CLI output `{"backendUrl": ..., "secret": ...}`."""
    try:
        value = json.loads(text.strip())
    except ValueError:
        raise ValueError(UNRECOGNIZED) from None
    if (not isinstance(value, dict) or set(value) != {"backendUrl", "secret"}
            or not all(isinstance(value[k], str) for k in value) or not _secret(value["secret"])):
        raise ValueError(UNRECOGNIZED)  # a mistyped secret is caught here, before anything is sent
    try:
        backend = canonical_backend(value["backendUrl"])
    except EnrollmentError:
        raise ValueError("Адреса сервера в коді недійсна: потрібна адреса https:// без шляху.") from None
    return EnrollmentBundle(value["backendUrl"], value["secret"]), urlsplit(backend).netloc


def enrollment_error(error: Exception) -> str:
    """Actionable Ukrainian text; never echoes the error's own details."""
    if isinstance(error, VaultUnavailable):
        return "Сховище облікових даних Windows недоступне. Код не використано; спробуйте ще раз."
    if isinstance(error, SyncError):
        if error.retryable:
            # A timeout or server error may come after the server used the code; consumption is final.
            return ("Немає зв’язку з сервером або він не відповів. Перевірте інтернет і спробуйте ще раз. "
                    "Якщо код більше не приймається, попросіть власника скасувати це підключення "
                    "(revoke-enrollment) і видати новий код.")
        return "Код недійсний, прострочений або вже використаний. Попросіть власника видати новий код."
    if isinstance(error, EnrollmentError) and ("owner recovery" in str(error) or "Credential storage" in str(error)):
        return ("Код використано, але ноутбук не зміг завершити підключення. Попросіть власника "
                "скасувати це підключення і видати новий код.")
    return "Не вдалося підключити ноутбук. Попросіть власника видати новий код."


def _keeps_code(error: Exception) -> bool:
    """Only failures that happen before the code reaches the server leave it worth retrying."""
    return isinstance(error, VaultUnavailable) or isinstance(error, SyncError) and error.retryable


def aw_message(capabilities, host: str, port: int) -> str:
    address = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
    if not capabilities.reachable:
        return f"ActivityWatch не відповідає за адресою {address}. Запустіть ActivityWatch або перевірте порт."
    problems = [issue for issue in capabilities.issues if issue not in INFORMATIONAL]
    if not problems:
        return f"ActivityWatch працює ({capabilities.hostname}, версія {capabilities.server_version})."
    parts = []
    for issue in problems:
        if issue.endswith("_window"):
            parts.append("немає єдиного джерела даних про вікна (aw-watcher-window)")
        elif issue.endswith("_afk"):
            parts.append("немає єдиного джерела даних про присутність (aw-watcher-afk)")
        else:
            parts.append("не вдалося прочитати категорії — налаштуйте їх в ActivityWatch")
    return "ActivityWatch відповідає, але " + "; ".join(dict.fromkeys(parts)) + "."


class _Relay(QObject):
    finished = Signal(object, object, object)

    def __init__(self):
        super().__init__()
        self.finished.connect(self._deliver, Qt.ConnectionType.QueuedConnection)

    @staticmethod
    def _deliver(done, result, error):
        done(result, error)


class ThreadRunner:
    """Runs fn on a daemon thread and calls done(result, error) back on the GUI thread."""

    def __init__(self):
        self._relay = _Relay()

    def __call__(self, fn, done):
        def work():
            try:
                result, error = fn(), None
            except Exception as exc:
                result, error = None, exc
            self._relay.finished.emit(done, result, error)
        threading.Thread(target=work, name="aw-telegram-settings", daemon=True).start()


class SettingsPanel(QWidget):
    def __init__(self, *, enroll, probe, on_enrolled, on_aw_changed, executable, registry=None, runner=None,
                 on_reset=None, confirm=None):
        super().__init__()
        self._enroll, self._probe = enroll, probe
        self._on_enrolled, self._on_aw_changed, self._on_reset = on_enrolled, on_aw_changed, on_reset
        self._confirm = confirm or (lambda text: QMessageBox.question(self, "AW Telegram", text)
                                    == QMessageBox.StandardButton.Yes)
        self._executable, self._registry = executable, registry
        self._run = runner or ThreadRunner()
        self._pending = None  # (bundle, host) confirmed for sending; holds the one-time secret briefly
        layout = QVBoxLayout(self)

        server = QGroupBox("Підключення до сервера")
        box = QVBoxLayout(server)
        self.code_hint = QLabel("Вставте код підключення, який видала команда власника.")
        self.code = QPlainTextEdit()
        self.code.setPlaceholderText('{"backendUrl":"https://…","secret":"…"}')
        self.code.setMaximumHeight(70)
        self.code.textChanged.connect(self._code_changed)
        buttons = QHBoxLayout()
        self.check_button = QPushButton("Перевірити код")
        self.check_button.clicked.connect(self._check)
        self.connect_button = QPushButton("Підключити")
        self.connect_button.clicked.connect(self._connect)
        self.connect_button.setVisible(False)
        self.reconnect_button = QPushButton("Підключити заново…")
        self.reconnect_button.clicked.connect(self._reconnect)
        self.reconnect_button.setVisible(False)
        buttons.addWidget(self.check_button)
        buttons.addWidget(self.connect_button)
        buttons.addWidget(self.reconnect_button)
        buttons.addStretch()
        self.connection_message = QLabel()
        self.connection_message.setWordWrap(True)
        self.connection_message.setTextFormat(Qt.TextFormat.PlainText)
        for item in (self.code_hint, self.code):
            box.addWidget(item)
        box.addLayout(buttons)
        box.addWidget(self.connection_message)
        layout.addWidget(server)

        aw = QGroupBox("ActivityWatch")
        form = QFormLayout(aw)
        self.aw_host = QComboBox()
        self.aw_host.addItems(AW_HOSTS)
        self.aw_port = QSpinBox()
        self.aw_port.setRange(1, 65535)
        self.aw_save = QPushButton("Зберегти й перевірити")
        self.aw_save.clicked.connect(self._save_aw)
        self.aw_message = QLabel()
        self.aw_message.setWordWrap(True)
        self.aw_message.setTextFormat(Qt.TextFormat.PlainText)
        form.addRow("Адреса", self.aw_host)
        form.addRow("Порт", self.aw_port)
        form.addRow(self.aw_save)
        form.addRow(self.aw_message)
        layout.addWidget(aw)

        startup = QGroupBox("Автозапуск")
        box = QVBoxLayout(startup)
        self.autostart = QCheckBox("Запускати разом з Windows")
        self.autostart.toggled.connect(self._autostart_toggled)
        self.autostart_note = QLabel()
        self.autostart_note.setWordWrap(True)
        box.addWidget(self.autostart)
        box.addWidget(self.autostart_note)
        layout.addWidget(startup)
        layout.addStretch()
        self.version_label = QLabel(f"Версія {_version.VERSION}")  # which build this laptop runs
        self.version_label.setStyleSheet("color: gray; font-size: 11px;")
        layout.addWidget(self.version_label)

    def set_state(self, binding: dict | None, config: dict) -> None:
        enrolled = binding is not None
        for widget in (self.code_hint, self.code, self.check_button):
            widget.setVisible(not enrolled)
        self.connect_button.setVisible(False)
        self.reconnect_button.setVisible(enrolled and self._on_reset is not None)
        if enrolled:
            host = urlsplit(binding["backendUrl"]).netloc
            self.connection_message.setText(f"Підключено до сервера {host}. Ноутбук: {binding['deviceId'][:8]}…")
        self.aw_host.setCurrentText(config["awHost"])
        self.aw_port.setValue(config["awPort"])
        self.autostart.blockSignals(True)
        if self._executable is None:
            self.autostart.setChecked(False)
            self.autostart.setEnabled(False)
            self.autostart_note.setText("Доступно у встановленій версії програми.")
        else:
            self.autostart.setEnabled(True)
            self.autostart.setChecked(startup_enabled(self._executable, self._registry))
            self.autostart_note.setText("")
        self.autostart.blockSignals(False)

    # Enrollment
    def _code_changed(self):
        self._pending = None
        self.connect_button.setVisible(False)

    def _check(self):
        try:
            bundle, host = parse_bundle(self.code.toPlainText())
        except ValueError as error:
            self.connection_message.setText(str(error))
            return
        self._pending = (bundle, host)
        self.connection_message.setText(f"Сервер: {host}\nПереконайтеся, що це ваш сервер, і натисніть «Підключити».")
        self.connect_button.setVisible(True)

    def _connect(self):
        if self._pending is None:
            return
        bundle, host = self._pending
        self._pending = None
        self.check_button.setEnabled(False)
        self.connect_button.setEnabled(False)
        self.connection_message.setText("Підключення…")
        self._run(lambda: self._enroll(bundle, host), lambda identity, error: self._enrolled(identity, error, host))

    def _enrolled(self, identity, error, host):
        self.check_button.setEnabled(True)
        self.connect_button.setEnabled(True)
        if error is not None:
            if not _keeps_code(error):
                self.code.clear()
            self.connection_message.setText(enrollment_error(error))
            return
        self.code.clear()
        try:
            self._on_enrolled(identity)
        except Exception:
            self.connection_message.setText("Код використано, але ноутбук не зміг зберегти підключення. Попросіть "
                                            "власника скасувати це підключення і видати новий код.")
            return
        self.connection_message.setText(f"Ноутбук підключено до {host}.")
        self._check_aw()  # SETUP-03: check ActivityWatch right after connecting

    def _reconnect(self):
        if self._confirm("Підключити ноутбук заново? Поточне підключення буде забуто. Локальні дані збережуться "
                         "в окремому файлі, а для нового підключення потрібен новий код від власника."):
            self._on_reset()

    # ActivityWatch
    def _save_aw(self):
        host, port = self.aw_host.currentText(), self.aw_port.value()
        self._on_aw_changed(host, port)
        self._check_aw()

    def _check_aw(self):
        host, port = self.aw_host.currentText(), self.aw_port.value()
        self.aw_message.setText("Перевірка ActivityWatch…")
        self._run(lambda: self._probe(host, port),
                  lambda result, error: self.aw_message.setText(
                      aw_message(result, host, port) if error is None else
                      f"Не вдалося перевірити ActivityWatch за адресою {host}:{port}."))

    # Autostart
    def _autostart_toggled(self, checked: bool):
        try:
            set_startup(checked, self._executable, self._registry)
            self.autostart_note.setText("")
        except (OSError, ValueError):
            self.autostart.blockSignals(True)
            self.autostart.setChecked(not checked)
            self.autostart.blockSignals(False)
            self.autostart_note.setText("Не вдалося змінити автозапуск Windows.")
