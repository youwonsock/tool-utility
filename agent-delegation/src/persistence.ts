import fs from 'node:fs';
import path from 'node:path';
import { STORE_FORMAT, Fault, invariant, type State, type Run, type Attempt } from './types.js';
import { digest, hash, mkdir, readJson, writeJson, durableWrite, alive, treeAlive, inside } from './io.js';
import { holdsResources, validateStoredState } from './lifecycle.js';
import { processEvidence } from './backends/process.js';
import { applyDeltas, type TransactionRecord } from './storage-delta.js';

export const ARCHIVE_AGE = 7 * 24 * 60 * 60 * 1000;
export const emptyState = (): State => ({ protocol: STORE_FORMAT, revision: 0, runs: [], requests: {}, events: [], event_seq: 0,
  archived_runs: {}, archived_requests: {}, resource_hashes: {}, operations: {}, metrics: { responses: 0, response_bytes: 0, mutations: 0 } });
// Legacy checkpoint records are accepted only by the migration reader.
export const journalRecord = (state: State) => `${JSON.stringify({ hash: digest(state), state })}\n`;
export const deltaRecord = (transaction: TransactionRecord) => {
  const payload = JSON.stringify(transaction); return `${JSON.stringify({ hash: hash(payload), payload })}\n`;
};
export const runAttempts = (run: Run): Attempt[] => [...run.tasks.flatMap(t => t.attempts),
  ...(run.validation ? [run.validation.attempt] : []), ...(run.validation_history ?? []).map(v => v.attempt)];
export type StorageManifest = { protocol: 4; generation: string; snapshot: { file: string; hash: string; revision: number }; journals: string[] };
export function readStorageManifest(root:string):StorageManifest|undefined {
  const value=readJson<StorageManifest>(path.join(root,'checkpoint.json'));
  if(value)validateStorageManifest(root,value);return value;
}
export function validateStorageManifest(root:string,value:StorageManifest) {
  invariant(value.protocol===4 && typeof value.generation==='string' && value.snapshot && Number.isSafeInteger(value.snapshot.revision) && value.snapshot.revision>=0 && /^[a-f0-9]{64}$/.test(value.snapshot.hash),'STATE_CORRUPT','Invalid checkpoint manifest.');
  invariant(/^(state\.json|checkpoints\/[a-zA-Z0-9_-]+\/state\.json)$/.test(value.snapshot.file) && Array.isArray(value.journals) && value.journals.length>0 && value.journals.every(file=>/^(journal\.jsonl|journals\/[a-zA-Z0-9_-]+\.jsonl)$/.test(file)) && new Set(value.journals).size===value.journals.length,'STATE_CORRUPT','Invalid checkpoint file identities.');
  inside(root,value.snapshot.file);for(const file of value.journals)inside(root,file);
}

