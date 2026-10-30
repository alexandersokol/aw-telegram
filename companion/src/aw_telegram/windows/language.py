"""The Windows display language, for the «Системна / System» choice of the app language."""
import ctypes

UKRAINIAN = 0x22  # primary language id of uk-UA (LANG_UKRAINIAN)


def ui_language_id() -> int:
    """GetUserDefaultUILanguage: the signed-in user's Windows display language as a LANGID."""
    return int(ctypes.WinDLL("kernel32").GetUserDefaultUILanguage())


def system_language() -> str:
    """'uk' when Windows displays Ukrainian, otherwise (or when it cannot be read) 'en'."""
    try:
        return "uk" if ui_language_id() & 0x3FF == UKRAINIAN else "en"
    except (OSError, AttributeError, ValueError):
        return "en"
