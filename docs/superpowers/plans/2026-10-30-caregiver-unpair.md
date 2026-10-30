# Caregiver Self-Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a paired caregiver remove their own access from Telegram (`/unpair` or a Settings button), with exactly the effect of removal in the laptop's «Доступ батьків» (ACCESS-09).

**Architecture:** The caregiver half of `FirestoreRepository.revokeAccess` moves into one private transaction helper that both the laptop route and a new `leaveDevice` method call. The Telegram side adds a `leave` screen to the existing Settings menu state machine in `navigation.ts`, guarded by the same menu-session nonce and version as every other button. No sync contract, companion or notification change.

**Tech Stack:** TypeScript on Node 22, grammY, firebase-admin, vitest with the in-memory `MemoryDb` fixture, the Firestore emulator for `*.emulator.test.ts`.

Spec: [2026-10-30-caregiver-unpair-design.md](../specs/2026-10-30-caregiver-unpair-design.md).

## Global Constraints

- Nobody is notified of a self-removal: no event, no outbox row, no message to another caregiver.
- Copy, verbatim:
  - Settings button: `🚪 Відключитися`
  - Confirm screen: `Відключитися від цього ноутбука? Ви більше не отримуватимете звіти й сповіщення. Щоб повернутися, потрібен новий ключ із ноутбука.`
  - Last-caregiver paragraph: `Ви останній підключений дорослий. Після цього всі правила на ноутбуці зупиняться.`
  - Buttons: `Так, відключитися`, `Скасувати`
  - After removal: `Вас відключено.`, a blank line, then the existing `PAIRING` text.
  - Help line: `/unpair — відключитися від ноутбука`
- The last-caregiver paragraph shows when the device's `activeParentIds` has exactly one entry at render time.
- Commands run from `bot/`. Unit: `npm.cmd test`. Emulator: `JAVA_HOME="C:/Program Files/JetBrains/PyCharm 2023.3.5/jbr" npm.cmd run test:emulator -- <selector>`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not deploy and do not send real Telegram messages.

## File Structure

- Modify `bot/src/repository.ts`: add private `revokeParentTx`, make `revokeAccess` use it, add `leaveDevice`.
- Modify `bot/src/telegram/uk.ts`: copy for the new screen, labels and the help line.
- Modify `bot/src/telegram/navigation.ts`: `leave` screen, actions, effect, `openLeave`, rendering.
- Modify `bot/src/telegram/webhook.ts`: `case 'unpair'`.
- Tests: `bot/tests/caregivers.test.ts`, `bot/tests/pairing.emulator.test.ts`, `bot/tests/webhook.test.ts`, `bot/tests/e2e.test.ts`.
- Docs: `docs/user-requirements.md`, `docs/operations.md`, `docs/implementation-plan.md`.

---

### Task 1: Shared revocation and `leaveDevice`

**Files:**
- Modify: `bot/src/repository.ts:159-178` (`revokeAccess`) and add two methods after it
- Test: `bot/tests/caregivers.test.ts`, `bot/tests/pairing.emulator.test.ts`

**Interfaces:**
- Consumes: `requireParent(tx, identity: ParentIdentity): Promise<Parent>` (existing), `ParentIdentity = {deviceId, userId, pairingId, chatId}` (existing).
- Produces: `FirestoreRepository.leaveDevice(identity: ParentIdentity): Promise<void>`. It throws the usual 401 `BoundaryError` ("Unauthorized") when the caregiver is no longer authorized.

- [ ] **Step 1: Write the failing unit test**

Append to `bot/tests/caregivers.test.ts`:

```ts
it('lets a caregiver remove themselves with the same effect as removal on the laptop (ACCESS-09)', async()=>{
  const f=fixture(),api=new DeviceApi(f.repo,f.clock),self=parent('1');  // a full ParentIdentity
  f.db.data.set(`${root}/sessions/1`,{menu:'nav'});
  await f.repo.leaveDevice(self);
  expect(f.db.data.get(`${root}/parents/1`).revokedAt).not.toBeNull();
  expect(f.db.data.get('telegramUsers/1').revokedAt).not.toBeNull();
  expect(f.db.data.get(root).activeParentIds).toEqual(['2']);
  expect(f.db.data.has(`${root}/sessions/1`)).toBe(false);
  await expect(f.repo.leaveDevice(self)).rejects.toThrow('Unauthorized');
  expect((await api.syncDevice(identity,request())).activeCaregivers).toBe(1);
});
```

