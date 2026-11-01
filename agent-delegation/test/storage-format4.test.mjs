import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, emptyState, loadState, writeJson, digest, hash, deltaRecord, ARCHIVE_AGE } from '../dist/index.mjs';
import * as api from '../dist/index.mjs';
import { storageTree } from './storage-preservation.mjs';

const now=1_800_000_000_000;
const worker={platform:'codex',profile:'codex-default',executable:process.execPath,executable_args:[],baseline:'test',config_hash:'test'};
function root(t){const value=fs.mkdtempSync(path.join(os.tmpdir(),'storage4-'));t.after(()=>fs.rmSync(value,{recursive:true,force:true}));return value;}
function run(dir,id='r',state='cancelled') {return {id,repo:dir,common_dir:path.join(dir,'.git'),branch:'main',base:'base',integration_branch:`codex/${id}`,integration_dir:path.join(dir,'worktrees',id),integration_commit:'base',state,revision:1,created:1,ended_at:now-ARCHIVE_AGE,tasks:[],context:[],worker,resources:[],final_verification:[],settings:{concurrency:2,timeout_ms:1000,max_retries:0}};}
const activeJournal=dir=>path.join(dir,loadState(dir).manifest.journals.at(-1));

test('one attempt update commits bounded bytes with its request and event despite a large hot history',async t=>{
  const dir=root(t),store=new Store(dir,()=>now);
  store.state.runs=Array.from({length:80},(_,i)=>({...run(dir,`r${i}`),error:'historical-body'.repeat(4000),tasks:[{spec:{id:'task'},worker,state:'cancelled',revision:1,attempts:[{id:`a${i}`,state:'cancelled',job_dir:dir,artifacts:[],verification:[],inputs:[],context:[],resources:[],error:'attempt-history'.repeat(500)}]}]}));
  store.state.requests.old={hash:'hash',status:'done',result:'response-history'.repeat(200000)};store.save();await store.flushCheckpoint(true);
  const before=store.io.journal_bytes,revision=store.state.revision,snapshot=fs.readFileSync(path.join(dir,loadState(dir).manifest.snapshot.file));
  store.transaction(()=>{store.run('r79').tasks[0].attempts[0].error='tiny update';store.state.requests.change={hash:'new',status:'done',result:{ok:true},completed_at:now};store.event('r79','changed',{ok:true});});
  assert.ok(store.io.journal_bytes-before<2500,'one tiny update must not rewrite unrelated run/attempt/response bodies');
  assert.equal(store.state.revision,revision+1,'request + state + event are one atomic journal transaction');
  assert.deepEqual(fs.readFileSync(path.join(dir,loadState(dir).manifest.snapshot.file)),snapshot,'routine save must not rewrite a snapshot');
  const restored=new Store(dir);assert.equal(restored.run('r79').tasks[0].attempts[0].error,'tiny update');assert.equal(restored.run('r78').tasks[0].attempts[0].error.length,7500);assert.deepEqual(restored.state.requests.change.result,{ok:true});assert.equal(restored.events('r79')[0].seq,1);
});

test('run handles bind to IDs after an earlier run is archived and array positions move',async t=>{
  const dir=root(t),store=new Store(dir,()=>now);store.state.runs=[run(dir,'first'),run(dir,'held','active'),run(dir,'last','active')];store.save();const held=store.run('held');
  assert.equal(await store.archiveNext(),true);held.error='belongs to held';store.save();const reopened=new Store(dir);
  assert.equal(reopened.run('held').error,'belongs to held');assert.equal(reopened.run('last').error,undefined);
});

test('checkpoint worker publication retains concurrent journal tails and retires old generations',async t=>{
  const dir=root(t),store=new Store(dir);for(let i=0;i<255;i++)store.event('r','tick',{i});assert.equal(store.io.checkpoints,0);
  store.event('r','tick',{i:255});store.event('r','concurrent',{i:256});store.state.requests.tail={hash:'hash',status:'intent'};store.save();await store.flushCheckpoint();
  const restored=loadState(dir);assert.equal(store.io.checkpoints,1);assert.equal(restored.state.events.length,257);assert.equal(restored.state.requests.tail.status,'intent');assert.equal(restored.state.event_seq,257);assert.ok(restored.records<=2);assert.equal(fs.existsSync(path.join(dir,'journal.jsonl')),false);
});

