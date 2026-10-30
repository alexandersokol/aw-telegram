/** ACCESS-08: each sync tells the laptop how many caregivers are paired, so it can pause every rule at zero. */
import {it,expect} from 'vitest';
import {DeviceApi} from '../src/deviceApi.js';
import {fixture,identity,parent,request,root} from './delivery-fixture.js';

it('reports the paired caregiver count, including zero after the last removal', async()=>{
  const f=fixture(),api=new DeviceApi(f.repo,f.clock);
  expect((await api.syncDevice(identity,request())).activeCaregivers).toBe(2);
  for(const id of ['1','2']){
    const {userId,pairingId}=parent(id);
    await f.repo.revokeAccess(identity,`parent:${userId}:${pairingId}`);
  }
  f.advance(1000);
  expect((await api.syncDevice(identity,request(2))).activeCaregivers).toBe(0);
});

it('lets a caregiver remove themselves with the same effect as removal on the laptop (ACCESS-09)', async()=>{
  const f=fixture(),api=new DeviceApi(f.repo,f.clock),self=parent('1');
  f.db.data.set(`${root}/sessions/1`,{menu:'nav'});
  await f.repo.leaveDevice(self);
  expect(f.db.data.get(`${root}/parents/1`).revokedAt).not.toBeNull();
  expect(f.db.data.get('telegramUsers/1').revokedAt).not.toBeNull();
  expect(f.db.data.get(root).activeParentIds).toEqual(['2']);
  expect(f.db.data.has(`${root}/sessions/1`)).toBe(false);
  await expect(f.repo.leaveDevice(self)).rejects.toThrow('Unauthorized');
  expect((await api.syncDevice(identity,request())).activeCaregivers).toBe(1);
});
