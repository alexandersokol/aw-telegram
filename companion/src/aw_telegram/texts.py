"""Every built-in text of the laptop app, in Ukrainian and English (LANG-01).

`t(key, **params)` renders in the current language, which the app sets from the stored choice. Caregiver
message text, ActivityWatch category and app names are shown as received and never pass through here.
"""
from .windows.language import system_language

CHOICES = ("system", "uk", "en")

UK = {
    # Window, tray and the three overlays' own chrome
    "tab.status": "Стан",
    "tab.access": "Доступ батьків",
    "tab.settings": "Налаштування",
    "tray.open": "Відкрити",
    "tray.quit": "Вийти",
    "overlay.title": "Нагадування AW Telegram",
    "overlay.dismiss": "Закрити",
    "notification.title": "Сповіщення AW Telegram",
    "notification.dismiss": "Закрити",
    "countdown.title": "Таймер AW Telegram",
    "countdown.caption": "До нагадування",

    # Status
    "status.duration.under_minute": "менше 1 хв",
    "status.duration.hours": "{hours} год {minutes:02d} хв",
    "status.duration.minutes": "{minutes} хв",
    "status.when.today": "о {clock}",
    "status.when.date": "{date} о {clock}",
    "status.aw.ready": "працює",
    "status.aw.partial": "неповні дані",
    "status.aw.stale": "дані застаріли",
    "status.aw.unavailable": "недоступний",
    "status.aw.unsupported": "категорії не налаштовано",
    "status.aw.unknown": "невідомо",
    "status.aw.report_error": " (звіт завеликий, надіслано останні дані)",
    "status.aw.line": "ActivityWatch: {state}",
    "status.aw.after_pairing": "ActivityWatch: облік почнеться після першого під’єднання батьків",
    "status.server.not_enrolled": "Сервер: ноутбук не підключено. Введіть код підключення в «Налаштування».",
    "status.server.rejected": "Сервер: доступ ноутбука відхилено. Попросіть власника видати новий код і натисніть "
                             "«Підключити заново» в «Налаштування».",
    "status.server.startup_failed": "Сервер: синхронізація не запустилася. Закрийте програму через «Вийти» і "
                                    "запустіть знову.",
    "status.server.vault_unavailable": "Сервер: не вдалося прочитати облікові дані ноутбука зі сховища Windows; "
                                       "синхронізацію буде повторено.",
    "status.server.never": "Сервер: ще не синхронізувався",
    "status.server.online": "Сервер: на зв’язку, остання синхронізація {when}",
    "status.server.offline": "Сервер: немає зв’язку, остання синхронізація {when}",
    "status.caregivers.none_yet": "Батьки: ще ніхто не під’єднався. Створіть ключ у «Доступ батьків».",
    "status.caregivers.none_now": "Батьки: зараз ніхто не під’єднаний. Обмеження й нагадування призупинено, доки "
                                  "хтось не під’єднається в «Доступ батьків».",
    "status.today.no_categories": "Сьогодні: для обліку не вибрано жодної категорії. Оберіть їх у Telegram: "
                                  "/categories.",
    "status.today.no_data": "Сьогодні: даних немає",
    "status.today.partial": " (неповні дані)",
    "status.today.free_use": "Сьогодні: {used}{partial}, вільний режим",
    "status.today.left": "залишилось {left}",
    "status.today.over": "перевищено на {over}",
    "status.today.limit": "Сьогодні: {used} з {limit}, {rest}{partial}",
    "status.endtime.on": "Час завершення: увімкнено, о {time}",
    "status.endtime.off": "Час завершення: вимкнено",
    "status.free_use.on": "Вільний режим: увімкнено до опівночі",
    "status.free_use.off": "Вільний режим: вимкнено",
    "status.reminders.off": "Автоматичні нагадування: вимкнено до опівночі",
    "status.reminders.on": "Автоматичні нагадування: активні",

    # Limit and endtime warnings and overlays made on the laptop
    "scheduler.endtime_overlay": "Час завершення {time}.\nЧас відкласти ноутбук.",
    "scheduler.endtime_warning": "Час завершення о {time}: залишилося {minutes} хв.",
    "scheduler.allowance_overlay": "Денний час вичерпано.\nБудь ласка, вимкни комп’ютер.",
    "scheduler.allowance_warning": "Денний час: залишилося {minutes} хв або менше.",

    # Settings
    "settings.server.title": "Підключення до сервера",
    "settings.server.hint": "Вставте код підключення, який видала команда власника.",
    "settings.server.check": "Перевірити код",
    "settings.server.connect": "Підключити",
    "settings.server.reconnect": "Підключити заново…",
    "settings.server.connected": "Підключено до сервера {host}. Ноутбук: {device}…",
    "settings.server.confirm_host": "Сервер: {host}\nПереконайтеся, що це ваш сервер, і натисніть «Підключити».",
    "settings.server.connecting": "Підключення…",
    "settings.server.done": "Ноутбук підключено до {host}.",
    "settings.server.save_failed": "Код використано, але ноутбук не зміг зберегти підключення. Попросіть власника "
                                   "скасувати це підключення і видати новий код.",
    "settings.server.reconnect_confirm": "Підключити ноутбук заново? Поточне підключення буде забуто. Локальні дані "
                                         "збережуться в окремому файлі, а для нового підключення потрібен новий код "
                                         "від власника.",
    "settings.server.code_invalid": "Код підключення не розпізнано. Вставте повністю рядок, який видала команда "
                                    "власника.",
    "settings.server.host_invalid": "Адреса сервера в коді недійсна: потрібна адреса https:// без шляху.",
    "settings.enroll.vault": "Сховище облікових даних Windows недоступне. Код не використано; спробуйте ще раз.",
    "settings.enroll.retryable": "Немає зв’язку з сервером або він не відповів. Перевірте інтернет і спробуйте ще "
                                 "раз. Якщо код більше не приймається, попросіть власника скасувати це підключення "
                                 "(revoke-enrollment) і видати новий код.",
    "settings.enroll.rejected": "Код недійсний, прострочений або вже використаний. Попросіть власника видати новий "
                                "код.",
    "settings.enroll.unfinished": "Код використано, але ноутбук не зміг завершити підключення. Попросіть власника "
                                  "скасувати це підключення і видати новий код.",
    "settings.enroll.failed": "Не вдалося підключити ноутбук. Попросіть власника видати новий код.",
    "settings.aw.host": "Адреса",
    "settings.aw.port": "Порт",
    "settings.aw.save": "Зберегти й перевірити",
    "settings.aw.checking": "Перевірка ActivityWatch…",
    "settings.aw.check_failed": "Не вдалося перевірити ActivityWatch за адресою {address}.",
    "settings.aw.unreachable": "ActivityWatch не відповідає за адресою {address}. Запустіть ActivityWatch або "
                               "перевірте порт.",
    "settings.aw.working": "ActivityWatch працює ({hostname}, версія {version}).",
    "settings.aw.no_window": "немає єдиного джерела даних про вікна (aw-watcher-window)",
    "settings.aw.no_afk": "немає єдиного джерела даних про присутність (aw-watcher-afk)",
    "settings.aw.no_categories": "не вдалося прочитати категорії — налаштуйте їх в ActivityWatch",
    "settings.aw.problems": "ActivityWatch відповідає, але {problems}.",
    "settings.startup.title": "Автозапуск",
    "settings.startup.enable": "Запускати разом з Windows",
    "settings.startup.installed_only": "Доступно у встановленій версії програми.",
    "settings.startup.failed": "Не вдалося змінити автозапуск Windows.",
    "settings.language.title": "Мова / Language",
    "settings.language.system": "Системна / System",
    "settings.language.uk": "Українська",
    "settings.language.en": "English",
    "settings.version": "Версія {version}",

    # Parent access
    "access.waiting": "видалення чекає на підтвердження сервера",
    "access.parent": "підключено, Telegram ID {user_id}",
    "access.key_revoked": "ключ скасовано",
    "access.key_expired": "ключ прострочено",
    "access.key_pending": "ключ чекає на підключення до {time}",
    "access.name_hint": "Ім’я, наприклад «Мама»",
    "access.create": "Створити ключ",
    "access.new_key": "Новий ключ",
    "access.copy": "Копіювати команду",
    "access.done": "Готово",
    "access.header_name": "Ім’я",
    "access.header_state": "Стан",
    "access.refresh": "Оновити",
    "access.remove": "Видалити",
    "access.full": "Підключено {max} із {max} облікових записів: щоб додати новий, спершу видаліть один.",
    "access.connect_first": "Спочатку підключіть ноутбук у «Налаштування».",
    "access.list_failed": "Список недоступний: немає зв’язку з сервером.",
    "access.name_invalid": "Введіть ім’я до 80 символів, наприклад «Мама».",
    "access.create_offline": "Немає зв’язку з сервером. Спробуйте ще раз.",
    "access.create_failed": "Не вдалося створити ключ.",
    "access.key_note": "Надішліть цю команду боту в особистому чаті Telegram. Ключ діє до {time} і підключає один "
                       "обліковий запис.",
    "access.remove_key_confirm": "Видалити ключ «{name}»? Його більше не можна буде використати.",
    "access.remove_parent_confirm": "Видалити доступ «{name}»? Цей обліковий запис Telegram більше не зможе керувати "
                                    "ноутбуком.",
    "access.remove_saved": "Видалення збережено. Його буде надіслано, щойно з’явиться зв’язок із сервером.",
    "access.key_removed": "Ключ «{name}» більше не можна використати.",
    "access.parent_removed": "Доступ «{name}» видалено.",

    # Start-up failures and uninstall
    "main.reset_failed": "Не вдалося звільнити файл даних. Закрийте програму через «Вийти» і спробуйте ще раз.",
    "main.start_failed": "Не вдалося запустити AW Telegram: не відкриваються локальні дані в {directory}. "
                         "Перезапустіть комп’ютер; якщо не допоможе, зверніться до власника.",
    "uninstall.close_first": "Спершу закрийте AW Telegram: значок у треї → «Вийти».",
    "uninstall.confirm": "Вимкнути AW Telegram на цьому ноутбуці? Автозапуск буде вимкнено, а облікові дані "
                         "ноутбука видалено з Windows.",
    "uninstall.revoke_parents": "Також видалити доступ усіх батьків? Потрібен зв’язок із сервером.",
    "uninstall.project": "ПРОЄКТ",
    "uninstall.startup_off": "Автозапуск вимкнено.",
    "uninstall.startup_failed": "Не вдалося вимкнути автозапуск Windows.",
    "uninstall.parents_removed": "Доступ батьків видалено (записів: {count}).",
    "uninstall.parents_failed": "Не вдалося видалити доступ батьків (видалено записів: {count}). Його скасує "
                                "відкликання ноутбука власником — команда нижче.",
    "uninstall.vault_deleted": "Облікові дані ноутбука видалено з Windows.",
    "uninstall.vault_failed": "Не вдалося видалити облікові дані з Windows.",
    "uninstall.owner_revoke": "Щоб відкликати ноутбук на сервері (це також скасує доступ усіх батьків і ключі), "
                              "власник виконує на своєму комп’ютері: {command}",
    "uninstall.data_left": "Дані програми залишилися в {path}; їх можна видалити вручну.",

    # Local presentation harness (manual_presentation.py)
    "harness.description": "Локальна перевірка нагадувань",
    "harness.order_help": "endtime-sequence: яке накладання з'являється першим",
    "harness.default_text": "Час зробити перерву",
    "harness.quit_after_help": "Завершити після показу",
    "harness.allow_minimize_help": "Повний шлях дозволеної повноекранної програми",
    "harness.capture_help": "PNG основного екрана для ручної перевірки",
    "harness.buttonless_needs_overlay": "--buttonless потребує --mode overlay та --duration-ms",
    "harness.buttonless_min": "--buttonless потребує тривалості щонайменше 1000 мс",
    "harness.bad_duration": "Некоректна тривалість",
    "harness.bad_executable": "--allow-minimize-exe потребує повного шляху Windows",
}

