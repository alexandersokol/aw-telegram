# -*- mode: python -*-
# Portable one-folder Windows build of the companion. Build from companion/ with a virtual environment made
# from a python.org CPython 3.12 for Windows (its LICENSE.txt covers the bundled OpenSSL, libffi, bzip2 and
# other C libraries) and requirements.lock:
#   .venv-build\Scripts\pyinstaller.exe --clean --noconfirm aw-telegram.spec
# Output: dist\aw-telegram\aw-telegram.exe. No console window; nothing is logged to files.
import os
import sys
from pathlib import Path

from PyInstaller.config import CONF
from PyInstaller.utils.hooks import collect_data_files

ROOT = Path(SPECPATH)
BASE = Path(sys.base_prefix)
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tools")]
import licenses  # noqa: E402
import release  # noqa: E402

python_license = BASE / "LICENSE.txt"
if "Additional Conditions for this Windows binary build" not in python_license.read_text(encoding="utf-8", errors="replace"):
    raise SystemExit(f"Build from a python.org CPython for Windows; {BASE} lacks its bundled-library license terms")
# Resolve DLLs from this Python first: another OpenSSL on PATH (e.g. Git's mingw64) breaks _ssl at startup.
os.environ["PATH"] = os.pathsep.join([str(BASE / "DLLs"), str(BASE), os.environ.get("PATH", "")])

notice = Path(CONF["workpath"]) / "THIRD-PARTY-NOTICES.txt"
notice.parent.mkdir(parents=True, exist_ok=True)
notice.write_text(licenses.notices(), encoding="utf-8")
missing = licenses.missing_texts()
if missing:
    print("WARNING: not distributable until companion/licenses has: " + ", ".join(missing))

# File Explorer's Properties shows the version stamped into aw_telegram/_version.py (0.0.0.0 for a local build).
version_file = Path(CONF["workpath"]) / "version-info.txt"
version_file.write_text(release.version_info(release.stamped_version(ROOT)), encoding="utf-8")

datas = (collect_data_files("aw_telegram", includes=["schemas/*.schema.json"])
         + collect_data_files("tzdata")
         + licenses.license_files()
         + [(str(notice), "."), (str(ROOT.parent / "LICENSE"), ".")])

a = Analysis(
    [str(ROOT / "tools" / "entry.py")],
    pathex=[str(ROOT / "src")],
    datas=datas,
    hiddenimports=["keyring.backends.Windows"],
    excludes=["tkinter", "pytest", "pytestqt", "aw_telegram.manual_presentation", "setuptools", "pkg_resources"],
    # PySide6/shiboken6 Python files stay on disk, replaceable like their LGPL libraries.
    module_collection_mode={"PySide6": "py", "shiboken6": "py"},
)
# Only what a widgets tray app uses: no software OpenGL, image formats, SVG, TLS or network-information plugins.
UNUSED = ("opengl32sw.dll", "qt6svg.dll", "/imageformats/", "/iconengines/", "/tls/", "/networkinformation/",
          "/generic/", "qdirect2d.dll", "qminimal.dll")
a.binaries = [b for b in a.binaries if not any(part in "/" + b[0].replace("\\", "/").lower() for part in UNUSED)]
# PyInstaller's QtNetwork hook also searches PATH for an OpenSSL for Qt's own TLS plugin (found Git's copy).
# That plugin is excluded above, so only Python's own OpenSSL for _ssl ships.
openssl = lambda entry: Path(entry[1]).name.lower().startswith(("libssl", "libcrypto"))
ours = lambda entry: Path(entry[1]).resolve().is_relative_to(BASE.resolve())
a.binaries = [b for b in a.binaries if not openssl(b) or ours(b)]
if not any(openssl(b) for b in a.binaries):
    raise SystemExit("Python's own OpenSSL DLLs were not collected; _ssl would fail at startup")
pyz = PYZ(a.pure)
# AW_TELEGRAM_CONSOLE=1 builds a console variant for diagnosing a frozen build; never ship it.
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="aw-telegram",
          console=os.environ.get("AW_TELEGRAM_CONSOLE") == "1", upx=False, version=str(version_file))
coll = COLLECT(exe, a.binaries, a.datas, name="aw-telegram", upx=False)
