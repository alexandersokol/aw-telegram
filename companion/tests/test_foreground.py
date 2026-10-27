"""Policy tests keep external OS state at one narrow boundary.

The fake records actual mutation requests to catch unsafe targets/duplicate calls;
return-state assertions alone would miss an unrelated window being minimized.
"""
from dataclasses import replace

import pytest

from aw_telegram.windows.foreground import ForegroundAdapter, ForegroundWindow


GAME = ForegroundWindow(hwnd=20, pid=200, executable=r"C:\Games\Game.exe",
                        fullscreen_primary=True, safe_process=True)


class Desktop:
    def __init__(self, window=GAME):
        self.window = window
        self.topmost = []
        self.minimized = []
        self.topmost_ok = True

    def foreground(self):
        return self.window

    def show_topmost(self, hwnd):
        self.topmost.append(hwnd)
        return self.topmost_ok

    def minimize(self, window):
        self.minimized.append(window.hwnd)
        return True

    def is_window(self, hwnd):
        return hwnd > 0


def test_iswindowvisible_does_not_establish_pixel_visibility():
    # Returning visible merely after a successful OS request would be false evidence.
    desktop = Desktop()
    result = ForegroundAdapter(native=desktop).reveal_overlay(10)
    assert result.state == "unconfirmed"
    assert result.reason == "topmost_requested"
    assert desktop.topmost == [10]
    assert desktop.minimized == []


def test_allowed_primary_fullscreen_is_minimized_once():
    desktop = Desktop()
    adapter = ForegroundAdapter(native=desktop, allowed_executables=[r"c:\games\game.EXE"])
    result = adapter.reveal_overlay(10)
    assert result.state == "unconfirmed"
    assert result.reason == "minimize_requested"
    assert result.minimized_hwnd == 20
    assert desktop.minimized == [20]
    assert desktop.topmost == [10, 10]


@pytest.mark.parametrize("window", [
    replace(GAME, fullscreen_primary=False),
    replace(GAME, safe_process=False),
    replace(GAME, executable=r"C:\Windows\System32\consent.exe"),
    replace(GAME, hwnd=10),
    None,
])
def test_unrelated_secondary_elevated_or_own_window_is_never_minimized(window):
    desktop = Desktop(window)
    result = ForegroundAdapter(native=desktop, allowed_executables=[GAME.executable]).reveal_overlay(10)
    assert desktop.minimized == []
    assert result.minimized_hwnd is None


def test_changed_foreground_is_never_minimized():
    class ChangedDesktop(Desktop):
        def show_topmost(self, hwnd):
            self.window = replace(GAME, pid=201)
            return super().show_topmost(hwnd)
    desktop = ChangedDesktop()
    ForegroundAdapter(native=desktop, allowed_executables=[GAME.executable]).reveal_overlay(10)
    assert desktop.minimized == []


@pytest.mark.parametrize("hwnd", [0, -1, True, 1 << 80])
def test_invalid_overlay_handle_is_failed_without_os_mutation(hwnd):
    desktop = Desktop()
    result = ForegroundAdapter(native=desktop).reveal_overlay(hwnd)
    assert result.state == "failed"
    assert result.reason == "invalid_overlay_handle"
    assert desktop.topmost == desktop.minimized == []


def test_blocked_topmost_does_not_trigger_minimization():
    desktop = Desktop()
    desktop.topmost_ok = False
    result = ForegroundAdapter(native=desktop, allowed_executables=[GAME.executable]).reveal_overlay(10)
    assert result.state == "unconfirmed"
    assert result.reason == "topmost_rejected"
    assert desktop.minimized == []


def test_relative_allowlist_path_is_rejected():
    with pytest.raises(ValueError):
        ForegroundAdapter(native=Desktop(), allowed_executables=["Game.exe"])