for(const mode of ['duplicate','gap','checksum'])test(`replay rejects ${mode} after a checkpoint instead of silently losing ordering`,t=>{
  const dir=root(t),store=new Store(dir);store.event('r','one',{});const file=activeJournal(dir),line=fs.readFileSync(file,'utf8');
  if(mode==='duplicate')fs.appendFileSync(file,line);
  if(mode==='gap')fs.appendFileSync(file,deltaRecord({protocol:4,previous:2,revision:3,changes:[]}));
  if(mode==='checksum'){const record=JSON.parse(line);record.hash='0'.repeat(64);fs.appendFileSync(file,JSON.stringify(record)+'\n');}
  assert.throws(()=>new Store(dir),e=>e.code==='JOURNAL_CORRUPT');
});

test('snapshot helper failure fences new writes and restart retains every acknowledged commit',async t=>{
  const dir=root(t),store=new Store(dir);store.event('r','one',{});fs.writeFileSync(path.join(dir,'checkpoints'),'blocked');
  await assert.rejects(store.flushCheckpoint(true),e=>e.code==='REQUEST_UNCERTAIN');assert.equal(store.uncertain,true);assert.throws(()=>store.event('r','two',{}),e=>e.code==='REQUEST_UNCERTAIN');
  assert.equal(new Store(dir).events('r').length,1);
});

test('checkpoint manifest replacement failure keeps the old snapshot and its concurrent tail recoverable',async t=>{
  const dir=root(t),store=new Store(dir);store.event('r','one',{});const rename=fs.renameSync;let publications=0;
  const mock=t.mock.method(fs,'renameSync',(from,to)=>{if(to===path.join(dir,'checkpoint.json')&&++publications===2)throw new Error('manifest failure');return rename(from,to);});
  const checkpoint=store.flushCheckpoint(true);store.event('r','two',{});await assert.rejects(checkpoint,e=>e.code==='REQUEST_UNCERTAIN');mock.mock.restore();
  const restored=new Store(dir);assert.equal(restored.events('r').length,2);assert.equal(restored.state.event_seq,2);
});

test('chunked archive pages skip historical attempts and earlier event chunks, yet detect requested corruption',async t=>{
  const dir=root(t),store=new Store(dir,()=>now),r=run(dir);r.tasks=[{spec:{id:'task'},state:'cancelled',worker,revision:1,attempts:Array.from({length:8},(_,i)=>({id:`a${i}`,state:'cancelled',job_dir:dir,artifacts:[],verification:[],inputs:[],context:[],resources:[],error:`history-${i}`}))}];store.state.runs=[r];
  for(let i=0;i<400;i++)store.event('r','tick',{i});await store.flushCheckpoint();assert.equal(await store.archiveNext(),true);
  const ref=store.state.archived_runs.r,manifest=JSON.parse(fs.readFileSync(path.join(dir,ref.file),'utf8'));assert.equal(manifest.kind,'chunked-run');assert.ok(manifest.events.length>=4);
  fs.writeFileSync(path.join(dir,manifest.tasks[0].attempts[0].file),'{}');fs.writeFileSync(path.join(dir,manifest.events[0].file),'[]');
  const page=await store.getRunPageAsync('r');assert.equal(page.items[0].attempt.id,'a7');const events=await store.eventsAsync('r',300,20);assert.equal(events[0].seq,301);assert.equal(events.length,20);
  await assert.rejects(store.runAsync('r'),e=>e.code==='STATE_CORRUPT');await assert.rejects(store.eventsAsync('r',0,20),e=>e.code==='STATE_CORRUPT');
  await store.close();
});

test('only current typed storage entry points are exported',()=>{
  assert.equal(Object.hasOwn(api,'prepareStorage'),false);assert.equal(Object.hasOwn(api,'journalRecord'),false);
  assert.equal(typeof loadState,'function');assert.equal(typeof deltaRecord,'function');
});

