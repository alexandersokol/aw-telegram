"""«Налаштування» / Settings: one-time enrollment, the ActivityWatch address, autostart and the language.

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
from ..texts import t
from ..transport import EnrollmentBundle, EnrollmentError, SyncError, _secret, canonical_backend
from ..windows.startup import set_startup, startup_enabled
from .i18n import Messages

LANGUAGE_CHOICES = ("system", "uk", "en")
INFORMATIONAL = {"browser_enrichment_unavailable", "browser_local_settings_unavailable", "ui_build_presets_unverified"}
AW_HOSTS = ("127.0.0.1", "::1")


class BundleError(ValueError):
    """A connection code that cannot be used; `key` names its text so the message follows a language switch."""

    def __init__(self, key: str):
        super().__init__(t(key))
        self.key = key


def parse_bundle(text: str) -> tuple[EnrollmentBundle, str]:
    """(bundle, canonical host) from the owner CLI output `{"backendUrl": ..., "secret": ...}`."""
    try:
        value = json.loads(text.strip())
    except ValueError:
        raise BundleError("settings.server.code_invalid") from None
    if (not isinstance(value, dict) or set(value) != {"backendUrl", "secret"}
            or not all(isinstance(value[k], str) for k in value) or not _secret(value["secret"])):
        raise BundleError("settings.server.code_invalid")  # a mistyped secret is caught here, before anything is sent
    try:
        backend = canonical_backend(value["backendUrl"])
    except EnrollmentError:
        raise BundleError("settings.server.host_invalid") from None
    return EnrollmentBundle(value["backendUrl"], value["secret"]), urlsplit(backend).netloc


def enrollment_error(error: Exception) -> str:
    """Actionable text in the current language; never echoes the error's own details."""
    if isinstance(error, VaultUnavailable):
        return t("settings.enroll.vault")
    if isinstance(error, SyncError):
        if error.retryable:
            # A timeout or server error may come after the server used the code; consumption is final.
            return t("settings.enroll.retryable")
        return t("settings.enroll.rejected")
    if isinstance(error, EnrollmentError) and ("owner recovery" in str(error) or "Credential storage" in str(error)):
        return t("settings.enroll.unfinished")
    return t("settings.enroll.failed")


def _keeps_code(error: Exception) -> bool:
    """Only failures that happen before the code reaches the server leave it worth retrying."""
    return isinstance(error, VaultUnavailable) or isinstance(error, SyncError) and error.retryable


