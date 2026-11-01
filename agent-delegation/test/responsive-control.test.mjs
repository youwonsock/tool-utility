import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine, Store, uid, sleep } from '../dist/index.mjs';
import { fixture, submit, task, callOk, cli, runDefaults } from './helpers.mjs';

function gate(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function bounded(promise){return Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Control request waited for the held external effect.')),5000);timer.unref();})]);}
function hold(t,name){
  const entered=gate(),release=gate(),original=Engine.prototype[name];
  assert.equal(typeof original,'function');
  Engine.prototype[name]=async function(...args){entered.resolve();await release.promise;return original.apply(this,args);};
  t.after(()=>{release.resolve();Engine.prototype[name]=original;});return {entered,release};
}

test('a held diagnosis leaves queries and durable cancellation responsive',async t=>{
  const f=await fixture(t,{service:true});const submitted=await submit(f,[task('a')]);
  const entered=gate(),release=gate(),original=Engine.prototype.effectDoctor;
  Engine.prototype.effectDoctor=async()=>{entered.resolve();await release.promise;return {compatible:true,connection:{healthy:true}};};
  t.after(()=>{release.resolve();Engine.prototype.effectDoctor=original;});
  const diagnosis=f.engine.call('doctor',{worker:{platform:'opencode'}});await entered.promise;
  assert.equal((await bounded(f.engine.call('list_runs',{}))).items[0].run_id,submitted.run_id);
  const cancelled=await bounded(f.engine.call('cancel_run',{request_id:'cancel_during_doctor',run_id:submitted.run_id}));
  assert.equal(cancelled.state,'cancelling');
  assert.equal(new Store(f.data).request('cancel_during_doctor').status,'done');
  assert.ok(Object.values(f.store.state.operations).some(op=>op.kind==='doctor'));
  release.resolve();assert.equal((await diagnosis).compatible,true);
});

test('a detached completion must reenter the queue after its external wait',async t=>{
  const f=await fixture(t,{service:true});const entered=gate(),release=gate(),held=gate(),unhold=gate();
  const original=Engine.prototype.effectDoctor;
  Engine.prototype.effectDoctor=async function(){entered.resolve();await release.promise;await this.persist();return {compatible:true};};
  t.after(()=>{release.resolve();unhold.resolve();Engine.prototype.effectDoctor=original;});
  let finished=false;const diagnosis=f.engine.doctor({}).then(value=>{finished=true;return value;});await entered.promise;
  const blocker=f.engine.serial(async()=>{held.resolve();await unhold.promise;});await held.promise;
  release.resolve();await turn();await turn();assert.equal(finished,false,'The completion bypassed a held control transaction.');
  unhold.resolve();await blocker;assert.equal((await bounded(diagnosis)).compatible,true);
});

test('a held submission returns live progress, preserves request identity and publishes no partial run',async t=>{
  const f=await fixture(t,{service:true}),blocked=hold(t,'effectSubmit');
  const args={request_id:'held_submission',...runDefaults,repo:f.repo,tasks:[task('a')],final_verification:[{command:'node -e "process.exit(0)"'}]};
  const first=f.engine.call('create_run',args);await blocked.entered.promise;
  const pending=await first;assert.equal(pending.in_progress,true);assert.ok(pending.operation_id);
  assert.equal(f.store.state.requests[args.request_id].status,'intent');assert.equal(f.store.state.requests[args.request_id].result,undefined);
  assert.equal((await bounded(f.engine.call('list_runs',{}))).items.length,0);
  const repeated=await f.engine.call('create_run',args);assert.equal(repeated.operation_id,pending.operation_id);
  await assert.rejects(f.engine.call('create_run',{...args,tasks:[task('different')]}),error=>error.code==='IDEMPOTENCY_CONFLICT');
  blocked.release.resolve();const result=await callOk(f,'create_run',args);assert.ok(result.run_id);assert.equal(result.in_progress,undefined);
  const reopened=new Store(f.data);assert.deepEqual(reopened.request(args.request_id).result,result);assert.equal(Object.keys(reopened.state.operations).length,0);
  assert.equal(reopened.state.runs.length,1);assert.equal(reopened.state.runs[0].tasks.length,1);
  assert.equal(await f.engine.call('create_run',args).then(value=>value.run_id),result.run_id);
});

test('cancel wins over a held launch, retaining its reservation until completion and never dispatching a model',async t=>{
  const f=await fixture(t,{service:true});const {run_id}=await submit(f,[task('a')]);const run=f.engine.getRun(run_id),blocked=hold(t,'effectLaunch');
  const launching=f.engine.launch(run,run.tasks[0]);await blocked.entered.promise;
  const op=Object.values(f.store.state.operations).find(value=>value.kind==='launch');assert.equal(op.reservations.slot,true);
  const cancelled=await bounded(f.engine.call('cancel_run',{request_id:'cancel_before_launch',run_id}));assert.equal(cancelled.state,'cancelling');
  assert.equal(f.store.state.operations[op.id].status,'running');assert.equal(new Store(f.data).run(run_id).state,'cancelling');
  blocked.release.resolve();await launching;await f.engine.reconcile(f.engine.getRun(run_id));
  const current=f.engine.getRun(run_id);assert.equal(current.state,'cancelled');
  for(const attempt of current.tasks[0].attempts){assert.equal(fs.existsSync(path.join(attempt.job_dir,'worker.json')),false);assert.equal(fs.existsSync(path.join(attempt.job_dir,'spec.json')),false);}
  assert.equal(f.engine.busy(),false);
});

test('a held archive preparation leaves list and cancellation available',async t=>{
  const f=await fixture(t,{service:true});const {run_id}=await submit(f,[task('a')]);
  f.engine.getRun(run_id).tasks[0].state='cancelled';f.store.save();
  const entered=gate(),release=gate(),original=f.store.prepareArchive.bind(f.store);
  f.store.prepareArchive=async()=>{entered.resolve();await release.promise;return original();};t.after(()=>release.resolve());
  const scanning=f.engine.tick();await entered.promise;
  assert.equal((await bounded(f.engine.call('get_run',{run_id}))).state,'active');
  assert.equal((await bounded(f.engine.call('cancel_run',{request_id:'cancel_during_archive',run_id}))).state,'cancelling');
  release.resolve();await scanning;
});

test('restart fences unowned operation intent without replaying its effect',async t=>{
  const f=await fixture(t,{service:true});const {run_id}=await submit(f,[task('a')]);
  const args={request_id:'interrupted_reconcile',run_id};
  const {digest}=await import('../dist/index.mjs');
  const operation={id:uid('operation'),kind:'reconcile_run',request_id:args.request_id,run_id,status:'running',created:Date.now(),updated:Date.now(),inputs:args,reservations:{repository:f.engine.getRun(run_id).common_dir}};
  f.store.state.operations[operation.id]=operation;f.store.state.requests[args.request_id]={hash:digest({name:'reconcile_run',args}),status:'intent',operation_id:operation.id};f.store.save();
  const recovered=new Engine(new Store(f.data),cli);await recovered.recoverPreparations();
  assert.equal(recovered.store.state.operations[operation.id].status,'uncertain');
  await assert.rejects(recovered.call('reconcile_run',args),error=>error.code==='REQUEST_UNCERTAIN');
  assert.equal(recovered.store.run(run_id).tasks[0].attempts.length,0);
  const result=await recovered.call('reconcile_run',{request_id:'explicit_reconciliation',run_id});assert.equal(result.error,undefined);
  assert.equal(Object.keys(recovered.store.state.operations).length,0);
  assert.equal(recovered.store.request(args.request_id).status,'done');
});

async function waitFile(file){const deadline=Date.now()+15000;while(!fs.existsSync(file)&&Date.now()<deadline)await sleep(10);assert.equal(fs.existsSync(file),true,'External fixture did not reach its synchronized wait.');}
function gatedResource(directory,key){
  const mode=path.join(directory,`${key}-mode`),entered=path.join(directory,`${key}-entered`),release=path.join(directory,`${key}-release`);
  fs.writeFileSync(mode,'wrong');
  const code='const fs=require("fs");const [mode,entered,release]=process.argv.slice(1);if(fs.readFileSync(mode,"utf8")==="wrong"){console.log(JSON.stringify({instance_id:"wrong"}));}else{fs.writeFileSync(entered,"waiting");const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);console.log(JSON.stringify({instance_id:"editor"}));}},10);}';
  return {mode,entered,release,profile:{resource_key:key,connection:{name:key,config:{type:'remote',url:'http://127.0.0.1:59998/mcp'}},probe:{executable:process.execPath,args:['-e',code,mode,entered,release],read_only:true},expected_instance:'editor'}};
}

test('a real held resource probe preserves its slot and cancellation prevents resumed worker dispatch',async t=>{
  const f=await fixture(t,{service:true}),resource=gatedResource(f.dir,'probe');fs.writeFileSync(resource.mode,'gate');t.after(()=>fs.writeFileSync(resource.release,'release'));
  const {run_id}=await submit(f,[task('a',{}, {resources:['probe']})],{resources:[resource.profile]});const run=f.engine.getRun(run_id);
  const launching=f.engine.launch(run,run.tasks[0]);await waitFile(resource.entered);
  const response=await bounded(f.engine.call('cancel_run',{request_id:'cancel_real_probe',run_id}));assert.equal(response.state,'cancelling');
  assert.equal(f.engine.lockedResources().has('probe'),true);assert.equal(Object.values(f.store.state.operations).filter(op=>op.reservations.slot).length,1);
  assert.equal((await bounded(f.engine.call('get_run',{run_id}))).state,'cancelling');
  fs.writeFileSync(resource.release,'release');await launching;await f.engine.reconcile(f.engine.getRun(run_id));
  const attempt=f.engine.getRun(run_id).tasks[0].attempts[0];assert.equal(attempt.state,'cancelled');assert.equal(fs.existsSync(path.join(attempt.job_dir,'worker.json')),false);assert.equal(fs.existsSync(path.join(attempt.job_dir,'launch.json')),false);
});

test('two explicit resource resumes in different repositories cannot overbook the service slot',async t=>{
  const f=await fixture(t,{service:true}),other=await fixture(t,{service:true});f.engine.options.concurrency=1;
  const one=gatedResource(f.dir,'one'),two=gatedResource(f.dir,'two');t.after(()=>{fs.writeFileSync(one.release,'release');fs.writeFileSync(two.release,'release');});
  const first=await submit(f,[task('a',{}, {resources:['one']})],{resources:[one.profile]});
  const second=await submit(f,[task('b',{}, {resources:['two']})],{repo:other.repo,resources:[two.profile]});
  for(const id of [first.run_id,second.run_id]){const run=f.engine.getRun(id);await f.engine.launch(run,run.tasks[0]);assert.equal(run.tasks[0].attempts[0].state,'resource_wait');}
  fs.writeFileSync(one.mode,'gate');fs.writeFileSync(two.mode,'gate');
  const firstArgs={request_id:'resume_one',run_id:first.run_id},resuming=f.engine.call('reconcile_run',firstArgs);await waitFile(one.entered);
  const rejected=await bounded(f.engine.call('reconcile_run',{request_id:'resume_two',run_id:second.run_id}));assert.equal(rejected.error.code,'CAPACITY');assert.equal(fs.existsSync(two.entered),false);
  await f.engine.call('cancel_run',{request_id:'cancel_resume',run_id:first.run_id});fs.writeFileSync(one.release,'release');await resuming;
  while(Object.values(f.store.state.operations).some(op=>op.run_id===first.run_id))await sleep(10);
  await f.engine.reconcile(f.engine.getRun(first.run_id));assert.equal(f.engine.getRun(first.run_id).state,'cancelled');
  assert.equal(fs.existsSync(path.join(f.engine.getRun(first.run_id).tasks[0].attempts[0].job_dir,'worker.json')),false);
});

test('polling a hot run does not clone or serialize large immutable attempt histories',async t=>{
  const f=await fixture(t,{service:true});const {run_id}=await submit(f,[task('a')]);const run=f.engine.getRun(run_id),payload='x'.repeat(1024*1024);
  const attempts=Array.from({length:20},(_,index)=>({id:`old_${index}`,number:index+1,base:run.base,directory:path.join(f.dir,`old-${index}`),job_dir:path.join(f.dir,`job-${index}`),state:'failed',artifacts:[],verification:[],context:[],resources:[],inputs:[],worker:{protocol:2,id:`old_${index}`,phase:'failed',updated:Date.now(),prompt_id:'old',inputs:[],replies:{},verification:[],stopped:true,summary:payload}}));
  attempts.push({id:'latest',number:21,base:run.base,directory:path.join(f.dir,'latest'),job_dir:path.join(f.dir,'latest-job'),state:'orphaned',artifacts:[],verification:[],context:[],resources:[],inputs:[]});
  run.tasks[0].attempts=attempts;run.tasks[0].state='running';f.store.save();
  // Reading or JSON-cloning historical report bodies would trip this sentinel.
  for(const attempt of run.tasks[0].attempts.slice(0,-1))Object.defineProperty(attempt.worker,'summary',{enumerable:true,configurable:true,get(){throw new Error('Historical report body was read during polling.');}});
  const before=f.store.io.journal_bytes;await f.engine.collect(run);const written=f.store.io.journal_bytes-before;
  assert.ok(written<32768,`A no-change poll wrote ${written} bytes for a 20 MiB history.`);
  // Restore the in-memory fixture for teardown; no durable history was touched.
  for(const attempt of run.tasks[0].attempts.slice(0,-1))Object.defineProperty(attempt.worker,'summary',{enumerable:true,configurable:true,writable:true,value:payload});
  run.tasks[0].attempts.at(-1).state='interrupted';run.tasks[0].state='needs_review';f.store.save();
});

test('review final state, event and response publish together even when completion fsync is uncertain',async t=>{
  const f=await fixture(t,{service:true});const {run_id}=await submit(f,[task('a',{files:{'a.txt':'result'}})]);await f.engine.tick();
  const run=f.engine.getRun(run_id),deadline=Date.now()+30000;while(run.tasks[0].state!=='needs_review'&&Date.now()<deadline){await f.engine.tick();await sleep(25);}assert.equal(run.tasks[0].state,'needs_review');
  const original=Engine.prototype.effectReview,entered=gate(),release=gate();Engine.prototype.effectReview=async function(...args){const value=await original.apply(this,args);entered.resolve();await release.promise;return value;};t.after(()=>{release.resolve();Engine.prototype.effectReview=original;});
  const attempt=run.tasks[0].attempts[0],args={request_id:'atomic_review',run_id,task_id:'a',attempt_id:attempt.id,commit:attempt.commit};
  const reviewing=f.engine.call('approve_task',args);await entered.promise;
  const before=new Store(f.data);assert.equal(before.request(args.request_id).status,'intent');assert.equal(before.run(run_id).tasks[0].state,'needs_review');assert.equal(before.events(run_id).some(event=>event.type==='reviewed'),false);
  const fsync=fs.fsyncSync;let injected=false;fs.fsyncSync=function(fd){if(!injected&&f.store.state.requests[args.request_id]?.status==='done'){injected=true;throw new Error('injected final fsync uncertainty');}return fsync(fd);};
  t.after(()=>{fs.fsyncSync=fsync;});release.resolve();await assert.rejects(reviewing,error=>error.code==='REQUEST_UNCERTAIN');fs.fsyncSync=fsync;assert.equal(injected,true);
  const recovered=new Store(f.data),record=recovered.request(args.request_id);assert.equal(record.status,'done');assert.equal(recovered.run(run_id).tasks[0].state,'integrated');assert.equal(recovered.events(run_id).some(event=>event.type==='reviewed'),true);assert.equal(Object.keys(recovered.state.operations).length,0);
  const reopened=new Engine(recovered,cli);assert.deepEqual(await reopened.call('approve_task',args),record.result);
});

test('a revision change rejects an old completion and leaves an explicit uncertain operation',async t=>{
  const f=await fixture(t,{service:true});const {run_id}=await submit(f,[task('a')]);const entered=gate(),release=gate(),original=Engine.prototype.effectReconcile;
  Engine.prototype.effectReconcile=async function(run){run.error='stale effect marker';entered.resolve();await release.promise;};t.after(()=>{release.resolve();Engine.prototype.effectReconcile=original;});
  const reconciling=f.engine.call('reconcile_run',{request_id:'old_revision',run_id});await entered.promise;
  await f.engine.serial(async()=>{f.engine.getRun(run_id).revision++;f.store.save();});release.resolve();
  await assert.rejects(reconciling,error=>error.code==='STALE_OPERATION');
  assert.equal(f.store.uncertain,false);assert.equal(f.engine.getRun(run_id).error,undefined);
  assert.equal(Object.values(f.store.state.operations).find(operation=>operation.request_id==='old_revision').status,'uncertain');
  assert.equal(new Store(f.data).request('old_revision').status,'intent');
  Engine.prototype.effectReconcile=original;await f.engine.call('reconcile_run',{request_id:'reconcile_after_stale',run_id});
});

test('archive publication between admission and get_run never invokes a synchronous cold reader',async t=>{
  const f=await fixture(t,{service:true});const {run_id}=await submit(f,[task('a')]);const run=f.engine.getRun(run_id);
  run.state='cancelled';run.tasks[0].state='cancelled';run.ended_at=Date.now()-8*24*60*60*1000;f.store.save();
  const prepared=await f.store.prepareArchive();assert.ok(prepared);
  const entered=gate(),release=gate(),blocker=f.engine.serial(async()=>{entered.resolve();await release.promise;});await entered.promise;
  const commit=f.engine.serial(async()=>f.store.commitArchive(prepared));
  const read=f.engine.call('get_run',{run_id});const original=f.store.run.bind(f.store);
  f.store.run=id=>{assert.equal(f.store.isArchived(id),false,'Synchronous cold archive reader entered the control queue.');return original(id);};
  release.resolve();await blocker;await commit;const page=await read;assert.equal(page.archived,true);assert.equal(page.run_id,run_id);
  const cleaned=await f.engine.cleanup(run_id);assert.equal(cleaned.evidence_retained,true);
  assert.equal((await f.store.eventsAsync(run_id)).at(-1).type,'worktrees_cleaned');
});

test('shutdown fences late publication and drains its external effect before a new engine can recover it',async t=>{
  const f=await fixture(t,{service:true});const {run_id}=await submit(f,[task('a')]);const entered=gate(),release=gate(),original=Engine.prototype.effectReconcile;
  Engine.prototype.effectReconcile=async function(run){entered.resolve();await release.promise;run.error='late shutdown marker';};t.after(()=>{release.resolve();Engine.prototype.effectReconcile=original;});
  const pending=f.engine.reconcile(f.engine.getRun(run_id));await entered.promise;f.engine.beginShutdown();let drained=false;const draining=f.engine.drain().then(()=>{drained=true;});await turn();assert.equal(drained,false);
  release.resolve();const result=await pending;await draining;assert.equal(result.error.code,'REQUEST_UNCERTAIN');assert.equal(f.engine.getRun(run_id).error,undefined);
  const recovered=new Engine(new Store(f.data),cli);await recovered.recoverPreparations();assert.equal(Object.values(recovered.store.state.operations).find(operation=>operation.run_id===run_id).status,'uncertain');
  Engine.prototype.effectReconcile=original;await recovered.reconcile(recovered.getRun(run_id));f.engine=recovered;f.store=recovered.store;
});

test('canonical repository reservations also cover a new submission through a checkout alias',async t=>{
  const f=await fixture(t,{service:true});const {run_id}=await submit(f,[task('a')]);const alias=path.join(f.dir,'repository-alias');fs.symlinkSync(f.repo,alias,process.platform==='win32'?'junction':'dir');
  const entered=gate(),release=gate(),original=Engine.prototype.effectReview;
  Engine.prototype.effectReview=async()=>{entered.resolve();await release.promise;return {held:true};};t.after(()=>{release.resolve();Engine.prototype.effectReview=original;});
  const reviewing=f.engine.call('request_changes',{request_id:'held_repo_operation',run_id,task_id:'a',attempt_id:'synthetic',feedback:'held fixture'});await entered.promise;
  const denied=await f.engine.call('create_run',{request_id:'alias_submission',...runDefaults,repo:alias,tasks:[task('b')]});assert.equal(denied.error.code,'REPOSITORY_BUSY');assert.equal(f.store.state.runs.length,1);
  assert.equal(fs.existsSync(path.join(f.data,'submissions','alias_submission')),false);release.resolve();await reviewing;
});

test('every resource-wait resume reserves a fresh slot after a previous resume becomes running',async t=>{
  const f=await fixture(t,{service:true}),other=await fixture(t,{service:true});f.engine.options.concurrency=2;
  const one=gatedResource(f.dir,'first_resume'),two=gatedResource(f.dir,'second_resume'),third=gatedResource(f.dir,'competing_launch');
  const releaseFirst=gate(),firstRunning=gate();t.after(()=>{releaseFirst.resolve();for(const resource of [one,two,third])fs.writeFileSync(resource.release,'release');});
  const first=await submit(f,[task('a',{}, {resources:['first_resume']}),task('b',{}, {resources:['second_resume']})],{resources:[one.profile,two.profile]});const run=f.engine.getRun(first.run_id);
  for(const current of run.tasks)await f.engine.launch(run,current);assert.ok(run.tasks.every(current=>current.attempts[0].state==='resource_wait'));
  const firstID=run.tasks[0].attempts[0].id,spawn=f.engine.spawn;
  f.engine.options.spawn=async function(current,attempt,spec){if(attempt.id!==firstID)return spawn.call(this,current,attempt,spec);attempt.state='running';await this.persist();firstRunning.resolve();await releaseFirst.promise;};
  fs.writeFileSync(one.mode,'gate');fs.writeFileSync(two.mode,'gate');fs.writeFileSync(third.mode,'gate');fs.writeFileSync(one.release,'release');
  const args={request_id:'resume_multiple',run_id:run.id},resuming=f.engine.call('reconcile_run',args);await firstRunning.promise;
  const competition=await submit(f,[task('c',{}, {resources:['competing_launch']})],{repo:other.repo,resources:[third.profile]});const competing=f.engine.getRun(competition.run_id);
  const launching=f.engine.launch(competing,competing.tasks[0]);await waitFile(third.entered);
  releaseFirst.resolve();await resuming;await callOk(f,'reconcile_run',args);
  assert.equal(run.tasks[1].attempts[0].state,'resource_wait');assert.equal(fs.existsSync(two.entered),false,'The second resume ran its probe without a free service slot.');
  assert.match(run.tasks[1].attempts[0].error,/free service worker slot/);
  await f.engine.cancel(run);await f.engine.cancel(competing);fs.writeFileSync(third.release,'release');await launching;
  await f.engine.reconcile(f.engine.getRun(run.id));await f.engine.reconcile(f.engine.getRun(competing.id));
  assert.equal(f.engine.getRun(run.id).state,'cancelled');assert.equal(f.engine.getRun(competing.id).state,'cancelled');
});

test('a promised progress response keeps a child event loop alive without unrelated handles',async t=>{
  const f=await fixture(t,{service:true}),script=path.join(f.dir,'progress-without-handles.mjs');
  const source=`import assert from 'node:assert/strict';import {Engine,Store} from ${JSON.stringify(new URL('../dist/index.mjs',import.meta.url).href)};
let release;Engine.prototype.effectSubmit=async()=>{await new Promise(resolve=>{release=resolve;});return {finished:true};};
const engine=new Engine(new Store(${JSON.stringify(path.join(f.dir,'child-data'))}),${JSON.stringify(cli)});
const args={request_id:'progress_without_handles',repo:${JSON.stringify(f.repo)},worker:{platform:'opencode'},final_verification:[{command:'node -e 0'}],tasks:[{id:'a',goal:'held mock effect',scope:['a.txt'],acceptance:['done'],verification:[{command:'node -e 0'}]}]};
const progress=await engine.call('create_run',args);assert.equal(progress.in_progress,true);release();const result=await engine.call('create_run',args);assert.equal(result.finished,true);await engine.drain();await engine.store.close();console.log(JSON.stringify({progress:true,finished:true}));`;
  fs.writeFileSync(script,source);const {exec}=await import('../dist/index.mjs');const result=await exec(process.execPath,[script],{timeout:10000});
  assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout.trim()),{progress:true,finished:true});
});
