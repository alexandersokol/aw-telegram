"""One companion per Windows user session: a later start asks the running one to open its window and exits.

A session-local named mutex is the authority, so two near-simultaneous starts cannot both win (two
QLocalServers may listen on one pipe name on Windows). The pipe only carries the "show" handover; its
name includes the session ID, and only the same user may connect.
"""
import ctypes
from ctypes import wintypes

from PySide6.QtCore import QObject, Signal
from PySide6.QtNetwork import QLocalServer, QLocalSocket

ERROR_ALREADY_EXISTS = 183
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel32.CreateMutexW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
_kernel32.CreateMutexW.restype = wintypes.HANDLE
_kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
_kernel32.ProcessIdToSessionId.argtypes = (wintypes.DWORD, ctypes.POINTER(wintypes.DWORD))


def session_id() -> int:
    value = wintypes.DWORD()
    if not _kernel32.ProcessIdToSessionId(_kernel32.GetCurrentProcessId(), ctypes.byref(value)):
        raise ctypes.WinError(ctypes.get_last_error())
    return value.value


class SingleInstance(QObject):
    activated = Signal()  # another start asked this instance to show itself

    def __init__(self, name: str):
        super().__init__()
        self.name = name
        self.pipe = f"{name}-s{session_id()}"
        self._mutex = None
        self._server = None

    def acquire(self) -> bool:
        """True when this process is the only instance; False after handing over to a running one."""
        handle = _kernel32.CreateMutexW(None, False, "Local\\" + self.name)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
            _kernel32.CloseHandle(handle)
            self._hand_over()
            return False
        self._mutex = handle
        server = QLocalServer(self)
        server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        if server.listen(self.pipe):
            server.newConnection.connect(self._connection)
            self._server = server
        return True  # without the pipe a later start still exits; it just cannot open this window

    def _hand_over(self) -> None:
        """The winner may not be listening yet when two starts race; asking to show is best effort."""
        for _ in range(4):
            probe = QLocalSocket()
            probe.connectToServer(self.pipe)
            if probe.waitForConnected(500):
                probe.write(b"show")
                probe.flush()
                probe.waitForBytesWritten(500)
                probe.disconnectFromServer()
                return

    def _connection(self):
        while self._server is not None and self._server.hasPendingConnections():
            self._server.nextPendingConnection().deleteLater()
            self.activated.emit()

    def release(self) -> None:
        if self._server is not None:
            self._server.close()
            self._server = None
        if self._mutex is not None:
            _kernel32.CloseHandle(self._mutex)
            self._mutex = None
