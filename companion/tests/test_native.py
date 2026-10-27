"""Read-only native ABI smoke checks on the real Windows desktop."""
import os
import sys
from dataclasses import replace

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows ABI only")


def test_native_rejects_invalid_overlay_without_mutation():
    from aw_telegram.windows._native import NativeWin32
    native = NativeWin32()
    assert not native.is_window(0)
    assert not native.show_topmost(0)
    assert not native.minimize(0)


def test_native_understands_own_pointer_sized_hwnd(qtbot):
    from aw_telegram.ui.overlay import OverlayWindow
    from aw_telegram.windows._native import NativeWin32
    overlay = OverlayWindow()
    qtbot.addWidget(overlay)
    native = NativeWin32()
    assert native.is_window(int(overlay.winId()))
    candidate = native.foreground()
    assert candidate is None or candidate.pid != os.getpid()


def test_minimize_revalidates_complete_identity_before_request():
    from aw_telegram.windows.foreground import ForegroundWindow
    from aw_telegram.windows._native import NativeWin32
    expected = ForegroundWindow(20, 200, r"C:\Games\Game.exe", True, True)
    native = object.__new__(NativeWin32)
    requests = []
    native._show = lambda hwnd, mode: requests.append((hwnd, mode)) or True
    native.foreground = lambda: expected
    assert native.minimize(expected)
    assert requests == [(20, 6)]
    native.foreground = lambda: replace(expected, executable=r"C:\Other\Unrelated.exe")
    assert not native.minimize(expected)
    assert requests == [(20, 6)]
