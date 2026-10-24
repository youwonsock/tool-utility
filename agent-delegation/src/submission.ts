import fs from 'node:fs';
import path from 'node:path';
import { STORE_FORMAT, Fault, invariant, idSchema, type Run, type TaskSpec, type ContextFile, type SubmitArgs, type WorkerConfig, type WorkerSelection } from './types.js';
import { uid, hash, digest, inside, mkdir, readJson, writeJson, durableWrite } from './io.js';
import { repository, captureContext, checkContext, worktree, clean, head, branch, git } from './git.js';
import { moveRun, moveValidation } from './lifecycle.js';
import type { Store } from './store.js';
import { resolveWorker } from './profiles.js';
import { resolveRuntime } from './runtime.js';
import { connection } from './backends/policy.js';

type Manifest = {
  protocol: number; request_id: string; request_hash: string; run_id: string; repo: string; base: string;
  new_run: boolean; integration_dir: string; integration_branch: string;
  files: { path: string; hash: string }[];
  result: {run_id:string; revision:number; tasks:string[]};
};
function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory,'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function validateManifest(store: Store, m: Manifest, requestID: string) {
  invariant(m.protocol===STORE_FORMAT && m.request_id === requestID && idSchema.safeParse(m.run_id).success, 'STATE_CORRUPT','Invalid submission preparation record.');
  invariant(m.result?.run_id===m.run_id && Array.isArray(m.result.tasks) && m.result.tasks.every(id=>idSchema.safeParse(id).success) && Array.isArray(m.files) && typeof m.new_run==='boolean' && typeof m.repo==='string' && typeof m.base==='string','STATE_CORRUPT','Invalid prepared submission fields.');
  invariant(store.request(requestID)?.hash === m.request_hash, 'STATE_CORRUPT','Submission request does not match its durable intent.');
  invariant(m.integration_dir === path.join(store.root,'worktrees',m.run_id,'integration') && m.integration_branch === `codex/agent-delegation-${m.run_id}`, 'STATE_CORRUPT','Invalid prepared worktree identity.');
  for (const file of m.files) {
    const artifact = file.path.startsWith(`artifacts/${m.run_id}/artifact_`) && !file.path.slice(`artifacts/${m.run_id}/`.length).includes('/');
    const metadata = m.result.tasks.some(id=>idSchema.safeParse(id).success && file.path===`runs/${m.run_id}/${id}.json`);
    invariant(artifact || metadata,'STATE_CORRUPT','Invalid prepared file identity.'); inside(store.root,file.path);
  }
}
function published(store: Store, m: Manifest) {
  return !!store.run(m.run_id) && store.events(m.run_id).some(e=>e.type==='tasks_submitted' && (e.data as {request_id?:string})?.request_id===m.request_id);
}
async function rollback(store: Store, m: Manifest, directory: string, beforeCleanup?:()=>Promise<void>) {
  // Only unpublished, unchanged resources owned by this exact preparation may be removed.
  invariant(!published(store,m),'REQUEST_UNCERTAIN','Submission was published; its resources cannot be rolled back.');
  if (m.new_run) {
    if (fs.existsSync(m.integration_dir)) {
      invariant(await head(m.integration_dir)===m.base && await branch(m.integration_dir)===m.integration_branch,'REQUEST_UNCERTAIN','Prepared worktree changed; it was preserved.');
      await clean(m.integration_dir);
      await git(m.repo,['worktree','remove',m.integration_dir]);
    }
    const ref=await git(m.repo,['rev-parse','--verify',`refs/heads/${m.integration_branch}`],true);
    if (ref.code===0) {
      invariant(ref.stdout.trim()===m.base,'REQUEST_UNCERTAIN','Prepared branch changed; it was preserved.');
      await git(m.repo,['branch','-D',m.integration_branch]);
    }
    // Empty parents are harmless, but remove them to make failed submissions leave no checkout.
    for (const dir of [path.dirname(m.integration_dir),path.join(store.root,'worktrees')]) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length===0) fs.rmdirSync(dir);
    }
  }
  for (const file of m.files) {
    const absolute=inside(store.root,file.path);
    if (!fs.existsSync(absolute)) continue;
    invariant(hash(fs.readFileSync(absolute))===file.hash,'REQUEST_UNCERTAIN','Prepared file changed; it was preserved.',{path:file.path});
    fs.unlinkSync(absolute);
    let parent=path.dirname(absolute);
    while (parent!==store.root && fs.existsSync(parent) && fs.readdirSync(parent).length===0) { fs.rmdirSync(parent); parent=path.dirname(parent); }
  }
  // Keep the ownership manifest until the durable reservation retirement succeeds.
  // A failed retirement can therefore be retried after restart without guessing.
  await beforeCleanup?.();fs.rmSync(directory,{recursive:true});
}