// Bounded input buffers: retain one record, never a complete journal/history.
export function visitJournal(file:string, visit:(item:any)=>void, maximum=Number.POSITIVE_INFINITY) {
  let records=0,completeBytes=0,bytes=0;
  if(!fs.existsSync(file))return {records,completeBytes,bytes};
  const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(64*1024);let pending:Buffer[]=[];
  try {for(;;){const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,maximum-bytes),null);if(!count)break;bytes+=count;let start=0;
    for(let i=0;i<count;i++)if(buffer[i]===10){pending.push(Buffer.from(buffer.subarray(start,i)));const line=Buffer.concat(pending);completeBytes+=line.length+1;pending=[];start=i+1;if(!line.length)continue;
      let item;try{item=JSON.parse(line.toString('utf8'));}catch{throw new Fault('JOURNAL_CORRUPT','A complete journal record is invalid JSON.');}visit(item);records++;}
    if(start<count)pending.push(Buffer.from(buffer.subarray(start,count)));
  }}finally{fs.closeSync(fd);}return {records,completeBytes,bytes};
}
export function loadState(root:string, selected?:StorageManifest, limits?:Record<string,number>) {
  const manifest=selected??readStorageManifest(root);
  let state=readJson<State>(inside(root,manifest?.snapshot.file??'state.json'));
  invariant(!state||[2,3,4].includes(state.protocol),'UPDATE_PENDING','Unknown stored state format.');
  if(state)invariant(Array.isArray(state.runs)&&Array.isArray(state.events),'STATE_CORRUPT','Missing stored entity collections.');
  if(manifest){invariant(state && state.protocol===4 && state.revision===manifest.snapshot.revision && digest(state)===manifest.snapshot.hash,'STATE_CORRUPT','Checkpoint snapshot is missing or corrupt.');}
  let records=0,completeBytes=0,bytes=0;const files:{file:string;records:number;completeBytes:number;bytes:number}[]=[];
  const cutoff=state?.revision??0;let physicalRevision:number|undefined;
  let runs=new Map(state?.runs.map(r=>[r.id,r])??[]),events=new Map(state?.events.map(e=>[e.seq,e])??[]);
  const journals=manifest?.journals??['journal.jsonl'];
  for(const relative of journals){
    const file=inside(root,relative);if(manifest)invariant(fs.existsSync(file),'STATE_CORRUPT','A committed journal generation is missing.',{file:relative});
    const result=visitJournal(file,item=>{
      if(typeof item.payload==='string'){
        invariant(item.hash===hash(item.payload),'JOURNAL_CORRUPT','A committed transaction failed its checksum.');
        let transaction:TransactionRecord;try{transaction=JSON.parse(item.payload);}catch{throw new Fault('JOURNAL_CORRUPT','Invalid transaction JSON.');}
        invariant(transaction.protocol===4 && Array.isArray(transaction.changes) && Number.isSafeInteger(transaction.previous) && transaction.previous>=0 && Number.isSafeInteger(transaction.revision) && transaction.revision===transaction.previous+1,'JOURNAL_CORRUPT','Invalid journal transaction.');
        // Covered checkpoint records may form a retained prefix, but they are still
        // physical committed transactions: duplicates/backtracking/gaps are corruption.
        invariant(physicalRevision===undefined||transaction.previous===physicalRevision,'JOURNAL_CORRUPT','Physical journal transaction order is missing, duplicated, or backwards.');
        physicalRevision=transaction.revision;
        state??=emptyState();invariant(state.protocol===4,'UPDATE_PENDING','Format-4 transactions require a format-4 checkpoint.');
        if(transaction.revision<=cutoff)return;
        invariant(transaction.previous===state.revision,'JOURNAL_CORRUPT','Journal revision is missing, duplicated, or out of order.');
        try{applyDeltas(state,transaction.changes,runs,events);}catch(error){if(error instanceof Fault)throw error;throw new Fault('JOURNAL_CORRUPT','Invalid typed journal operation.',{reason:(error as Error).message});}state.revision=transaction.revision;
      }else{
        invariant(!manifest && item.state && item.hash===digest(item.state),'JOURNAL_CORRUPT','A committed legacy journal record failed its checksum.');
        invariant([2,3,4].includes(item.state.protocol),'UPDATE_PENDING','Journal contains an unsupported storage format.');
        if(!state||item.state.revision>state.revision){state=item.state;runs=new Map(state!.runs.map(r=>[r.id,r]));events=new Map(state!.events.map(e=>[e.seq,e]));}
      }
    },limits?.[relative]);
    // A torn record may exist only at the newest segment, never before later committed records.
    invariant(result.bytes===result.completeBytes||relative===journals.at(-1),'JOURNAL_CORRUPT','An immutable journal generation has a torn record.');
    records+=result.records;completeBytes+=result.completeBytes;bytes+=result.bytes;files.push({file:relative,...result});
  }
  if(state){state.runs=[...runs.values()];state.events=[...events.values()].sort((a,b)=>a.seq-b.seq);}
  return {state,records,bytes,completeBytes,files,manifest};
}
export async function attemptsStopped(run: Run): Promise<boolean> {
  for (const attempt of runAttempts(run)) {
    if (holdsResources(attempt)) return false;
    const worker = readJson<Attempt['worker']>(path.join(attempt.job_dir, 'worker.json')) ?? attempt.worker;
    const launch = readJson<{ host?: NonNullable<Attempt['worker']>['host'] }>(path.join(attempt.job_dir, 'launch.json'));
    const started = readJson<{ host?: NonNullable<Attempt['worker']>['host'] }>(path.join(attempt.job_dir, 'started.json'));
    const evidence = processEvidence(attempt.job_dir, worker ?? { } as NonNullable<Attempt['worker']>);
    if (evidence.uncertain || worker && (!worker.stopped || worker.phase === 'stop_uncertain')) return false;
    const identities = [...evidence.identities, ...(worker?.processes ?? []), ...(worker?.server ? [worker.server] : [])];
    if (await alive(worker?.host ?? started?.host ?? launch?.host)) return false;
    if ((await Promise.all(identities.map(treeAlive))).some(Boolean)) return false;
    if (!worker && fs.existsSync(path.join(attempt.job_dir, 'server-intent.json')) && !evidence.ledger) return false;
  }
  return true;
}


