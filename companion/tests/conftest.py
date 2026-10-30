"""Every test starts in Ukrainian with a Ukrainian Windows, whatever language the machine running it uses."""
import pytest

from aw_telegram import texts
from aw_telegram.windows import language


@pytest.fixture(autouse=True)
def ukrainian_windows(monkeypatch):
    monkeypatch.setattr(language, "ui_language_id", lambda: 0x0422)  # uk-UA
    texts.set_language("uk")
    yield
    texts.set_language("uk")
