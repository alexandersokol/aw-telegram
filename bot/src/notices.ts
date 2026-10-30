/** UX-03: the author of a settings change or a clear learns when the laptop applied it. Each revision leaves a notice
 * in appliedNotices; the sync that acknowledges it turns the notices into one outbox message per author and deletes
 * them. Recipients are re-authorized at send time, so a removed author receives nothing. */
import type {DocumentReference,Transaction} from 'firebase-admin/firestore';
import {FirestoreRepository,digest,type ParentIdentity} from './repository.js';
import {planParentEvent,type PlannedWrite} from './outbox.js';
import {both,storedLang,type Catalogue,type Lang,type Localized} from './telegram/i18n/index.js';

/** Notices sent per sync; a larger backlog sets `noticesDue` and goes out on the following syncs. */
export const NOTICE_LIMIT=50;
export type NoticeKind='settings'|'cancellation';
/** Each kind is queried by its own revision field: a single-field range, so no composite index. */
const FIELD={settings:'settingsRevision',cancellation:'cancellationRevision'} as const;

/** « Ліміт на сьогодні 2 год 00 хв.» (the coordination summary) becomes the clause «ліміт на сьогодні 2 год 00 хв». */
const clause=(summary:string):string=>{const text=summary.trim().replace(/\.$/,'');return text.charAt(0).toLowerCase()+text.slice(1);};

/** One outbox message per author per sync, the changes in order, within the outbox's 3500 UTF-16 units; the cut never
 * splits a surrogate pair (an emoji in a category name). */
export const appliedText=(t:Catalogue,summaries:string[]):string=>{
  const text=t.APPLIED_PREFIX+summaries.join('; ')+'.';
  if(text.length<=3500)return text;
  const cut=text.slice(0,3499);
  return (/[\uD800-\uDBFF]$/.test(cut)?cut.slice(0,-1):cut)+'…';
};

/** The summary in every language, and the author's language when they made the change, which their message uses. */
export function noticeWrite(repo:FirestoreRepository,identity:ParentIdentity,kind:NoticeKind,revision:number,summary:Localized,now:string):PlannedWrite {
  return {ref:repo.db.doc(`devices/${identity.deviceId}/appliedNotices/${kind==='settings'?'s':'c'}-${revision}`),
    value:{pairingId:identity.pairingId,userId:identity.userId,summary:both((_,lang)=>clause(summary[lang])),lang:storedLang(identity.lang)??'uk',createdAt:now,[FIELD[kind]]:revision}};
}
/** A notice written before 11f holds one Ukrainian string and no lang; it is sent as it is. */
const summaryIn=(summary:string|Localized,lang:Lang):string=>typeof summary==='string'?summary:summary[lang];

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
  type Author={userId:string;ids:string[];summaries:(string|Localized)[];lang:Lang};
  const taken:typeof due=[],authors=new Map<string,Author>();
  let cost=0;
  for(const doc of due.slice(0,NOTICE_LIMIT)){
    const notice=doc.data(),known=authors.get(notice.pairingId);
    const next=cost+1+(known||!activeUserIds.includes(notice.userId)?0:3);
    if(next>budget)break;
    // The author's latest notice gives the language.
    const author:Author=known??{userId:notice.userId,ids:[],summaries:[],lang:'uk'};
    author.ids.push(doc.id);author.summaries.push(notice.summary);author.lang=storedLang(notice.lang)??'uk';authors.set(notice.pairingId,author);
    taken.push(doc);cost=next;
  }
  const writes:PlannedWrite[]=[];
  for(const [pairingId,author] of authors) if(activeUserIds.includes(author.userId))
    writes.push(...await planParentEvent(repo,tx,{id:digest(`applied:${deviceId}:${author.ids.join(',')}`),deviceId,at:now,kind:'applied',
      text:both((t,lang)=>appliedText(t,author.summaries.map(s=>summaryIn(s,lang)))),recipients:[{deviceId,userId:author.userId,pairingId,lang:author.lang}]}));
  return {writes,deletes:taken.map(doc=>doc.ref),
    more:due.length>taken.length||settings.length===NOTICE_LIMIT||cancellations.length===NOTICE_LIMIT};
}
