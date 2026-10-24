import fs from 'node:fs';
import path from 'node:path';
import { STORE_FORMAT, Fault, invariant, type State, type Run, type Attempt } from './types.js';
import { digest, hash, readJson, alive, treeAlive, inside } from './io.js';
import { holdsResources } from './lifecycle.js';
import { processEvidence } from './backends/process.js';
import { applyDeltas, type TransactionRecord } from './storage-delta.js';

export const ARCHIVE_AGE = 7 * 24 * 60 * 60 * 1000;
export const emptyState = (): State => ({ protocol: STORE_FORMAT, revision: 0, runs: [], requests: {}, events: [], event_seq: 0,
  archived_runs: {}, archived_requests: {}, resource_hashes: {}, operations: {}, metrics: { responses: 0, response_bytes: 0, mutations: 0 } });
export const deltaRecord = (transaction: TransactionRecord) => {
  const payload = JSON.stringify(transaction); return `${JSON.stringify({ hash: hash(payload), payload })}\n`;
};
export const runAttempts = (run: Run): Attempt[] => [...run.tasks.flatMap(t => t.attempts),
  ...(run.validation ? [run.validation.attempt] : []), ...(run.validation_history ?? []).map(v => v.attempt)];
export type StorageManifest = { protocol: 4; generation: string; snapshot: { file: string; hash: string; revision: number }; journals: string[] };
export function readStorageManifest(root:string):StorageManifest|undefined {
  const file=path.join(root,'checkpoint.json');if(!fs.existsSync(file))return;
  const value=readJson<StorageManifest>(file);validateStorageManifest(root,value!);return value;
}
export function validateStorageManifest(root:string,value:StorageManifest) {
  invariant(value&&typeof value==='object'&&!Array.isArray(value)&&value.protocol===STORE_FORMAT,'UPDATE_PENDING','Only the current storage format is supported; existing files were preserved.');
  invariant(typeof value.generation==='string' && value.snapshot && Number.isSafeInteger(value.snapshot.revision) && value.snapshot.revision>=0 && /^[a-f0-9]{64}$/.test(value.snapshot.hash),'STATE_CORRUPT','Invalid checkpoint manifest.');
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
  invariant(!fs.existsSync(path.join(root,'migration.json')),'UPDATE_PENDING','Incomplete storage preparation is unsupported; existing files were preserved.');
  if(selected!==undefined)validateStorageManifest(root,selected);
  const manifest=selected??readStorageManifest(root);
  const snapshot=inside(root,manifest?.snapshot.file??'state.json'),snapshotExists=fs.existsSync(snapshot),state=readJson<State>(snapshot);
  invariant(!snapshotExists&&state===undefined||state&&typeof state==='object'&&!Array.isArray(state)&&state.protocol===STORE_FORMAT,'UPDATE_PENDING','Only the current storage format is supported; existing files were preserved.');
  invariant(state||manifest||!fs.existsSync(path.join(root,'journal.jsonl')),'UPDATE_PENDING','Journal-only storage is unsupported; existing files were preserved.');
  if(state)invariant(Array.isArray(state.runs)&&Array.isArray(state.events),'STATE_CORRUPT','Missing stored entity collections.');
  if(manifest){invariant(state && state.protocol===4 && state.revision===manifest.snapshot.revision && digest(state)===manifest.snapshot.hash,'STATE_CORRUPT','Checkpoint snapshot is missing or corrupt.');}
  let records=0,completeBytes=0,bytes=0;const files:{file:string;records:number;completeBytes:number;bytes:number}[]=[];
  const cutoff=state?.revision??0;let physicalRevision:number|undefined;
  const runs=new Map(state?.runs.map(r=>[r.id,r])??[]),events=new Map(state?.events.map(e=>[e.seq,e])??[]);
  const journals=manifest?.journals??['journal.jsonl'];
  for(const relative of journals){
    const file=inside(root,relative);if(manifest)invariant(fs.existsSync(file),'STATE_CORRUPT','A committed journal generation is missing.',{file:relative});
    const result=visitJournal(file,item=>{
        invariant(item&&typeof item==='object'&&!Array.isArray(item),'JOURNAL_CORRUPT','Invalid journal record.');
        invariant(!Object.hasOwn(item,'state')&&typeof item.payload==='string','UPDATE_PENDING','Only typed journal transactions are supported; existing files were preserved.');
        invariant(item.hash===hash(item.payload),'JOURNAL_CORRUPT','A committed transaction failed its checksum.');
        let transaction:TransactionRecord;try{transaction=JSON.parse(item.payload);}catch{throw new Fault('JOURNAL_CORRUPT','Invalid transaction JSON.');}
        invariant(transaction&&typeof transaction==='object'&&!Array.isArray(transaction),'JOURNAL_CORRUPT','Invalid typed transaction object.');
        invariant(transaction.protocol===STORE_FORMAT,'UPDATE_PENDING','Only the current journal format is supported; existing files were preserved.');
        invariant(Array.isArray(transaction.changes) && Number.isSafeInteger(transaction.previous) && transaction.previous>=0 && Number.isSafeInteger(transaction.revision) && transaction.revision===transaction.previous+1,'JOURNAL_CORRUPT','Invalid journal transaction.');
        // Covered checkpoint records may form a retained prefix, but they are still
        // physical committed transactions: duplicates/backtracking/gaps are corruption.
        invariant(physicalRevision===undefined||transaction.previous===physicalRevision,'JOURNAL_CORRUPT','Physical journal transaction order is missing, duplicated, or backwards.');
        physicalRevision=transaction.revision;
        invariant(state,'STATE_CORRUPT','Typed journal transactions require a current checkpoint.');
        if(transaction.revision<=cutoff)return;
        invariant(transaction.previous===state.revision,'JOURNAL_CORRUPT','Journal revision is missing, duplicated, or out of order.');
        try{applyDeltas(state,transaction.changes,runs,events);}catch(error){if(error instanceof Fault)throw error;throw new Fault('JOURNAL_CORRUPT','Invalid typed journal operation.',{reason:(error as Error).message});}state.revision=transaction.revision;
    },limits?.[relative]);
    // A torn record may exist only at the newest segment, never before later committed records.
    invariant(result.bytes===result.completeBytes||relative===journals.at(-1),'JOURNAL_CORRUPT','An immutable journal generation has a torn record.');
    records+=result.records;completeBytes+=result.completeBytes;bytes+=result.bytes;files.push({file:relative,...result});
  }
  invariant(manifest||bytes===0,'STATE_CORRUPT','A storage generation manifest is missing; existing files were preserved.');
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
  }
  return true;
}
