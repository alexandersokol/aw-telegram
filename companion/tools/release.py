"""Release tooling for .github/workflows/release.yml: the next version from git tags, stamping it into the app,
the Windows version resource, the notes and patch since the previous build, and the self-check report check.
Standard library only, so the workflow can run it with any Python.

    release.py next                          print the next MAJOR.MINOR.PATCH from ../VERSION and the git tags
    release.py stamp VERSION                 write VERSION into _version.py and pyproject.toml
    release.py previous                      print the previous release tag, or the first commit when there is none
    release.py notes VERSION PREV REPO OUT   release notes (REPO is owner/name)
    release.py patch PREV OUT                git diff PREV..HEAD
    release.py verify REPORT VERSION         check the --self-check report of the built app
"""
import re
import subprocess
import sys
from pathlib import Path

COMPANION = Path(__file__).resolve().parents[1]
ROOT = COMPANION.parent
NUMBER = r"(0|[1-9]\d*)"
TAG = re.compile(rf"v{NUMBER}\.{NUMBER}\.{NUMBER}")


def major_minor(text: str) -> str:
    value = text.strip()
    if not re.fullmatch(rf"{NUMBER}\.{NUMBER}", value):
        raise ValueError(f"VERSION must hold MAJOR.MINOR, for example 1.0; found {value!r}")
    return value


def next_version(line: str, tags: list[str]) -> str:
    """line (MAJOR.MINOR) plus one more than the highest patch tagged on that line, or 0."""
    patches = [int(m[3]) for m in map(TAG.fullmatch, tags) if m and f"{m[1]}.{m[2]}" == line]
    return f"{line}.{max(patches) + 1 if patches else 0}"


def git(*args: str, cwd: Path = ROOT, text: bool = True):
    done = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=cwd, check=True, capture_output=True)
    return done.stdout.decode("utf-8") if text else done.stdout


def git_tags(cwd: Path = ROOT) -> list[str]:
    return git("tag", "--list", cwd=cwd).split()


def previous_ref(cwd: Path = ROOT) -> str:
    """The highest release tag of any line, else the repository's first commit."""
    tags = [(tuple(map(int, m.groups())), m[0]) for m in map(TAG.fullmatch, git_tags(cwd)) if m]
    return max(tags)[1] if tags else git("rev-list", "--max-parents=0", "HEAD", cwd=cwd).split()[-1]


# Stamping

def _release_number(version: str) -> str:
    if not re.fullmatch(rf"{NUMBER}\.{NUMBER}\.{NUMBER}", version):
        raise ValueError(f"A release number is MAJOR.MINOR.PATCH, for example 1.0.7; found {version!r}")
    return version


def _rewrite(path: Path, pattern: str, value: str) -> None:
    text = path.read_bytes().decode("utf-8")  # keeps the file's line endings
    stamped, count = re.subn(pattern, lambda m: m[1] + value + m[2], text, count=1, flags=re.M)
    if count != 1:
        raise ValueError(f"No version line in {path}")
    path.write_bytes(stamped.encode("utf-8"))


def stamp(version: str, companion: Path = COMPANION) -> None:
    _release_number(version)
    _rewrite(companion / "src" / "aw_telegram" / "_version.py", r'^(VERSION = ")[^"]*(")', version)
    _rewrite(companion / "pyproject.toml", r'^(version = ")[^"]*(")', version)


def stamped_version(companion: Path = COMPANION) -> str:
    text = (companion / "src" / "aw_telegram" / "_version.py").read_text(encoding="utf-8")
    return re.search(r'(?m)^VERSION = "([^"]*)"', text)[1]


def file_version(version: str) -> tuple[int, int, int, int]:
    """(1, 0, 7, 0) for 1.0.7; a dev build such as 0.0.0-dev is (0, 0, 0, 0)."""
    numbers = tuple(int(n) for n in re.match(r"(\d+)\.(\d+)\.(\d+)", version).groups())
    return (*numbers, 0)


def version_info(version: str) -> str:
    """A PyInstaller version file: File Explorer's Properties shows FileVersion and ProductVersion."""
    numbers = file_version(version)
    dotted = ".".join(map(str, numbers))
    return f"""# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers={numbers},
    prodvers={numbers},
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
    ),
  kids=[
    StringFileInfo(
      [
      StringTable(
        '040904B0',
        [StringStruct('FileDescription', 'AW Telegram'),
        StringStruct('FileVersion', '{dotted}'),
        StringStruct('InternalName', 'aw-telegram'),
        StringStruct('OriginalFilename', 'aw-telegram.exe'),
        StringStruct('ProductName', 'AW Telegram'),
        StringStruct('ProductVersion', '{dotted}')])
      ]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"""


# Notes, patch and verification

def notes(version: str, previous: str, repo: str, cwd: Path = ROOT) -> str:
    commits = "\n".join("- " + line for line in git("log", "--format=%h %s", f"{previous}..HEAD", cwd=cwd).splitlines())
    files = git("diff", "--stat=200", f"{previous}..HEAD", cwd=cwd).rstrip()
    since = previous[:7] if re.fullmatch(r"[0-9a-f]{40}", previous) else previous
    return (f"This build is not code-signed, so Windows SmartScreen will warn before it runs: choose More info, "
            f"then Run anyway.\n\n## Commits since {since}\n\n{commits}\n\n## Changed files\n\n```text\n{files}\n```\n\n"
            f"Compare: https://github.com/{repo}/compare/{previous}...v{version}\n")


def patch(previous: str, cwd: Path = ROOT) -> bytes:
    return git("diff", f"{previous}..HEAD", cwd=cwd, text=False)


def verify_report(report: dict, version: str) -> list[str]:
    """Problems with the --self-check report: any check not ok, or a version other than the stamped one."""
    problems = [f"{name}: {value}" for name, value in report.items() if name != "version" and value != "ok"]
    if report.get("version") != version:
        problems.append(f"version: reported {report.get('version')!r}, stamped {version!r}")
    return problems


def main(argv: list[str]) -> int:
    import json
    sys.stdout.reconfigure(newline="\n")  # no CR for the shell to keep in $(...)
    command, args = (argv[0], argv[1:]) if argv else ("", [])
    if command == "next" and not args:
        print(next_version(major_minor((ROOT / "VERSION").read_text(encoding="utf-8")), git_tags()))
    elif command == "stamp" and len(args) == 1:
        stamp(args[0])
    elif command == "previous" and not args:
        print(previous_ref())
    elif command == "notes" and len(args) == 4:
        Path(args[3]).write_text(notes(args[0], args[1], args[2]), encoding="utf-8", newline="\n")
    elif command == "patch" and len(args) == 2:
        Path(args[1]).write_bytes(patch(args[0]))
    elif command == "verify" and len(args) == 2:
        problems = verify_report(json.loads(Path(args[0]).read_text(encoding="utf-8")), args[1])
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1 if problems else 0
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
