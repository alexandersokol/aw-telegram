"""`aw-telegram.exe --uninstall`: undo this laptop's local setup before its folder is deleted.

Turns off autostart, optionally removes every caregiver's access first (it needs the credential), then
deletes this laptop's credential from Windows. The device itself can be revoked only by the owner on
the server, so the report gives that command. Local data is listed for manual deletion, never removed.
"""
from pathlib import Path

from .transport import EnrollmentError
from .windows.startup import set_startup

OWNER_COMMAND = "node --experimental-strip-types scripts/enroll.ts revoke-device --project ПРОЄКТ --device-id {device}"


def uninstall(store, *, registry, vault, access, revoke_parents: bool, data: Path) -> list[str]:
    report = []
    set_startup(False, "", registry)
    report.append("Автозапуск вимкнено.")
    binding = store.binding if store is not None else None
    if binding is not None:
        if revoke_parents and access is not None:
            try:
                listing = access.list_all()
                entries = listing["parents"] + [k for k in listing["keys"] if k["status"] == "pending"]
                for entry in entries:
                    access.revoke(entry["id"])
                report.append(f"Доступ батьків видалено (записів: {len(entries)}).")
            except EnrollmentError:
                report.append("Не вдалося видалити доступ батьків: немає зв’язку з сервером. "
                              "Видаліть його пізніше в Telegram або попросіть власника.")
        try:
            vault.delete(binding["backendUrl"], binding["deviceId"])
            report.append("Облікові дані ноутбука видалено з Windows.")
        except Exception:
            report.append("Не вдалося видалити облікові дані з Windows.")
        report.append("Щоб відкликати ноутбук на сервері, власник виконує на своєму комп’ютері: "
                      + OWNER_COMMAND.format(device=binding["deviceId"]))
    report.append(f"Дані програми залишилися в {data}; їх можна видалити вручну.")
    return report
