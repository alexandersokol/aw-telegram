/** The enrollment throttle counts an IPv6 subscriber's whole /64, so rotating addresses inside it does not reset it. */
import {it,expect} from 'vitest';
import {fixture} from './delivery-fixture.js';

const attempt=async(f:ReturnType<typeof fixture>,ip:string)=>f.repo.consumeEnrollment('bad',ip).catch((e:any)=>e.status);

it('throttles a /64 together, and other /64s and IPv4 separately',async()=>{
  const f=fixture();
  for(let i=1;i<=5;i++) expect(await attempt(f,`2001:db8:1:2::${i}`)).toBe(400);
  expect(await attempt(f,'2001:0db8:0001:0002:ffff:eeee:dddd:cccc')).toBe(429);  // same /64, any spelling
  expect(await attempt(f,'2001:db8:1:3::1')).toBe(400);  // the next /64 has its own window
  expect(await attempt(f,'::ffff:203.0.113.7')).toBe(400);  // IPv4-mapped counts as IPv4
  expect(await attempt(f,'::1')).toBe(400);
});
