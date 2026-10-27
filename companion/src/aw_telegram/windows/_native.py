"""Pointer-safe, bounded Win32 calls. Unknown identity is always ineligible.

All handles have explicit ctypes signatures (including 64-bit return values).
Reads use fixed buffers; no synchronous messages to another process are sent.
"""
import ctypes as C
from ctypes import wintypes as W
import ntpath
import os

from .foreground import ForegroundWindow


class MONITORINFO(C.Structure):
    _fields_ = [("cbSize", W.DWORD), ("rcMonitor", W.RECT),
                ("rcWork", W.RECT), ("dwFlags", W.DWORD)]


def _bind(dll, name, restype, *argtypes):
    function = getattr(dll, name)
    function.restype = restype
    function.argtypes = list(argtypes)
    return function


class NativeWin32:
    def __init__(self):
        user = C.WinDLL("user32", use_last_error=True)
        kernel = C.WinDLL("kernel32", use_last_error=True)
        advapi = C.WinDLL("advapi32", use_last_error=True)
        dwm = C.WinDLL("dwmapi", use_last_error=True)
        self._foreground = _bind(user, "GetForegroundWindow", W.HWND)
        self._iswindow = _bind(user, "IsWindow", W.BOOL, W.HWND)
        self._visible = _bind(user, "IsWindowVisible", W.BOOL, W.HWND)
        self._iconic = _bind(user, "IsIconic", W.BOOL, W.HWND)
        self._hung = _bind(user, "IsHungAppWindow", W.BOOL, W.HWND)
        self._pid = _bind(user, "GetWindowThreadProcessId", W.DWORD, W.HWND, C.POINTER(W.DWORD))
        self._class = _bind(user, "GetClassNameW", C.c_int, W.HWND, W.LPWSTR, C.c_int)
        self._ancestor = _bind(user, "GetAncestor", W.HWND, W.HWND, W.UINT)
        self._owner = _bind(user, "GetWindow", W.HWND, W.HWND, W.UINT)
        self._style = _bind(user, "GetWindowLongPtrW" if C.sizeof(C.c_void_p) == 8
                            else "GetWindowLongW", C.c_ssize_t, W.HWND, C.c_int)
        self._monitor = _bind(user, "MonitorFromWindow", W.HANDLE, W.HWND, W.DWORD)
        self._monitorinfo = _bind(user, "GetMonitorInfoW", W.BOOL, W.HANDLE, C.POINTER(MONITORINFO))
        self._clientrect = _bind(user, "GetClientRect", W.BOOL, W.HWND, C.POINTER(W.RECT))
        self._clientpoint = _bind(user, "ClientToScreen", W.BOOL, W.HWND, C.POINTER(W.POINT))
        self._cloaked = _bind(dwm, "DwmGetWindowAttribute", W.LONG, W.HWND,
                              W.DWORD, C.c_void_p, W.DWORD)
        self._openprocess = _bind(kernel, "OpenProcess", W.HANDLE, W.DWORD, W.BOOL, W.DWORD)
        self._close = _bind(kernel, "CloseHandle", W.BOOL, W.HANDLE)
        self._image = _bind(kernel, "QueryFullProcessImageNameW", W.BOOL, W.HANDLE,
                            W.DWORD, W.LPWSTR, C.POINTER(W.DWORD))
        self._session = _bind(kernel, "ProcessIdToSessionId", W.BOOL, W.DWORD, C.POINTER(W.DWORD))
        self._windowsdir = _bind(kernel, "GetWindowsDirectoryW", W.UINT, W.LPWSTR, W.UINT)
        self._token = _bind(advapi, "OpenProcessToken", W.BOOL, W.HANDLE,
                            W.DWORD, C.POINTER(W.HANDLE))
        self._tokeninfo = _bind(advapi, "GetTokenInformation", W.BOOL, W.HANDLE,
                                C.c_int, C.c_void_p, W.DWORD, C.POINTER(W.DWORD))
        self._setpos = _bind(user, "SetWindowPos", W.BOOL, W.HWND, W.HWND,
                             C.c_int, C.c_int, C.c_int, C.c_int, W.UINT)
        self._show = _bind(user, "ShowWindowAsync", W.BOOL, W.HWND, C.c_int)

    def _process_id(self, hwnd):
        pid = W.DWORD()
        if not self._pid(hwnd, C.byref(pid)):
            return 0
        return pid.value

    def is_window(self, hwnd):
        # The adapter may change Z order only for a window owned by this process.
        return bool(self._iswindow(hwnd)) and self._process_id(hwnd) == os.getpid()

    def show_topmost(self, hwnd):
        if not self.is_window(hwnd):
            return False
        # NOSIZE | NOMOVE | NOACTIVATE | SHOWWINDOW | ASYNCWINDOWPOS
        return bool(self._setpos(hwnd, W.HWND(-1), 0, 0, 0, 0, 0x4053))

    def minimize(self, expected):
        # Re-read immediately; OS races cannot be eliminated, so default deny.
        window = self.foreground()
        if window is None or window != expected or not window.safe_process or not window.fullscreen_primary:
            return False
        return bool(self._show(window.hwnd, 6))  # SW_MINIMIZE; async request, not proof.

    def foreground(self):
        hwnd = self._foreground()
        if not hwnd or not self._iswindow(hwnd):
            return None
        pid = self._process_id(hwnd)
        if pid <= 4 or pid == os.getpid():
            return None
        if not self._visible(hwnd) or self._iconic(hwnd) or self._hung(hwnd):
            return None
        if self._ancestor(hwnd, 2) != hwnd or self._owner(hwnd, 4):
            return None  # GA_ROOT, GW_OWNER: child/owned dialogs cannot qualify.
        window_class = C.create_unicode_buffer(256)
        if not self._class(hwnd, window_class, len(window_class)):
            return None
        if window_class.value in {"#32770", "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"}:
            return None
        if self._style(hwnd, -16) & (0x40000000 | 0x08000000):
            return None  # WS_CHILD | WS_DISABLED
        cloaked = W.DWORD()
        if self._cloaked(hwnd, 14, C.byref(cloaked), C.sizeof(cloaked)) != 0 or cloaked.value:
            return None
        monitor = self._monitor(hwnd, 0)  # No nearest-monitor fallback.
        info = MONITORINFO()
        info.cbSize = C.sizeof(info)
        if not monitor or not self._monitorinfo(monitor, C.byref(info)) or not info.dwFlags & 1:
            return None
        client, origin = W.RECT(), W.POINT(0, 0)
        if not self._clientrect(hwnd, C.byref(client)) or not self._clientpoint(hwnd, C.byref(origin)):
            return None
        rect = info.rcMonitor
        fullscreen = (origin.x, origin.y, client.right, client.bottom) == (
            rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
        if not fullscreen:
            return None
        executable = self._safe_executable(pid)
        if executable is None or self._foreground() != hwnd or self._process_id(hwnd) != pid:
            return None
        return ForegroundWindow(int(hwnd), pid, executable, True, True)

    def _safe_executable(self, pid):
        own_session, session = W.DWORD(), W.DWORD()
        if (not self._session(os.getpid(), C.byref(own_session))
                or not self._session(pid, C.byref(session)) or session.value != own_session.value):
            return None
        process = self._openprocess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION only.
        if not process:
            return None
        token = W.HANDLE()
        try:
            if not self._token(process, 0x0008, C.byref(token)):  # TOKEN_QUERY
                return None
            elevation, used = W.DWORD(), W.DWORD()
            if (not self._tokeninfo(token, 20, C.byref(elevation), C.sizeof(elevation), C.byref(used))
                    or used.value != C.sizeof(elevation) or elevation.value):
                return None
            image, size = C.create_unicode_buffer(32768), W.DWORD(32768)
            if not self._image(process, 0, image, C.byref(size)):
                return None
            windows = C.create_unicode_buffer(32768)
            length = self._windowsdir(windows, len(windows))
            if not length or length >= len(windows):
                return None
            path = ntpath.normcase(ntpath.normpath(image.value))
            system = ntpath.normcase(ntpath.normpath(windows.value))
            if path == system or path.startswith(system + "\\"):
                return None
            return path
        finally:
            if token:
                self._close(token)
            self._close(process)
