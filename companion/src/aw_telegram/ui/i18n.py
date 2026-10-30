"""Qt's own Ukrainian strings (dialog buttons, text-field context menus) for LANG-01, and re-rendering on a language switch."""
from collections.abc import Callable
from pathlib import Path

import PySide6
from PySide6.QtCore import QLibraryInfo, QTranslator

_translator: QTranslator | None = None


def install_translations(app) -> bool:
    """Install qtbase_uk on app; False when no translation file is found."""
    global _translator
    if _translator is not None:
        return True
    translator = QTranslator(app)
    for directory in (QLibraryInfo.path(QLibraryInfo.LibraryPath.TranslationsPath),
                      str(Path(PySide6.__file__).parent / "translations")):
        if translator.load("qtbase_uk", directory):
            app.installTranslator(translator)
            _translator = translator
            return True
    return False


def remove_translations(app) -> None:
    global _translator
    if _translator is not None:
        app.removeTranslator(_translator)
        _translator = None


def apply_language(app, language: str) -> None:
    """Qt's strings are Ukrainian only for Ukrainian; English needs none."""
    if language == "uk":
        install_translations(app)
    else:
        remove_translations(app)


class Messages:
    """Labels whose text depends on state: each is remembered as a factory so a language switch re-renders it."""

    def __init__(self):
        self._messages: dict = {}

    def say(self, label, factory: Callable[[], str]) -> None:
        self._messages[label] = factory
        label.setText(factory())

    def clear(self, label) -> None:
        self._messages.pop(label, None)
        label.setText("")

    def retranslate(self) -> None:
        for label, factory in self._messages.items():
            label.setText(factory())
