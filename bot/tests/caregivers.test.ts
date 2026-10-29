/** ACCESS-08: each sync tells the laptop how many caregivers are paired, so it can pause every rule at zero. */
import {it,expect} from 'vitest';
import {DeviceApi} from '../src/deviceApi.js';
import {fixture,identity,parent,request} from './delivery-fixture.js';

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
