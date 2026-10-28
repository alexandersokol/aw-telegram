"""Explicit Windows Credential Manager storage. No backend discovery or plaintext fallback."""
import hashlib
import re


class CredentialError(RuntimeError):
    pass


class WindowsVault:
    def __init__(self):
        backend = None
        try:
            from keyring.backends.Windows import WinVaultKeyring
            candidate = WinVaultKeyring()
            if (type(candidate).__module__ == 'keyring.backends.Windows'
                    and type(candidate).__name__ == 'WinVaultKeyring' and candidate.priority > 0):
                backend = candidate
        except Exception:
            pass
        if backend is None:
            raise CredentialError('Windows credential vault is unavailable')
        self._backend = backend

    @staticmethod
    def _service(backend_url: str) -> str:
        return 'aw-telegram:' + hashlib.sha256(backend_url.encode('utf-8')).hexdigest()

    def store(self, backend_url: str, device_id: str, secret: str) -> None:
        failed = False
        try:
            self._backend.set_password(self._service(backend_url), device_id, secret)
            if self._backend.get_password(self._service(backend_url), device_id) != secret:
                failed = True
        except Exception:
            failed = True
        if failed:
            raise CredentialError('Windows credential vault write failed')

    def load(self, backend_url: str, device_id: str) -> str:
        value = None
        try:
            value = self._backend.get_password(self._service(backend_url), device_id)
        except Exception:
            pass
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', value):
            raise CredentialError('Windows credential vault read failed')
        return value

    def delete(self, backend_url: str, device_id: str) -> None:
        failed = False
        try:
            self._backend.delete_password(self._service(backend_url), device_id)
        except Exception:
            failed = True
        if failed:
            raise CredentialError('Windows credential vault delete failed')
