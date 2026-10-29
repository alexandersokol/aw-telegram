/** Firestore forbids directly nested arrays; wire Settings always keeps exact paths. */
import {defaultSettings,validateContract,type Settings} from './contracts.js';
export type StoredSettings=Omit<Settings,'selectedPaths'>&{selectedPaths:{segments:string[]}[]};
/** Only the known pre-endtime storage shape is eligible; partial fields stay invalid. */
export function needsSettingsMigration(value:unknown):boolean {
  return value!==null && typeof value==='object' && !Array.isArray(value) &&
    ['endtimeEnabled','endtimeLocalTime','endtimeGeneration'].every(key=>!Object.hasOwn(value,key));
}
export function encodeSettings(value:Settings):StoredSettings {
  const settings=validateContract('settings',value);
  return {...settings,selectedPaths:settings.selectedPaths.map(segments=>({segments}))};
}
export function decodeSettings(value:unknown):Settings {
  if(value===undefined) return defaultSettings();
  if(value===null || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid persisted settings');
  const stored=value as Record<string,unknown>;
  if(!Array.isArray(stored.selectedPaths)) throw new Error('Invalid persisted settings');
  // The Task4 default has an empty array, identical in both representations.
  const paths=stored.selectedPaths.map(path=>{
    if(path===null || typeof path!=='object' || Array.isArray(path) || Object.keys(path).join(',')!=='segments')
      throw new Error('Invalid persisted settings path');
    return (path as {segments:unknown}).segments;
  });
  return validateContract('settings',{
    ...(needsSettingsMigration(stored)?{endtimeEnabled:false,endtimeLocalTime:'21:00',endtimeGeneration:0}:{}),
    ...stored,selectedPaths:paths});
}
