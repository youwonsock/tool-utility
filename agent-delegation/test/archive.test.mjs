import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, Engine, ARCHIVE_AGE, emptyState, digest, loadState, serve, connect,
  writeJson, remoteCall, processIdentity, alive, sleep } from '../dist/index.mjs';
import { cli } from './helpers.mjs';
import { storageTree } from './storage-preservation.mjs';

const epoch=1_800_000_000_000;
const worker={platform:'codex',profile:'codex-default',executable:process.execPath,executable_args:[],baseline:'test',config_hash:'test'};
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function run(root,id='run_old',state='cancelled',ended_at=epoch-ARCHIVE_AGE){return {id,repo:path.join(root,'repo'),common_dir:path.join(root,'repo/.git'),branch:'main',base:'base',integration_branch:`codex/${id}`,integration_dir:path.join(root,'worktrees',id,'integration'),integration_commit:'base',state,revision:1,created:1,ended_at,tasks:[],context:[],worker,resources:[],final_verification:[],settings:{concurrency:2,timeout_ms:1000,max_retries:0}};}

test('seven-day boundary, immutable end time, active runs and resource leases',async t=>{
  const root=setup(t),store=new Store(root,()=>epoch);
  store.state.runs=[run(root,'before','completed',epoch-ARCHIVE_AGE+1),run(root,'exact'),run(root,'after','completed',epoch-ARCHIVE_AGE-1),run(root,'active','active')];
  const leased=run(root,'leased');leased.tasks=[{spec:{id:'task'},state:'cancelled',worker,attempts:[{state:'stop_uncertain'}]}];store.state.runs.push(leased);store.save();
  assert.equal(await store.archiveNext(),true);assert.equal(store.isArchived('exact'),true);
  assert.equal(await store.archiveNext(),true);assert.equal(store.isArchived('after'),true);
  assert.equal(await store.archiveNext(),false);assert.equal(store.state.runs.length,3);
  store.clock=()=>epoch+1;assert.equal(await store.archiveNext(),true);assert.equal(store.run('before').ended_at,epoch-ARCHIVE_AGE+1);
});

