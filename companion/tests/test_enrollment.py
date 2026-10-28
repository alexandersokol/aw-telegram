"""Synthetic vault/HTTP fixtures; native vault proof is a separate owner-safe probe."""
import dataclasses
import importlib
import json
import sqlite3
import pytest


@pytest.fixture
def api():
    try:
        transport = importlib.import_module('aw_telegram.transport')
        credentials = importlib.import_module('aw_telegram.credentials')
    except ModuleNotFoundError:
        pytest.fail('Task 4 enrollment and credential boundary must exist')
    return transport, credentials


class MemoryVault:
    def __init__(self): self.values = {}
    def store(self, url, device_id, secret): self.values[(url, device_id)] = secret
    def load(self, url, device_id): return self.values[(url, device_id)]


SECRET = 'A' * 43
DEVICE = '00000000-0000-4000-8000-000000000001'
RESPONSE = json.dumps({'schemaVersion': 1, 'deviceId': DEVICE, 'deviceSecret': SECRET}).encode()


def bundle(t): return t.EnrollmentBundle('https://backend.example', 'E' * 43)


def test_enrollment_requires_explicit_host_acceptance_before_exchange(api):
    t, _ = api
    calls = []
    client = t.Transport(MemoryVault(), request=lambda *args: calls.append(args))
    with pytest.raises(t.EnrollmentError, match='host'):
        client.enroll(bundle(t))
    assert calls == []


def test_secret_goes_only_to_vault_and_identity_is_safe_for_config_sqlite_logs(api, tmp_path, caplog, capsys):
    t, _ = api
    vault = MemoryVault()
    requests = []
    def request(method, url, body, headers):
        requests.append((url, body, headers))
        return 200, RESPONSE
    identity = t.Transport(vault, request=request, accept_host=lambda host: host == 'backend.example').enroll(bundle(t))
    assert vault.load('https://backend.example', DEVICE) == SECRET
    assert dataclasses.asdict(identity) == {'deviceId': DEVICE, 'backendUrl': 'https://backend.example'}
    serialized = json.dumps(dataclasses.asdict(identity))
    (tmp_path / 'config.json').write_text(serialized)
    with sqlite3.connect(tmp_path / 'state.sqlite') as db:
        db.execute('CREATE TABLE config (value TEXT)')
        db.execute('INSERT INTO config VALUES (?)', (serialized,))
    for path in tmp_path.iterdir():
        assert SECRET.encode() not in path.read_bytes()
        assert ('E' * 43).encode() not in path.read_bytes()
    assert SECRET not in repr(identity) + caplog.text + capsys.readouterr().out
    assert requests[0][0] == 'https://backend.example/v1/enroll'
    assert json.loads(requests[0][1]) == {'schemaVersion': 1, 'secret': 'E' * 43}
    assert requests[0][2]['Content-Type'] == 'application/json'


@pytest.mark.parametrize('url', [
    'http://backend.example', 'https://user:pass@backend.example', 'https://backend.example?x=1',
    'https://backend.example#x', 'https://backend.example\\evil', 'https://backend.example\n',
    'https://backend.example/path', 'https:///missing', 'https://backend.example:99999',
    'https://backend.example/%2e%2e', 'https://backend.example@evil.example',
])
def test_invalid_or_ambiguous_backend_is_rejected_before_io(api, url):
    t, _ = api
    calls = []
    with pytest.raises((ValueError, t.EnrollmentError)):
        t.Transport(MemoryVault(), request=lambda *a: calls.append(a), accept_host=lambda h: True).enroll(t.EnrollmentBundle(url, 'E' * 43))
    assert calls == []


@pytest.mark.parametrize('status,body', [
    (302, RESPONSE), (307, RESPONSE), (401, b'secret-response'), (200, b'x' * 131073),
    (200, b'\xff'), (200, b'{"schemaVersion":1,"schemaVersion":1}'),
    (200, b'{"schemaVersion":1,"deviceId":"victim","deviceSecret":"bad"}'),
    (200, RESPONSE[:-1] + b',"extra":true}'),
], ids=['302','307','401','oversized','utf8','duplicate','malformed','extra'])
def test_redirects_errors_and_nonclosed_responses_never_store_secrets(api, status, body):
    t, _ = api
    vault = MemoryVault()
    with pytest.raises(t.EnrollmentError):
        t.Transport(vault, request=lambda *a: (status, body), accept_host=lambda h: True).enroll(bundle(t))
    assert vault.values == {}