for(const format of [2,3,99,undefined])test(`typed transaction with unsupported protocol ${format} is rejected without writes`,t=>{
  const dir=root(t),store=new Store(dir),file=activeJournal(dir);
  fs.appendFileSync(file,deltaRecord({protocol:format,previous:0,revision:1,changes:[]}));const before=storageTree(dir);
  assert.throws(()=>loadState(dir),e=>e.code==='UPDATE_PENDING');assert.throws(()=>new Store(dir),e=>e.code==='UPDATE_PENDING');assert.deepEqual(storageTree(dir),before);
});
for(const value of [null,false,0,'text',[]])test(`non-object transaction ${JSON.stringify(value)} fails with a typed corruption error`,t=>{
  const dir=root(t),store=new Store(dir),payload=JSON.stringify(value);
  fs.appendFileSync(activeJournal(dir),JSON.stringify({hash:hash(payload),payload})+'\n');const before=storageTree(dir);
  assert.throws(()=>new Store(dir),e=>e.code==='JOURNAL_CORRUPT');assert.deepEqual(storageTree(dir),before);
});
for(const value of [null,false,0,[],{}, {protocol:3}, {protocol:99}])test(`unsupported checkpoint ${JSON.stringify(value)} cannot be treated as a fresh store`,t=>{
  const dir=root(t);new Store(dir);writeJson(path.join(dir,'checkpoint.json'),value);const before=storageTree(dir);
  assert.throws(()=>loadState(dir),e=>e.code==='UPDATE_PENDING');assert.throws(()=>new Store(dir),e=>e.code==='UPDATE_PENDING');assert.deepEqual(storageTree(dir),before);
});

test('artifact byte range reads stay bounded for a sparse large file, support short reads and detect truncation',t=>{
  const dir=root(t),store=new Store(dir),id=store.artifact('r','large.log',''),file=path.join(dir,'artifacts',id),offset=128*1024*1024;
  const fd=fs.openSync(file,'r+');fs.ftruncateSync(fd,256*1024*1024);fs.writeSync(fd,Buffer.from('한글 😀 '.repeat(100)),0,Buffer.byteLength('한글 😀 '.repeat(100)),offset);fs.closeSync(fd);
  const read=fs.readSync;const partial=t.mock.method(fs,'readSync',(descriptor,buffer,start,length,position)=>read(descriptor,buffer,start,Math.min(length,11),position));
  const page=store.artifactPage(id,offset,512);assert.ok(page.text.startsWith('한글 😀 '));assert.ok(!page.text.includes('\ufffd'));assert.ok(store.io.artifact_read_bytes<=516);partial.mock.restore();
  let shortened=false;const truncation=t.mock.method(fs,'readSync',(descriptor,...args)=>{if(!shortened){shortened=true;fs.truncateSync(file,offset+1);}return read(descriptor,...args);});assert.throws(()=>store.artifactPage(id,offset,512),e=>e.code==='ARTIFACT_CHANGED');truncation.mock.restore();
});

test('cold archive reads use bounded helper concurrency while a checkpoint has its reserved lane',async t=>{
  const dir=root(t),store=new Store(dir,()=>now);store.state.runs=[run(dir)];store.save();await store.archiveNext();
  const reads=Array.from({length:12},()=>store.runAsync('r'));const checkpoint=store.flushCheckpoint(true);await Promise.all([...reads,checkpoint]);assert.ok(store.io.helper_peak<=3);assert.equal(store.io.checkpoints,1);await store.close();
});

test('a torn atomic state/request/event record retains its earlier intent and never reexecutes',async t=>{
  const dir=root(t),store=new Store(dir);store.state.runs=[run(dir)];store.state.requests.atomic={hash:digest({atomic:true}),status:'intent'};store.save();
  const write=fs.writeFileSync;const mock=t.mock.method(fs,'writeFileSync',(file,data,...args)=>{if(typeof file==='number'&&typeof data==='string'&&data.includes('atomic-mark')){write(file,data.slice(0,Math.floor(data.length/2)),...args);throw new Error('torn transaction');}return write(file,data,...args);});
  assert.throws(()=>store.transaction(()=>{store.run('r').error='atomic-mark';store.state.requests.atomic={hash:digest({atomic:true}),status:'done',result:{marker:'atomic-mark'},completed_at:now};store.event('r','atomic-mark',{});}),e=>e.code==='REQUEST_UNCERTAIN');mock.mock.restore();
  const restored=new Store(dir);assert.equal(restored.run('r').error,undefined);assert.equal(restored.events('r').length,0);assert.equal(restored.state.requests.atomic.status,'intent');await assert.rejects(restored.mutation('atomic',{atomic:true},()=>assert.fail('intent must never replay')),e=>e.code==='REQUEST_UNCERTAIN');
});

