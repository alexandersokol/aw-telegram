import {parseJson} from './contracts.js';
import {BoundaryError,label,type FirestoreRepository} from './repository.js';
export function envelope(raw: string | Uint8Array, field: 'secret'|'name'): string {
  let value: any;
  try {value=parseJson(raw);} catch {throw new BoundaryError('Invalid request');}
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==2 ||
    value.schemaVersion!==1 || typeof value[field]!=='string' || !Object.hasOwn(value,field)) throw new BoundaryError('Invalid request');
  if(field==='name') return label(value[field]);
  if(value[field].length>256) throw new BoundaryError('Invalid request');
  return value[field];
}
export function enroll(repository: FirestoreRepository, raw: string|Uint8Array, trustedSourceIp: string) {
  return repository.consumeEnrollment(envelope(raw,'secret'),trustedSourceIp);
}
