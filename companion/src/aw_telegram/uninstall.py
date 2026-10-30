"""`aw-telegram.exe --uninstall`: undo this laptop's local setup before its folder is deleted.

Turns off autostart, optionally removes every caregiver's access first (it needs the credential), then
deletes this laptop's credential from Windows. The device itself can be revoked only by the owner on
the server, so the report gives that command; it also invalidates every remaining parent and key.
Local data is listed for manual deletion, never removed. No step's failure stops the later ones.
"""
from pathlib import Path

from .texts import t
from .windows.startup import set_startup

OWNER_COMMAND = "node --experimental-strip-types scripts/enroll.ts revoke-device --project {project} --device-id {device}"


def uninstall(store, *, registry, vault, access, revoke_parents: bool, data: Path) -> list[str]:
    report = []
    try:
        set_startup(False, "", registry)
        report.append(t("uninstall.startup_off"))
    except Exception:
        report.append(t("uninstall.startup_failed"))
    binding = store.binding if store is not None else None
    if binding is not None:
        if revoke_parents and access is not None:
            removed = 0
            try:
                listing = access.list_all()
                for entry in listing["parents"] + [k for k in listing["keys"] if k["status"] == "pending"]:
                    access.revoke(entry["id"])
                    removed += 1
                report.append(t("uninstall.parents_removed", count=removed))
            except Exception:
                report.append(t("uninstall.parents_failed", count=removed))
        try:
            vault.delete(binding["backendUrl"], binding["deviceId"])
            report.append(t("uninstall.vault_deleted"))
        except Exception:
            report.append(t("uninstall.vault_failed"))
        command = OWNER_COMMAND.format(project=t("uninstall.project"), device=binding["deviceId"])
        report.append(t("uninstall.owner_revoke", command=command))
    report.append(t("uninstall.data_left", path=data))
    return report
