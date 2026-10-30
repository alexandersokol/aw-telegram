"""Task 11b: version numbering, stamping, the Windows version resource and release notes (tools/release.py)."""
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import release  # noqa: E402

GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]


def git(repo, *args):
    return subprocess.run([*GIT, *args], cwd=repo, check=True, capture_output=True, text=True, encoding="utf-8").stdout


def commit(repo, name, text="x\n", message=None):
    (repo / name).parent.mkdir(parents=True, exist_ok=True)
    (repo / name).write_text(text, encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message or f"add {name}")
    return git(repo, "rev-parse", "HEAD").strip()


@pytest.fixture
def repo(tmp_path):
    git(tmp_path, "init", "-q", "-b", "main")
    return tmp_path


# Numbering

@pytest.mark.parametrize("tags, expected", [
    ([], "1.0.0"),
    (["v1.0.0"], "1.0.1"),
    (["v1.0.0", "v1.0.9", "v1.0.10", "v1.0.2"], "1.0.11"),  # numeric order, not alphabetical
    (["v1.1.4", "v2.0.7", "v1.0.3"], "1.0.4"),  # other MAJOR.MINOR lines are ignored
    (["v1.0.3-rc1", "v1.0.x", "1.0.8", "v1.00.8", "release-1.0.9", "v1.0.3.1"], "1.0.0"),  # not release tags
])
def test_the_patch_is_one_more_than_the_highest_tag_of_the_line(tags, expected):
    assert release.next_version("1.0", tags) == expected


def test_bumping_the_version_file_restarts_the_patch():
    assert release.next_version("1.1", ["v1.0.0", "v1.0.5"]) == "1.1.0"
    assert release.next_version("1.1", ["v1.0.5", "v1.1.0", "v1.1.1"]) == "1.1.2"


@pytest.mark.parametrize("text, expected", [("1.0\n", "1.0"), ("1.0\r\n", "1.0"), ("  12.3  ", "12.3")])
def test_the_version_file_holds_major_and_minor(text, expected):
    assert release.major_minor(text) == expected


@pytest.mark.parametrize("text", ["", "1", "1.0.0", "v1.0", "1.x", "1.0-dev", "01.0", "1.0\n2.0"])
def test_a_malformed_version_file_is_rejected(text):
    with pytest.raises(ValueError, match="MAJOR.MINOR"):
        release.major_minor(text)


def test_the_repository_version_file_is_valid():
    assert release.major_minor((Path(__file__).parents[2] / "VERSION").read_text(encoding="utf-8")) == "1.0"


def test_tags_come_from_git_and_the_next_version_from_the_real_ones(repo):
    commit(repo, "a.txt")
    assert release.next_version("1.0", release.git_tags(repo)) == "1.0.0"
    git(repo, "tag", "v1.0.0")
    commit(repo, "b.txt")
    git(repo, "tag", "v1.0.1")
    git(repo, "tag", "not-a-release")
    assert release.next_version("1.0", release.git_tags(repo)) == "1.0.2"


# Stamping

def test_stamping_rewrites_the_version_module_and_the_project_version(tmp_path):
    src = tmp_path / "src" / "aw_telegram"
    src.mkdir(parents=True)
    (src / "_version.py").write_bytes(b'"""doc"""\r\nVERSION = "0.0.0-dev"\r\n')
    (tmp_path / "pyproject.toml").write_bytes(b'[project]\r\nname = "x"\r\nversion = "0.1.0"\r\nrequires = ["a==1.0"]\r\n')
    release.stamp("1.0.7", tmp_path)
    assert (src / "_version.py").read_bytes() == b'"""doc"""\r\nVERSION = "1.0.7"\r\n'
    assert (tmp_path / "pyproject.toml").read_bytes() == b'[project]\r\nname = "x"\r\nversion = "1.0.7"\r\nrequires = ["a==1.0"]\r\n'
    assert release.stamped_version(tmp_path) == "1.0.7"


@pytest.mark.parametrize("version", ["1.0", "1.0.7.0", "v1.0.7", "1.0.x", "0.0.0-dev", ""])
def test_only_a_release_number_can_be_stamped(tmp_path, version):
    with pytest.raises(ValueError, match="MAJOR.MINOR.PATCH"):
        release.stamp(version, tmp_path)


def test_the_checked_in_module_and_project_keep_the_dev_values():
    root = Path(__file__).parents[1]
    assert release.stamped_version(root) == "0.0.0-dev"
    assert re.search(r'(?m)^version = "0\.1\.0"', (root / "pyproject.toml").read_text(encoding="utf-8"))


# Windows version resource

@pytest.mark.parametrize("version, numbers", [("1.0.7", (1, 0, 7, 0)), ("12.3.45", (12, 3, 45, 0)),
                                              ("0.0.0-dev", (0, 0, 0, 0))])
