"""Exercise the installed-source manual entry point with actual Qt surfaces."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.parametrize("mode", ["overlay", "notification", "countdown"])
def test_harness_runs_and_emits_lifecycle_without_network(mode):
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")
    result = subprocess.run([sys.executable, "-m", "aw_telegram.manual_presentation",
                             "--mode", mode, "--duration-ms", "40", "--delay-ms", "0",
                             "--quit-after-ms", "150"],
                            capture_output=True, text=True, timeout=15, env=environment)
    assert result.returncode == 0, result.stderr
    events = [json.loads(line) for line in result.stdout.splitlines()]
    shown = [event for event in events if event["event"] == "shown"]
    expired = [event for event in events if event["event"] == "expired"]
    assert len(shown) == len(expired) == 1
    assert shown[0]["id"] == expired[0]["id"]
    if mode == "overlay":
        requests = [event for event in events if event["event"] == "native_request"]
        assert requests[0]["state"] == "unconfirmed"


def test_endtime_sequence_starts_its_simulated_clock_after_the_launch_delay():
    # The clock must not run during --delay-ms, or the first tick lands after endtime and skips the date.
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")
    result = subprocess.run([sys.executable, "-m", "aw_telegram.manual_presentation", "--mode", "endtime-sequence",
                             "--order", "manual-first", "--delay-ms", "4000", "--quit-after-ms", "4500"],
                            capture_output=True, text=True, timeout=30, env=environment)
    assert result.returncode == 0, result.stderr
    shown = [json.loads(line)["text"] for line in result.stdout.splitlines() if json.loads(line)["event"] == "overlay_shown"]
    assert len(shown) == 2 and "21:00" not in shown[0] and "21:00" in shown[1]
