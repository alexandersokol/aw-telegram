"""One companion per Windows user: a later start asks the running one to open its window and exits."""
from PySide6.QtCore import QObject, Signal
from PySide6.QtNetwork import QLocalServer, QLocalSocket


class SingleInstance(QObject):
    activated = Signal()  # another start asked this instance to show itself

    def __init__(self, name: str):
        super().__init__()
        self.name = name
        self._server = None

    def acquire(self) -> bool:
        """True when this process is the only instance; False after handing over to a running one."""
        probe = QLocalSocket()
        probe.connectToServer(self.name)
        if probe.waitForConnected(500):
            probe.write(b"show")
            probe.flush()
            probe.waitForBytesWritten(500)
            probe.disconnectFromServer()
            return False
        server = QLocalServer(self)
        server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        if not server.listen(self.name):
            QLocalServer.removeServer(self.name)  # a stale Unix socket; Windows pipes vanish with their owner
            if not server.listen(self.name):
                return False  # lost a start race; the winner owns the name
        server.newConnection.connect(self._connection)
        self._server = server
        return True

    def _connection(self):
        while self._server is not None and self._server.hasPendingConnections():
            self._server.nextPendingConnection().deleteLater()
            self.activated.emit()

    def release(self) -> None:
        if self._server is not None:
            self._server.close()
            self._server = None
