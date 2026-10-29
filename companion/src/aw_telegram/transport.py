"""TLS-verified, bounded transport. Enrollment returns only a vault-backed public identity."""
import base64
from dataclasses import dataclass
import http.client
import json
import re
import ssl
import time
from typing import Callable, Protocol
from urllib.parse import urlsplit, quote

from .models import parse_json, MAX_BODY_BYTES, SyncRequest, SyncResponse, wire_bytes
from .clock import parse_instant


MAX_CAREGIVERS = 10  # active caregivers per laptop (ACCESS-07)


class EnrollmentError(RuntimeError):
    pass


class SyncError(EnrollmentError):
    def __init__(self, *, retryable=False, retry_after=None, reason=None):
        super().__init__('Backend request failed')
        self.retryable, self.retry_after, self.reason = retryable, retry_after, reason


class VaultUnavailable(EnrollmentError):
    """The local Windows credential vault could not supply the bearer; nothing was sent."""


class CredentialError(SyncError):
    pass


class Vault(Protocol):
    def store(self, backend_url: str, device_id: str, secret: str) -> None: ...
    def load(self, backend_url: str, device_id: str) -> str: ...


class EnrollmentBundle:
    # Deliberately no secret-bearing dataclass repr/asdict.
    __slots__ = ('backendUrl', 'secret')
    def __init__(self, backendUrl: str, secret: str):
        self.backendUrl, self.secret = backendUrl, secret


@dataclass(frozen=True, slots=True)
class DeviceIdentity:
    deviceId: str
    backendUrl: str


_UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')


def _secret(value, size=32):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        return False
    try:
        decoded = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
        return len(decoded) == size and base64.urlsafe_b64encode(decoded).decode().rstrip('=') == value
    except (ValueError, TypeError):
        return False


def canonical_backend(value: str) -> str:
    if (not isinstance(value, str) or not value or any(ord(c) <= 32 or ord(c) == 127 for c in value)
            or '\\' in value or '?' in value or '#' in value or '@' in value):
        raise EnrollmentError('Invalid backend URL')
    result = None
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
        if (parsed.scheme == 'https' and hostname and parsed.path in ('', '/')
                and parsed.username is None and parsed.password is None and not parsed.query and not parsed.fragment
                and re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?', hostname)
                and all(part and len(part) <= 63 and not part.startswith('-') and not part.endswith('-') for part in hostname.split('.'))
                and (port is None or 1 <= port <= 65535)):
            result = 'https://' + hostname.lower() + (f':{port}' if port and port != 443 else '')
    except (ValueError, UnicodeError):
        pass
    if result is None:
        raise EnrollmentError('Invalid backend URL')
    return result


