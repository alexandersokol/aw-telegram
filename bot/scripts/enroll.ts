/** Local owner administrative entry point; uses owner IAM/ADC, never runs on the laptop. */
import {Firestore} from 'firebase-admin/firestore';
import {FirestoreRepository,newSecret} from '../dist/repository.js';

async function main() {
  const args=process.argv.slice(2), operation=args.shift();
  if(operation==='--help') {
    console.log('After npm run build: node --experimental-strip-types scripts/enroll.ts issue --project PROJECT --backend-url https://HOST');
    console.log('Recovery: revoke-enrollment --project PROJECT (original enrollment code via stdin), or revoke-device --project PROJECT --device-id UUID');
    return;
  }
  if(!['issue','revoke-enrollment','revoke-device'].includes(operation??'') || args.length%2) throw new Error('Invalid owner CLI request');
  const options=new Map();
  for(let i=0;i<args.length;i+=2) {
    if(!['--project','--backend-url','--device-id'].includes(args[i]) || options.has(args[i])) throw new Error('Invalid owner CLI request');
    options.set(args[i],args[i+1]);
  }
  const project=options.get('--project');
  if(typeof project!=='string' || !/^[a-z][a-z0-9-]{4,62}$/.test(project)) throw new Error('Explicit project required');
  const emulator=process.env.FIRESTORE_EMULATOR_HOST;
  if(emulator && (!/^(127\.0\.0\.1|localhost):[0-9]+$/.test(emulator) || project!=='demo-aw-telegram' || process.env.GOOGLE_APPLICATION_CREDENTIALS))
    throw new Error('Refusing unsafe emulator environment');
  if(project.startsWith('demo-') && !emulator) throw new Error('Demo project requires explicit loopback emulator');
  let backend;
  if(operation==='issue') {
    const raw=options.get('--backend-url');
    if(typeof raw!=='string' || /[\\\x00-\x20\x7f?#@]/.test(raw)) throw new Error('Invalid backend URL');
    const url=new URL(raw);
    if(url.protocol!=='https:' || !url.hostname || url.username || url.password || url.pathname!=='/') throw new Error('Invalid backend URL');
    backend=url.origin;
  }
  const db=new Firestore({projectId:project}), repository=new FirestoreRepository(db);
  try {
    if(operation==='issue') {
      const secret=newSecret(32); await repository.issueEnrollment(secret);
      // The sole intentional secret output: one-time local owner display. Do not pipe to logs.
      console.log(JSON.stringify({backendUrl:backend,secret}));
    } else if(operation==='revoke-device') {
      await repository.revokeDevice(options.get('--device-id')); console.log('Device revocation processed');
    } else {
      let code='';
      for await (const chunk of process.stdin) {code+=chunk.toString('utf8'); if(code.length>100) throw new Error('Invalid recovery input');}
      await repository.revokeEnrollment(code.trim()); console.log('Enrollment recovery processed');
    }
  } finally {await db.terminate();}
}
main().catch(()=>{console.error('Owner CLI failed. Check explicit project, IAM, emulator guard and input; no credential details are logged.');process.exitCode=1;});
