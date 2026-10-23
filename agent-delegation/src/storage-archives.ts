import { STORE_FORMAT, Fault, invariant, type Run, type RunEvent, type ArchiveRef, type RunArchive, type Task, type Attempt, type Validation } from './types.js';
import { digest, inside, readJson, writeJson } from './io.js';
import { validateStoredRun, validateStoredTask } from './lifecycle.js';
export type ChunkRef={file:string;hash:string};
export type EventChunk=ChunkRef&{first:number;last:number;count:number};
export type TaskChunks={task:ChunkRef;attempts:ChunkRef[]};
export type ChunkedArchive={protocol:4;kind:'chunked-run';id:string;run:ChunkRef;tasks:TaskChunks[];events:EventChunk[];validation?:ChunkRef;history:ChunkRef[]};
export const isChunked=(value:unknown):value is ChunkedArchive=>!!value&&typeof value==='object'&&(value as ChunkedArchive).kind==='chunked-run';
function checkRef(ref:ChunkRef){invariant(ref&&typeof ref.file==='string'&&/^archives\/(runs|requests)\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/.test(ref.file)&&/^[a-f0-9]{64}$/.test(ref.hash),'STATE_CORRUPT','Invalid archive chunk reference.');}
export function readVerified<T>(root:string,ref:ChunkRef):T {
  try{checkRef(ref);const value=readJson<T>(inside(root,ref.file));invariant(value&&digest(value)===ref.hash,'STATE_CORRUPT','Archived record is missing or corrupt.',{file:ref.file});return value;}
  catch(error){if(error instanceof Fault&&error.code==='STATE_CORRUPT')throw error;throw new Fault('STATE_CORRUPT','Archived record could not be verified.',{file:ref?.file,reason:(error as Error).message});}
}
function writeChunk(root:string,id:string,value:unknown):ChunkRef {const hash=digest(value),file=`archives/runs/${digest(id)}/${hash}.json`;writeJson(inside(root,file),value);return {file,hash};}
function checkEvents(events:RunEvent[],id:string){invariant(Array.isArray(events),'STATE_CORRUPT','Missing archived events.');let previous=0;for(const event of events){invariant(event&&event.run_id===id&&Number.isSafeInteger(event.seq)&&event.seq>previous,'STATE_CORRUPT','Invalid archived event identity/order.');previous=event.seq;}}
function checkedArchive(root:string,id:string,ref:ArchiveRef){
  const value=readVerified<RunArchive|ChunkedArchive>(root,ref);
  if(!isChunked(value)){invariant([3,4].includes(value.protocol)&&value.run?.id===id,'STATE_CORRUPT','Archive identity mismatch.');validateStoredRun(value.run);checkEvents(value.events,id);return value;}
  invariant(value.protocol===STORE_FORMAT&&value.id===id&&Array.isArray(value.tasks)&&Array.isArray(value.events)&&Array.isArray(value.history),'STATE_CORRUPT','Invalid archive manifest.');checkRef(value.run);
  for(const item of value.tasks){invariant(item&&Array.isArray(item.attempts),'STATE_CORRUPT','Invalid task chunk index.');checkRef(item.task);for(const ref of item.attempts)checkRef(ref);}
  for(const ref of value.history)checkRef(ref);if(value.validation)checkRef(value.validation);
  let previous=0;for(const chunk of value.events){checkRef(chunk);invariant(Number.isSafeInteger(chunk.first)&&chunk.first>previous&&Number.isSafeInteger(chunk.last)&&chunk.last>=chunk.first&&Number.isSafeInteger(chunk.count)&&chunk.count>0,'STATE_CORRUPT','Invalid event chunk index.');previous=chunk.last;}
  return value;
}
function header(root:string,id:string,value:ChunkedArchive,includeHistory=true):Run{
  const run=readVerified<Omit<Run,'tasks'>>(root,value.run)as Run;invariant(run?.id===id,'STATE_CORRUPT','Archived run header identity mismatch.');run.tasks=[];
  if(value.validation)run.validation=readVerified<Validation>(root,value.validation);if(includeHistory&&value.history.length)run.validation_history=value.history.map(ref=>readVerified<Validation>(root,ref));validateStoredRun(run);return run;
}
function task(root:string,item:TaskChunks,latest=false):Task{
  const result={...readVerified<Omit<Task,'attempts'>>(root,item.task),attempts:(latest?item.attempts.slice(-1):item.attempts).map(ref=>readVerified<Attempt>(root,ref))};validateStoredTask(result);return result;
}
export function writeChunkedArchive(root:string,id:string,run:Run,events:RunEvent[],archived_at:number):ArchiveRef {
  invariant(run.id===id,'STATE_CORRUPT','Archive identity mismatch.');validateStoredRun(run);checkEvents(events,id);
  const {tasks,validation,validation_history,...metadata}=run;
  const manifest:ChunkedArchive={protocol:4,kind:'chunked-run',id,run:writeChunk(root,id,metadata),tasks:tasks.map(task=>{const{attempts,...metadata}=task;return {task:writeChunk(root,id,metadata),attempts:attempts.map(attempt=>writeChunk(root,id,attempt))};}),history:(validation_history??[]).map(value=>writeChunk(root,id,value)),events:[]};if(validation)manifest.validation=writeChunk(root,id,validation);
  let group:RunEvent[]=[],bytes=0;const flush=()=>{if(!group.length)return;manifest.events.push({...writeChunk(root,id,group),first:group[0]!.seq,last:group.at(-1)!.seq,count:group.length});group=[];bytes=0;};
  for(const event of events){const size=Buffer.byteLength(JSON.stringify(event));if(group.length&&(group.length>=128||bytes+size>128*1024))flush();group.push(event);bytes+=size;}flush();
  return {...writeChunk(root,id,manifest),archived_at};
}
export function readRunArchive(root:string,id:string,ref:ArchiveRef):Run {
  const value=checkedArchive(root,id,ref);if(!isChunked(value))return value.run;const run=header(root,id,value);run.tasks=value.tasks.map(item=>task(root,item));validateStoredRun(run);return run;
}
export function readArchiveEvents(root:string,id:string,ref:ArchiveRef,after=0,limit=Number.MAX_SAFE_INTEGER):RunEvent[]{
  const value=checkedArchive(root,id,ref);if(!isChunked(value))return value.events.filter(event=>event.seq>after).slice(0,limit);const events:RunEvent[]=[];
  for(const chunk of value.events){if(chunk.last<=after)continue;const items=readVerified<RunEvent[]>(root,chunk);checkEvents(items,id);invariant(items.length===chunk.count&&items[0]?.seq===chunk.first&&items.at(-1)?.seq===chunk.last,'STATE_CORRUPT','Invalid event chunk.');for(const event of items)if(event.seq>after){events.push(event);if(events.length>=limit)return events;}}
  return events;
}
export function appendArchiveEvent(root:string,id:string,ref:ArchiveRef,event:RunEvent):ArchiveRef {
  checkEvents([event],id);const value=checkedArchive(root,id,ref);
  if(!isChunked(value)){invariant(event.seq>(value.events.at(-1)?.seq??0),'STATE_CORRUPT','Archived event sequence regressed.');return writeChunkedArchive(root,id,value.run,[...value.events,event],ref.archived_at);}
  invariant(event.seq>(value.events.at(-1)?.last??0),'STATE_CORRUPT','Archived event sequence regressed.');
  const next:ChunkedArchive={...value,events:[...value.events,{...writeChunk(root,id,[event]),first:event.seq,last:event.seq,count:1}]};return {...writeChunk(root,id,next),archived_at:ref.archived_at};
}
// Task pages load metadata and only the newest attempt. Historical attempt chunks stay closed.
export function readArchiveTaskPage(root:string,id:string,ref:ArchiveRef,start:number,count:number){
  const value=checkedArchive(root,id,ref);if(!isChunked(value)){const run=value.run;return {run:{...run,tasks:run.tasks.slice(start,start+count)},total:run.tasks.length};}
  const run=header(root,id,value,false);run.validation_history=undefined;run.tasks=value.tasks.slice(start,start+count).map(item=>task(root,item,true));return {run,total:value.tasks.length};
}
