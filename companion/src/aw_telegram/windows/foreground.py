"""Conservative desktop presentation without pixel-visibility claims."""
from dataclasses import dataclass
import ntpath
import struct
import sys
from typing import Literal


@dataclass(frozen=True)
class PresentationResult:
    state: Literal["visible", "unconfirmed", "failed"]
    reason: str
    minimized_hwnd: int | None = None


@dataclass(frozen=True)
class ForegroundWindow:
    hwnd: int
    pid: int
    executable: str
    fullscreen_primary: bool
    safe_process: bool


class ForegroundAdapter:
    def __init__(self, native=None, allowed_executables=()):
        self._native = native
        self._allowed = set()
        for path in allowed_executables:
            if not ntpath.isabs(path) or not ntpath.splitdrive(path)[0]:
                raise ValueError("allowed executable must be an absolute Windows path")
            self._allowed.add(ntpath.normcase(ntpath.normpath(path)))

    def reveal_overlay(self, hwnd: int) -> PresentationResult:
        """One topmost request; at most one opt-in fullscreen minimization.

        Native success means a request was accepted, never that pixels were seen.
        No SetForegroundWindow, input attachment, hooks, injection, or polling.
        Capture the foreground before showing/activating the Qt overlay.
        """
        if type(hwnd) is not int or not 0 < hwnd < (1 << (struct.calcsize("P") * 8)):
            return PresentationResult("failed", "invalid_overlay_handle")
        try:
            if self._native is None:
                if sys.platform != "win32":
                    return PresentationResult("unconfirmed", "unsupported_platform")
                from ._native import NativeWin32
                self._native = NativeWin32()
            native = self._native
            before = native.foreground()
            if not native.is_window(hwnd):
                return PresentationResult("failed", "invalid_overlay_handle")
            if not native.show_topmost(hwnd):
                return PresentationResult("unconfirmed", "topmost_rejected")
            if (before is not None and before.hwnd != hwnd
                    and before.fullscreen_primary and before.safe_process
                    and ntpath.normcase(ntpath.normpath(before.executable)) in self._allowed
                    and native.foreground() == before):
                if not native.minimize(before):
                    return PresentationResult("unconfirmed", "minimize_rejected")
                # Reassert once only, asynchronously; never steal focus in a loop.
                native.show_topmost(hwnd)
                return PresentationResult("unconfirmed", "minimize_requested", before.hwnd)
            return PresentationResult("unconfirmed", "topmost_requested")
        except OSError:
            return PresentationResult("unconfirmed", "windows_request_failed")