and extend the import line to `import {fixture,identity,parent,request,root} from './delivery-fixture.js';`.

- [ ] **Step 2: Run it and see it fail**

Run: `npm.cmd test -- tests/caregivers.test.ts`
Expected: FAIL, `f.repo.leaveDevice is not a function`.

- [ ] **Step 3: Implement**

In `bot/src/repository.ts`, replace the caregiver branch of `revokeAccess`. The method becomes:

```ts
  async revokeAccess(identity: DeviceIdentity, accessId: string): Promise<void> {
    const parts=accessId.split(':');
    await this.db.runTransaction(async tx=>{
      await this.requireDevice(tx,identity);
      if(parts.length===2 && parts[0]==='key' && UUID.test(parts[1]!)) {
        const keys=await tx.get(this.db.collection('pairKeys').where('deviceId','==',identity.deviceId).where('accessId','==',parts[1]).limit(2));
        if(keys.size!==1) return;
        const key=keys.docs[0]!, data=key.data();
        if(data.deviceId===identity.deviceId && data.accessId===parts[1] && data.consumedAt===null && data.revokedAt===null) tx.update(key.ref,{revokedAt:this.clock()});
      } else if(parts.length===3 && parts[0]==='parent' && /^[1-9][0-9]{0,15}$/.test(parts[1]!) && UUID.test(parts[2]!)) {
        await this.revokeParentTx(tx,identity.deviceId,numericId(parts[1]),parts[2]!);
      }
    });
  }
  /** ACCESS-09: a caregiver removes their own access, exactly as «Доступ батьків» would. */
  async leaveDevice(identity: ParentIdentity): Promise<void> {
    await this.db.runTransaction(async tx=>{
      await this.requireParent(tx,identity);
      await this.revokeParentTx(tx,identity.deviceId,identity.userId,identity.pairingId);
    });
  }
  /** The one caregiver removal, shared by the laptop and Telegram. Reads first, then writes; a stale pairing changes nothing. */
  private async revokeParentTx(tx: Transaction, deviceId: string, userId: string, pairingId: string): Promise<void> {
    const deviceRef=this.db.doc(`devices/${deviceId}`), parentRef=this.db.doc(`devices/${deviceId}/parents/${userId}`), bindingRef=this.db.doc(`telegramUsers/${userId}`);
    const [d,p,b]=await tx.getAll(deviceRef,parentRef,bindingRef), device=d!.data()!, parent=p!.data(), binding=b!.data(), now=this.clock();
    if(!parent || parent.pairingId!==pairingId || parent.revokedAt!==null) return;
    tx.update(parentRef,{revokedAt:now});
    if(binding?.deviceId===deviceId && binding.pairingId===pairingId) tx.update(bindingRef,{revokedAt:now});
    tx.update(deviceRef,{activeParentIds:device.activeParentIds.filter((id:string)=>id!==userId)});
    tx.delete(this.db.doc(`devices/${deviceId}/sessions/${userId}`));
  }
```

`requireDevice` already rejects an unknown or revoked device, so `device` is present when `revokeParentTx` runs; `leaveDevice` gets the same guarantee from `requireParent`.

- [ ] **Step 4: Run the unit suite**

Run: `npm.cmd test`
Expected: all pass, including the new test and the existing `revokeAccess` tests in `caregivers.test.ts` and `webhook.test.ts`.

- [ ] **Step 5: Write the emulator test**

Append to `bot/tests/pairing.emulator.test.ts`:

