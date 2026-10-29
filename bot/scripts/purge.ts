/** Owner administrative purge of one device's cloud data; uses owner IAM/ADC, never runs on the laptop.
 * Irreversible. Revoke the device first (enroll.ts revoke-device) so the laptop cannot write new data. */
import {Firestore} from 'firebase-admin/firestore';
import {purgeDevice} from '../dist/purge.js';

async function main() {
  const args=process.argv.slice(2);
  if(args[0]==='--help') {
    console.log('After npm run build: node --experimental-strip-types scripts/purge.ts --project PROJECT --device-id UUID --confirm UUID');
    return;
  }
  if(args.length!==6) throw new Error('Invalid owner CLI request');
  const options=new Map();
  for(let i=0;i<args.length;i+=2) {
    if(!['--project','--device-id','--confirm'].includes(args[i]) || options.has(args[i])) throw new Error('Invalid owner CLI request');
    options.set(args[i],args[i+1]);
  }
  const project=options.get('--project');
  if(typeof project!=='string' || !/^[a-z][a-z0-9-]{4,62}$/.test(project)) throw new Error('Explicit project required');
  const emulator=process.env.FIRESTORE_EMULATOR_HOST;
  if(emulator && (!/^(127\.0\.0\.1|localhost):[0-9]+$/.test(emulator) || project!=='demo-aw-telegram' || process.env.GOOGLE_APPLICATION_CREDENTIALS))
    throw new Error('Refusing unsafe emulator environment');
  if(project.startsWith('demo-') && !emulator) throw new Error('Demo project requires explicit loopback emulator');
  const db=new Firestore({projectId:project});
  try {
    const report=await purgeDevice(db,options.get('--device-id'),{confirm:options.get('--confirm')});
    console.log(`Device purged; ${report.indexDocuments} related documents outside the device tree deleted`);
  } finally {await db.terminate();}
}
main().catch(()=>{console.error('Purge failed. Check explicit project, IAM, emulator guard, device ID and --confirm; no credential details are logged.');process.exitCode=1;});