def test_file_and_product_version_are_the_release_number_with_a_zero(version, numbers):
    assert release.file_version(version) == numbers
    info = release.version_info(version)
    dotted = ".".join(map(str, numbers))
    assert f"filevers={numbers}" in info and f"prodvers={numbers}" in info
    assert f"StringStruct('FileVersion', '{dotted}')" in info and f"StringStruct('ProductVersion', '{dotted}')" in info


def test_the_version_resource_is_a_pyinstaller_version_file(tmp_path):
    from PyInstaller.utils.win32.versioninfo import load_version_info_from_text_file
    path = tmp_path / "version-info.txt"
    path.write_text(release.version_info("1.0.7"), encoding="utf-8")
    info = load_version_info_from_text_file(str(path))
    assert (info.ffi.fileVersionMS, info.ffi.fileVersionLS) == (1 << 16, 7 << 16) and "AW Telegram" in str(info)


# Previous build, notes and patch

def test_the_previous_build_is_the_highest_release_tag_of_any_line(repo):
    first = commit(repo, "a.txt")
    assert release.previous_ref(repo) == first
    git(repo, "tag", "v1.0.0")
    commit(repo, "b.txt")
    git(repo, "tag", "v1.0.10")
    git(repo, "tag", "v1.0.9")
    commit(repo, "c.txt")
    git(repo, "tag", "v1.1.0")
    git(repo, "tag", "v1.0.99")
    assert release.previous_ref(repo) == "v1.1.0"


def test_notes_list_commits_files_and_the_compare_link_after_the_unsigned_line(repo):
    commit(repo, "old.txt", message="first")
    git(repo, "tag", "v1.0.0")
    commit(repo, "companion/a.py", message="feat: add a")
    commit(repo, "contracts/b.json", message="fix: change b")
    text = release.notes("1.0.1", "v1.0.0", "owner/repo", repo)
    lines = text.splitlines()
    assert "not code-signed" in lines[0] and "SmartScreen" in lines[0]
    assert re.search(r"(?m)^- [0-9a-f]{7,} fix: change b$", text) and re.search(r"(?m)^- [0-9a-f]{7,} feat: add a$", text)
    assert "first" not in text and "old.txt" not in text
    assert "companion/a.py" in text and "contracts/b.json" in text
    assert "https://github.com/owner/repo/compare/v1.0.0...v1.0.1" in text


def test_notes_for_the_first_release_start_at_the_first_commit(repo):
    first = commit(repo, "a.txt", message="root")
    commit(repo, "b.txt", message="second")
    text = release.notes("1.0.0", release.previous_ref(repo), "owner/repo", repo)
    assert f"compare/{first}...v1.0.0" in text and "second" in text
    assert f"## Commits since {first[:7]}\n" in text


def test_the_patch_is_the_git_diff_since_the_previous_build(repo):
    commit(repo, "a.txt", "one\n")
    git(repo, "tag", "v1.0.0")
    commit(repo, "a.txt", "two\n")
    commit(repo, "b.txt", "new\n")
    data = release.patch("v1.0.0", repo)
    assert data == subprocess.run(["git", "diff", "v1.0.0..HEAD"], cwd=repo, check=True, capture_output=True).stdout
    assert b"+two" in data and b"b/b.txt" in data


# Verifying the self-check report

def test_the_report_must_be_all_ok_with_the_stamped_version():
    good = {"schemas": "ok", "timezone": "ok", "vault": "ok", "qt": "ok", "translations": "ok", "version": "1.0.7"}
    assert release.verify_report(good, "1.0.7") == []
    assert release.verify_report({**good, "version": "0.0.0-dev"}, "1.0.7")
    assert release.verify_report({k: v for k, v in good.items() if k != "version"}, "1.0.7")
    assert release.verify_report({**good, "vault": "FileNotFoundError"}, "1.0.7") == ["vault: FileNotFoundError"]


def test_the_command_line_prints_values_without_a_carriage_return():
    for command in ("next", "previous"):
        out = subprocess.run([sys.executable, "-I", release.__file__, command], capture_output=True, check=True).stdout
        assert out.endswith(b"\n") and b"\r" not in out


def test_the_command_line_verifies_a_report_file(tmp_path):
    path = tmp_path / "report.json"
    path.write_text(json.dumps({"qt": "ok", "version": "1.0.7"}), encoding="utf-8")

    def run(version):
        return subprocess.run([sys.executable, "-I", release.__file__, "verify", str(path), version],
                              capture_output=True, text=True)

    assert run("1.0.7").returncode == 0
    bad = run("1.0.8")
    assert bad.returncode == 1 and "version" in bad.stderr
