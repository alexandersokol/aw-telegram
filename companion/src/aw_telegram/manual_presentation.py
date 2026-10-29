"""Local presentation harness: no AW, backend, credentials, or network calls."""
import argparse
import json
from pathlib import Path
import sys

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from .ui.countdown import CountdownWindow
from .ui.notification import NotificationCard
from .ui.overlay import OverlayWindow
from .windows.foreground import ForegroundAdapter


def main(argv=None):
    parser = argparse.ArgumentParser(description="Локальна перевірка нагадувань")
    parser.add_argument("--mode", choices=["overlay", "notification", "countdown", "endtime-sequence"], default="overlay")
    parser.add_argument("--order", choices=["manual-first", "endtime-first"], default="manual-first",
                        help="endtime-sequence: яке накладання з'являється першим")
    parser.add_argument("--text", default="Час зробити перерву")
    parser.add_argument("--buttonless", action="store_true")
    parser.add_argument("--duration-ms", type=int)
    parser.add_argument("--delay-ms", type=int, default=3000)
    parser.add_argument("--quit-after-ms", type=int, help="Завершити після показу")
    parser.add_argument("--allow-minimize-exe", action="append", default=[],
                        help="Повний шлях дозволеної повноекранної програми")
    parser.add_argument("--capture", type=Path, help="PNG основного екрана для ручної перевірки")
    options = parser.parse_args(argv)
    maximum = 86_340_000 if options.mode == "countdown" else 3_600_000
    if options.duration_ms is not None and not 1 <= options.duration_ms <= maximum:
        parser.error(f"--duration-ms: 1..{maximum}")
    if options.buttonless and (options.mode != "overlay" or options.duration_ms is None):
        parser.error("--buttonless потребує --mode overlay та --duration-ms")
    if options.buttonless and options.duration_ms < 1000:
        parser.error("--buttonless потребує тривалості щонайменше 1000 мс")
    if options.delay_ms < 0 or (options.quit_after_ms is not None and options.quit_after_ms <= 0):
        parser.error("Некоректна тривалість")
    try:
        adapter = ForegroundAdapter(allowed_executables=options.allow_minimize_exe)
    except ValueError:
        parser.error("--allow-minimize-exe потребує повного шляху Windows")

    app = QApplication.instance() or QApplication(sys.argv[:1])
    app.setQuitOnLastWindowClosed(False)
    if options.mode == "endtime-sequence":
        return endtime_sequence(app, adapter, options)
    if options.mode == "overlay":
        surface = OverlayWindow(foreground_adapter=adapter)
    elif options.mode == "notification":
        surface = NotificationCard()
    else:
        surface = CountdownWindow()

    def emit(event, **fields):
        print(json.dumps({"event": event, **fields}, ensure_ascii=True), flush=True)

    for event in ("shown", "dismissed", "expired"):
        getattr(surface, event).connect(lambda identifier, event=event: emit(event, id=identifier))

    def capture():
        # Desktop capture can still miss protected/fullscreen surfaces; inspect manually.
        image = app.primaryScreen().grabWindow(0)
        saved = not image.isNull() and image.save(str(options.capture), "PNG")
        emit("capture", saved=bool(saved))

    def finish():
        surface.hide_message()
        app.quit()

    def present():
        screen = app.primaryScreen()
        rect = screen.geometry()
        emit("screen", x=rect.x(), y=rect.y(), width=rect.width(), height=rect.height(),
             dpr=screen.devicePixelRatio(), logical_dpi=screen.logicalDotsPerInch())
        if options.mode == "overlay":
            surface.show_message(options.text, not options.buttonless, options.duration_ms)
            result = surface.presentation_result
            emit("native_request", state=result.state, reason=result.reason,
                 minimize_requested=result.minimized_hwnd is not None)
        elif options.mode == "notification":
            surface.show_message(options.text, options.duration_ms or 10_000)
        else:
            surface.start_countdown(options.duration_ms or 60_000, options.text)
        if options.capture:
            QTimer.singleShot(250, capture)
        if options.quit_after_ms:
            QTimer.singleShot(options.quit_after_ms, finish)

    QTimer.singleShot(options.delay_ms, present)
    return app.exec()


def endtime_sequence(app, adapter, options):
    """Real presenter/scheduler on a temporary store; simulated wall time starts 3 s before endtime.

    manual-first: a manual overlay at +1 s is replaced by endtime at +3 s.
    endtime-first: endtime at +3 s is replaced by a manual overlay at +8 s; endtime
    returns one minute after that replacement (+68 s). Dismissals recur after one minute.
    """
    from datetime import timedelta
    import tempfile
    import time
    from .clock import endtime_at, kyiv_date
    from .models import Settings
    from .scheduler import Scheduler
    from .storage import LocalStore
    from .ui.presenter import PolicyPresenter, utc_now

    directory = tempfile.TemporaryDirectory(prefix="aw-telegram-endtime-")
    store = LocalStore(Path(directory.name) / "harness.sqlite")
    with store._transaction():  # harness-only settings install; real settings arrive by sync
        state = store._state()
        state["settings"] = Settings(revision=1, endtimeEnabled=True, endtimeGeneration=1).to_wire()
        store._save(state)
    base = endtime_at(kyiv_date(utc_now()), "21:00") - timedelta(seconds=3)
    started = None  # set at presenter start; --delay-ms must not consume the 3 s lead
    def now():
        if started is None:
            return base
        return base + timedelta(milliseconds=int((time.monotonic() - started) * 1000))
    scheduler = Scheduler(store)
    manual_at = base + timedelta(seconds=1 if options.order == "manual-first" else 8)
    scheduler.add_manual("harness-manual", options.text, manual_at, repeat_minutes=1)
    presenter = PolicyPresenter(scheduler, OverlayWindow(foreground_adapter=adapter), NotificationCard(), now=now)

    def emit(event, **fields):
        print(json.dumps({"event": event, "simulated": now().isoformat(timespec="milliseconds"), **fields},
                         ensure_ascii=True), flush=True)
    presenter.overlay.shown.connect(lambda identifier: emit("overlay_shown", text=presenter.overlay._text,
                                                            native=presenter.overlay.presentation_result.reason))
    presenter.overlay.completed.connect(lambda identifier, reason: emit("overlay_completed", reason=reason))
    presenter.notification.shown.connect(lambda identifier: emit("card_shown"))

    def finish():
        presenter.stop()
        presenter.overlay.hide_message()
        receipts = [a.to_wire() for a in store.pending_acks() if a.kind == "endtime"]
        emit("receipts", count=len(receipts))
        store.close()
        directory.cleanup()
        app.quit()

    def begin():
        nonlocal started
        started = time.monotonic()
        presenter.start()

    QTimer.singleShot(options.delay_ms, begin)
    if options.quit_after_ms:
        QTimer.singleShot(options.delay_ms + options.quit_after_ms, finish)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
