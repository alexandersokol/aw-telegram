"""Task 11g: the Ukrainian/English catalogue, the system-language default and the literal scan."""
import ast
import re
import string
from pathlib import Path

import pytest

from aw_telegram import texts
from aw_telegram.windows import language

SOURCE = Path(__file__).resolve().parents[1] / "src" / "aw_telegram"
CYRILLIC = re.compile("[\u0400-\u04ff]")


def placeholders(text):
    return {name for _, name, _, _ in string.Formatter().parse(text) if name}


def cyrillic_literals(source: str) -> list[str]:
    """String literals with Cyrillic letters; docstrings and comments are documentation, not UI."""
    tree = ast.parse(source)
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            first = node.body[0] if node.body else None
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                docstrings.add(id(first.value))
    return [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)
            and id(node) not in docstrings and CYRILLIC.search(node.value)]


# Catalogue

def test_both_languages_have_the_same_keys():
    assert set(texts.UK) == set(texts.EN)


def test_every_text_is_present_and_has_the_same_placeholders():
    for catalogue in (texts.UK, texts.EN):
        assert all(isinstance(v, str) and v.strip() for v in catalogue.values())
    assert {k: placeholders(v) for k, v in texts.UK.items()} == {k: placeholders(v) for k, v in texts.EN.items()}


def test_english_is_english_and_ukrainian_is_ukrainian():
    bilingual = {"settings.language.title", "settings.language.system", "settings.language.uk", "settings.language.en"}
    for key in set(texts.UK) - bilingual:
        assert CYRILLIC.search(texts.UK[key]) or key == "status.aw.line", key
        assert not CYRILLIC.search(texts.EN[key]), key


def test_t_renders_in_the_current_language_with_params():
    texts.set_language("uk")
    assert texts.t("tray.quit") == "Вийти"
    assert texts.t("status.duration.hours", hours=1, minutes=5) == "1 год 05 хв"
    texts.set_language("en")
    assert texts.t("tray.quit") == "Quit"
    assert texts.t("status.duration.hours", hours=1, minutes=5) == "1 h 05 min"
    with pytest.raises(KeyError):
        texts.t("no.such.key")
    with pytest.raises(ValueError):
        texts.set_language("de")


def test_in_all_lists_every_language():
    assert texts.in_all("overlay.title") == {"Нагадування AW Telegram", "AW Telegram reminder"}


# Default language

@pytest.mark.parametrize("langid, expected", [
    (0x0422, "uk"),   # uk-UA
    (0x0022, "uk"),   # the neutral Ukrainian id
    (0x0409, "en"),   # en-US
    (0x0809, "en"),   # en-GB
    (0x0419, "en"),   # ru-RU: only Ukrainian switches the laptop to Ukrainian
    (0x0407, "en"),   # de-DE
])
def test_system_language_follows_the_windows_display_language(monkeypatch, langid, expected):
    monkeypatch.setattr(language, "ui_language_id", lambda: langid)
    assert language.system_language() == expected
    assert texts.effective("system") == expected


def test_system_language_is_english_when_the_call_fails(monkeypatch):
    def broken():
        raise OSError("no kernel32")
    monkeypatch.setattr(language, "ui_language_id", broken)
    assert language.system_language() == "en"


def test_the_native_call_asks_for_the_user_interface_language(monkeypatch):
    calls = []

    class Kernel32:
        def GetUserDefaultUILanguage(self):
            calls.append("called")
            return 0x0422

    monkeypatch.undo()  # the autouse mock hides the real wrapper
    monkeypatch.setattr(language.ctypes, "WinDLL", lambda name: Kernel32() if name == "kernel32" else None)
    assert language.ui_language_id() == 0x0422 and calls == ["called"]
    assert language.system_language() == "uk"


def test_an_explicit_choice_overrides_windows(monkeypatch):
    monkeypatch.setattr(language, "ui_language_id", lambda: 0x0409)
    assert texts.apply("uk") == "uk" and texts.language() == "uk"
    assert texts.apply("en") == "en" and texts.language() == "en"
    assert texts.apply("system") == "en"
    monkeypatch.setattr(language, "ui_language_id", lambda: 0x0422)
    assert texts.apply("system") == "uk" and texts.language() == "uk"
    with pytest.raises(ValueError):
        texts.apply("de")


# No Ukrainian literal outside the catalogue

def test_the_scan_finds_a_leftover_literal_but_not_docs_or_comments():
    leftover = 'def f():\n    """Документація"""\n    # коментар\n    return "Закрити"\n'
    assert cyrillic_literals(leftover) == ["Закрити"]
    assert cyrillic_literals('x = f"Стан {1}"')  # an f-string's text part counts
    assert cyrillic_literals('"""Модуль."""\nclass A:\n    """Клас."""\nx = "ok"\n') == []


def test_no_user_facing_ukrainian_literal_outside_texts():
    found = {}
    for path in sorted(SOURCE.rglob("*.py")):
        if path.name == "texts.py":
            continue
        literals = cyrillic_literals(path.read_text(encoding="utf-8"))
        if literals:
            found[str(path.relative_to(SOURCE))] = literals
    assert found == {}
