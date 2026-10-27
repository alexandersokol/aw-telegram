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
    parser.add_argument("--mode", choices=["overlay", "notification", "countdown"], default="overlay")
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


if __name__ == "__main__":
    raise SystemExit(main())