test('checkpoint refuses a source revision different from the acknowledged in-memory revision',async t=>{
  const dir=root(t),store=new Store(dir);store.event('r','one',{});fs.truncateSync(activeJournal(dir),0);await assert.rejects(store.flushCheckpoint(true),e=>e.code==='REQUEST_UNCERTAIN');assert.equal(store.uncertain,true);
});

for(const delta of [
  {entity:'run',id:'r',path:null,value:'invalid'},
  {entity:'counter',id:'event_seq',value:-1},
  {entity:'run',id:'r',path:['id'],value:'other'},
])test(`malformed typed changes fail explicitly: ${JSON.stringify(delta)}`,t=>{
  const dir=root(t),store=new Store(dir);store.state.runs=[run(dir)];store.save();fs.appendFileSync(activeJournal(dir),deltaRecord({protocol:4,previous:store.state.revision,revision:store.state.revision+1,changes:[delta]}));assert.throws(()=>new Store(dir),e=>e.code==='JOURNAL_CORRUPT');
});

test('missing generation manifest never silently rewrites a journal into a guessed snapshot',t=>{
  const dir=root(t),store=new Store(dir);store.event('r','one',{});const original=fs.readFileSync(activeJournal(dir));fs.unlinkSync(path.join(dir,'checkpoint.json'));assert.throws(()=>new Store(dir),e=>e.code==='STATE_CORRUPT');assert.deepEqual(fs.readFileSync(path.join(dir,'journal.jsonl')),original);
});

test('archive publication refuses changed records and newly unresolved preparation ownership',async t=>{
  const dir=root(t),store=new Store(dir,()=>now);store.state.runs=[run(dir)];store.save();const prepared=await store.prepareArchive();
  fs.mkdirSync(path.join(dir,'submissions','unknown'),{recursive:true});assert.equal(store.commitArchive(prepared),false);assert.equal(store.isArchived('r'),false);fs.rmSync(path.join(dir,'submissions'),{recursive:true});
  store.run('r').error='changed after preparation';store.save();assert.equal(store.commitArchive(prepared),false);assert.equal(store.isArchived('r'),false);
  const requests=new Store(root(t),()=>now);requests.state.requests.one={hash:'hash',status:'done',result:{value:1},completed_at:now-ARCHIVE_AGE};requests.save();const response=await requests.prepareArchive();requests.state.requests.one.result.value=2;requests.save();assert.equal(requests.commitArchive(response),false);assert.equal(requests.state.requests.one.result.value,2);
});

test('a valid covered transaction appended after a newer checkpoint tail is rejected',async t=>{
  const dir=root(t),store=new Store(dir);store.event('r','covered',{});const covered=fs.readFileSync(activeJournal(dir),'utf8');await store.flushCheckpoint(true);store.event('r','new-tail',{});fs.appendFileSync(activeJournal(dir),covered);
  assert.throws(()=>new Store(dir),e=>e.code==='JOURNAL_CORRUPT');
});

test('covered prefixes must be unique and contiguous even when the snapshot already contains them',async t=>{
  const dir=root(t),store=new Store(dir);for(const type of ['one','two','three'])store.event('r',type,{});const prefix=fs.readFileSync(activeJournal(dir),'utf8'),lines=prefix.trimEnd().split('\n');await store.flushCheckpoint(true);const file=activeJournal(dir);
  fs.writeFileSync(file,prefix);assert.equal(new Store(dir).state.event_seq,3,'a contiguous covered prefix is safe to skip');
  for(const records of [[lines[0],lines[0],lines[1]],[lines[1],lines[0]],[lines[0],lines[2]]]){fs.writeFileSync(file,records.join('\n')+'\n');assert.throws(()=>new Store(dir),e=>e.code==='JOURNAL_CORRUPT');}
});