EN = {
    "tab.status": "Status",
    "tab.access": "Parent access",
    "tab.settings": "Settings",
    "tray.open": "Open",
    "tray.quit": "Quit",
    "overlay.title": "AW Telegram reminder",
    "overlay.dismiss": "Close",
    "notification.title": "AW Telegram notification",
    "notification.dismiss": "Close",
    "countdown.title": "AW Telegram timer",
    "countdown.caption": "Until the reminder",

    "status.duration.under_minute": "under 1 min",
    "status.duration.hours": "{hours} h {minutes:02d} min",
    "status.duration.minutes": "{minutes} min",
    "status.when.today": "at {clock}",
    "status.when.date": "{date} at {clock}",
    "status.aw.ready": "running",
    "status.aw.partial": "incomplete data",
    "status.aw.stale": "data is out of date",
    "status.aw.unavailable": "unavailable",
    "status.aw.unsupported": "categories are not set up",
    "status.aw.unknown": "unknown",
    "status.aw.report_error": " (report too large, latest data sent)",
    "status.aw.line": "ActivityWatch: {state}",
    "status.aw.after_pairing": "ActivityWatch: tracking starts after the first parent connects",
    "status.server.not_enrolled": "Server: this laptop is not connected. Enter the connection code in Settings.",
    "status.server.rejected": "Server: this laptop's access was rejected. Ask the owner for a new code and press "
                              "\"Connect again\" in Settings.",
    "status.server.startup_failed": "Server: sync did not start. Close the app with \"Quit\" and start it again.",
    "status.server.vault_unavailable": "Server: could not read this laptop's credentials from the Windows vault; "
                                       "sync will be retried.",
    "status.server.never": "Server: not synced yet",
    "status.server.online": "Server: connected, last sync {when}",
    "status.server.offline": "Server: not connected, last sync {when}",
    "status.caregivers.none_yet": "Parents: nobody has connected yet. Create a key in Parent access.",
    "status.caregivers.none_now": "Parents: nobody is connected now. Limits and reminders are paused until someone "
                                  "connects in Parent access.",
    "status.today.no_categories": "Today: no category is selected for tracking. Choose them in Telegram: "
                                  "/categories.",
    "status.today.no_data": "Today: no data",
    "status.today.partial": " (incomplete data)",
    "status.today.free_use": "Today: {used}{partial}, free use",
    "status.today.left": "{left} left",
    "status.today.over": "over by {over}",
    "status.today.limit": "Today: {used} of {limit}, {rest}{partial}",
    "status.endtime.on": "Endtime: on, at {time}",
    "status.endtime.off": "Endtime: off",
    "status.free_use.on": "Free use: on until midnight",
    "status.free_use.off": "Free use: off",
    "status.reminders.off": "Automatic reminders: off until midnight",
    "status.reminders.on": "Automatic reminders: active",

    "scheduler.endtime_overlay": "Endtime {time}.\nTime to put the laptop away.",
    "scheduler.endtime_warning": "Endtime at {time}: {minutes} min left.",
    "scheduler.allowance_overlay": "Today's time is used up.\nPlease turn off the computer.",
    "scheduler.allowance_warning": "Daily time: {minutes} min or less left.",

    "settings.server.title": "Server connection",
    "settings.server.hint": "Paste the connection code produced by the owner's command.",
    "settings.server.check": "Check code",
    "settings.server.connect": "Connect",
    "settings.server.reconnect": "Connect again…",
    "settings.server.connected": "Connected to server {host}. Laptop: {device}…",
    "settings.server.confirm_host": "Server: {host}\nMake sure this is your server, then press \"Connect\".",
    "settings.server.connecting": "Connecting…",
    "settings.server.done": "The laptop is connected to {host}.",
    "settings.server.save_failed": "The code was used, but the laptop could not save the connection. Ask the owner "
                                   "to cancel this connection and issue a new code.",
    "settings.server.reconnect_confirm": "Connect this laptop again? The current connection will be forgotten. Local "
                                         "data is kept in a separate file, and the new connection needs a new code "
                                         "from the owner.",
    "settings.server.code_invalid": "The connection code was not recognised. Paste the whole line produced by the "
                                    "owner's command.",
    "settings.server.host_invalid": "The server address in the code is not valid: it must be an https:// address "
                                    "without a path.",
    "settings.enroll.vault": "The Windows credential vault is unavailable. The code was not used; try again.",
    "settings.enroll.retryable": "No connection to the server, or it did not respond. Check the internet and try "
                                 "again. If the code is no longer accepted, ask the owner to cancel this connection "
                                 "(revoke-enrollment) and issue a new code.",
    "settings.enroll.rejected": "The code is invalid, expired or already used. Ask the owner for a new code.",
    "settings.enroll.unfinished": "The code was used, but the laptop could not finish connecting. Ask the owner to "
                                  "cancel this connection and issue a new code.",
    "settings.enroll.failed": "Could not connect the laptop. Ask the owner for a new code.",
    "settings.aw.host": "Address",
    "settings.aw.port": "Port",
    "settings.aw.save": "Save and check",
    "settings.aw.checking": "Checking ActivityWatch…",
    "settings.aw.check_failed": "Could not check ActivityWatch at {address}.",
    "settings.aw.unreachable": "ActivityWatch does not respond at {address}. Start ActivityWatch or check the port.",
    "settings.aw.working": "ActivityWatch is running ({hostname}, version {version}).",
    "settings.aw.no_window": "there is no single source of window data (aw-watcher-window)",
    "settings.aw.no_afk": "there is no single source of presence data (aw-watcher-afk)",
    "settings.aw.no_categories": "could not read the categories; set them up in ActivityWatch",
    "settings.aw.problems": "ActivityWatch responds, but {problems}.",
    "settings.startup.title": "Autostart",
    "settings.startup.enable": "Start with Windows",
    "settings.startup.installed_only": "Available in the installed version of the app.",
    "settings.startup.failed": "Could not change Windows autostart.",
    "settings.language.title": "Мова / Language",
    "settings.language.system": "Системна / System",
    "settings.language.uk": "Українська",
    "settings.language.en": "English",
    "settings.version": "Version {version}",

    "access.waiting": "removal is waiting for the server to confirm",
    "access.parent": "connected, Telegram ID {user_id}",
    "access.key_revoked": "key canceled",
    "access.key_expired": "key expired",
    "access.key_pending": "key waiting to be used until {time}",
    "access.name_hint": "Name, for example \"Mom\"",
    "access.create": "Create key",
    "access.new_key": "New key",
    "access.copy": "Copy command",
    "access.done": "Done",
    "access.header_name": "Name",
    "access.header_state": "Status",
    "access.refresh": "Refresh",
    "access.remove": "Remove",
    "access.full": "{max} of {max} accounts are connected: remove one before adding another.",
    "access.connect_first": "First connect the laptop in Settings.",
    "access.list_failed": "The list is unavailable: no connection to the server.",
    "access.name_invalid": "Enter a name up to 80 characters, for example \"Mom\".",
    "access.create_offline": "No connection to the server. Try again.",
    "access.create_failed": "Could not create the key.",
    "access.key_note": "Send this command to the bot in a private Telegram chat. The key is valid until {time} and "
                       "connects one account.",
    "access.remove_key_confirm": "Remove the key \"{name}\"? It will no longer be usable.",
    "access.remove_parent_confirm": "Remove access for \"{name}\"? This Telegram account will no longer be able to "
                                    "control the laptop.",
    "access.remove_saved": "The removal is saved. It will be sent as soon as the server is reachable.",
    "access.key_removed": "The key \"{name}\" can no longer be used.",
    "access.parent_removed": "Access for \"{name}\" was removed.",

    "main.reset_failed": "Could not release the data file. Close the app with \"Quit\" and try again.",
    "main.start_failed": "Could not start AW Telegram: the local data in {directory} cannot be opened. Restart the "
                         "computer; if that does not help, contact the owner.",
    "uninstall.close_first": "First close AW Telegram: tray icon → \"Quit\".",
    "uninstall.confirm": "Turn off AW Telegram on this laptop? Autostart will be turned off and the laptop's "
                         "credentials removed from Windows.",
    "uninstall.revoke_parents": "Also remove access for all parents? This needs a connection to the server.",
    "uninstall.project": "PROJECT",
    "uninstall.startup_off": "Autostart turned off.",
    "uninstall.startup_failed": "Could not turn off Windows autostart.",
    "uninstall.parents_removed": "Parent access removed (entries: {count}).",
    "uninstall.parents_failed": "Could not remove parent access (entries removed: {count}). The owner revoking this "
                                "laptop will cancel it: command below.",
    "uninstall.vault_deleted": "The laptop's credentials were removed from Windows.",
    "uninstall.vault_failed": "Could not remove the credentials from Windows.",
    "uninstall.owner_revoke": "To revoke the laptop on the server (this also cancels all parents' access and keys), "
                              "the owner runs on their computer: {command}",
    "uninstall.data_left": "The app's data stays in {path}; you can delete it by hand.",

    "harness.description": "Local check of reminders",
    "harness.order_help": "endtime-sequence: which overlay appears first",
    "harness.default_text": "Time for a break",
    "harness.quit_after_help": "Quit after showing",
    "harness.allow_minimize_help": "Full path of an allowed fullscreen program",
    "harness.capture_help": "PNG of the primary screen for manual inspection",
    "harness.buttonless_needs_overlay": "--buttonless needs --mode overlay and --duration-ms",
    "harness.buttonless_min": "--buttonless needs a duration of at least 1000 ms",
    "harness.bad_duration": "Invalid duration",
    "harness.bad_executable": "--allow-minimize-exe needs a full Windows path",
}

_CATALOGUES = {"uk": UK, "en": EN}
_language = "uk"  # until the app applies the stored choice, today's Ukrainian text


def language() -> str:
    return _language


def set_language(lang: str) -> None:
    global _language
    if lang not in _CATALOGUES:
        raise ValueError(f"unknown language {lang!r}")
    _language = lang


def effective(choice: str) -> str:
    """'uk' or 'en' for a stored choice; 'system' follows the Windows display language."""
    if choice == "system":
        return system_language()
    if choice not in _CATALOGUES:
        raise ValueError(f"unknown language choice {choice!r}")
    return choice


def apply(choice: str) -> str:
    """Make the choice the current language; returns the effective language."""
    lang = effective(choice)
    set_language(lang)
    return lang


def t(key: str, **params) -> str:
    text = _CATALOGUES[_language][key]
    return text.format(**params) if params else text


def in_all(key: str) -> set[str]:
    """The text in every language, for matching something that may have been shown in either."""
    return {catalogue[key] for catalogue in _CATALOGUES.values()}
