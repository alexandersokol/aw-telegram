"""Qt's own Ukrainian strings (dialog buttons, text-field context menus) for LANG-01."""
from pathlib import Path

import PySide6
from PySide6.QtCore import QLibraryInfo, QTranslator


def install_translations(app) -> bool:
    """Install qtbase_uk on app; False when no translation file is found."""
    translator = QTranslator(app)
    for directory in (QLibraryInfo.path(QLibraryInfo.LibraryPath.TranslationsPath),
                      str(Path(PySide6.__file__).parent / "translations")):
        if translator.load("qtbase_uk", directory):
            app.installTranslator(translator)
            return True
    return False