def aw_message(capabilities, host: str, port: int) -> str:
    address = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
    if not capabilities.reachable:
        return t("settings.aw.unreachable", address=address)
    problems = [issue for issue in capabilities.issues if issue not in INFORMATIONAL]
    if not problems:
        return t("settings.aw.working", hostname=capabilities.hostname, version=capabilities.server_version)
    parts = []
    for issue in problems:
        if issue.endswith("_window"):
            parts.append(t("settings.aw.no_window"))
        elif issue.endswith("_afk"):
            parts.append(t("settings.aw.no_afk"))
        else:
            parts.append(t("settings.aw.no_categories"))
    return t("settings.aw.problems", problems="; ".join(dict.fromkeys(parts)))


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
                 on_reset=None, confirm=None, on_language=None):
        super().__init__()
        self._enroll, self._probe = enroll, probe
        self._on_enrolled, self._on_aw_changed, self._on_reset = on_enrolled, on_aw_changed, on_reset
        self._on_language = on_language
        self._messages = Messages()
        self._confirm = confirm or (lambda text: QMessageBox.question(self, "AW Telegram", text)
                                    == QMessageBox.StandardButton.Yes)
        self._executable, self._registry = executable, registry
        self._run = runner or ThreadRunner()
        self._pending = None  # (bundle, host) confirmed for sending; holds the one-time secret briefly
        layout = QVBoxLayout(self)

        self.server_group = server = QGroupBox()
        box = QVBoxLayout(server)
        self.code_hint = QLabel()
        self.code = QPlainTextEdit()
        self.code.setPlaceholderText('{"backendUrl":"https://…","secret":"…"}')
        self.code.setMaximumHeight(70)
        self.code.textChanged.connect(self._code_changed)
        buttons = QHBoxLayout()
        self.check_button = QPushButton()
        self.check_button.clicked.connect(self._check)
        self.connect_button = QPushButton()
        self.connect_button.clicked.connect(self._connect)
        self.connect_button.setVisible(False)
        self.reconnect_button = QPushButton()
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
        self.aw_host_label, self.aw_port_label = QLabel(), QLabel()
        self.aw_host = QComboBox()
        self.aw_host.addItems(AW_HOSTS)
        self.aw_port = QSpinBox()
        self.aw_port.setRange(1, 65535)
        self.aw_save = QPushButton()
        self.aw_save.clicked.connect(self._save_aw)
        self.aw_message = QLabel()
        self.aw_message.setWordWrap(True)
        self.aw_message.setTextFormat(Qt.TextFormat.PlainText)
        form.addRow(self.aw_host_label, self.aw_host)
        form.addRow(self.aw_port_label, self.aw_port)
        form.addRow(self.aw_save)
        form.addRow(self.aw_message)
        layout.addWidget(aw)

        self.startup_group = startup = QGroupBox()
        box = QVBoxLayout(startup)
        self.autostart = QCheckBox()
        self.autostart.toggled.connect(self._autostart_toggled)
        self.autostart_note = QLabel()
        self.autostart_note.setWordWrap(True)
        box.addWidget(self.autostart)
        box.addWidget(self.autostart_note)
        layout.addWidget(startup)

        self.language_group = language = QGroupBox()
        box = QVBoxLayout(language)
        self.language = QComboBox()
        for choice in LANGUAGE_CHOICES:
            self.language.addItem("", choice)
        self.language.currentIndexChanged.connect(self._language_changed)
        box.addWidget(self.language)
        layout.addWidget(language)
        layout.addStretch()
        self.version_label = QLabel()  # which build this laptop runs
        self.version_label.setStyleSheet("color: gray; font-size: 11px;")
        layout.addWidget(self.version_label)
        self.retranslate()

    def retranslate(self) -> None:
        """Static texts and every remembered message, in the current language."""
        self.server_group.setTitle(t("settings.server.title"))
        self.code_hint.setText(t("settings.server.hint"))
        self.check_button.setText(t("settings.server.check"))
        self.connect_button.setText(t("settings.server.connect"))
        self.reconnect_button.setText(t("settings.server.reconnect"))
        self.aw_host_label.setText(t("settings.aw.host"))
        self.aw_port_label.setText(t("settings.aw.port"))
        self.aw_save.setText(t("settings.aw.save"))
        self.startup_group.setTitle(t("settings.startup.title"))
        self.autostart.setText(t("settings.startup.enable"))
        self.language_group.setTitle(t("settings.language.title"))
        for index, choice in enumerate(LANGUAGE_CHOICES):
            self.language.setItemText(index, t(f"settings.language.{choice}"))
        self.version_label.setText(t("settings.version", version=_version.VERSION))
        self._messages.retranslate()

    def say_connection(self, factory) -> None:
        self._messages.say(self.connection_message, factory)

    def set_state(self, binding: dict | None, config: dict) -> None:
        enrolled = binding is not None
        for widget in (self.code_hint, self.code, self.check_button):
            widget.setVisible(not enrolled)
        self.connect_button.setVisible(False)
        self.reconnect_button.setVisible(enrolled and self._on_reset is not None)
        if enrolled:
            host = urlsplit(binding["backendUrl"]).netloc
            self._messages.say(self.connection_message, lambda: t("settings.server.connected", host=host,
                                                                  device=binding["deviceId"][:8]))
        self.aw_host.setCurrentText(config["awHost"])
        self.aw_port.setValue(config["awPort"])
        self.language.blockSignals(True)
        self.language.setCurrentIndex(LANGUAGE_CHOICES.index(config.get("language", "system")))
        self.language.blockSignals(False)
        self.autostart.blockSignals(True)
        if self._executable is None:
            self.autostart.setChecked(False)
            self.autostart.setEnabled(False)
            self._messages.say(self.autostart_note, lambda: t("settings.startup.installed_only"))
        else:
            self.autostart.setEnabled(True)
            self.autostart.setChecked(startup_enabled(self._executable, self._registry))
            self._messages.clear(self.autostart_note)
        self.autostart.blockSignals(False)

    # Enrollment
    def _code_changed(self):
        self._pending = None
        self.connect_button.setVisible(False)

    def _check(self):
        try:
            bundle, host = parse_bundle(self.code.toPlainText())
        except BundleError as error:
            key = error.key  # `error` is unbound once the handler ends, but the message is re-rendered later
            self._messages.say(self.connection_message, lambda: t(key))
            return
        self._pending = (bundle, host)
        self._messages.say(self.connection_message, lambda: t("settings.server.confirm_host", host=host))
        self.connect_button.setVisible(True)

    def _connect(self):
        if self._pending is None:
            return
        bundle, host = self._pending
        self._pending = None
        self.check_button.setEnabled(False)
        self.connect_button.setEnabled(False)
        self._messages.say(self.connection_message, lambda: t("settings.server.connecting"))
        self._run(lambda: self._enroll(bundle, host), lambda identity, error: self._enrolled(identity, error, host))

    def _enrolled(self, identity, error, host):
        self.check_button.setEnabled(True)
        self.connect_button.setEnabled(True)
        if error is not None:
            if not _keeps_code(error):
                self.code.clear()
            self._messages.say(self.connection_message, lambda: enrollment_error(error))
            return
        self.code.clear()
        try:
            self._on_enrolled(identity)
        except Exception:
            self._messages.say(self.connection_message, lambda: t("settings.server.save_failed"))
            return
        self._messages.say(self.connection_message, lambda: t("settings.server.done", host=host))
        self._check_aw()  # SETUP-03: check ActivityWatch right after connecting

    def _reconnect(self):
        if self._confirm(t("settings.server.reconnect_confirm")):
            self._on_reset()

    # ActivityWatch
    def _save_aw(self):
        host, port = self.aw_host.currentText(), self.aw_port.value()
        self._on_aw_changed(host, port)
        self._check_aw()

    def _check_aw(self):
        host, port = self.aw_host.currentText(), self.aw_port.value()
        self._messages.say(self.aw_message, lambda: t("settings.aw.checking"))
        self._run(lambda: self._probe(host, port),
                  lambda result, error: self._messages.say(
                      self.aw_message, (lambda: aw_message(result, host, port)) if error is None else
                      (lambda: t("settings.aw.check_failed", address=f"{host}:{port}"))))

    # Autostart
    def _autostart_toggled(self, checked: bool):
        try:
            set_startup(checked, self._executable, self._registry)
            self._messages.clear(self.autostart_note)
        except (OSError, ValueError):
            self.autostart.blockSignals(True)
            self.autostart.setChecked(not checked)
            self.autostart.blockSignals(False)
            self._messages.say(self.autostart_note, lambda: t("settings.startup.failed"))

    # Language
    def _language_changed(self, index: int):
        if self._on_language is not None:
            self._on_language(LANGUAGE_CHOICES[index])