export async function recoverSubmissions(store: Store, onRollback?:(requestID:string)=>Promise<void>) {
  const root=path.join(store.root,'submissions'); if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root)) {
    invariant(idSchema.safeParse(entry).success,'STATE_CORRUPT','Invalid submission directory.');
    const directory=inside(root,entry), m=readJson<Manifest>(path.join(directory,'manifest.json'));
    // No external creation begins before the manifest is durable.
    if (!m) {
      const request=store.request(entry);
      const owned=request && (fs.readdirSync(directory).every(name=>/^manifest\.json\.[a-f0-9-]+\.tmp$/.test(name)) || request.status==='done'&&store.state.events.some(e=>e.type==='tasks_submitted' && (e.data as {request_id?:string})?.request_id===entry));
      if (owned) fs.rmSync(directory,{recursive:true});
      else process.stderr.write(`Submission directory ${entry} has no ownership manifest; it was preserved.\n`);
      continue;
    }
    validateManifest(store,m,entry);
    if (published(store,m)) {
      const request=store.request(entry)!;
      invariant(request.status==='done','REQUEST_UNCERTAIN','Published submission has no atomic response; its records were preserved.');
      fs.rmSync(directory,{recursive:true});
    } else {
      try { await rollback(store,m,directory,async()=>{await onRollback?.(entry);}); }
      catch (e) { process.stderr.write(`Submission ${entry} cleanup requires reconciliation: ${(e as Error).message}\n`); }
    }
  }
}