```ts
test('a caregiver leaves exactly as the laptop removes them, and can pair again with a new key',async()=>{
  const p=await pair('101'); await pair('102');
  const self={userId:'101',chatId:'101',deviceId:device.deviceId,pairingId:p.pairingId};
  await db.doc(`devices/${device.deviceId}/sessions/101`).set({menu:'nav'});
  await repo.leaveDevice(self);
  expect((await db.doc(`devices/${device.deviceId}/parents/101`).get()).data()!.revokedAt).toBe(now);
  expect((await db.doc('telegramUsers/101').get()).data()!.revokedAt).toBe(now);
  expect((await db.doc(`devices/${device.deviceId}`).get()).data()!.activeParentIds).toEqual(['102']);
  expect((await db.doc(`devices/${device.deviceId}/sessions/101`).get()).exists).toBe(false);
  await expect(repo.leaveDevice(self)).rejects.toThrow('Unauthorized');
  await expect(repo.authorizeParent(actor('101'))).rejects.toThrow('Unauthorized');
  expect((await pair('101')).pairingId).not.toBe(p.pairingId);
});
```

- [ ] **Step 6: Run the emulator suites that cover revocation**

Run: `JAVA_HOME="C:/Program Files/JetBrains/PyCharm 2023.3.5/jbr" npm.cmd run test:emulator -- auth pairing`
Expected: all pass, new test included.

- [ ] **Step 7: Typecheck and commit**

Run: `npm.cmd run build`
Expected: no errors.

```bash
git add bot/src/repository.ts bot/tests/caregivers.test.ts bot/tests/pairing.emulator.test.ts
git commit -m "feat: let a caregiver revoke their own access through the shared removal path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `/unpair` and the Settings confirmation

**Files:**
- Modify: `bot/src/telegram/uk.ts` (constants, `NAV_LABELS`, `HELP`)
- Modify: `bot/src/telegram/navigation.ts` (whole state machine and controller)
- Modify: `bot/src/telegram/webhook.ts:190-215` (`reply` switch)
- Test: `bot/tests/webhook.test.ts`

**Interfaces:**
- Consumes: `FirestoreRepository.leaveDevice(identity: ParentIdentity): Promise<void>` from Task 1; `PAIRING` from `uk.ts`.
- Produces: `NavigationController.openLeave(identity: ParentIdentity): Promise<Reply>`; `NavScreen` gains `'leave'`; `NavAction` gains `'leave' | 'leaveyes' | 'leaveno'`; `NavResult.effect` gains `'leave'`; `uk.ts` exports `LEAVE_CONFIRM`, `LEAVE_LAST`, `LEFT`.

- [ ] **Step 1: Write the failing tests**

In `bot/tests/webhook.test.ts`, change the expected Settings layout in "shows the main menu and navigates Settings…" (line 67) to:

```ts
    expect(s.last().buttons!.map(r=>r.map(b=>b.text))).toEqual([['Щогодинні звіти: вимкнено'],['Час завершення: вимкнено'],['Допомога'],['🚪 Відключитися'],['← Назад']]);
