/** Pure measured-usage policy. Reservations belong to parent pairing generations. */
import type {Settings,Instant} from './contracts.js';
import type {RecipientRef} from './repository.js';
export interface MilestoneState {observedFloor:number;reservedHighWater:number;deliveredHighWater:number;pendingBaseline?:boolean}
export interface Measurement {selectedTotalMs:number;partial:boolean;availableThrough:Instant}
export interface AlertInput {
  now:Instant;date:string;settings:Settings;measurement:Measurement|null;
  parents:(RecipientRef&{hourlyEnabled:boolean})[];states:Record<string,MilestoneState>;lastWarning?:string|null;
}
export interface AlertEvent extends Measurement {
  kind:'hourly'|'warning';recipient?:RecipientRef;hour?:number;severity?:string;totalMs:number;
}
export function advanceMilestone(old:MilestoneState|undefined,total:number|null,mode:'enable'|'category'|'reserve'|'delivered'):MilestoneState {
  const next={observedFloor:0,reservedHighWater:0,deliveredHighWater:0,...old};
  if(total===null){if(mode==='enable')next.pendingBaseline=true;return next;}
  const hour=Math.floor(total/3600000);
  if(mode==='enable'||mode==='category'||next.pendingBaseline){next.observedFloor=Math.max(next.observedFloor,hour);next.pendingBaseline=false;}
  if(mode==='category'||mode==='reserve')next.reservedHighWater=Math.max(next.reservedHighWater,hour);
  if(mode==='delivered')next.deliveredHighWater=Math.max(next.deliveredHighWater,hour);
  return next;
}
export function evaluateAlerts(input:AlertInput):AlertEvent[]{
  const m=input.measurement;if(!m)return [];
  const events:AlertEvent[]=[],hour=Math.floor(m.selectedTotalMs/3600000);
  for(const parent of input.parents){
    const s=input.states[parent.pairingId];
    if(parent.hourlyEnabled&&!s?.pendingBaseline&&hour>Math.max(s?.observedFloor??0,s?.reservedHighWater??0,s?.deliveredHighWater??0))
      events.push({...m,kind:'hourly',recipient:parent,hour,totalMs:m.selectedTotalMs});
  }
  const limit=input.settings.todayOverride?.date===input.date?input.settings.todayOverride.limitMs:input.settings.defaultLimitMs;
  const remaining=limit-m.selectedTotalMs;
  const severity=remaining<=0?'expired':remaining<=300000?'5m':remaining<=600000?'10m':remaining<=900000?'15m':null;
  if(severity&&severity!==input.lastWarning&&input.settings.freeUseDate!==input.date&&input.settings.suppressedDate!==input.date)
    events.push({...m,kind:'warning',severity,totalMs:m.selectedTotalMs});
  return events;
}
