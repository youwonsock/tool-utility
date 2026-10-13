import fs from 'node:fs';
import path from 'node:path';
import { STORE_FORMAT, Fault, invariant, idSchema, type State, type WorkerSpec, type WorkerConfig, type Attempt, type ProcessIdentity } from './types.js';
import { readJson, writeJson, durableWrite, mkdir, uid, hash, digest, inside, alive, processIdentity, treeAlive } from './io.js';
import { validateStoredState, validateWorkerState, holdsResources } from './lifecycle.js';
import { resolveWorker, type LegacyOptions } from './profiles.js';

type MigrationFile={path:string;original_hash:string|null;converted_hash:string};
type MigrationRecord={id:string;from:1;to:2;phase:'prepared'|'committing'|'committed'|'rolling_back';files:MigrationFile[]};
export type MigrationOptions={apply?:boolean;rollback?:boolean;legacy?:LegacyOptions;onPhase?:(phase:string)=>void};
const attempts=(state:State)=>state.runs.flatMap(r=>[...r.tasks.flatMap(t=>t.attempts),...(r.validation?[r.validation.attempt]:[]),...(r.validation_history??[]).map(v=>v.attempt)]);

function legacyState(root:string) {
  const snapshot=readJson<State>(path.join(root,'state.json'));
  let state=snapshot;
  const journal=fs.existsSync(path.join(root,'journal.jsonl'))?fs.readFileSync(path.join(root,'journal.jsonl'),'utf8'):'';
  const complete=journal.slice(0,journal.lastIndexOf('\n')+1),entries:State[]=[];
  for(const line of complete.split('\n').filter(Boolean)) {
    const record=JSON.parse(line) as {state:State;hash:string};
    invariant(record.hash===digest(record.state),'JOURNAL_CORRUPT','Migration found an invalid committed journal checksum.');
    invariant(record.state.protocol===1,'UPDATE_PENDING','Journal is not a legacy format. Resume the pending migration.');
    entries.push(record.state);
    if(!state||record.state.revision>state.revision)state=record.state;
    if(snapshot&&record.state.revision===snapshot.revision)invariant(digest(snapshot)===record.hash,'STATE_CORRUPT','Snapshot differs from its committed journal record.');
  }
  invariant(state&&state.protocol===1,'UPDATE_PENDING','No legacy state is available to migrate.');
  validateStoredState(state);
  return {state,entries};
}
async function inactive(root:string,state:State) {
  invariant(!Object.values(state.requests).some(r=>r.status!=='done'),'UPDATE_PENDING','Resolve outstanding request intents with the previous release first.');
  for(const run of state.runs) {
    invariant(['active','waiting_final_review','completed','cancelled'].includes(run.state),'UPDATE_PENDING','Resolve cancellation, validation or finalization before migration.');
    invariant(run.tasks.every(t=>['queued','needs_review','integrated','cancelled'].includes(t.state)),'UPDATE_PENDING','A task still has an unresolved execution state.');
  }
  for(const attempt of attempts(state)) {
    invariant(!holdsResources(attempt)&&attempt.state!=='integrating','UPDATE_PENDING','An attempt still holds resources or has an integration intent.');
    invariant(attempt.job_dir===path.join(root,'jobs',attempt.id),'STATE_CORRUPT','Attempt ownership path differs from the data directory.');
    const worker=readJson<Attempt['worker']>(path.join(attempt.job_dir,'worker.json'))??attempt.worker;
    if(worker) {
      validateWorkerState(worker);
      invariant(!await alive(worker.host)&&!await alive(worker.server),'UPDATE_PENDING','An owned worker or server is still alive.');
      if(worker.server)invariant(!await treeAlive(worker.server),'UPDATE_PENDING','An owned process group is still alive.');
      invariant(worker.stopped===true||!fs.existsSync(path.join(attempt.job_dir,'server-intent.json')),'UPDATE_PENDING','Owned process termination is uncertain.');
    }else invariant(!fs.existsSync(path.join(attempt.job_dir,'server-intent.json')),'UPDATE_PENDING','A launch intent has no confirmed owner.');
  }
}
async function acquire(root:string) {
  mkdir(root);const lock=path.join(root,'service.lock');
  if(fs.existsSync(lock)) {
    const prior=readJson<{owner:ProcessIdentity}>(path.join(lock,'owner.json'));
    invariant(prior?.owner&&!await alive(prior.owner),'UPDATE_PENDING','Stop the existing service or verify its uncertain owner first.');
    const reap=path.join(root,'service-reaping.lock');
    try{fs.mkdirSync(reap,{mode:0o700});}catch{throw new Fault('UPDATE_PENDING','Another process is changing service ownership.');}
    try{invariant(!await alive(prior.owner),'UPDATE_PENDING','Service owner became active.');fs.rmSync(lock,{recursive:true});fs.mkdirSync(lock,{mode:0o700});}
    finally{fs.rmSync(reap,{recursive:true});}
  }else fs.mkdirSync(lock,{mode:0o700});
  const owner=await processIdentity(process.pid);invariant(owner,'SERVICE_IDENTITY','Cannot verify migration owner.');writeJson(path.join(lock,'owner.json'),{owner});
  return ()=>{const current=readJson<{owner:ProcessIdentity}>(path.join(lock,'owner.json'));if(current?.owner.pid===owner.pid&&current.owner.birth===owner.birth)fs.rmSync(lock,{recursive:true});};
}
function convertState(root:string,state:State,legacy?:LegacyOptions):State {
  const next=structuredClone(state);next.protocol=STORE_FORMAT;
  for(const run of next.runs) {
    run.worker=resolveWorker(root,undefined,undefined,legacy);
    for(const task of run.tasks) {
      invariant(!task.spec.worker||task.spec.worker.platform==='opencode','STATE_CORRUPT','Legacy record contains a non-OpenCode worker selection.');
      const last=task.attempts.at(-1),spec=last?readJson<WorkerSpec>(path.join(last.job_dir,'spec.json')):undefined;
      const options=spec?{opencode:spec.executable,opencode_args:spec.executable_args}:legacy;
      const model=last?.model??task.spec.model;
      invariant(model===undefined||typeof model==='object','STATE_CORRUPT','Legacy model has an unknown format.');
      task.worker=resolveWorker(root,undefined,model,options);
      for(const attempt of task.attempts)attempt.execution={...task.worker,model:attempt.model??task.worker.model};
    }
    for(const validation of [...(run.validation?[run.validation]:[]),...(run.validation_history??[])])validation.attempt.execution=structuredClone(run.worker);
  }
  validateStoredState(next);return next;
}
function preparationFiles(root:string,state:State) {
  const folder=path.join(root,'submissions');if(!fs.existsSync(folder))return [];
  return fs.readdirSync(folder).map(id=>{
    invariant(idSchema.safeParse(id).success,'STATE_CORRUPT','Unknown submission directory.');
    const relative=`submissions/${id}/manifest.json`,m=readJson<any>(inside(root,relative));
    invariant(m?.protocol===1&&m.request_id===id&&state.requests[id]?.status==='done'&&state.requests[id]?.hash===m.request_hash
      &&state.events.some(e=>e.type==='tasks_submitted'&&(e.data as any).request_id===id&&e.run_id===m.run_id),'UPDATE_PENDING','Resolve the prepared submission with the previous release first.');
    return {path:relative,data:Buffer.from(JSON.stringify({...m,protocol:STORE_FORMAT}))};
  });
}
function directory(root:string,id:string) {invariant(idSchema.safeParse(id).success,'STATE_CORRUPT','Invalid migration ID.');return inside(root,`migrations/${id}`);}
function validateRecord(record:MigrationRecord) {
  invariant(record.from===1&&record.to===2&&['prepared','committing','committed','rolling_back'].includes(record.phase)&&Array.isArray(record.files),'STATE_CORRUPT','Invalid migration record.');
  for(const file of record.files)invariant(['state.json','journal.jsonl'].includes(file.path)||/^submissions\/[A-Za-z0-9_-]+\/manifest\.json$/.test(file.path),'STATE_CORRUPT','Unknown migration target.');
}
function unchanged(root:string,record:MigrationRecord) {
  for(const file of record.files) {
    const location=inside(root,file.path),current=fs.existsSync(location)?hash(fs.readFileSync(location)):null;
    invariant(current===file.original_hash||current===file.converted_hash,'REQUEST_UNCERTAIN','Migration target changed outside this migration; it was preserved.',{path:file.path});
  }
}
async function finish(root:string,record:MigrationRecord,options:MigrationOptions) {
  validateRecord(record);unchanged(root,record);
  const stage=directory(root,record.id),marker=path.join(root,'migration.json');
  record.phase='committing';writeJson(marker,record);
  // Snapshot version is the old release's guard, so publish it before journal/manifests.
  const files=[...record.files].sort((a,b)=>a.path==='state.json'?-1:b.path==='state.json'?1:a.path.localeCompare(b.path));
  for(const file of files) {
    const data=fs.readFileSync(inside(stage,`converted/${file.path}`));invariant(hash(data)===file.converted_hash,'STATE_CORRUPT','Converted migration file checksum differs.');
    durableWrite(inside(root,file.path),data);options.onPhase?.(`written:${file.path}`);
  }
  record.phase='committed';writeJson(marker,record);writeJson(path.join(stage,'completed.json'),record);
  options.onPhase?.('committed');fs.unlinkSync(marker);
  return {migrated:true,from:1,to:2,migration_id:record.id,backup:stage};
}
async function rollback(root:string,record:MigrationRecord,options:MigrationOptions) {
  validateRecord(record);unchanged(root,record);
  const stage=directory(root,record.id),marker=path.join(root,'migration.json');record.phase='rolling_back';writeJson(marker,record);
  const files=[...record.files].sort((a,b)=>a.path==='state.json'?1:b.path==='state.json'?-1:a.path.localeCompare(b.path));
  for(const file of files) {
    if(file.original_hash===null)fs.rmSync(inside(root,file.path),{force:true});
    else {const data=fs.readFileSync(inside(stage,`backup/${file.path}`));invariant(hash(data)===file.original_hash,'STATE_CORRUPT','Migration backup checksum differs.');durableWrite(inside(root,file.path),data);}
    options.onPhase?.(`restored:${file.path}`);
  }
  fs.unlinkSync(marker);return {rolled_back:true,migration_id:record.id};
}
export async function migrate(root:string,options:MigrationOptions={}) {
  const pending=readJson<MigrationRecord>(path.join(root,'migration.json'));
  if(pending&&!options.apply&&!options.rollback){validateRecord(pending);return {from:1,to:2,pending:pending.phase,migration_id:pending.id};}
  if(pending){const release=await acquire(root);try{return options.rollback||pending.phase==='rolling_back'?await rollback(root,pending,options):await finish(root,pending,options);}finally{release();}}
  invariant(!options.rollback,'UPDATE_PENDING','Rollback is available only for an incomplete migration before new work starts.');
  const snapshot=readJson<State>(path.join(root,'state.json'));
  if(snapshot?.protocol===STORE_FORMAT)return {migrated:false,format:STORE_FORMAT};
  const prior=readJson<{owner:ProcessIdentity}>(path.join(root,'service.lock','owner.json'));
  invariant(!prior||!await alive(prior.owner),'UPDATE_PENDING','Stop the service before migrating.');
  let legacy=legacyState(root);await inactive(root,legacy.state);preparationFiles(root,legacy.state);
  if(!options.apply)return {from:1,to:2,eligible:true,runs:legacy.state.runs.length,requests:Object.keys(legacy.state.requests).length};
  const release=await acquire(root);
  try {
    legacy=legacyState(root);await inactive(root,legacy.state);
    const next=convertState(root,legacy.state,options.legacy);
    const journal=legacy.entries.map(state=>{const converted=convertState(root,state,options.legacy);return JSON.stringify({hash:digest(converted),state:converted});}).join('\n');
    const outputs=[{path:'state.json',data:Buffer.from(JSON.stringify(next))},{path:'journal.jsonl',data:Buffer.from(journal?`${journal}\n`:`${JSON.stringify({hash:digest(next),state:next})}\n`)},...preparationFiles(root,legacy.state)];
    const id=uid('migration'),stage=directory(root,id),record:MigrationRecord={id,from:1,to:2,phase:'prepared',files:[]};
    for(const file of outputs) {
      const original=fs.existsSync(inside(root,file.path))?fs.readFileSync(inside(root,file.path)):undefined;
      if(original)durableWrite(inside(stage,`backup/${file.path}`),original);
      durableWrite(inside(stage,`converted/${file.path}`),file.data);
      record.files.push({path:file.path,original_hash:original?hash(original):null,converted_hash:hash(file.data)});
    }
    writeJson(path.join(root,'migration.json'),record);
    return await finish(root,record,options);
  }catch(e){if(fs.existsSync(path.join(root,'migration.json')))throw new Fault('REQUEST_UNCERTAIN','Migration is incomplete. Resume or roll back explicitly; no task was dispatched.',{reason:(e as Error).message});throw e;}
  finally{release();}
}
