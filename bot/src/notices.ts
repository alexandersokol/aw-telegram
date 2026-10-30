/** UX-03: the author of a settings change or a clear learns when the laptop applied it. Each revision leaves a notice
 * in appliedNotices; the sync that acknowledges it turns the notices into one outbox message per author and deletes
 * them. Recipients are re-authorized at send time, so a removed author receives nothing. */
import type {DocumentReference,Transaction} from 'firebase-admin/firestore';
import {FirestoreRepository,digest,type ParentIdentity} from './repository.js';
import {planParentEvent,type PlannedWrite} from './outbox.js';
import {appliedText} from './telegram/uk.js';

/** Notices sent per sync; a larger backlog sets `noticesDue` and goes out on the following syncs. */
export const NOTICE_LIMIT=50;
export type NoticeKind='settings'|'cancellation';
/** Each kind is queried by its own revision field: a single-field range, so no composite index. */
const FIELD={settings:'settingsRevision',cancellation:'cancellationRevision'} as const;

/** « Ліміт на сьогодні 2 год 00 хв.» (the coordination summary) becomes the clause «ліміт на сьогодні 2 год 00 хв». */
const clause=(summary:string):string=>{const text=summary.trim().replace(/\.$/,'');return text.charAt(0).toLowerCase()+text.slice(1);};

export function noticeWrite(repo:FirestoreRepository,identity:ParentIdentity,kind:NoticeKind,revision:number,summary:string,now:string):PlannedWrite {
  return {ref:repo.db.doc(`devices/${identity.deviceId}/appliedNotices/${kind==='settings'?'s':'c'}-${revision}`),
    value:{pairingId:identity.pairingId,userId:identity.userId,summary:clause(summary),createdAt:now,[FIELD[kind]]:revision}};
}

export interface NoticePlan {writes:PlannedWrite[];deletes:DocumentReference[];more:boolean}
/** Reads the notices up to each acknowledged revision (null: that kind is not due), oldest first, at most 50 in all,
 * and takes as many as fit in `budget` writes: one deletion each and three writes (event, outbox row, task intent)
 * for each author. The rest, in order, stay for a later sync. Authors no longer active on the device are dropped
 * here; their notices are deleted unsent. */
export async function planNotices(repo:FirestoreRepository,tx:Transaction,deviceId:string,acked:Record<NoticeKind,number|null>,
                                  activeUserIds:string[],now:string,budget:number):Promise<NoticePlan> {
  if(acked.settings===null&&acked.cancellation===null)return {writes:[],deletes:[],more:false};
  if(budget<1)return {writes:[],deletes:[],more:true};
  const notices=repo.db.collection(`devices/${deviceId}/appliedNotices`);
  const read=async(kind:NoticeKind)=>acked[kind]===null?[]:
    (await tx.get(notices.where(FIELD[kind],'<=',acked[kind]).orderBy(FIELD[kind]).limit(NOTICE_LIMIT))).docs;
  const settings=await read('settings'),cancellations=await read('cancellation');
  const due=[...settings,...cancellations].sort((a,b)=>a.data().createdAt<b.data().createdAt?-1:a.data().createdAt>b.data().createdAt?1:0);
  type Author={userId:string;ids:string[];summaries:string[]};
  const taken:typeof due=[],authors=new Map<string,Author>();
  let cost=0;
  for(const doc of due.slice(0,NOTICE_LIMIT)){
    const notice=doc.data(),known=authors.get(notice.pairingId);
    const next=cost+1+(known||!activeUserIds.includes(notice.userId)?0:3);
    if(next>budget)break;
    const author:Author=known??{userId:notice.userId,ids:[],summaries:[]};
    author.ids.push(doc.id);author.summaries.push(notice.summary);authors.set(notice.pairingId,author);
    taken.push(doc);cost=next;
  }
  const writes:PlannedWrite[]=[];
  for(const [pairingId,author] of authors) if(activeUserIds.includes(author.userId))
    writes.push(...await planParentEvent(repo,tx,{id:digest(`applied:${deviceId}:${author.ids.join(',')}`),deviceId,at:now,kind:'applied',
      text:appliedText(author.summaries),recipients:[{deviceId,userId:author.userId,pairingId}]}));
  return {writes,deletes:taken.map(doc=>doc.ref),
    more:due.length>taken.length||settings.length===NOTICE_LIMIT||cancellations.length===NOTICE_LIMIT};
}
