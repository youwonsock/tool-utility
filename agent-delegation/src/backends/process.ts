import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { invariant, type ProcessIdentity } from '../types.js';
import { writeJson, readJson, uid, processIdentity, terminate, treeAlive } from '../io.js';
import type { BackendContext } from './contract.js';

export function beginProcess(context:BackendContext) {
  const id=uid('process');
  writeJson(path.join(context.spec.job_dir,'process-intents',`${id}.json`),{id,at:Date.now()});
  writeJson(path.join(context.spec.job_dir,'server-intent.json'),{id,at:Date.now(),backend:context.spec.worker?.platform});
  return id;
}
export async function registerProcess(context:BackendContext,child:ChildProcess,intentID?:string) {
  await new Promise<void>((resolve,reject)=>{
    const onError=(error:Error)=>{
      if(intentID)writeJson(path.join(context.spec.job_dir,'process-records',`${intentID}.json`),{failed:true,stopped:true});
      reject(error);
    };
    child.once('spawn',()=>{child.removeListener('error',onError);resolve();});child.once('error',onError);
  });
  invariant(child.pid,'SPAWN','Native runtime failed to start.');
  const identity=await processIdentity(child.pid);
  invariant(identity,'PROCESS_IDENTITY','Native runtime identity could not be verified.');
  if(intentID)writeJson(path.join(context.spec.job_dir,'process-records',`${intentID}.json`),{identity,stopped:false});
  context.state.server=identity;
  (context.state.processes??=[]).push(identity);context.save();
  return identity;
}
export async function spawnRuntime(context:BackendContext,executable:string,args:string[],env:NodeJS.ProcessEnv) {
  const intent=beginProcess(context);
  const child=spawn(executable,args,{cwd:context.spec.directory,env,detached:process.platform!=='win32',windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.on('error',error=>{context.state.error=error.message;context.save();});
  await registerProcess(context,child,intent);
  const log=fs.createWriteStream(path.join(context.spec.job_dir,'server.log'),{flags:'a',mode:0o600});
  child.stderr!.on('data',data=>log.write(data));
  child.once('close',()=>log.end());
  return {child,log};
}
export async function stopOwned(context:BackendContext):Promise<boolean> {
  const intents=path.join(context.spec.job_dir,'process-intents');
  if(fs.existsSync(intents)) {
    let stopped=true;
    for(const name of fs.readdirSync(intents).filter(n=>/^process_[a-f0-9]{32}\.json$/.test(n))) {
      const file=path.join(context.spec.job_dir,'process-records',name);
      const record=readJson<{identity?:ProcessIdentity;stopped:boolean;failed?:boolean}>(file);
      if(record?.failed&&record.stopped)continue;
      if(!record?.identity){stopped=false;continue;}
      if(record.stopped)continue;
      const confirmed=await terminate(record.identity,true);
      if(confirmed)writeJson(file,{...record,stopped:true});
      stopped=confirmed&&stopped;
    }
    return stopped;
  }
  const identities:ProcessIdentity[]=[...new Map([...(context.state.processes??[]),...(context.state.server?[context.state.server]:[])].map(p=>[`${p.pid}:${p.birth}`,p])).values()];
  if(!identities.length)return !fs.existsSync(path.join(context.spec.job_dir,'server-intent.json'));
  let stopped=true;
  for(const identity of identities) stopped=await terminate(identity,true)&&stopped;
  return stopped;
}
export async function confirmedStopped(spec:BackendContext['spec'],state:BackendContext['state']) {
  const intents=path.join(spec.job_dir,'process-intents');
  if(!fs.existsSync(intents))return !(!state.server&&fs.existsSync(path.join(spec.job_dir,'server-intent.json')))&&(!state.server||!await treeAlive(state.server));
  for(const name of fs.readdirSync(intents).filter(n=>/^process_[a-f0-9]{32}\.json$/.test(n))) {
    const record=readJson<{identity?:ProcessIdentity;stopped:boolean;failed?:boolean}>(path.join(spec.job_dir,'process-records',name));
    if(record?.failed&&record.stopped)continue;
    if(!record?.identity||!record.stopped||await treeAlive(record.identity))return false;
  }
  return true;
}
export function processEvidence(jobDir:string,state:BackendContext['state']) {
  const intents=path.join(jobDir,'process-intents');
  if(!fs.existsSync(intents))return {identities:state.server?[state.server]:[],uncertain:!state.server&&fs.existsSync(path.join(jobDir,'server-intent.json')),ledger:false};
  const identities:ProcessIdentity[]=[];let uncertain=false;
  for(const name of fs.readdirSync(intents).filter(n=>/^process_[a-f0-9]{32}\.json$/.test(n))) {
    const record=readJson<{identity?:ProcessIdentity;stopped:boolean;failed?:boolean}>(path.join(jobDir,'process-records',name));
    if(record?.failed&&record.stopped)continue;
    if(!record?.identity){uncertain=true;continue;}
    if(!record.stopped)identities.push(record.identity);
  }
  return {identities,uncertain,ledger:true};
}
