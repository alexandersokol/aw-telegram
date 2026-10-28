/** Firestore forbids directly nested arrays; wire Settings always keeps exact paths. */
import {defaultSettings,validateContract,type Settings} from './contracts.js';
export type StoredSettings=Omit<Settings,'selectedPaths'>&{selectedPaths:{segments:string[]}[]};
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
  return validateContract('settings',{...stored,selectedPaths:paths});
}
