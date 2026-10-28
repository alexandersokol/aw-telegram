"""Write/read/delete one random synthetic credential; never enumerate or read user entries."""
import secrets
import uuid
from aw_telegram.credentials import WindowsVault, CredentialError


def main():
    vault = WindowsVault()
    backend = 'https://task4-vault-probe.invalid'
    device = str(uuid.uuid4())
    value = secrets.token_urlsafe(32)
    try:
        vault.store(backend, device, value)
        if vault.load(backend, device) != value:
            raise RuntimeError('Synthetic credential mismatch')
        print('Native WinVaultKeyring synthetic write/read: PASS')
    finally:
        # Only this process-created random username under the synthetic service.
        vault.delete(backend, device)
    try:
        vault.load(backend, device)
    except CredentialError:
        print('Native WinVaultKeyring synthetic delete/absent: PASS')
    else:
        raise RuntimeError('Synthetic credential cleanup failed')


if __name__ == '__main__':
    main()
