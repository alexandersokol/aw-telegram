"""`aw-telegram.exe --uninstall`: undo this laptop's local setup before its folder is deleted.

Turns off autostart, optionally removes every caregiver's access first (it needs the credential), then
deletes this laptop's credential from Windows. The device itself can be revoked only by the owner on
the server, so the report gives that command; it also invalidates every remaining parent and key.
Local data is listed for manual deletion, never removed. No step's failure stops the later ones.
"""
from pathlib import Path

from .windows.startup import set_startup

OWNER_COMMAND = "node --experimental-strip-types scripts/enroll.ts revoke-device --project ПРОЄКТ --device-id {device}"


def uninstall(store, *, registry, vault, access, revoke_parents: bool, data: Path) -> list[str]:
    report = []
    try:
        set_startup(False, "", registry)
        report.append("Автозапуск вимкнено.")
    except Exception:
        report.append("Не вдалося вимкнути автозапуск Windows.")
    binding = store.binding if store is not None else None
    if binding is not None:
        if revoke_parents and access is not None:
            removed = 0
            try:
                listing = access.list_all()
                for entry in listing["parents"] + [k for k in listing["keys"] if k["status"] == "pending"]:
                    access.revoke(entry["id"])
                    removed += 1
                report.append(f"Доступ батьків видалено (записів: {removed}).")
            except Exception:
                report.append(f"Не вдалося видалити доступ батьків (видалено записів: {removed}). "
                              "Його скасує відкликання ноутбука власником — команда нижче.")
        try:
            vault.delete(binding["backendUrl"], binding["deviceId"])
            report.append("Облікові дані ноутбука видалено з Windows.")
        except Exception:
            report.append("Не вдалося видалити облікові дані з Windows.")
        report.append("Щоб відкликати ноутбук на сервері (це також скасує доступ усіх батьків і ключі), власник "
                      "виконує на своєму комп’ютері: " + OWNER_COMMAND.format(device=binding["deviceId"]))
    report.append(f"Дані програми залишилися в {data}; їх можна видалити вручну.")
    return report
