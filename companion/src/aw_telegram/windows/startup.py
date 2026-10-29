"""Current-user autostart through the HKCU Run key. No machine-wide or scheduled-task entries."""
import ntpath

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "AW Telegram"


class RunKey:
    """HKCU Run key; tests inject a fake with the same get/set/delete."""

    def _open(self, access):
        import winreg
        return winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, access)

    def get(self, name):
        import winreg
        try:
            with self._open(winreg.KEY_QUERY_VALUE) as key:
                value, kind = winreg.QueryValueEx(key, name)
        except FileNotFoundError:
            return None
        return value if kind == winreg.REG_SZ else None

    def set(self, name, value):
        import winreg
        with self._open(winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)

    def delete(self, name):
        import winreg
        try:
            with self._open(winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, name)
        except FileNotFoundError:
            pass


def startup_command(executable: str) -> str:
    """Quoted absolute executable, so a path with spaces cannot run a different program."""
    if (not isinstance(executable, str) or not ntpath.isabs(executable) or '"' in executable
            or not executable.lower().endswith(".exe")):
        raise ValueError("startup needs an absolute .exe path")
    return f'"{executable}" --background'


def set_startup(enabled: bool, executable: str, registry=None) -> None:
    registry = registry or RunKey()
    if enabled:
        registry.set(RUN_VALUE, startup_command(executable))
    else:
        registry.delete(RUN_VALUE)


def startup_enabled(executable: str, registry=None) -> bool:
    registry = registry or RunKey()
    try:
        return registry.get(RUN_VALUE) == startup_command(executable)
    except ValueError:
        return False