export async function submitTasks(store: Store, args: SubmitArgs, validateGraph: (specs:TaskSpec[])=>void,
  resolve:(selection?:WorkerSelection)=>WorkerConfig=selection=>resolveWorker(store.root,selection),
  publish:(result?:unknown)=>Promise<void>=async()=>undefined,
  bindRepository:(commonDir:string)=>Promise<void>=async()=>undefined) {
  const specs=structuredClone(args.tasks);
  let existing: Run | undefined, candidate: Run;
  if (args.run_id) {
    existing=store.state.runs.find(r=>r.id===args.run_id); invariant(existing,'NOT_FOUND','Run not found.');
    invariant(['active','waiting_final_review'].includes(existing.state),'RUN_FROZEN','Run does not accept new tasks in its current state.');
    invariant(!args.repo || args.repo===existing.repo,'REPO','Cannot change run repository.');
    invariant(!args.worker && !args.settings && !args.resources.length && !args.context_files.length,'RUN_CONFIG','Run worker, settings, resources and shared context are immutable.');
    candidate={...existing,tasks:[...existing.tasks]};
    checkContext(existing.repo,existing.context);
  } else {
    invariant(args.repo,'REPO','A repository root is required for a new run.');
    const repo=await repository(args.repo), id=uid('run');
    candidate={id,...repo,integration_branch:`codex/agent-delegation-${id}`,integration_dir:path.join(store.root,'worktrees',id,'integration'),integration_commit:repo.base,
      state:'active',revision:1,created:Date.now(),tasks:[],context:[],resources:args.resources,final_verification:args.final_verification??[],worker:resolve(args.worker),
      settings:{concurrency:2,timeout_ms:3600000,max_retries:3,...args.settings}};
    const keys=candidate.resources.map(r=>r.resource_key);
    invariant(new Set(keys).size===keys.length,'RESOURCE','Duplicate resource key.');
    for (const profile of candidate.resources) {
      const priorHash=store.state.resource_hashes[profile.resource_key];
      invariant(!priorHash || priorHash===digest(profile),'RESOURCE_PROFILE','The same resource_key must refer to the same profile service-wide.');
      for (const other of store.state.runs.flatMap(r=>r.resources)) if (other.resource_key===profile.resource_key) {
        invariant(digest(other)===digest(profile),'RESOURCE_PROFILE','The same resource_key must refer to the same profile service-wide.');
      }
    }
  }
  await bindRepository(candidate.common_dir);
  validateGraph([...candidate.tasks.map(t=>t.spec),...specs]);
  for (const spec of specs) invariant(spec.resources.every(key=>candidate.resources.some(r=>r.resource_key===key)),'RESOURCE',`Task ${spec.id} references an unregistered resource.`);
  for(const resource of candidate.resources)connection(resource,candidate.integration_dir);
  const workers=new Map<string,WorkerConfig>();
  for(const spec of specs) {
    const worker=spec.worker?resolve(spec.worker):JSON.parse(JSON.stringify(candidate.worker));
    worker.runtime=await resolveRuntime(worker);
    workers.set(spec.id,worker);
    for(const key of spec.resources) {
      const normalized=connection(candidate.resources.find(r=>r.resource_key===key)!,candidate.integration_dir);
      invariant(worker.platform!=='codex'||normalized.type!=='sse','MCP_POLICY','Codex resources must use stdio or streamable HTTP.');
      const config=candidate.resources.find(r=>r.resource_key===key)!.connection.config;
      invariant(!['codex','claude-code'].includes(worker.platform)||config.oauth===undefined&&config.timeout===undefined,'MCP_POLICY','This platform cannot express resource oauth/timeout settings. Use native authentication or a compatible connection.');
    }
  }
  const shared=existing ? existing.context.map(c=>c.path) : args.context_files;
  const captures=await captureContext(candidate.repo,[...shared,...specs.flatMap(s=>s.context_files)]);
  const files: {path:string;hash:string;data:Buffer}[]=[];
  const contexts=new Map<string,ContextFile>();
  for (const {data,...context} of captures) {
    const old=existing?.context.find(c=>c.path===context.path);
    if (old) { invariant(old.hash===context.hash,'CONTEXT_CHANGED',`Context changed: ${context.path}`); contexts.set(context.path,old); }
    else {
      const artifact=`${candidate.id}/${uid('artifact')}-context`;
      contexts.set(context.path,{...context,artifact}); files.push({path:`artifacts/${artifact}`,hash:hash(data),data});
    }
  }
  if (!existing) candidate.context=[...new Set(shared)].sort().map(p=>contexts.get(p)!);
  for (const spec of specs) {
    spec.context_files=[...new Set([...shared,...spec.context_files])].sort();
    const context=spec.context_files.map(p=>contexts.get(p)!);
    const worker=workers.get(spec.id)!;
    const data=Buffer.from(JSON.stringify({spec,context,worker}));
    files.push({path:`runs/${candidate.id}/${spec.id}.json`,hash:hash(data),data});
    candidate.tasks.push({spec,state:'queued',attempts:[],revision:1,worker});
  }
  if (existing) {
    candidate.revision++;
    if (candidate.validation) {
      const invalidated={...candidate.validation}; moveValidation(invalidated,'invalidated');
      candidate.validation_history=[...(candidate.validation_history??[]),invalidated]; candidate.validation=undefined;
    }
  }
  if (args.final_verification) candidate.final_verification=args.final_verification;
  moveRun(candidate,'active');
  for (const file of files) invariant(!fs.existsSync(inside(store.root,file.path)),'SUBMISSION_COLLISION','Prepared metadata already exists.');
  if (!existing) {
    invariant(!fs.existsSync(candidate.integration_dir),'SUBMISSION_COLLISION','Prepared worktree already exists.');
    invariant((await git(candidate.repo,['show-ref','--verify',`refs/heads/${candidate.integration_branch}`],true)).code!==0,'SUBMISSION_COLLISION','Prepared branch already exists.');
  }
  const result={run_id:candidate.id,revision:candidate.revision,tasks:specs.map(s=>s.id)};
  const m: Manifest={protocol:STORE_FORMAT,request_id:args.request_id,request_hash:store.state.requests[args.request_id]!.hash,run_id:candidate.id,
    repo:candidate.repo,base:candidate.base,new_run:!existing,integration_dir:candidate.integration_dir,integration_branch:candidate.integration_branch,
    files:files.map(({data,...file})=>file),result};
  const directory=inside(path.join(store.root,'submissions'),args.request_id);
  invariant(!fs.existsSync(directory),'REQUEST_UNCERTAIN','This submission still has an unresolved preparation record.');
  writeJson(path.join(directory,'manifest.json'),m);
  let publishing=false;
  try {
    for (let index=0;index<files.length;index++) {
      const file=files[index]!, staged=path.join(directory,'files',String(index)), destination=inside(store.root,file.path);
      durableWrite(staged,file.data); mkdir(path.dirname(destination));
      // Exclusive hard-link publication cannot overwrite metadata and never exposes a partial file.
      fs.linkSync(staged,destination); syncDirectory(path.dirname(destination));
    }
    if (!existing) await worktree(candidate.repo,candidate.integration_dir,candidate.base,candidate.integration_branch);
    publishing=true;
    if(existing){
      const appended=candidate.tasks.slice(existing.tasks.length);existing.tasks.push(...appended);existing.revision=candidate.revision;
      if(existing.validation&&!candidate.validation){moveValidation(existing.validation,'invalidated');(existing.validation_history??=[]).push(existing.validation);existing.validation=undefined;}
      if(args.final_verification)existing.final_verification=candidate.final_verification;moveRun(existing,'active');
    }else store.state.runs.push(candidate);
    store.event(candidate.id,'tasks_submitted',{...result,request_id:args.request_id});
    await publish(result);
  } catch (e) {
    if(e instanceof Fault&&e.code==='CANCELLED'&&!store.uncertain)publishing=false;
    if (publishing || store.uncertain) { store.uncertain=true; throw new Fault('REQUEST_UNCERTAIN','Submission publication is uncertain. Restart and reconcile; no submission was replayed.',{request_id:args.request_id,run_id:candidate.id}); }
    try { await rollback(store,m,directory); }
    catch (cleanup) { throw new Fault('REQUEST_UNCERTAIN','Preparation failed and owned resources could not be safely cleaned.',{request_id:args.request_id,reason:(e as Error).message,cleanup:(cleanup as Error).message}); }
    throw e;
  }
  // Publication is already durable. A retained manifest can be safely recovered on restart.
  try { fs.rmSync(directory,{recursive:true}); } catch { /* Keep the committed preparation for recovery. */ }
  return result;
}
