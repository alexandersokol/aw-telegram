# -*- mode: python -*-
# Portable one-folder Windows build of the companion. From companion/, with the locked venv:
#   .venv\Scripts\pyinstaller.exe --clean --noconfirm aw-telegram.spec
# Output: dist\aw-telegram\aw-telegram.exe. No console window; nothing is logged to files.
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

ROOT = Path(SPECPATH)
BASE = Path(sys.base_prefix)
# Resolve DLLs from this Python first: another OpenSSL on PATH (e.g. Git's mingw64) breaks _ssl at startup.
os.environ["PATH"] = os.pathsep.join([str(BASE / "DLLs"), str(BASE), os.environ.get("PATH", "")])
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tools")]
import licenses  # noqa: E402

notice = ROOT / "build" / "THIRD-PARTY-NOTICES.txt"
notice.parent.mkdir(exist_ok=True)
notice.write_text(licenses.notices(), encoding="utf-8")
missing = licenses.missing_texts()
if missing:
    print("WARNING: not distributable until companion/licenses has: " + ", ".join(missing))

datas = (collect_data_files("aw_telegram", includes=["schemas/*.schema.json"])
         + collect_data_files("tzdata")
         + licenses.license_files()
         + [(str(notice), ".")])

a = Analysis(
    [str(ROOT / "tools" / "entry.py")],
    pathex=[str(ROOT / "src")],
    datas=datas,
    hiddenimports=["keyring.backends.Windows"],
    excludes=["tkinter", "pytest", "pytestqt", "aw_telegram.manual_presentation"],
)
foreign = [src for _, src, _ in a.binaries if Path(src).name.lower().startswith(("libssl", "libcrypto"))
           and not Path(src).resolve().is_relative_to(BASE.resolve())]
if foreign:
    raise SystemExit("OpenSSL DLLs must come from this Python, not: " + ", ".join(foreign))
pyz = PYZ(a.pure)
# AW_TELEGRAM_CONSOLE=1 builds a console variant for diagnosing a frozen build; never ship it.
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="aw-telegram",
          console=os.environ.get("AW_TELEGRAM_CONSOLE") == "1", upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="aw-telegram", upx=False)
