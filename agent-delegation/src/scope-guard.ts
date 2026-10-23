import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Fault, invariant } from './types.js';
import { digest, writeJson, sleep } from './io.js';
import { git, head, checkContext, status } from './git.js';
import { checkedMutationPath, scopeAllows, workerPolicyHash } from './scope.js';
import type { BackendContext } from './backends/contract.js';

async function fileDigest(file:string):Promise<string> {
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink())return `link:${fs.readlinkSync(file)}`;
  if(!stat.isFile())return `mode:${stat.mode}`;
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return `${stat.mode}:${hash.digest('hex')}`;
}

// The worker owns this monitor: service/MCP disconnects do not disable it.
// Notifications provide prompt checks; periodic Git/context checks cover missed
// events. Unknown watcher or inspection health is a hard failure.
export class ScopeGuard {
  private watcher?:fs.FSWatcher;
  private timer?:NodeJS.Timeout;
  private watchdog?:NodeJS.Timeout;
  private lastHealthyAt=Date.now();
  private pending=new Set<string>();
  private checking?:Promise<void>;
  private initialHead='';
  private initialRef='';
  private verification?:Map<string,string>;
  private failure?:Fault;
  private closed=false;
  constructor(private context:BackendContext,private halt:()=>Promise<unknown>){}
  async start() {
    const {spec,state,save}=this.context;
    state.scope_guard={status:'starting',checked_at:Date.now(),policy_hash:workerPolicyHash(spec)};save();
    this.lastHealthyAt=Date.now();
    this.watchdog=setInterval(()=>this.checkHeartbeat(),250);
    try {
      this.initialHead=await head(spec.directory);
      this.initialRef=(await git(spec.directory,['symbolic-ref','--quiet','HEAD'],true)).stdout.trim();
      this.watcher=fs.watch(spec.directory,{recursive:true},(_event,file)=>{
        if(this.failure||this.closed)return;
        if(!file){this.fail(new Fault('SCOPE_GUARD_UNKNOWN','Filesystem notification omitted its path.'));return;}
        const relative=String(file).split(path.sep).join('/');
        if(relative==='.git'||relative.startsWith('.git/'))return;
        this.pending.add(relative);
        if(this.pending.size>4096){this.fail(new Fault('SCOPE_GUARD_UNKNOWN','Scope notification backlog exceeded its bounded capacity.'));return;}
        void this.check();
      });
      this.watcher.on('error',error=>this.fail(new Fault('SCOPE_GUARD_UNKNOWN',`Scope watcher failed: ${error.message}`)));
      await this.check();this.assertHealthy();
      this.timer=setInterval(()=>{void this.check();},250);
    }catch(error){this.fail(error instanceof Fault?error:new Fault('SCOPE_GUARD_UNKNOWN',(error as Error).message));this.assertHealthy();}
  }
  private fail(error:Fault) {
    if(this.failure||this.closed)return;
    this.failure=error;
    const {spec,state,save}=this.context;
    const evidence='scope-violation.json';
    const encoded=JSON.stringify(error.details??null),details=encoded.length>48*1024?{truncated:true,preview:encoded.slice(0,48*1024)}:error.details??null;
    const policy_hash=state.scope_guard?.policy_hash??'<unavailable>';
    state.scope_guard={status:error.code==='SCOPE_GUARD_UNKNOWN'?'unknown':'violated',checked_at:Date.now(),policy_hash,evidence};
    state.error_code=error.code;state.error_details=error.details;
    try {
      try{writeJson(path.join(spec.job_dir,evidence),{code:error.code,message:error.message.slice(0,4096),details,at:Date.now(),phase:state.phase,policy_hash});}
      catch(collectionError){state.error_details={violation:details,collection_error:(collectionError as Error).message.slice(0,4096)};}
      try{save();}catch{/* The original violation still stops owned execution if persistence failed. */}
    }finally{void this.halt().catch(()=>undefined);}
  }
  fault(){return this.failure;}
  checkHeartbeat(at=Date.now()) {
    if(!this.closed&&!this.failure&&at-this.lastHealthyAt>=10000)this.fail(new Fault('SCOPE_GUARD_UNKNOWN','Scope inspection stopped reporting healthy progress.'));
  }
  assertHealthy(){if(this.failure)throw this.failure;invariant(!this.closed,'SCOPE_GUARD_UNKNOWN','Scope monitor has stopped.');}
  async check():Promise<void> {
    if(this.failure||this.closed)return;
    if(this.checking)return this.checking;
    this.checking=this.inspect().catch(error=>this.fail(error instanceof Fault?error:new Fault('SCOPE_GUARD_UNKNOWN',`Scope inspection failed: ${(error as Error).message}`))).finally(()=>{this.checking=undefined;});
    return this.checking;
  }
  // Join an in-flight scan, then run a fresh one after owned execution stopped.
  // A status/snapshot sampled before its last write cannot certify completion.
  async flush(){await this.check();await this.check();}
  private async sourceSnapshot():Promise<Map<string,string>> {
    const {spec}=this.context;
    const paths=(await git(spec.directory,['--no-optional-locks','ls-files','-z','--cached','--others','--exclude-standard'])).stdout.split('\0').filter(Boolean);
    const result=new Map<string,string>();
    for(const file of [...new Set(paths)].sort()) {
      const absolute=path.resolve(spec.directory,file);
      try{result.set(file,await fileDigest(absolute));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')result.set(file,'<absent>');else throw error;}
    }
    return result;
  }
  async beginVerification() {
    await this.flush();this.assertHealthy();
    this.verification=await this.sourceSnapshot();
    await this.flush();this.assertHealthy();
  }
  private async inspect() {
    const {spec,state,save}=this.context;
    const changes=await status(spec.directory);
    invariant(await head(spec.directory)===this.initialHead,'WORKER_CHANGED_HEAD','Worker changed HEAD.');
    invariant((await git(spec.directory,['symbolic-ref','--quiet','HEAD'],true)).stdout.trim()===this.initialRef,'WORKER_CHANGED_HEAD','Worker changed its Git branch.');
    checkContext(spec.directory,spec.context);
    const violations=changes.filter(change=>!spec.context.some(c=>!c.tracked&&c.path===change.path)&&!scopeAllows(spec.scope,change.path));
    invariant(!violations.length,'SCOPE_VIOLATION','Changes exceed the declared scope.',violations.slice(0,100));
    for(const change of changes.filter(c=>!spec.context.some(context=>context.path===c.path)))checkedMutationPath(spec.directory,change.path,spec.scope,spec.context.map(c=>c.path));
    const notifications=[...this.pending];this.pending.clear();
    for(const file of notifications) {
      if(spec.context.some(c=>c.path.toLowerCase()===file.toLowerCase())){checkContext(spec.directory,spec.context);continue;}
      if(scopeAllows(spec.scope,file))continue;
      try{if(fs.lstatSync(path.join(spec.directory,file)).isDirectory()&&spec.scope.some(entry=>entry==='**'||entry.normalize('NFC').toLowerCase().startsWith(`${file.normalize('NFC').toLowerCase()}/`)))continue;}catch{/* Removed paths still require a policy check. */}
      const ignored=await git(spec.directory,['check-ignore','--quiet','--',file],true);
      invariant(ignored.code===0,'SCOPE_VIOLATION','Changes exceed the declared scope.',[{path:file,notification:true}]);
    }
    if(this.verification) {
      const observed=await this.sourceSnapshot();
      invariant(digest([...observed])===digest([...this.verification]),'VERIFICATION_CHANGED','Verification changed source files.');
    }
    this.assertHealthy();this.lastHealthyAt=Date.now();state.scope_guard={status:'healthy',checked_at:this.lastHealthyAt,policy_hash:workerPolicyHash(spec)};save();
  }
  async stop(){this.closed=true;clearInterval(this.timer);clearInterval(this.watchdog);this.watcher?.close();await this.checking;}
}

// Uncertain termination retains the worker and its monitor. Retry only owned
// termination confirmation; never repeat model, command, or permission effects.
export async function awaitGuardedTermination(guard:Pick<ScopeGuard,'check'>|undefined,confirm:()=>Promise<boolean>,wait:(ms:number)=>Promise<void>=sleep) {
  let retries=0;
  while(!await confirm()) {await guard?.check();await wait(Math.min(1000,100*2**Math.min(4,retries++)));}
  await guard?.check();
}
