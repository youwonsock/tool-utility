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
  return id;
}
export async function registerProcess(context:BackendContext,child:ChildProcess,intentID:string,primary=true) {
  await new Promise<void>((resolve,reject)=>{
    const onError=(error:Error)=>{
      writeJson(path.join(context.spec.job_dir,'process-records',`${intentID}.json`),{failed:true,stopped:true});
      reject(error);
    };
    child.once('spawn',()=>{child.removeListener('error',onError);resolve();});child.once('error',onError);
  });
  invariant(child.pid,'SPAWN','Native runtime failed to start.');
  const identity=await processIdentity(child.pid);
  invariant(identity,'PROCESS_IDENTITY','Native runtime identity could not be verified.');
  writeJson(path.join(context.spec.job_dir,'process-records',`${intentID}.json`),{identity,stopped:false});
  if(primary)context.state.server=identity;
  (context.state.processes??=[]).push(identity);context.save();
  return identity;
}
export async function spawnRuntime(context:BackendContext,executable:string,args:string[],env:NodeJS.ProcessEnv,options:{primary?:boolean}={}) {
  const primary=options.primary!==false,intent=beginProcess(context);
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
    if(record?.failed)return record.stopped&&!record.identity;
    if(!record?.identity)return false;
    if(record.stopped)return !await treeAlive(record.identity);
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
type ProcessRecord={identity?:ProcessIdentity;stopped:boolean;failed?:boolean};
function processLedger(jobDir:string,state:BackendContext['state']) {
  const directory=path.join(jobDir,'process-intents'),ledger=fs.existsSync(directory);
  const names=ledger?fs.readdirSync(directory):[],records=new Map<string,ProcessRecord>();
  let uncertain=names.some(name=>!/^process_[a-f0-9]{32}\.json$/.test(name));
  for(const name of names.filter(name=>/^process_[a-f0-9]{32}\.json$/.test(name))) {
    const intent=readJson<{id:string}>(path.join(directory,name));
    const record=readJson<ProcessRecord>(path.join(jobDir,'process-records',name));
    if(intent?.id!==name.slice(0,-5)||!record||typeof record.stopped!=='boolean'
      ||(record.identity&&(!Number.isSafeInteger(record.identity.pid)||record.identity.pid<=0||typeof record.identity.birth!=='string'||!record.identity.birth))
      ||(record.failed&&(!record.stopped||record.identity))
      ||(!record.identity&&!(record.failed&&record.stopped))){uncertain=true;continue;}
    records.set(name,record);
  }
  const recorded=path.join(jobDir,'process-records');
  if(fs.existsSync(recorded)&&fs.readdirSync(recorded).some(name=>!records.has(name)))uncertain=true;
  // State pointers cannot replace the durable launch ledger. Missing entries must
  // retain leases even if a worker snapshot claims that its process stopped.
  for(const identity of [...(state.processes??[]),...(state.server?[state.server]:[])]) {
    if(![...records.values()].some(record=>record.identity?.pid===identity.pid&&record.identity.birth===identity.birth))uncertain=true;
  }
  if(!ledger&&fs.existsSync(path.join(jobDir,'server-intent.json')))uncertain=true;
  return {records,uncertain,ledger};
}
async function stopOwnedProcesses(context:BackendContext):Promise<boolean> {
  const evidence=processLedger(context.spec.job_dir,context.state);let stopped=!evidence.uncertain;
  for(const name of evidence.records.keys())stopped=await stopRuntimeIntent(context,name.slice(0,-5))&&stopped;
  return stopped;
}
export async function confirmedStopped(spec:BackendContext['spec'],state:BackendContext['state']) {
  const evidence=processLedger(spec.job_dir,state);if(evidence.uncertain)return false;
  for(const record of evidence.records.values()) {
    if(record.failed&&record.stopped)continue;
    if(!record.identity||!record.stopped||await treeAlive(record.identity))return false;
  }
  return true;
}
export function processEvidence(jobDir:string,state:BackendContext['state']) {
  const {records,uncertain,ledger}=processLedger(jobDir,state);
  return {identities:[...records.values()].filter(record=>!record.stopped&&record.identity).map(record=>record.identity!),uncertain,ledger};
}
