import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { invariant, type ProcessIdentity } from '../types.js';
import { writeJson, readJson, uid, processIdentity, terminate, treeAlive } from '../io.js';
import type { BackendContext } from './contract.js';

export function beginProcess(context:BackendContext,primary=true) {
  const id=uid('process');
  writeJson(path.join(context.spec.job_dir,'process-intents',`${id}.json`),{id,at:Date.now()});
  if(primary)writeJson(path.join(context.spec.job_dir,'server-intent.json'),{id,at:Date.now(),backend:context.spec.worker?.platform});
  return id;
}
export async function registerProcess(context:BackendContext,child:ChildProcess,intentID?:string,primary=true) {
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
  if(primary)context.state.server=identity;
  (context.state.processes??=[]).push(identity);context.save();
  return identity;
}
export async function spawnRuntime(context:BackendContext,executable:string,args:string[],env:NodeJS.ProcessEnv,options:{primary?:boolean}={}) {
  const primary=options.primary!==false,intent=beginProcess(context,primary);
  const child=spawn(executable,args,{cwd:context.spec.directory,env,detached:process.platform!=='win32',windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.on('error',error=>{context.state.error=error.message;context.save();});
  const identity=await registerProcess(context,child,intent,primary);
  const log=fs.createWriteStream(path.join(context.spec.job_dir,'server.log'),{flags:'a',mode:0o600});
  child.stderr!.on('data',data=>log.write(data));
  child.once('close',()=>log.end());
  return {child,log,identity,intent};
}
const stopping=new Map<string,Promise<boolean>>();
export function stopRuntimeIntent(context:BackendContext,intent:string):Promise<boolean> {
  invariant(/^process_[a-f0-9]{32}$/.test(intent),'PROCESS_IDENTITY','Invalid owned process intent.');
  const key=`${path.resolve(context.spec.job_dir)}:${intent}`,active=stopping.get(key);if(active)return active;
  const operation=(async()=>{
    const file=path.join(context.spec.job_dir,'process-records',`${intent}.json`);
    const record=readJson<{identity?:ProcessIdentity;stopped:boolean;failed?:boolean}>(file);
    if(record?.failed&&record.stopped)return true;
    if(!record?.identity)return false;
    if(record.stopped)return true;
    const confirmed=await terminate(record.identity,true);
    if(confirmed)writeJson(file,{...record,stopped:true});
    return confirmed;
  })().finally(()=>{if(stopping.get(key)===operation)stopping.delete(key);});
  stopping.set(key,operation);return operation;
}
export function stopOwned(context:BackendContext):Promise<boolean> {
  const key=path.resolve(context.spec.job_dir),active=stopping.get(key);if(active)return active;
  const operation=stopOwnedProcesses(context).finally(()=>{if(stopping.get(key)===operation)stopping.delete(key);});
  stopping.set(key,operation);return operation;
}
async function stopOwnedProcesses(context:BackendContext):Promise<boolean> {
  const intents=path.join(context.spec.job_dir,'process-intents');
  if(fs.existsSync(intents)) {
    let stopped=true;
    for(const name of fs.readdirSync(intents).filter(n=>/^process_[a-f0-9]{32}\.json$/.test(n))) {
      stopped=await stopRuntimeIntent(context,name.slice(0,-5))&&stopped;
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
