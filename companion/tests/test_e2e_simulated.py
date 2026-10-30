"""Task 10c cross-process end-to-end: the real companion (Transport, LocalStore, SyncCoordinator, Scheduler)
against the compiled bot backend served on loopback by bot/scripts/e2e-server.ts. ActivityWatch and Telegram are
the only stand-ins: synthetic observations on one side, a recording Telegram on the other. Nothing leaves the host.
"""
import http.client
import json
import shutil
import subprocess
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from aw_telegram.clock import format_instant, kyiv_date, parse_instant
from aw_telegram.models import ActionAck
from aw_telegram.scheduler import Hide, Scheduler
from aw_telegram.storage import LocalStore
from aw_telegram.sync import Observation, SyncCoordinator
from aw_telegram.transport import EnrollmentBundle, SyncError, Transport
from aw_telegram.windows.foreground import PresentationResult

BOT = Path(__file__).parents[2] / "bot"
BACKEND = "https://backend.e2e.test"
SHOWN = PresentationResult("unconfirmed", "topmost_requested")
GAMES = {"id": '["Games"]', "path": ["Games"]}
MIN = 60_000


@pytest.fixture(scope="module")
def server():
    node, npm = shutil.which("node"), shutil.which("npm.cmd") or shutil.which("npm")
    if node is None or npm is None:
        pytest.skip("Node.js is needed for the cross-process end-to-end test")
    subprocess.run([npm, "run", "build"], cwd=BOT, check=True, capture_output=True, timeout=300)
    process = subprocess.Popen([node, "--experimental-strip-types", "--no-warnings", "scripts/e2e-server.ts"],
                               cwd=BOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = process.stdout.readline()
        assert line.startswith("PORT "), process.stderr.read()
        yield int(line.split()[1])
    finally:
        process.terminate()
        process.wait(timeout=10)


class Vault:
    def __init__(self):
        self.values = {}

    def store(self, url, device, secret):
        self.values[(url, device)] = secret

    def load(self, url, device):
        return self.values[(url, device)]


class World:
    def __init__(self, port, tmp_path):
        self.port, self.path = port, tmp_path / "companion.sqlite"
        self.now, self.mono, self.online = parse_instant("2026-10-28T06:00:00.000Z"), 0.0, True
        self.vault, self.usage_ms = Vault(), 0

    # Loopback HTTP in place of the TLS connection; the companion's Transport is otherwise unchanged.
    def request(self, method, url, body, headers):
        if not self.online:
            raise OSError("network down")
        parts = urlsplit(url)
        assert parts.scheme + "://" + parts.netloc == BACKEND
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request(method, parts.path + (f"?{parts.query}" if parts.query else ""), body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def control(self, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request("POST", path, body=json.dumps(body or {}), headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            data = response.read()
            assert response.status == 200, data
            return json.loads(data)
        finally:
            connection.close()

    def clock(self):
        return format_instant(self.now)

    def advance(self, **delta):
        self.now += timedelta(**delta)
        self.mono += timedelta(**delta).total_seconds()
        self.control("/e2e/clock", {"now": self.clock()})

    def say(self, user, text):
        self.control("/e2e/clock", {"now": self.clock()})
        self.control("/e2e/telegram", {"userId": user, "text": text})

    def inbox(self, user):
        self.control("/e2e/tasks")
        return [m["text"] for m in self.control("/e2e/messages", {"userId": user})]

    # Synthetic ActivityWatch: the child plays a Games app; usage is whatever the test set.
    def observe(self, now, settings, started):
        live = dict(observedAt=now, state="active", app="game.exe", title="Game", category=GAMES, rulesRevision="r1",
                    categoryCatalog=[GAMES, {"id": '["Study"]', "path": ["Study"]}])
        return Observation(live, dict(observedAt=now, awState="ready", lastSuccessAt=now, reportError=None))

    def summarize(self, date, lo, hi, settings, started):
        used = self.usage_ms
        return dict(date=date, leafTotalsMs=[dict(category=GAMES, totalMs=used)] if used else [],
                    appLeafTotalsMs=[dict(app="game.exe", categoryId=GAMES["id"], totalMs=used)] if used else [],
                    totalActiveMs=used, selectedTotalMs=0, settingsRevision=0, rulesRevision="r1",
                    availableFrom=lo, availableThrough=hi, partial=False, sequence=0)

    def open(self, identity=None):
        self.store = LocalStore(self.path, now=self.clock, identity=identity)
        binding = self.store.binding
        from aw_telegram.transport import DeviceIdentity
        self.identity = DeviceIdentity(**binding)
        self.transport = Transport(self.vault, request=self.request, identity=self.identity)
        self.coordinator = SyncCoordinator(self.store, self.transport, self.observe, self.summarize, jitter=lambda: 1.0)
        self.scheduler = Scheduler(self.store)

    def step(self):
        """One laptop cycle 30 s later, the real sync interval: sync, poll and the today summary are due."""
        self.advance(seconds=30)
        self.coordinator.step(self.clock(), self.mono)

    def tick(self):
        """The IO thread's next step, a moment later: a receipt queued since the last sync goes out at once."""
        self.advance(seconds=1)
        self.coordinator.step(self.clock(), self.mono)

    def cycle(self):
        """Long enough for a fresh summary to reach the bot."""
        self.step()
        self.step()

    def show(self):
        """The presenter's tick: report every requested overlay as shown, as the Windows adapter would."""
        commands = self.scheduler.tick(self.now)
        for command in commands:
            if getattr(command, "kind", None) == "overlay":
                self.scheduler.presented(command.key, SHOWN, self.now)
        return commands


def test_the_companion_and_the_bot_work_together(server, tmp_path):
    w = World(server, tmp_path)
    w.control("/e2e/clock", {"now": w.clock()})
    code = w.control("/e2e/enrollment")["secret"]
    enroll = Transport(w.vault, request=w.request, accept_host=lambda host: host == "backend.e2e.test")
    w.open(enroll.enroll(EnrollmentBundle(BACKEND, code)))
    w.step()
    assert w.store.collection_started_at is None  # no collection before a caregiver pairs

    # Pairing through the real webhook with a key from the real access API.
    key = w.transport.create_pair_key(w.identity, "Мама")["secret"]
    w.say("101", "/pair " + key)
    assert any("Доступ підтверджено" in t for t in w.inbox("101"))
    w.step()
    assert w.store.collection_started_at is not None and w.store.active_caregivers == 1

    # Settings travel from Telegram to the laptop and are acknowledged.
    w.advance(hours=2)
    w.usage_ms = 30 * MIN
    w.cycle()
    w.step()  # a cycle syncs before it polls: the category list reaches the bot on the next sync
    w.say("101", "/add_category Games")
    w.say("101", "/limit 1h today")
    w.step()
    assert w.store.settings.selectedPaths == [["Games"]]
    assert w.store.settings.todayOverride == {"date": kyiv_date(w.now), "limitMs": 60 * MIN}
    w.tick()  # the settings receipts go out at once, not at the next 30 s sync
    assert not [a for a in w.store.pending_acks() if a.kind == "settings"]  # the backend confirmed them

    # A reminder: offered, accepted, shown, and confirmed back to the caregiver.
    w.say("101", "/overlay Час на перерву")
    w.step()
    commands = w.show()
    assert [c.text for c in commands if getattr(c, "source", None) == "manual"] == ["Час на перерву"]
    reminder = next(c for c in commands if getattr(c, "source", None) == "manual")
    w.tick()  # the shown receipt goes out at once, well inside the reminder's 60 s delivery window
    assert any("Підтверджено показ: 1" in t or "Показ підтверджено" in t for t in w.inbox("101"))
    w.scheduler.dismissed(reminder.key, w.now)

    # The allowance runs out: the laptop shows its own overlay and the bot alerts the caregiver.
    w.usage_ms = 70 * MIN
    w.cycle()
    w.step()
    overlay = next(c for c in w.show() if getattr(c, "source", None) == "allowance")
    assert any(t.startswith("Денний час вичерпано") for t in w.inbox("101"))

    # Offline: sync fails, the local rule still repeats the overlay a minute after dismissal.
    w.online = False
    w.scheduler.dismissed(overlay.key, w.now)
    w.coordinator.live = None
    w.advance(seconds=61)
    w.store.record_activity(dict(observedAt=w.clock(), state="active", app="game.exe", title=None, category=GAMES,
                                 rulesRevision="r1", categoryCatalog=[]))
    assert any(getattr(c, "source", None) == "allowance" for c in w.show())
    w.coordinator.step(w.clock(), w.mono + 120)
    assert w.coordinator.last_error == "transient_sync_error"

    # Reboot: everything needed is on disk; nothing is replayed.
    w.online = True
    w.store.close()
    w.open()
    w.scheduler.recover(w.now)
    assert w.store.settings.todayOverride["limitMs"] == 60 * MIN and w.store.active_caregivers == 1
    assert [c for c in w.show() if getattr(c, "source", None) == "manual"] == []

    # Removing the last caregiver pauses every rule on the laptop (ACCESS-08).
    [parent] = w.transport.list_access(w.identity)["parents"]
    w.transport.revoke_access(w.identity, parent["id"])
    w.step()
    assert w.store.active_caregivers == 0
    w.advance(seconds=61)
    assert not any(getattr(c, "source", None) == "allowance" and not isinstance(c, Hide) for c in w.show())
    w.store.close()
