# Companion window and tray

Status: agreed initial interface recorded 2026-10-27; endtime and newest-overlay
amendment approved 2026-10-29. The window, tray and all three sections, including
first-launch enrollment, are implemented (Tasks 9a–9c); packaging is pending.
All built-in interface text is Ukrainian.

## Window and tray behavior

- Provide a Windows tray icon that opens a small companion window.
- Closing the window keeps the companion running in the tray.
- Notifications, overlays, synchronization, and command retrieval work without
  the window being open.
- Start automatically in the signed-in user's Windows session.
- Protection against deliberately stopping/uninstalling the app is outside scope.

## Стан

Show ActivityWatch connectivity, backend connectivity, last synchronization,
remaining daily allowance, configured endtime state/time, and active
free-use/reminder-suppression modes.
Distinguish disconnected services from zero usage and from a confirmed power-off.

## Доступ батьків

- Create a pairing key by entering a descriptive name, then display the generated key.
- Unused keys expire after 15 minutes; each key pairs one Telegram account.
- List named entries with pairing status and paired-account details.
- Remove an unused key to invalidate it, or a paired entry to revoke access.
- Do not claim remote revocation completed before the backend acknowledges it.
- Paired access has no inactivity-based expiration in this version.

## Налаштування

Provide ActivityWatch address, backend connection configuration, and automatic
startup settings. Keep bot tokens and cloud administrator credentials out of the
companion. Exact installation/enrollment bootstrap remains a technical-design detail.

## First launch

1. The owner deploys the backend once using the documented setup procedure and
   obtains a one-time laptop enrollment code.
2. Enter this code in the companion to connect it to that backend.
3. Automatically check ActivityWatch and show connection status or actionable errors.
4. Create named, expiring parent pairing keys through «Доступ батьків».
5. Each parent pairs in a Telegram private chat.

Laptop enrollment and Telegram pairing codes serve different purposes. Neither
flow requires storing backend administrator credentials or the bot token on the laptop.

## Overlay presentation

Use a full-primary-monitor, see-through black dimming layer (initial proposed
opacity 70%) with large, fully opaque white text centered horizontally/vertically.
Wrap long text. Place «Закрити» centered near the bottom with an edge margin,
except for explicitly selected buttonless overlays with a mandatory duration.
Capture clicks across the layer so they cannot reach the app underneath; keep
the dismiss button clickable. Keyboard blocking and OS locking are not implied.

The top-left countdown uses a #242424 background at 70% opacity (alpha 179)
with fully opaque white text through per-pixel transparency. Keep its existing
layout, primary-screen position and timing lifecycle. Mouse clicks pass through
the countdown to the app underneath while the timer stays on top. The fullscreen
overlay continues to capture clicks.

## Endtime presentation

The companion evaluates endtime locally in Europe/Kyiv. With the feature enabled,
show companion notification cards at 15, 10, and 5 minutes before the saved time.
At endtime show the standard dismissible fullscreen overlay; after dismissal or
replacement, a new endtime occurrence is due one minute later until local midnight.
Free use, Clear all, turning endtime off, or changing its time removes the current
endtime overlay and cancels its pending occurrence before reevaluation.

Only overlays use newest-due-wins: a newly due overlay replaces the visible overlay
regardless of source, records the displaced item as terminal `replaced`, and cancels
an entire displaced manual repeat family. Notification cards and countdowns keep
their separate slots. A confirmed first endtime presentation for a date/settings
generation is queued for backend acknowledgement; it is not proof that the child
read the message.
