import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
const root=fileURLToPath(new URL('../../',import.meta.url));
if ((process.env.FIRESTORE_EMULATOR_HOST && !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) ||
    (process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT!=='demo-aw-telegram') || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error('Refusing non-demo/credentialed emulator environment');
if(process.env.FIRESTORE_EMULATOR_HOST) {
  const port=Number(process.env.FIRESTORE_EMULATOR_HOST.split(':').at(-1));
  if(!Number.isInteger(port) || port<1 || port>65535) throw new Error('Refusing invalid emulator port');
}
const selectors=process.argv.slice(2);
if(selectors.some(s=>!['auth','pairing','rules','sync','delivery','purge'].includes(s))) throw new Error('Only auth, pairing, rules, sync, delivery, purge selectors supported');
const scratch=fileURLToPath(new URL('../../.firebase/',import.meta.url)); mkdirSync(scratch,{recursive:true});
const env={...process.env,GCLOUD_PROJECT:'demo-aw-telegram',METADATA_SERVER_DETECTION:'none',FIREBASE_CLI_DISABLE_UPDATE_CHECK:'true',FIREBASE_EMULATORS_PATH:scratch+'emulators',XDG_CONFIG_HOME:scratch+'config'};
const cli=fileURLToPath(new URL('../node_modules/firebase-tools/lib/bin/firebase.js',import.meta.url));
const command=`node bot/node_modules/vitest/vitest.mjs run --config bot/vitest.emulator.config.ts ${selectors.join(' ')}`;
const result=spawnSync(process.execPath,[cli,'emulators:exec','--only','firestore','--project','demo-aw-telegram',command],{cwd:root,env,stdio:'inherit'});
if(result.error) throw result.error; process.exitCode=result.status??1;