def test_vault_failure_after_commit_surfaces_owner_recovery_without_secret_in_error(api):
    t, _ = api
    class BrokenVault(MemoryVault):
        def store(self, url, device_id, secret): raise RuntimeError(secret)
    with pytest.raises(t.EnrollmentError, match='owner') as error:
        t.Transport(BrokenVault(), request=lambda *a: (200, RESPONSE), accept_host=lambda h: True).enroll(bundle(t))
    assert SECRET not in str(error.value)
    assert error.value.__cause__ is None


def test_secret_bundle_repr_and_network_failure_are_redacted(api):
    t, _ = api
    assert 'E' * 43 not in repr(bundle(t))
    def fail(*args): raise RuntimeError(SECRET)
    with pytest.raises(t.EnrollmentError) as error:
        t.Transport(MemoryVault(), request=fail, accept_host=lambda h: True).enroll(bundle(t))
    assert SECRET not in str(error.value)
    assert error.value.__cause__ is None


def test_windows_vault_explicit_backend_rejects_fallback_and_redacts_backend_errors(api, monkeypatch):
    _, c = api
    import keyring.backends.Windows
    class BrokenBackend:
        priority = 1
        def set_password(self, *args): raise RuntimeError(SECRET)
    monkeypatch.setattr(keyring.backends.Windows, 'WinVaultKeyring', BrokenBackend)
    with pytest.raises(c.CredentialError, match='Windows'):
        c.WindowsVault()


def test_authenticated_calls_load_vault_and_keep_origin_fixed(api):
    t, _ = api
    vault = MemoryVault(); vault.store('https://backend.example', DEVICE, SECRET)
    requests = []
    def request(method, url, body, headers): requests.append((url,body,headers)); return 200, b'{"schemaVersion":1,"parents":[],"keys":[],"nextPage":null}'
    client = t.Transport(vault,request=request)
    identity = t.DeviceIdentity(DEVICE,'https://backend.example')
    result = client.list_access(identity)
    assert result['keys'] == []
    assert requests[0][0] == 'https://backend.example/v1/access'
    assert requests[0][2]['Authorization'] == 'Bearer ' + SECRET
    for path in ['https://evil.example/', '//evil.example/', '/v1/access?redirect=evil']:
        with pytest.raises(t.EnrollmentError): client.authenticated(identity,'GET',path)
    assert len(requests) == 1


@pytest.mark.parametrize('body', [
    b'{"schemaVersion":1,"parents":[],"keys":[],"nextPage":null,"secret":"leak"}',
    b'{"schemaVersion":true,"parents":[],"keys":[],"nextPage":null}',
    b'{"schemaVersion":1,"parents":[],"keys":[{"id":"key:bad","name":"x","status":"pending","expiresAt":"bad"}],"nextPage":null}',
], ids=['extra','boolean-version','invalid-key-row'])
def test_access_response_is_closed_and_validated(api, body):
    t, _ = api
    vault = MemoryVault(); vault.store('https://backend.example', DEVICE, SECRET)
    client = t.Transport(vault, request=lambda *args: (200, body))
    with pytest.raises(t.EnrollmentError):
        client.list_access(t.DeviceIdentity(DEVICE, 'https://backend.example'))


def test_pair_key_response_requires_canonical_secret_and_utc_expiry(api):
    t, _ = api
    vault = MemoryVault(); vault.store('https://backend.example', DEVICE, SECRET)
    invalid = json.dumps({'schemaVersion': 1, 'id': 'key:' + DEVICE, 'name': 'Мама', 'secret': 'bad', 'expiresAt': '2026-10-28T00:00:00.000Z'}).encode()
    with pytest.raises(t.EnrollmentError):
        t.Transport(vault, request=lambda *args: (201, invalid)).create_pair_key(t.DeviceIdentity(DEVICE, 'https://backend.example'), 'Мама')

