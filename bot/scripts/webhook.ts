/** Owner webhook administration; uses owner ADC to read the two Telegram secrets from Secret Manager.
 * Nothing secret is taken from arguments or printed. Setting or removing the webhook changes live delivery. */
import {GoogleAuth} from 'google-auth-library';
import {WebhookAdmin,secretManagerReader} from '../dist/webhookAdmin.js';
import {fetchTransport} from '../dist/outbox.js';

async function main() {
  const [operation,...args]=process.argv.slice(2);
  if(operation==='--help' || operation===undefined) {
    console.log('After npm run build: node --experimental-strip-types scripts/webhook.ts info --project PROJECT');
    console.log('  set --project PROJECT --url https://HOST/telegram/webhook   (secret_token, message+callback_query, max_connections 1)');
    console.log('  remove --project PROJECT                                     (rollback; Telegram keeps updates for 24 h)');
    return;
  }
  if(!['info','set','remove'].includes(operation) || args.length%2) throw new Error('Invalid owner CLI request');
  const options=new Map();
  for(let i=0;i<args.length;i+=2) {
    if(!['--project','--url'].includes(args[i]) || options.has(args[i])) throw new Error('Invalid owner CLI request');
    options.set(args[i],args[i+1]);
  }
  const project=options.get('--project');
  if(typeof project!=='string' || !/^[a-z][a-z0-9-]{4,62}$/.test(project) || project.startsWith('demo-')) throw new Error('Explicit project required');
  if((operation==='set')!==options.has('--url')) throw new Error('--url is required for set only');
  const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});
  const token=async()=>{const value=await auth.getAccessToken(); if(!value) throw new Error('No owner access token'); return value;};
  const admin=new WebhookAdmin(secretManagerReader(project,token,fetchTransport),fetchTransport);
  console.log(operation==='set'?await admin.set(options.get('--url')):operation==='remove'?await admin.remove():await admin.info());
}
main().catch(error=>{
  // WebhookAdmin errors are already redacted; anything else is reported by kind only.
  const safe=/^(Telegram|Secret|The webhook URL|Invalid owner|Explicit project|--url|No owner)/.test(error?.message??'')?error.message:'Webhook administration failed';
  console.error(safe);process.exitCode=1;
});