```

and add, after the `paired navigation` describe block:

```ts
describe('self-removal (ACCESS-09)',()=>{
  const CONFIRM='Відключитися від цього ноутбука? Ви більше не отримуватимете звіти й сповіщення. Щоб повернутися, потрібен новий ключ із ноутбука.';
  const LAST='Ви останній підключений дорослий. Після цього всі правила на ноутбуці зупиняться.';
  const pairingId=(s:Bot,id:string)=>s.db.data.get(root+'/parents/'+id).pairingId;

  it('confirms from Settings, removes access like the laptop does and tells nobody',async()=>{
    const s=await setup(),before=events(s).length;
    await s.say('/settings');await s.tap('Відключитися');
    expect(s.last().text).toBe(CONFIRM);expect(s.labels()).toEqual([['Так, відключитися'],['Скасувати']]);
    await s.tap('Так, відключитися');
    expect(s.last().text).toBe('Вас відключено.\n\n'+PAIRING);expect(s.last().buttons).toEqual([]);
    expect(s.db.data.get(root+'/parents/1').revokedAt).not.toBeNull();
    expect(s.db.data.get('telegramUsers/1').revokedAt).not.toBeNull();
    expect(s.db.data.get(root).activeParentIds).toEqual(['2']);
    expect(events(s)).toHaveLength(before);
    expect(s.calls.filter(c=>c.chatId==='2')).toEqual([]);
    await s.say('/status');expect(s.last().text).toBe(PAIRING);
    await s.say('/status','2');expect(s.last().text).not.toBe(PAIRING);
  });
  it('goes back to Settings on cancel and keeps access',async()=>{
    const s=await setup();await s.say('/unpair');await s.tap('Скасувати');
    expect(s.last().text).toBe('⚙️ Налаштування');
    expect(s.db.data.get(root+'/parents/1').revokedAt).toBeNull();
  });
  it('warns the last caregiver that every rule will pause',async()=>{
    const s=await setup();await s.repo.revokeAccess(identity,`parent:2:${pairingId(s,'2')}`);
    await s.say('/unpair');expect(s.last().text).toBe(CONFIRM+'\n\n'+LAST);
    await s.tap('Так, відключитися');expect(s.db.data.get(root).activeParentIds).toEqual([]);
  });
  it('answers /unpair from an unpaired user with the pairing hint',async()=>{
    const s=await setup();await s.say('/unpair','3');expect(s.last().text).toBe(PAIRING);
  });
  it('treats a repeated confirm as coming from an unpaired user and changes nothing',async()=>{
    const s=await setup();await s.say('/unpair');
    const confirm=s.button('Так, відключитися');
    await s.handle(s.press('1',confirm));const revokedAt=s.db.data.get(root+'/parents/1').revokedAt;
    await s.handle(s.press('1',confirm));
    expect(s.last().text).toBe(PAIRING);
    expect(s.db.data.get(root+'/parents/1').revokedAt).toBe(revokedAt);
    expect(s.db.data.get(root).activeParentIds).toEqual(['2']);
  });
  it('refuses a confirm button from an older leave screen',async()=>{
    const s=await setup();await s.say('/unpair');const old=s.button('Так, відключитися');
    await s.say('/unpair');await s.handle(s.press('1',old));
    expect(s.calls.filter(c=>c.kind==='answer').at(-1)).toEqual({kind:'answer',text:'Це меню застаріло. Відкрийте /start знову.'});
    expect(s.db.data.get(root+'/parents/1').revokedAt).toBeNull();
  });
  it('lists /unpair in /help',async()=>{
    const s=await setup();await s.say('/help');expect(s.last().text).toContain('/unpair — відключитися від ноутбука');
  });
});
```

Extend the imports at the top of the file: `import {setup,events,type Bot} from './bot-fixture.js';`.

- [ ] **Step 2: Run them and see them fail**

Run: `npm.cmd test -- tests/webhook.test.ts`
Expected: FAIL. The Settings layout lacks `🚪 Відключитися`, `/unpair` answers «Невідома команда…», `/help` lacks the line.

- [ ] **Step 3: Add the copy to `uk.ts`**

After `ALREADY_PAIRED`:

```ts
export const LEAVE_CONFIRM = 'Відключитися від цього ноутбука? Ви більше не отримуватимете звіти й сповіщення. Щоб повернутися, потрібен новий ключ із ноутбука.';
export const LEAVE_LAST = 'Ви останній підключений дорослий. Після цього всі правила на ноутбуці зупиняться.';
export const LEFT = 'Вас відключено.';
```

In `HELP`, insert before `'/help — ця довідка',`:

```ts
  '/unpair — відключитися від ноутбука',