type Migration = { from: 2|3; to: 3|4; backup: string; at: number; target_hash: string };
function syncDirectory(root:string){if(process.platform!=='win32'){const fd=fs.openSync(root,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}
function durableCopy(source:string,destination:string){mkdir(path.dirname(destination));fs.copyFileSync(source,destination);const fd=fs.openSync(destination,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(path.dirname(destination));}
export async function prepareStorage(root:string,now=Date.now()) {
  mkdir(root);const markerPath=path.join(root,'migration.json');let marker=readJson<Migration>(markerPath);const loaded=marker?{state:undefined}:loadState(root);
  if(!marker && (!loaded.state||loaded.state.protocol===STORE_FORMAT))return;
  invariant(marker||[2,3].includes(loaded.state!.protocol),'UPDATE_PENDING','Unsupported storage format.');
  const descriptor=readJson<{owner?:Parameters<typeof alive>[0]}>(path.join(root,'service.json'));
  invariant(!await alive(descriptor?.owner),'UPDATE_PENDING','Stop the previous service before storage migration.');
  if(!marker){
    const legacy=loaded.state!;
    invariant((await Promise.all(legacy.runs.map(attemptsStopped))).every(Boolean),'UPDATE_PENDING','Finish/cancel owned attempts with the previous release before storage migration.');
    const target:State={...legacy,protocol:STORE_FORMAT,revision:legacy.revision+1,event_seq:legacy.events.reduce((maximum,event)=>Math.max(maximum,event.seq),legacy.event_seq??0),archived_runs:legacy.archived_runs??{},archived_requests:legacy.archived_requests??{},resource_hashes:legacy.resource_hashes??Object.create(null),operations:{}};
    for(const run of target.runs){if(['completed','cancelled'].includes(run.state))run.ended_at??=now;for(const resource of run.resources)target.resource_hashes[resource.resource_key]=digest(resource);}
    for(const request of Object.values(target.requests))if(request.status==='done')request.completed_at??=now;
    validateStoredState(target);
    const backup=`backups/format-${legacy.protocol}-${now}`,backupRoot=inside(root,backup);mkdir(backupRoot);
    for(const file of ['state.json','journal.jsonl'])if(fs.existsSync(path.join(root,file)))durableCopy(path.join(root,file),path.join(backupRoot,file));
    // Archive identities/bytes are preserved. The backup can be restored independently of later cleanup.
    if(fs.existsSync(path.join(root,'archives'))){const copyTree=(source:string,destination:string)=>{mkdir(destination);for(const entry of fs.readdirSync(source,{withFileTypes:true})){invariant(!entry.isSymbolicLink(),'STATE_CORRUPT','Archive backup cannot follow symlinks.');const from=path.join(source,entry.name),to=path.join(destination,entry.name);if(entry.isDirectory())copyTree(from,to);else durableCopy(from,to);}syncDirectory(destination);};copyTree(path.join(root,'archives'),path.join(backupRoot,'archives'));}
    writeJson(path.join(backupRoot,'target.json'),target);
    marker={from:legacy.protocol as 2|3,to:4,backup,at:now,target_hash:digest(target)};writeJson(markerPath,marker);
  }
  invariant([2,3].includes(marker.from)&&[3,4].includes(marker.to),'STATE_CORRUPT','Unknown migration marker.');
  const target=readJson<State>(inside(root,`${marker.backup}/target.json`));
  invariant(target&&digest(target)===marker.target_hash,'STATE_CORRUPT','Migration checkpoint is missing or corrupt.');
  invariant((await Promise.all(target.runs.map(attemptsStopped))).every(Boolean),'UPDATE_PENDING','Migration cannot resume while an owned process may still run.');
  const published=readStorageManifest(root);
  if(published){
    const committed=loadState(root,published).state;
    // A manifest is published only after the exact migration target is durable.
    // A resurfaced/stale marker must never roll back later acknowledged writes.
    invariant(committed&&committed.revision===target.revision&&digest(committed)===marker.target_hash,'STATE_CORRUPT','Migration marker conflicts with committed format-4 history; committed files were preserved.');
    fs.unlinkSync(markerPath);syncDirectory(root);return;
  }
  if(marker.to===3){
    // Finish an interrupted older migrator before starting the format-4 transition.
    durableWrite(path.join(root,'journal.jsonl'),journalRecord(target));writeJson(path.join(root,'state.json'),target);fs.unlinkSync(markerPath);syncDirectory(root);return prepareStorage(root,now);
  }
  validateStoredState(target);
  // The durable backup and intent precede both publications. A crash repeats these writes only.
  durableWrite(path.join(root,'journal.jsonl'),journalRecord(target));writeJson(path.join(root,'state.json'),target);
  const manifest:StorageManifest={protocol:4,generation:`migration_${marker.at}`,snapshot:{file:'state.json',hash:digest(target),revision:target.revision},journals:['journal.jsonl']};
  // The legacy full-state migration record is no longer needed once its exact snapshot is durable.
  durableWrite(path.join(root,'journal.jsonl'),'');writeJson(path.join(root,'checkpoint.json'),manifest);
  fs.unlinkSync(markerPath);syncDirectory(root);
}