test('archive queries, cursors, artifacts, mutation guards and request deduplication survive restart',async t=>{
  const root=setup(t),store=new Store(root,()=>epoch);store.state.runs=[run(root)];store.event('run_old','finished',{value:1});
  const artifact=store.artifact('run_old','evidence.txt','preserved');await store.mutation('saved',{a:1},async()=>({run_id:'run_old',artifact}));
  store.clock=()=>epoch+ARCHIVE_AGE;assert.equal(await store.archiveNext(),true);assert.equal(await store.archiveNext(),true);
  assert.equal(Object.keys(store.state.requests).length,0);assert.equal(store.state.events.length,0);
  const reopened=new Store(root),engine=new Engine(reopened,cli);
  const list=await engine.call('list_runs',{});assert.equal(list.items[0].archived,true);
  const detail=await engine.call('get_run',{run_id:'run_old'});assert.equal(detail.archived,true);assert.equal(detail.ended_at,epoch-ARCHIVE_AGE);
  const events=await engine.call('wait_run',{run_id:'run_old',after:0,timeout_ms:0});assert.equal(events.items.length,1);assert.equal(events.after,1);
  assert.equal((await reopened.mutation('saved',{a:1},async()=>assert.fail('replayed'))).artifact,artifact);
  await assert.rejects(reopened.mutation('saved',{a:2},async()=>{}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  for(const name of ['cancel_run','reconcile_run','validate_run'])assert.equal((await engine.call(name,{request_id:`new-${name}`,run_id:'run_old'})).error.code,'RUN_ARCHIVED');
  assert.equal(reopened.artifactPage(artifact,0,100).text,'preserved');reopened.event('run_old','worktrees_cleaned',{});reopened.event('another','next',{});
  assert.equal(reopened.events('run_old').at(-1).seq,2);assert.equal(reopened.events('another')[0].seq,3);
});

test('prepared submissions and unconfirmed or live processes prevent archiving',async t=>{
  const root=setup(t),store=new Store(root,()=>epoch);store.state.runs=[run(root)];store.save();
  const manifest=path.join(root,'submissions','pending','manifest.json');writeJson(manifest,{run_id:'run_old'});
  assert.equal(await store.archiveNext(),false);fs.rmSync(path.dirname(manifest),{recursive:true});
  const r=store.state.runs[0],job=path.join(root,'job');fs.mkdirSync(job);
  r.tasks=[{spec:{id:'task'},state:'cancelled',worker,attempts:[{state:'cancelled',job_dir:job,worker:{protocol:2,phase:'cancelled',stopped:true,host:await processIdentity(process.pid)}}]}];
  store.save();assert.equal(await store.archiveNext(),false);delete r.tasks[0].attempts[0].worker;writeJson(path.join(job,'server-intent.json'),{});assert.equal(await store.archiveNext(),false);
});

test('archive file failure retains records; checkpoint failure recovers the committed archive',async t=>{
  const root=setup(t),store=new Store(root,()=>epoch);store.state.runs=[run(root)];store.save();
  fs.writeFileSync(path.join(root,'archives'),'blocked');
  await assert.rejects(store.archiveNext());assert.equal(store.state.runs.length,1);assert.equal(store.uncertain,false);fs.unlinkSync(path.join(root,'archives'));
  assert.equal(await store.archiveNext(),true);
  const rename=fs.renameSync;const snapshot=t.mock.method(fs,'renameSync',(a,b)=>{if(b===path.join(root,'checkpoint.json'))throw new Error('checkpoint failure');return rename(a,b);});
  await assert.rejects(store.flushCheckpoint(true),e=>e.code==='REQUEST_UNCERTAIN');assert.equal(store.uncertain,true);snapshot.mock.restore();
  const recovered=new Store(root);assert.equal(recovered.state.runs.length,0);assert.equal(recovered.run('run_old').id,'run_old');
});

test('missing or corrupt archived responses never become new requests',async t=>{
  const root=setup(t),store=new Store(root,()=>epoch);await store.mutation('saved',{},async()=>({value:1}));store.clock=()=>epoch+ARCHIVE_AGE;await store.archiveNext();
  const file=path.join(root,store.state.archived_requests.saved.file);fs.writeFileSync(file,'{}');
  await assert.rejects(store.mutation('saved',{},async()=>assert.fail('replayed')),e=>e.code==='STATE_CORRUPT');fs.unlinkSync(file);
  await assert.rejects(store.mutation('saved',{},async()=>assert.fail('replayed')),e=>e.code==='STATE_CORRUPT');
});

test('large history reads only summaries at startup/list time; unresolved intents stay hot',async t=>{
  const root=setup(t),store=new Store(root,()=>epoch);store.state.runs=Array.from({length:100},(_,i)=>({...run(root,`run_${i}`),error:'large'.repeat(1000)}));
  store.state.requests.pending={hash:'hash',status:'intent'};store.save();while(await store.archiveNext()){}
  assert.equal(store.state.runs.length,0);assert.equal(store.state.events.length,0);assert.equal(store.state.requests.pending.status,'intent');assert.equal(Object.keys(store.state.archived_runs).length,100);
  const read=fs.readFileSync;t.mock.method(fs,'readFileSync',(file,...args)=>{if(String(file).includes(`${path.sep}archives${path.sep}`))assert.fail('eager archive read');return read(file,...args);});
  const engine=new Engine(new Store(root),cli);let cursor,seen=[];do{const page=await engine.call('list_runs',cursor?{cursor}:{});seen.push(...page.items);cursor=page.next_cursor;}while(cursor);
  assert.equal(seen.length,100);assert.equal(new Set(seen.map(r=>r.run_id)).size,100);
});

test('checkpoint rotation failure preserves commits and repairs a torn active tail sequentially',async t=>{
  const root=setup(t),store=new Store(root);for(let i=0;i<255;i++)store.event('one','event',{i});const rename=fs.renameSync;
  const blocked=t.mock.method(fs,'renameSync',(a,b)=>{if(b===path.join(root,'checkpoint.json'))throw new Error('rotation failure');return rename(a,b);});
  assert.throws(()=>store.event('one','event',{i:255}),e=>e.code==='REQUEST_UNCERTAIN');blocked.mock.restore();let reopened=new Store(root);assert.equal(reopened.state.events.length,256);
  await reopened.flushCheckpoint(true);assert.equal(loadState(root).records,0);const active=loadState(root).manifest.journals.at(-1);fs.appendFileSync(path.join(root,active),'{"torn":');
  const read=fs.readFileSync;t.mock.method(fs,'readFileSync',(file,...args)=>{if(String(file).endsWith('.jsonl'))assert.fail('whole journal read');return read(file,...args);});
  reopened=new Store(root);assert.equal(reopened.state.events.length,256);assert.equal(loadState(root).bytes,loadState(root).completeBytes);
});

for(const format of [2,3,99,'missing',null,false,0,'invalid',[]])test(`unsupported snapshot ${JSON.stringify(format)} is rejected without startup or file changes`,async t=>{
  const root=setup(t),state=typeof format==='number'&&format>0?{...emptyState(),protocol:format,runs:[run(root)]}:format==='missing'?{revision:1,runs:[],events:[]}:format;
  writeJson(path.join(root,'state.json'),state);writeJson(path.join(root,'archives','retained.json'),{original:'keep evidence'});
  const before=storageTree(root);
  assert.throws(()=>loadState(root),e=>e.code==='UPDATE_PENDING');assert.throws(()=>new Store(root),e=>e.code==='UPDATE_PENDING');
  await assert.rejects(serve(root,cli),e=>e.code==='UPDATE_PENDING');await assert.rejects(connect(root,cli),e=>e.code==='UPDATE_PENDING');
  assert.deepEqual(storageTree(root),before);
});

test('daemon cleanup retains an archived run and its event history',async t=>{
  const root=setup(t),store=new Store(root,()=>epoch);store.state.runs=[run(root)];store.save();await store.archiveNext();
  try {
    assert.equal((await remoteCall(root,cli,'',{run_id:'run_old'},'/cleanup')).evidence_retained,true);
    const view=await remoteCall(root,cli,'get_run',{run_id:'run_old'});assert.equal(view.archived,true);assert.equal(view.event_cursor,1);
  } finally {
    // Close before setup's after hook removes the directory: Windows locks the daemon log.
    const descriptor=JSON.parse(fs.readFileSync(path.join(root,'service.json')));
    await remoteCall(root,cli,'',{},'/stop');
    const deadline=Date.now()+15000;
    while(await alive(descriptor.owner)) {assert.ok(Date.now()<deadline,'Daemon did not stop');await sleep(100);}
  }
});

test('journal append failure never publishes an archive index; restart keeps the original run',async t=>{
  const root=setup(t),store=new Store(root,()=>epoch);store.state.runs=[run(root)];store.save();
  const open=fs.openSync;const mock=t.mock.method(fs,'openSync',(file,flags,...args)=>{if(file===path.join(root,'journal.jsonl')&&flags==='a')throw new Error('append failure');return open(file,flags,...args);});
  await assert.rejects(store.archiveNext(),e=>e.code==='REQUEST_UNCERTAIN');assert.equal(store.uncertain,true);mock.mock.restore();
  const recovered=new Store(root);assert.equal(recovered.isArchived('run_old'),false);assert.equal(recovered.run('run_old').id,'run_old');
});

test('byte threshold starts a helper checkpoint before the record-count threshold',async t=>{
  const root=setup(t),store=new Store(root);
  for(let i=0;i<4;i++){store.state.requests[`large_${i}`]={hash:'hash',status:'done',completed_at:epoch,result:'x'.repeat(9*1024*1024)};store.save();}
  await store.flushCheckpoint();assert.equal(store.io.checkpoints,1);assert.equal(loadState(root).records,0);assert.equal(Object.keys(new Store(root).state.requests).length,4);
});

test('resource fingerprints and prototype-like request IDs survive archive/restart',async t=>{
  const root=setup(t),store=new Store(root,()=>epoch),r=run(root);
  const resource={resource_key:'shared',connection:{name:'shared',config:{type:'stdio',command:'node',args:[]}},probe:{executable:'node',args:[],read_only:true},expected_instance:'instance',project_bound:false};
  r.resources=[resource];store.state.runs=[r];store.save();await store.archiveNext();
  for(const id of ['__proto__','constructor','toString'])await store.mutation(id,{id},async()=>({id}));
  store.clock=()=>epoch+ARCHIVE_AGE;while(await store.archiveNext()){}
  const reopened=new Store(root);assert.equal(reopened.state.resource_hashes.shared,digest(resource));
  for(const id of ['__proto__','constructor','toString'])assert.deepEqual(await reopened.mutation(id,{id},async()=>assert.fail('replayed')),{id});
  reopened.state.runs=[{...run(root,'conflict','active'),resources:[{...resource,expected_instance:'different'}]}];
  assert.throws(()=>reopened.save(),e=>e.code==='RESOURCE_PROFILE');
});

test('automatic scheduler archives on startup and scans again after one hour',async t=>{
  const root=setup(t);let now=epoch;const store=new Store(root,()=>now);store.state.runs=[run(root)];store.save();const engine=new Engine(store,cli);
  await engine.tick();assert.equal(store.isArchived('run_old'),true);await engine.tick();
  store.state.runs.push(run(root,'next'));store.save();await engine.tick();assert.equal(store.isArchived('next'),false);
  now+=3_600_000;await engine.tick();assert.equal(store.isArchived('next'),true);
});
