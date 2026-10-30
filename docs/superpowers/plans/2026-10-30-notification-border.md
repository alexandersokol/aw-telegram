# Notification Border (Task 11c) Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The laptop notification card shows its message without a box around the text.

**Architecture:** `NotificationCard` (`companion/src/aw_telegram/ui/notification.py`) holds its
text in a `QScrollArea`. That scroll area keeps Qt's default `StyledPanel` frame, which draws the
border. Set the frame to `NoFrame`. `_position` already subtracts `frameWidth()`, so the sizing
follows with no change.

Spec: `docs/review-notes.md`, note 2. Task: `docs/implementation-plan.md`, 11c.

## Global Constraints

- Companion only. No bot, contract or backend change.
- Test-first: the new frame assertion must fail before the fix.
- Overlay (`overlay.py`) and countdown (`countdown.py`) get no change unless they have a
  `QScrollArea` or a framed `QFrame`. They have neither (checked in step 3).
- The sizing tests (`test_notification_all_text_is_accessible_within_primary_screen`) and the
  other notification tests must keep passing.
- Owner-pending: a released build from 11b showing no border on the owner's desktop.

---

### Task 1: Frame test and fix

**Files:**
- Modify: `companion/tests/test_presentation.py`
- Modify: `companion/src/aw_telegram/ui/notification.py`

- [ ] **Step 1: Add a failing test**

Assert `card.message_scroll.frameShape() == QFrame.Shape.NoFrame` and
`card.message_scroll.frameWidth() == 0`. Run `tests/test_presentation.py -k notification` and
confirm it fails.

- [ ] **Step 2: Set the frame**

In `notification.py`, call `self.message_scroll.setFrameShape(QFrame.Shape.NoFrame)` after the
scroll area is created. Import `QFrame`. Re-run the notification tests; all pass.

- [ ] **Step 3: Check the other surfaces**

Grep `companion/src` for `QScrollArea`, `QFrame`, `setFrameShape`. Only `notification.py` uses
them. `overlay.py` is a painted `QWidget` with a button; `countdown.py` is a `QLabel` in a layout
(a `QLabel` has no frame by default). Neither changes.

- [ ] **Step 4: Verify**

Run the full companion suite and `python tools/licenses.py check`.

- [ ] **Step 5: Docs and commits**

Record the result in `docs/implementation-plan.md` under 11c, and set note 2's status in
`docs/review-notes.md`. Commit in conventional commits with the Co-Authored-By line.
