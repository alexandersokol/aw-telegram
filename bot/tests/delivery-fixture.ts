import {FirestoreRepository} from '../src/repository.js';
import {defaultSettings,minimalHealth} from '../src/contracts.js';
export const NOW='2026-10-28T12:00:00.000Z';
export const deviceId='00000000-0000-4000-8000-000000000001';
export const root=`devices/${deviceId}`;
export const identity={deviceId,credentialDigest:'a'.repeat(64)};
export const parent=(userId='1')=>({deviceId,userId,chatId:userId,pairingId:'00000000-0000-4000-8000-00000000000'+userId});
export const request=(sequence=1)=>({schemaVersion:2 as const,sequence,health:minimalHealth(NOW),acks:[]});
export class MemoryDb {
  data=new Map<string,any>(); private tail=Promise.resolve();
  doc(path:string):any {return {path,id:path.split('/').at(-1),collection:(name:string)=>this.collection(path+'/'+name)};}
  collection(path:string):any {
    const build=(filters:any[]=[],count=Infinity,order?:string):any=>({path,query:true,filters,count,order,
      doc:(id:string)=>this.doc(path+'/'+id),where:(...f:any[])=>build([...filters,f],count,order),
      limit:(n:number)=>build(filters,n,order),orderBy:(s:string)=>build(filters,count,s)});
    return build();
  }
  async runTransaction<T>(body:(tx:any)=>Promise<T>):Promise<T> {
    let release!:()=>void; const prior=this.tail;this.tail=new Promise<void>(r=>{release=r;});await prior;
    const next=structuredClone(this.data);let wrote=false;
    const snap=(path:string)=>{const saved=structuredClone(next.get(path));return {id:path.split('/').at(-1),ref:this.doc(path),exists:next.has(path),data:()=>structuredClone(saved)};};
    const tx:any={get:async(ref:any)=>{
      if(wrote)throw new Error('read after write');
      if(!ref.query)return snap(ref.path);
      let docs=[...next.keys()].filter(k=>k.startsWith(ref.path+'/')&&!k.slice(ref.path.length+1).includes('/')).map(snap);
      for(const [key,op,value] of ref.filters)docs=docs.filter(d=>{const a=key.split('.').reduce((v:any,k:string)=>v?.[k],d.data());return op==='=='?a===value:op==='<'?a<value:op==='<='?a<=value:op==='>'?a>value:op==='>='?a>=value:op==='in'?value.includes(a):false;});
      if(ref.order)docs.sort((a,b)=>a.data()[ref.order]>b.data()[ref.order]?1:-1);
      docs=docs.slice(0,ref.count);return {docs,size:docs.length,empty:!docs.length};
    },getAll:async(...refs:any[])=>{if(wrote)throw new Error('read after write');return refs.map(r=>snap(r.path));},
      set:(ref:any,v:any)=>{wrote=true;next.set(ref.path,structuredClone(v));},
      create:(ref:any,v:any)=>{if(next.has(ref.path))throw new Error('exists');wrote=true;next.set(ref.path,structuredClone(v));},
      update:(ref:any,v:any)=>{wrote=true;next.set(ref.path,{...next.get(ref.path),...structuredClone(v)});},
      delete:(ref:any)=>{wrote=true;next.delete(ref.path);}};
    try {const result=await body(tx);this.data=next;return result;}finally{release();}
  }
}
export function fixture(){
  const db=new MemoryDb();let time=Date.parse(NOW);
  const clock=()=>new Date(time).toISOString(),repo=new FirestoreRepository(db as any,()=>time);
  db.data.set(root,{status:'active',credentialDigest:identity.credentialDigest,activeParentIds:['1','2'],collectionStartedAt:time-36000000});
  db.data.set(root+'/settings/current',defaultSettings());
  for(const id of ['1','2']){const p=parent(id);db.data.set(root+'/parents/'+id,{...p,revokedAt:null,name:'Parent',joinedAt:time-1,hourlyEnabled:false});db.data.set('telegramUsers/'+id,{deviceId,pairingId:p.pairingId,revokedAt:null});}
  return {db,repo,clock,advance:(ms:number)=>{time+=ms;},setTime:(v:string)=>{time=Date.parse(v);}};
}
export const draft={kind:'overlay' as const,delayMinutes:0,options:{message:'Повернися до справ',countdown:false,dismissible:true as const,repeatEveryMinutes:null}};