def _network(method: str, url: str, body: bytes | None, headers: dict) -> tuple[int, bytes]:
    parsed = urlsplit(url)
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=10,
                                            context=ssl.create_default_context())
    deadline = time.monotonic() + 10
    try:
        connection.request(method, parsed.path + ('?' + parsed.query if parsed.query else ''), body=body, headers=headers)
        channel = connection.sock
        channel.settimeout(max(0.001, deadline - time.monotonic()))
        response = connection.getresponse()
        # http.client never follows redirects. Bound data even when Content-Length is absent or dishonest.
        chunks, size = [], 0
        while size <= MAX_BODY_BYTES:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Backend deadline exceeded')
            channel.settimeout(remaining)
            chunk = response.read1(min(16384, MAX_BODY_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        raw = b''.join(chunks)
        return response.status, raw, {"Retry-After": response.getheader("Retry-After")}
    finally:
        connection.close()


class Transport:
    def __init__(self, vault: Vault | None = None, *, request: Callable | None = None,
                 accept_host: Callable[[str], bool] | None = None, identity: DeviceIdentity | None = None):
        if vault is None:
            from .credentials import WindowsVault
            vault = WindowsVault()
        self.identity = identity
        self._vault = vault
        self._request = request or _network
        self._accept_host = accept_host

    def _exchange(self, method, url, body, headers, *, empty=False):
        status, result, retry_after = None, None, None
        try:
            reply = self._request(method, url, body, headers)
            status, raw = reply[:2]
            if len(reply) == 3:
                value = reply[2].get('Retry-After')
                if isinstance(value, str) and value.isascii() and value.isdigit():
                    retry_after = min(300, max(1, int(value)))
            if isinstance(raw, bytes) and len(raw) <= MAX_BODY_BYTES and 200 <= status < 300:
                result = {} if empty and status == 204 and not raw else parse_json(raw)
        except Exception:
            pass
        if result is None:
            if status in (401, 403):
                raise CredentialError()
            raise SyncError(retryable=status is None or status == 429 or isinstance(status, int) and status >= 500,
                            retry_after=retry_after)
        return result

    def sync(self, request: SyncRequest) -> SyncResponse:
        if self.identity is None:
            raise CredentialError()
        request = request.to_wire() if isinstance(request, SyncRequest) else SyncRequest.from_wire(request).to_wire()
        try:
            result = self.authenticated(self.identity, 'POST', '/v2/sync', request)
            response = SyncResponse.from_wire(result)
            if response.requestSequence != request['sequence']:
                raise ValueError('response sequence mismatch')
            return response
        except SyncError:
            raise
        except VaultUnavailable:
            raise SyncError(retryable=True, reason='vault') from None
        except EnrollmentError:
            raise CredentialError() from None
        except (ValueError, TypeError):
            raise SyncError() from None

    def enroll(self, bundle: EnrollmentBundle) -> DeviceIdentity:
        backend = canonical_backend(bundle.backendUrl)
        if not _secret(bundle.secret):
            raise EnrollmentError('Invalid enrollment bundle')
        host = urlsplit(backend).netloc
        accepted = False
        try:
            accepted = self._accept_host is not None and self._accept_host(host) is True
        except Exception:
            pass
        if not accepted:
            raise EnrollmentError('Explicit backend host acceptance is required')
        body = json.dumps({'schemaVersion': 1, 'secret': bundle.secret}, separators=(',', ':')).encode()
        result = self._exchange('POST', backend + '/v1/enroll', body, {'Content-Type': 'application/json', 'Accept': 'application/json'})
        if (not isinstance(result, dict) or set(result) != {'schemaVersion', 'deviceId', 'deviceSecret'}
                or type(result['schemaVersion']) is not int or result['schemaVersion'] != 1
                or not isinstance(result['deviceId'], str) or not _UUID.fullmatch(result['deviceId'])
                or not _secret(result['deviceSecret'])):
            raise EnrollmentError('Invalid enrollment response; owner recovery may be required')
        failed = False
        try:
            self._vault.store(backend, result['deviceId'], result['deviceSecret'])
        except Exception:
            failed = True
        if failed:
            raise EnrollmentError('Credential storage failed; ask the owner to revoke the orphan enrollment and issue a new one')
        return DeviceIdentity(result['deviceId'], backend)

    def authenticated(self, identity: DeviceIdentity, method: str, path: str, payload=None):
        backend = canonical_backend(identity.backendUrl)
        if not isinstance(identity.deviceId, str) or not _UUID.fullmatch(identity.deviceId):
            raise EnrollmentError('Invalid device identity')
        allowed = ((method == 'GET' and re.fullmatch(r'/v1/access(?:\?page=[0-9a-f-]{36})?', path))
                   or (method == 'POST' and path in ('/v1/pair-keys', '/v2/sync'))
                   or (method == 'DELETE' and re.fullmatch(r'/v1/access/(?:key:[0-9a-f-]{36}|parent:[1-9][0-9]{0,15}:[0-9a-f-]{36})', path)))
        if not allowed:
            raise EnrollmentError('Invalid authenticated endpoint')
        secret = None
        try:
            secret = self._vault.load(backend, identity.deviceId)
        except Exception:
            pass
        if not _secret(secret):
            raise VaultUnavailable('Credential vault is unavailable')
        body = wire_bytes(payload) if payload is not None else None
        if body is not None and len(body) > MAX_BODY_BYTES:
            raise EnrollmentError('Request exceeds transport bound')
        return self._exchange(method, backend + path, body,
                              {'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json', 'Accept': 'application/json'}, empty=method == 'DELETE')

    def list_access(self, identity: DeviceIdentity, page: str | None = None):
        result = self.authenticated(identity, 'GET', '/v1/access' + ('?page=' + quote(page, safe='') if page else ''))
        valid = False
        try:
            valid = (_envelope(result, {'schemaVersion', 'parents', 'keys', 'nextPage'})
                     and isinstance(result['parents'], list) and len(result['parents']) <= MAX_CAREGIVERS
                     and isinstance(result['keys'], list) and len(result['keys']) <= 50
                     and (result['nextPage'] is None or _uuid(result['nextPage']))
                     and all(_parent_row(row) for row in result['parents'])
                     and all(_key_row(row) for row in result['keys'])
                     and len({row['id'] for row in result['parents'] + result['keys']}) == len(result['parents']) + len(result['keys']))
        except (ValueError, TypeError, KeyError):
            pass
        if not valid:
            raise EnrollmentError('Invalid access response')
        return result

    def create_pair_key(self, identity: DeviceIdentity, name: str):
        if not _label(name):
            raise EnrollmentError('Invalid key label')
        result = self.authenticated(identity, 'POST', '/v1/pair-keys', {'schemaVersion': 1, 'name': name})
        valid = False
        try:
            valid = (_envelope(result, {'schemaVersion', 'id', 'name', 'secret', 'expiresAt'})
                     and _key_id(result['id']) and result['name'] == name and _secret(result['secret'], 16)
                     and parse_instant(result['expiresAt']) is not None)
        except (ValueError, TypeError, KeyError):
            pass
        if not valid:
            raise EnrollmentError('Invalid pairing key response')
        return result

    def revoke_access(self, identity: DeviceIdentity, access_id: str):
        return self.authenticated(identity, 'DELETE', '/v1/access/' + access_id)


def _uuid(value):
    return isinstance(value, str) and _UUID.fullmatch(value) is not None


def _label(value):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 80 and not any(0xD800 <= ord(c) <= 0xDFFF for c in value)


def _envelope(value, keys):
    return isinstance(value, dict) and set(value) == keys and type(value.get('schemaVersion')) is int and value['schemaVersion'] == 1


def _key_id(value):
    return isinstance(value, str) and value.startswith('key:') and _uuid(value[4:])


def _key_row(row):
    return (isinstance(row, dict) and set(row) == {'id', 'name', 'status', 'expiresAt'} and _key_id(row['id'])
            and _label(row['name']) and row['status'] in ('pending', 'expired', 'revoked')
            and parse_instant(row['expiresAt']) is not None)


def _parent_row(row):
    if not isinstance(row, dict) or set(row) != {'id', 'name', 'userId', 'status'} or not _label(row['name']) or row['status'] != 'active':
        return False
    user = row['userId']
    if not isinstance(user, str) or not re.fullmatch(r'[1-9][0-9]{0,15}', user) or int(user) > 9007199254740991:
        return False
    return isinstance(row['id'], str) and row['id'].startswith('parent:' + user + ':') and _uuid(row['id'][len('parent:' + user + ':'):])
