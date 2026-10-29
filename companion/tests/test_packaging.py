"""Task 9d: bundled notices, the frozen-build self-check and uninstall."""
import sys
from pathlib import Path

import pytest

from aw_telegram.storage import LocalStore
from aw_telegram.transport import DeviceIdentity, SyncError
from aw_telegram.uninstall import uninstall

sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import licenses  # noqa: E402

DEVICE = "00000000-0000-4000-8000-000000000001"
IDENTITY = DeviceIdentity(DEVICE, "https://backend.example")


# Notices

def test_every_runtime_dependency_ships_its_license():
    names = {d.metadata["Name"].lower().replace("_", "-") for d in licenses.runtime_distributions()}
    assert {"pyside6-essentials", "shiboken6", "jsonschema", "keyring", "tzdata", "referencing", "rpds-py",
            "pywin32-ctypes"} <= names
    assert "pytest" not in names and "pyinstaller" not in names
    files = licenses.license_files()
    covered = {Path(dest).name for _, dest in files}
    for dist in licenses.runtime_distributions():
        assert licenses.folder(dist) in covered, dist.metadata["Name"]
    assert all(Path(src).is_file() for src, _ in files)


def test_notices_name_python_the_bootloader_and_each_package():
    text = licenses.notices()
    assert "Python" in text and "PyInstaller" in text and "PySide6" in text and "LGPL" in text
    assert all(licenses.folder(d) in text for d in licenses.runtime_distributions())


# Self-check

def test_self_check_reports_each_bundle_requirement(qtbot):
    from aw_telegram.main import self_check
    report = self_check()
    assert set(report) == {"schemas", "timezone", "vault", "qt"}
    assert report["schemas"] == report["timezone"] == report["qt"] == "ok"


# Uninstall

class Registry:
    def __init__(self):
        self.values = {"AW Telegram": '"C:\\AW\\aw-telegram.exe" --background'}

    def get(self, name):
        return self.values.get(name)

    def set(self, name, value):
        self.values[name] = value

    def delete(self, name):
        self.values.pop(name, None)


class Vault:
    def __init__(self, fail=False):
        self.deleted, self.fail = [], fail

    def delete(self, backend, device):
        if self.fail:
            raise RuntimeError("vault")
        self.deleted.append((backend, device))


class Access:
    def __init__(self, offline=False):
        self.offline, self.revoked = offline, []

    def list_all(self):
        if self.offline:
            raise SyncError(retryable=True)
        return dict(parents=[dict(id=f"parent:101:{DEVICE}", name="Мама", userId="101", status="active")],
                    keys=[dict(id=f"key:{DEVICE}", name="Тато", status="pending", expiresAt="2026-10-28T12:15:00.000Z"),
                          dict(id="key:00000000-0000-4000-8000-000000000009", name="Старий", status="revoked",
                               expiresAt="2026-10-28T12:15:00.000Z")])

    def revoke(self, access_id):
        self.revoked.append(access_id)


@pytest.fixture
def store(tmp_path):
    s = LocalStore(tmp_path / "c.sqlite", identity=IDENTITY)
    yield s
    s.close()


def test_uninstall_removes_autostart_and_the_credential_and_explains_server_revocation(store, tmp_path):
    registry, vault = Registry(), Vault()
    report = uninstall(store, registry=registry, vault=vault, access=None, revoke_parents=False, data=tmp_path)
    assert registry.values == {} and vault.deleted == [("https://backend.example", DEVICE)]
    assert report[0] == "Автозапуск вимкнено."
    assert "Облікові дані ноутбука видалено з Windows." in report
    assert any(f"revoke-device --project ПРОЄКТ --device-id {DEVICE}" in line for line in report)
    assert report[-1] == f"Дані програми залишилися в {tmp_path}; їх можна видалити вручну."


def test_uninstall_can_first_remove_every_parent_and_pending_key(store, tmp_path):
    access = Access()
    report = uninstall(store, registry=Registry(), vault=Vault(), access=access, revoke_parents=True, data=tmp_path)
    assert access.revoked == [f"parent:101:{DEVICE}", f"key:{DEVICE}"]
    assert "Доступ батьків видалено (записів: 2)." in report


def test_uninstall_reports_what_could_not_be_done(store, tmp_path):
    report = uninstall(store, registry=Registry(), vault=Vault(fail=True), access=Access(offline=True),
                       revoke_parents=True, data=tmp_path)
    assert "Не вдалося видалити доступ батьків: немає зв’язку з сервером. Видаліть його пізніше в Telegram або попросіть власника." in report
    assert "Не вдалося видалити облікові дані з Windows." in report


def test_uninstall_of_an_unenrolled_laptop_only_turns_off_autostart(tmp_path):
    s = LocalStore(tmp_path / "c.sqlite")
    try:
        vault = Vault()
        report = uninstall(s, registry=Registry(), vault=vault, access=None, revoke_parents=True, data=tmp_path)
        assert vault.deleted == [] and report[0] == "Автозапуск вимкнено." and len(report) == 2
    finally:
        s.close()
