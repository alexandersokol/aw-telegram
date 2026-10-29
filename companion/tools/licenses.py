"""Third-party notices for the packaged companion.

Collects the runtime dependency closure of the companion's declared dependencies (no test or build
tools), each distribution's own license files, Python's license, the PyInstaller bootloader notice and
the license texts PySide6's wheel omits. `python tools/licenses.py check` fails while a text is missing.
"""
import importlib.metadata as metadata
import re
import sys
from pathlib import Path

from packaging.requirements import Requirement

RUNTIME = ("PySide6-Essentials", "jsonschema", "tzdata", "keyring")
TEXTS = Path(__file__).parents[1] / "licenses"
# The Qt for Python wheels name LGPL-3.0-only OR GPL-2.0-only but ship neither text; LGPL-3.0 builds on GPL-3.0.
# Qt's libraries also embed third-party code (PCRE2, zlib, libpng, HarfBuzz, FreeType, md4c, double-conversion...)
# whose notices the wheels omit: qt-third-party.txt holds Qt 6.12's "Licenses Used in Qt" attributions.
# Python's LICENSE.txt omits the libraries its Windows build incorporates (OpenSSL 3, expat, mpdecimal, zlib,
# SQLite...): python-incorporated.txt holds "Licenses and Acknowledgements for Incorporated Software".
REQUIRED_TEXTS = ("LGPL-3.0.txt", "GPL-3.0.txt", "qt-third-party.txt", "python-incorporated.txt")
QT_VERSION = "6.12.0"
_LICENSE_NAME = re.compile(r"(LICEN[CS]E|COPYING|NOTICE|AUTHORS)", re.IGNORECASE)


def _key(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def runtime_distributions() -> list:
    seen, queue, found = set(), list(RUNTIME), []
    while queue:
        name = queue.pop(0)
        if _key(name) in seen:
            continue
        seen.add(_key(name))
        dist = metadata.distribution(name)
        found.append(dist)
        for text in dist.requires or []:
            requirement = Requirement(text)
            if requirement.marker is None or requirement.marker.evaluate({"extra": ""}):
                queue.append(requirement.name)
    return sorted(found, key=lambda d: _key(d.metadata["Name"]))


def folder(dist) -> str:
    return f"{_key(dist.metadata['Name'])}-{dist.version}"


def license_files() -> list[tuple[str, str]]:
    """(source file, destination folder) pairs for PyInstaller `datas`."""
    pairs = []
    for dist in runtime_distributions():
        own = [item for item in dist.files or [] if _LICENSE_NAME.search(item.name) and ".dist-info" in str(item)
               and "Commercial" not in item.name]  # Qt's commercial terms do not apply to this LGPL use
        pairs += [(str(dist.locate_file(item)), f"licenses/{folder(dist)}") for item in own]
        declared = (dist.metadata.get("License-Expression") or "") + (dist.metadata.get("License") or "")
        if not own and "LGPL-3.0" in declared and (TEXTS / "LGPL-3.0.txt").is_file():
            pairs.append((str(TEXTS / "LGPL-3.0.txt"), f"licenses/{folder(dist)}"))
    python = Path(sys.base_prefix) / "LICENSE.txt"
    if python.is_file():
        pairs.append((str(python), "licenses/python"))
    bootloader = metadata.distribution("pyinstaller")
    pairs += [(str(bootloader.locate_file(f)), "licenses/pyinstaller-bootloader")
              for f in bootloader.files or [] if f.name == "COPYING.txt"]
    pairs += [(str(TEXTS / name), "licenses/texts") for name in REQUIRED_TEXTS if (TEXTS / name).is_file()]
    return pairs


def missing_texts() -> list[str]:
    return [name for name in REQUIRED_TEXTS if not (TEXTS / name).is_file()]


def notices() -> str:
    lines = ["AW Telegram companion — third-party notices", "",
             "Python runtime: Python Software Foundation License (licenses/python); libraries it incorporates "
             "(OpenSSL, expat, mpdecimal, zlib, SQLite and others): licenses/texts/python-incorporated.txt.",
             "PyInstaller bootloader: GPL-2.0-or-later with the bootloader exception, which permits "
             "distributing the bundled executable (licenses/pyinstaller-bootloader).", ""]
    for dist in runtime_distributions():
        license = dist.metadata.get("License-Expression") or dist.metadata.get("License") or "see license files"
        lines.append(f"{dist.metadata['Name']} {dist.version}: {license.splitlines()[0]} (licenses/{folder(dist)})")
    lines += ["", f"PySide6 and shiboken6 {QT_VERSION} and the Qt {QT_VERSION} libraries are used under LGPL-3.0 "
              "(licenses/texts/LGPL-3.0.txt and GPL-3.0.txt). They are separate files in this folder, PySide6's "
              "Python files included, and can be replaced with compatible builds. Exact sources: "
              f"https://download.qt.io/official_releases/QtForPython/pyside6/ (pyside-setup-everywhere-src-{QT_VERSION}) "
              f"and https://download.qt.io/official_releases/qt/{QT_VERSION.rsplit('.', 1)[0]}/{QT_VERSION}/.",
              "Third-party code inside the Qt libraries: licenses/texts/qt-third-party.txt.",
              "Microsoft Visual C++ runtime DLLs: redistributed under the Visual Studio redistributable terms."]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    if sys.argv[1:] == ["check"]:
        missing = missing_texts()
        print("missing license texts: " + ", ".join(missing) if missing else "license texts complete")
        raise SystemExit(1 if missing else 0)
    print(notices())