```

Replace `NAV_LABELS` with:

```ts
export const NAV_LABELS = {
  usage: '📊 Використання', status: '💻 Стан ноутбука', reminders: '💬 Нагадування', limit: '⏱ Ліміт часу',
  settings: '⚙️ Налаштування', help: 'Допомога', back: LABELS.back,
  leave: '🚪 Відключитися', leaveyes: 'Так, відключитися', leaveno: LABELS.cancel,
} as const;
```

- [ ] **Step 4: Extend the state machine in `navigation.ts`**

Update the import from `./uk.js` to add `LEAVE_CONFIRM,LEAVE_LAST,LEFT,PAIRING`.

Replace the type and constant declarations:

```ts
export type NavScreen = 'main' | 'settings' | 'help' | 'usage' | 'status' | 'leave';
export interface NavState {screen: NavScreen; period?: UsagePeriod}
export type NavAction = 'usage' | 'status' | 'reminders' | 'limit' | 'settings' | 'hourlyon' | 'hourlyoff' | 'endtime' | 'help' | 'back' |
  UsagePeriod | 'refresh' | 'leave' | 'leaveyes' | 'leaveno';
/** A null state leaves this menu: openEndtime hands over to the Endtime submenu; leave ends the caregiver's access. */
export interface NavResult {state: NavState | null; effect?: 'hourlyOn' | 'hourlyOff' | 'openEndtime' | 'openLimit' | 'openReminders' | 'leave'; error?: 'stale'}

const SECTIONS: readonly NavScreen[] = ['usage', 'status'];
const PERIODS: readonly UsagePeriod[] = ['today', 'yesterday', 'week'];
const ACTIONS: readonly NavAction[] = ['usage', 'status', 'reminders', 'limit', 'settings', 'hourlyon', 'hourlyoff', 'endtime', 'help', 'back', ...PERIODS, 'refresh',
  'leave', 'leaveyes', 'leaveno'];
```

In `transitionNav`, inside the `settings` branch, add after the `help` line:

```ts
    if (action === 'leave') return to('leave');
```

and add a branch after the `help` screen branch:

```ts
  } else if (state.screen === 'leave') {
    if (action === 'leaveno') return to('settings');
    if (action === 'leaveyes') return {state: null, effect: 'leave'};
```

Any other action on `leave`, including `back`, falls through to the stale result.

- [ ] **Step 5: Wire the controller**

Add next to `openStatus`:

```ts
  openLeave(identity: ParentIdentity): Promise<Reply> {return this.open(identity, 'leave');}
```

In `callback`, after the `openReminders` line:

```ts
      // The removal deletes the menu session, so nothing is advanced afterwards.
      if (result.effect === 'leave') {
        await this.repository.leaveDevice(identity);
        return {text: LEFT + '\n\n' + PAIRING, buttons: []};
      }
```

The existing `catch` already turns a 401 into the stale toast.

Add next to `hourlyEnabled`:

```ts
  private lastCaregiver(identity: ParentIdentity): Promise<boolean> {
    return this.repository.db.runTransaction(async tx => {
      await this.repository.requireParent(tx, identity);
      return (await tx.get(this.repository.db.doc(`devices/${identity.deviceId}`))).data()!.activeParentIds.length === 1;
    });
  }
```

In `render`, change the Settings buttons to:

```ts
      reply = {text: SETTINGS_MENU, buttons: [[button(hourly ? 'hourlyoff' : 'hourlyon', hourlyLabel(hourly))], [button('endtime', endtimeLabel(settings))],
        [button('help')], [button('leave')], [button('back')]]};
```

and add a branch before `} else if (state.screen === 'help') {`:

```ts
    } else if (state.screen === 'leave') {
      reply = {text: (await this.lastCaregiver(identity)) ? LEAVE_CONFIRM + '\n\n' + LEAVE_LAST : LEAVE_CONFIRM,
        buttons: [[button('leaveyes')], [button('leaveno')]]};
```

- [ ] **Step 6: Route the command in `webhook.ts`**

In `reply`, after `case 'settings': …`:

```ts
      case 'unpair': return this.navigation.openLeave(identity);
```

- [ ] **Step 7: Run the unit suite and typecheck**

Run: `npm.cmd test`
Expected: all pass.

Run: `npm.cmd run build`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add bot/src/telegram/uk.ts bot/src/telegram/navigation.ts bot/src/telegram/webhook.ts bot/tests/webhook.test.ts
git commit -m "feat: add /unpair and a Settings button for caregiver self-removal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: End-to-end scenario and docs

**Files:**
- Test: `bot/tests/e2e.test.ts`
- Modify: `docs/user-requirements.md` (after ACCESS-08, line 457-461), `docs/operations.md` (Recovery), `docs/implementation-plan.md` (end of file)

**Interfaces:**
- Consumes: the Telegram flow from Task 2; the e2e harness `world()`, `caregiver.say/tap/last/inbox`, `laptop.sync()`.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the e2e scenario**

Append to `bot/tests/e2e.test.ts`:

```ts
it('lets caregivers remove themselves; the other keeps working and the laptop pauses at zero (ACCESS-09)',async()=>{
  const w=world();
  const {laptop,people:[mama,tato]}=await paired(w);
  await mama!.say('/settings');
  await mama!.tap('Відключитися');
  await mama!.tap('Так, відключитися');
  expect(mama!.last()).toContain('Вас відключено.');
  await mama!.say('/status');
  expect(mama!.last()).toContain('/pair');
  await w.runTasks();
  expect(tato!.inbox().some(m=>/відключ/i.test(m.text))).toBe(false);  // nobody is told
  expect((await laptop.sync()).activeCaregivers).toBe(1);

  await tato!.say('/status');
  expect(tato!.last()).not.toContain('/pair');
  await tato!.say('/unpair');
  expect(tato!.last()).toContain('Ви останній підключений дорослий.');
  await tato!.tap('Так, відключитися');
  expect((await laptop.sync()).activeCaregivers).toBe(0);
});
```

- [ ] **Step 2: Run it**

Run: `npm.cmd test -- tests/e2e.test.ts`
Expected: PASS. Tasks 1 and 2 already implement the behaviour, so this checks the real router, webhook and sync together. A failure means a wiring problem in Task 2, not a missing feature.

- [ ] **Step 3: Record the requirement**

In `docs/user-requirements.md`, after the ACCESS-08 bullet (ending «…resumes only if its time has not passed.»), add:

```markdown
- ACCESS-09 (owner decision, 2026-10-30): a paired caregiver may remove their own
  access from Telegram with `/unpair` or «🚪 Відключитися» in Settings, after a
  confirmation. The effect is identical to removal in «Доступ батьків». Nobody else
  is notified. When the caregiver is the last active one, the confirmation says
  that every rule on the laptop will pause (ACCESS-08). Returning requires a new key.
```

In `docs/operations.md`, Recovery, replace the bullet beginning «**A caregiver's Telegram account is lost:**» with:

```markdown
- **A caregiver's Telegram account is lost:** remove that access in «Доступ
  батьків», then create a new key for the new account. A caregiver who still has
  the account can remove themselves with `/unpair` (ACCESS-09).
```

In `docs/implementation-plan.md`, append at the end:

```markdown

ACCESS-09, caregiver self-removal (2026-10-30). Spec:
superpowers/specs/2026-10-30-caregiver-unpair-design.md; plan:
superpowers/plans/2026-10-30-caregiver-unpair.md. `/unpair` and a Settings button
open a confirmation; removal shares `revokeParentTx` with «Доступ батьків».
Bot unit N, emulator M.
```

Replace N with the passing count from `npm.cmd test` and M with the total from the full emulator run in Step 4.

- [ ] **Step 4: Run every check**

Run, from `bot/`:
- `npm.cmd test`
- `npm.cmd run build`
- `npm.cmd run check:bundle`
- `JAVA_HOME="C:/Program Files/JetBrains/PyCharm 2023.3.5/jbr" npm.cmd run test:emulator -- auth pairing rules sync delivery purge cleanup`

Expected: all pass. The companion is untouched; its suite does not need to run.

- [ ] **Step 5: Commit**

```bash
git add bot/tests/e2e.test.ts docs/user-requirements.md docs/operations.md docs/implementation-plan.md docs/superpowers/specs/2026-10-30-caregiver-unpair-design.md
git commit -m "test: cover caregiver self-removal end to end; record ACCESS-09

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
