import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, Engine, Fault, uid, sleep, writeJson, readJson, WORKER_FORMAT, transition, moveRun, rejectedEvidence } from '../dist/index.mjs';
import { fixture, task, submit, review, callOk, cli, git } from './helpers.mjs';

function processFixture(jobDir, identity, stopped=false) {
  const id=uid('process');writeJson(path.join(jobDir,'process-intents',`${id}.json`),{id,at:Date.now()});
  if(identity)writeJson(path.join(jobDir,'process-records',`${id}.json`),{identity,stopped});
  return id;
}
function confirmFixtureProcesses(jobDir) {
  const identity={pid:99999999,birth:'confirmed stopped'};
  for(const file of fs.readdirSync(path.join(jobDir,'process-intents')))writeJson(path.join(jobDir,'process-records',file),{identity,stopped:true});
  return identity;
}

async function controlled(t) {
  const f = await fixture(t);
  f.engine.stop();
  return f;
}
async function tickUntil(f, id, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await f.engine.tick();
    const run = f.engine.getRun(id);
    if (predicate(run)) return run;
    await sleep(100);
  }
  throw new Error(`State did not converge: ${JSON.stringify(f.engine.getRun(id))}`);
}

test('a correction makes its previous result unreviewable before dispatch and after restart', async t => {
  const f = await controlled(t);
  const s = await submit(f, [task('a', {files:{'a.txt':'original'}})]);
  let run = await tickUntil(f, s.run_id, r => r.tasks[0].state === 'needs_review');
  const a = run.tasks[0].attempts[0];
  const args = {request_id:uid('correction'),run_id:run.id,task_id:'a',attempt_id:a.id,commit:a.commit,decision:'request_changes',feedback:'FAKE_ACTION:{"files":{"a.txt":"corrected"}}'};
  const correction = await callOk(f, 'review_task', args);
  assert.deepEqual(await callOk(f,'review_task',args),correction);
  for (const decision of ['approve','request_changes']) {
    const result = await f.call('review_task',{...args,request_id:uid('stale'),decision});
    assert.equal(result.error?.code, 'REVIEW');
  }
  const store = new Store(f.data);
  const engine = new Engine(store,cli,{concurrency:2});
  const recovered = {...f,store,engine,call:(name,args)=>engine.call(name,args)};
  const denied = await recovered.call('review_task',{...args,request_id:uid('stale'),decision:'approve'});
  assert.equal(denied.error?.code,'REVIEW');
  run = await tickUntil(recovered,run.id,r=>r.tasks[0].attempts.length===2 && r.tasks[0].state==='needs_review');
  await review(recovered,run,'a');
  assert.equal(fs.readFileSync(path.join(run.integration_dir,'a.txt'),'utf8'),'corrected');
});

test('invalid submissions publish no empty run, worktree, context or partial append', async t => {
  const f = await controlled(t);
  for (const extra of [{resources:['missing']},{context_files:['missing.md']}]) {
    const result = await f.call('submit_tasks',{request_id:uid('bad'),repo:f.repo,tasks:[task('a',{},extra)]});
    assert.ok(result.error);
    assert.equal(f.store.state.runs.length,0);
    assert.equal(fs.existsSync(path.join(f.data,'worktrees')),false);
  }
  const s = await submit(f,[task('a')]);
  const before = JSON.stringify(f.engine.getRun(s.run_id));
  const result = await f.call('submit_tasks',{request_id:uid('bad'),run_id:s.run_id,tasks:[task('b'),task('c',{}, {context_files:['missing.md']})]});
  assert.ok(result.error);
  assert.equal(JSON.stringify(f.engine.getRun(s.run_id)),before);
  assert.equal(fs.existsSync(path.join(f.data,'runs',s.run_id,'b.json')),false);
});

test('cancel wins over an already completed final verification snapshot', async t => {
  const f=await controlled(t),s=await submit(f,[task('a',{files:{'a.txt':'ok'}})]);
  const run=await tickUntil(f,s.run_id,r=>r.tasks[0].state==='needs_review');
  await review(f,run,'a');
  f.engine.options.spawn=async (_run,a)=>{
    writeJson(path.join(a.job_dir,'worker.json'),{protocol:WORKER_FORMAT,id:a.id,phase:'completed',updated:Date.now(),prompt_id:'msg',inputs:[],replies:{},stopped:true,
      verification:[{command:run.final_verification[0].command,status:'passed',exit_code:0,artifact:'verification-0.json'}]});
  };
  await callOk(f,'validate_run',{request_id:uid('validation'),run_id:run.id});
  const result=await callOk(f,'cancel_run',{request_id:uid('cancel'),run_id:run.id});
  assert.equal(result.state,'cancelling');
  await tickUntil(f,run.id,value=>value.state==='cancelled');
  assert.equal(run.validation.state,'cancelled');
  assert.equal(run.tasks[0].state,'integrated');
  assert.equal(new Store(f.data).state.runs[0].state,'cancelled');
});

test('cancel after a lost validation process does not reactivate the run', {skip:process.platform==='win32'?'A dead Windows parent cannot prove descendant termination':false}, async t=>{
  const f=await controlled(t),s=await submit(f,[task('a',{files:{'a.txt':'ok'}})]);
  const run=await tickUntil(f,s.run_id,r=>r.tasks[0].state==='needs_review');
  await review(f,run,'a');
  f.engine.options.spawn=async (_run,a)=>{
    const identity={pid:99999999,birth:'dead'};
    processFixture(a.job_dir,identity);
    writeJson(path.join(a.job_dir,'worker.json'),{protocol:WORKER_FORMAT,id:a.id,phase:'verifying',updated:Date.now(),prompt_id:'msg',host:identity,server:identity,inputs:[],replies:{},verification:[]});
  };
  await callOk(f,'validate_run',{request_id:uid('validation'),run_id:run.id});
  const result=await callOk(f,'cancel_run',{request_id:uid('cancel'),run_id:run.id});
  assert.equal(result.state,'cancelling');
  await tickUntil(f,run.id,value=>value.state==='cancelled');
  assert.equal(run.validation.state,'cancelled');
});

test('scope rejection preserves the untracked file and structured reason', async t=>{
  const f=await controlled(t),s=await submit(f,[task('a',{files:{'outside.txt':'review this change','base.txt':'tracked change'}})]);
  const run=await tickUntil(f,s.run_id,r=>r.tasks[0].state==='needs_review'),a=run.tasks[0].attempts[0];
  assert.equal(a.state,'scope_or_context_error');
  const id=a.artifacts.find(p=>p.endsWith('-rejected-result.json'));
  assert.ok(id);
  const evidence=JSON.parse(fs.readFileSync(path.join(f.data,'artifacts',id),'utf8'));
  assert.equal(evidence.code,'SCOPE_VIOLATION');
  assert.ok(evidence.details.some(f=>f.path==='outside.txt'));
  assert.equal(evidence.changed_files.find(f=>f.path==='outside.txt').preview,'review this change');
  const diff=a.artifacts.find(p=>p.endsWith('-rejected-diff.patch'));
  assert.match(fs.readFileSync(path.join(f.data,'artifacts',diff),'utf8'),/tracked change/);
});

test('metadata publication failure rolls back the whole submission and preserves an existing run', async t=>{
  const f=await controlled(t),s=await submit(f,[task('a')]),before=JSON.stringify(f.engine.getRun(s.run_id));
  const link=fs.linkSync;
  const mock=t.mock.method(fs,'linkSync',(source,destination)=>{
    if (destination===path.join(f.data,'runs',s.run_id,'c.json')) throw new Error('injected metadata failure');
    return link(source,destination);
  });
  const result=await f.call('submit_tasks',{request_id:uid('bad'),run_id:s.run_id,tasks:[task('b'),task('c')]});
  mock.mock.restore();
  assert.match(result.error.message,/injected metadata failure/);
  assert.equal(JSON.stringify(f.engine.getRun(s.run_id)),before);
  assert.equal(fs.existsSync(path.join(f.data,'runs',s.run_id,'b.json')),false);
  assert.equal(fs.existsSync(path.join(f.data,'runs',s.run_id,'a.json')),true);
});

test('a crash after checkout creation is fenced and its unpublished checkout is safely recovered', async t=>{
  const f=await controlled(t),save=f.store.save.bind(f.store);
  f.store.save=()=>{if(f.store.state.events.some(event=>event.type==='tasks_submitted')){f.store.uncertain=true;throw new Fault('REQUEST_UNCERTAIN','publication interruption');}return save();};
  const interrupted=await f.call('submit_tasks',{request_id:uid('submit'),repo:f.repo,tasks:[task('a')],final_verification:[{command:'node -e "process.exit(0)"'}]});
  assert.equal(interrupted.error.code,'REQUEST_UNCERTAIN');
  const prepared=f.store.state.runs[0];
  assert.equal(fs.existsSync(prepared.integration_dir),true);
  await f.engine.tick();
  assert.equal(prepared.tasks[0].attempts.length,0);
  const store=new Store(f.data),engine=new Engine(store,cli,{concurrency:2});
  await engine.recoverPreparations();
  assert.equal(store.state.runs.length,0);
  assert.equal(fs.existsSync(prepared.integration_dir),false);
  assert.equal((await git(f.repo,'branch','--list',prepared.integration_branch)).trim(),'');
});

test('journal publication survives fsync uncertainty and retransmission without replaying submission', async t=>{
  const f=await controlled(t),request_id=uid('submit');
  const args={request_id,repo:f.repo,tasks:[task('a')],final_verification:[{command:'node -e "process.exit(0)"'}]};
  const sync=fs.fsyncSync;
  const mock=t.mock.method(fs,'fsyncSync',descriptor=>{
    if (f.store.state.events.some(e=>e.type==='tasks_submitted')) throw new Error('journal fsync interruption');
    return sync(descriptor);
  });
  const interrupted=await f.call('submit_tasks',args);assert.equal(interrupted.error.code,'REQUEST_UNCERTAIN');
  mock.mock.restore();
  assert.equal(f.store.uncertain,true);
  await f.engine.tick();
  assert.equal(f.store.state.runs[0].tasks[0].attempts.length,0);
  const store=new Store(f.data),engine=new Engine(store,cli,{concurrency:2});
  const recovered=await engine.call('submit_tasks',args);
  assert.equal(recovered.run_id,store.state.runs[0].id);
  assert.equal(store.state.runs.length,1);
  assert.equal(store.state.runs[0].tasks[0].attempts.length,0);
  assert.equal(store.state.requests[request_id].status,'done');
  await engine.cancel(store.state.runs[0]);
});

test('state groups reject invalid transitions without partially changing the group', async t=>{
  const f=await controlled(t),s=await submit(f,[task('a')]),run=f.engine.getRun(s.run_id);
  const integrated={...run.tasks[0],state:'integrated'};
  assert.throws(()=>transition({run:[run,'cancelling'],task:[integrated,'queued']}),e=>e.code==='STATE_TRANSITION');
  assert.equal(run.state,'active');
  moveRun(run,'cancelling');moveRun(run,'cancelled');
  assert.throws(()=>moveRun(run,'active'),e=>e.code==='STATE_TRANSITION');
});

test('current state strings load while unknown stored and worker states block execution', async t=>{
  const f=await controlled(t),s=await submit(f,[task('a')]);
  assert.equal(new Store(f.data).state.runs[0].state,'active');
  const snapshot=readJson(path.join(f.data,'state.json'));
  writeJson(path.join(f.data,'state.json'),{...snapshot,runs:[{...snapshot.runs[0],state:'future_unknown'}]});
  assert.throws(()=>new Store(f.data),e=>e.code==='STATE_CORRUPT');
  writeJson(path.join(f.data,'state.json'),snapshot);
  const job_dir=path.join(f.dir,'bad-worker');writeJson(path.join(job_dir,'worker.json'),{phase:'future_unknown'});
  assert.throws(()=>f.engine.workerState({id:'bad',job_dir}),e=>e.code==='STATE_CORRUPT');
  assert.equal(f.engine.getRun(s.run_id).tasks[0].attempts.length,0);
});

test('uncertain termination retains a lease and blocks successors until termination is confirmed', async t=>{
  const f=await controlled(t),profile={resource_key:'editor',connection:{name:'editor',config:{type:'remote',url:'http://127.0.0.1:59998/mcp'}},probe:{executable:process.execPath,args:['-e','console.log(JSON.stringify({instance_id:"editor"}))'],read_only:true},expected_instance:'editor'};
  let dispatches=0;
  f.engine.options.spawn=async (_run,a)=>{
    dispatches++;
    processFixture(a.job_dir);
    writeJson(path.join(a.job_dir,'worker.json'),{protocol:WORKER_FORMAT,id:a.id,phase:'stop_uncertain',updated:Date.now(),prompt_id:'msg',inputs:[],replies:{},verification:[]});
  };
  const first=await submit(f,[task('a',{}, {resources:['editor']})],{resources:[profile]});
  await f.engine.tick();
  const run=f.engine.getRun(first.run_id),a=run.tasks[0].attempts[0];
  const second=await submit(f,[task('b',{}, {resources:['editor']})],{resources:[profile]});
  const cancelled=await callOk(f,'cancel_run',{request_id:uid('cancel'),run_id:run.id});
  assert.equal(cancelled.state,'cancelling');
  await f.engine.tick();
  assert.equal(dispatches,1);
  assert.ok(f.engine.lockedResources().has('editor'));
  const worker=readJson(path.join(a.job_dir,'worker.json'));
  writeJson(path.join(a.job_dir,'worker.json'),{...worker,phase:'cancelled',stopped:true,server:confirmFixtureProcesses(a.job_dir)});
  await f.engine.tick();
  await tickUntil(f,run.id,value=>value.state==='cancelled');
  await tickUntil(f,second.run_id,value=>value.tasks[0].attempts.length===1);
  assert.equal(dispatches,2);
  const next=f.engine.getRun(second.run_id).tasks[0].attempts[0];
  writeJson(path.join(next.job_dir,'worker.json'),{...readJson(path.join(next.job_dir,'worker.json')),phase:'cancelled',stopped:true,server:confirmFixtureProcesses(next.job_dir)});
});

test('rejection previews are bounded, UTF-8 safe and omit binary and authentication bodies', async t=>{
  const f=await controlled(t);
  fs.writeFileSync(path.join(f.repo,'large.txt'),'한글😀'.repeat(20000));
  fs.writeFileSync(path.join(f.repo,'binary.dat'),Buffer.from([0,1,2,255]));
  fs.writeFileSync(path.join(f.repo,'.env'),'NEVER_PUBLISH_SECRET');
  const artifacts=await rejectedEvidence(f.store,'diagnostic',{directory:f.repo,context:[]},new Error('reason'));
  const report=JSON.parse(fs.readFileSync(path.join(f.data,'artifacts',artifacts.find(p=>p.endsWith('-rejected-result.json'))),'utf8'));
  const large=report.changed_files.find(f=>f.path==='large.txt');
  assert.ok(large.preview_bytes<=65536);assert.equal(large.truncated,true);assert.ok(!large.preview.includes('\ufffd'));assert.equal(large.sha256.length,64);
  const binary=report.changed_files.find(f=>f.path==='binary.dat');assert.equal(binary.kind,'binary');assert.equal(binary.preview,undefined);
  assert.equal(report.changed_files.find(f=>f.path==='.env').omitted,'authentication_file');
  assert.ok(!JSON.stringify(report).includes('NEVER_PUBLISH_SECRET'));
});

test('rejection evidence records symlinks without reading their target', {skip:process.platform==='win32'?'Windows symlink creation requires developer-mode privileges':false}, async t=>{
  const f=await controlled(t),secret=path.join(f.dir,'outside-secret');fs.writeFileSync(secret,'NEVER_FOLLOW_SYMLINK');fs.symlinkSync(secret,path.join(f.repo,'link.txt'));
  const artifacts=await rejectedEvidence(f.store,'diagnostic',{directory:f.repo,context:[]},new Error('reason'));
  const report=JSON.parse(fs.readFileSync(path.join(f.data,'artifacts',artifacts.find(p=>p.endsWith('-rejected-result.json'))),'utf8'));
  assert.equal(report.changed_files.find(f=>f.path==='link.txt').kind,'symlink');
  assert.ok(!JSON.stringify(report).includes('NEVER_FOLLOW_SYMLINK'));
});

test('a diagnostic collection failure does not replace the original scope violation', async t=>{
  const f=await controlled(t),s=await submit(f,[task('a',{files:{'outside.txt':'bad'}})]);
  const artifact=f.store.artifact.bind(f.store);
  f.store.artifact=(run,name,content)=>{if(name==='rejected-diff.patch')throw new Error('injected evidence failure');return artifact(run,name,content);};
  const run=await tickUntil(f,s.run_id,r=>r.tasks[0].state==='needs_review'),a=run.tasks[0].attempts[0];
  assert.equal(a.error,'Changes exceed the declared scope.');
  const report=JSON.parse(fs.readFileSync(path.join(f.data,'artifacts',a.artifacts.find(p=>p.endsWith('-rejected-result.json'))),'utf8'));
  assert.equal(report.code,'SCOPE_VIOLATION');assert.match(report.collection_errors[0],/injected evidence failure/);
});

test('answered implementation input and service recovery cannot restart implementation during final verification', async t=>{
  const f=await controlled(t);
  const s=await submit(f,[task('a',{files:{'a.txt':'ok'},input:'question'})],{final_verification:[
    {command:'node -e "process.exit(0)"'},
    {command:'node -e "const fs=require(\'fs\');const timer=setInterval(()=>{if(fs.existsSync(\'ignored.txt\'))clearInterval(timer)},50)"'},
  ]});
  let run=await tickUntil(f,s.run_id,r=>r.tasks[0].attempts[0]?.inputs.length);
  const implementation=run.tasks[0].attempts[0];
  await callOk(f,'respond_to_request',{request_id:uid('answer'),run_id:run.id,attempt_id:implementation.id,input_id:implementation.inputs[0].id,decision:'answer',answers:[['Proceed']]});
  run=await tickUntil(f,run.id,r=>r.tasks[0].state==='needs_review');await review(f,run,'a');
  const previous=process.env.FAKE_SHELL_QUESTION;process.env.FAKE_SHELL_QUESTION='1';
  t.after(()=>{if(previous===undefined)delete process.env.FAKE_SHELL_QUESTION;else process.env.FAKE_SHELL_QUESTION=previous;});
  await callOk(f,'validate_run',{request_id:uid('validation'),run_id:run.id});
  await tickUntil(f,run.id,r=>r.validation.attempt.worker?.phase==='verifying' && r.validation.attempt.worker.verification.length===1 && r.validation.attempt.worker.shell_intent?.index===1);
  const a=run.validation.attempt;
  assert.equal(a.worker.session_id,undefined);assert.equal(a.inputs.length,0);
  f.engine.beginShutdown();await f.engine.drain();
  const recovered={...f,store:new Store(f.data)};recovered.engine=new Engine(recovered.store,cli,f.engine.options);
  await recovered.engine.reconcile(recovered.store.state.runs[0]);
  assert.equal(recovered.store.state.runs[0].validation.attempt.id,a.id);
  assert.equal(recovered.store.state.runs[0].tasks[0].attempts.length,1);
  f.store=recovered.store;f.engine=recovered.engine;run=recovered.store.state.runs[0];
  fs.writeFileSync(path.join(a.directory,'ignored.txt'),'release');
  await tickUntil(f,run.id,r=>r.state==='waiting_final_review');
  assert.equal(run.validation.state,'passed');
});

for(const preparation of ['absent','missing-manifest','published-manifest'])test(`a published submission without its atomic response and ${preparation} stays uncertain without recovery or replay`, async t=>{
  const f=await controlled(t),request_id=uid('submit'),args={request_id,repo:f.repo,tasks:[task('a')]};
  const committed=await f.call('submit_tasks',args);assert.equal(committed.run_id,f.store.state.runs[0].id);
  assert.equal(fs.existsSync(path.join(f.data,'submissions',request_id)),false);
  f.store.state.requests[request_id]={hash:f.store.state.requests[request_id].hash,status:'intent'};f.store.save();
  const store=new Store(f.data),engine=new Engine(store,cli,{concurrency:2}),run=store.state.runs[0],directory=path.join(f.data,'submissions',request_id);
  let retained;
  if(preparation!=='absent'){
    fs.mkdirSync(directory,{recursive:true});
    retained=path.join(directory,preparation==='missing-manifest'?'retained-evidence.txt':'manifest.json');
    if(preparation==='missing-manifest')fs.writeFileSync(retained,'preserve uncertain preparation');
    else writeJson(retained,{protocol:4,request_id,request_hash:store.state.requests[request_id].hash,run_id:run.id,repo:run.repo,base:run.base,new_run:true,integration_dir:run.integration_dir,integration_branch:run.integration_branch,files:[],result:committed});
  }
  const before=retained&&fs.readFileSync(retained);
  await assert.rejects(engine.call('submit_tasks',args),error=>error.code==='REQUEST_UNCERTAIN');
  if(retained)assert.deepEqual(fs.readFileSync(retained),before);
  assert.equal(store.state.requests[request_id].status,'intent');
  assert.equal(store.state.runs.length,1);assert.equal(store.state.runs[0].tasks[0].attempts.length,0);
  await engine.cancel(store.state.runs[0]);
});

test('recovery preserves user changes in an unpublished prepared checkout', async t=>{
  const f=await controlled(t),request_id=uid('submit'),args={request_id,repo:f.repo,tasks:[task('a')]},save=f.store.save.bind(f.store);
  f.store.save=()=>{if(f.store.state.events.some(event=>event.type==='tasks_submitted')){f.store.uncertain=true;throw new Fault('REQUEST_UNCERTAIN','publication interruption');}return save();};
  const interrupted=await f.call('submit_tasks',args);assert.equal(interrupted.error.code,'REQUEST_UNCERTAIN');
  const run=f.store.state.runs[0],original=fs.readFileSync(path.join(run.integration_dir,'base.txt'));
  fs.writeFileSync(path.join(run.integration_dir,'base.txt'),'user change');
  const store=new Store(f.data),engine=new Engine(store,cli,{concurrency:2});
  await engine.recoverPreparations();
  assert.equal(fs.readFileSync(path.join(run.integration_dir,'base.txt'),'utf8'),'user change');
  assert.equal(store.state.runs.length,0);
  await assert.rejects(engine.call('submit_tasks',args),e=>e.code==='REQUEST_UNCERTAIN');
  fs.writeFileSync(path.join(run.integration_dir,'base.txt'),original);
  const cleanupEngine=new Engine(new Store(f.data),cli,{concurrency:2});
  await cleanupEngine.recoverPreparations();
  assert.equal(fs.existsSync(run.integration_dir),false);
});

test('an owned process intent without an identity cannot release a slot even if the snapshot claims stopped', async t=>{
  const f=await controlled(t);let dispatches=0;
  f.engine.options.spawn=async (_run,a)=>{
    dispatches++;processFixture(a.job_dir);
    writeJson(path.join(a.job_dir,'worker.json'),{protocol:WORKER_FORMAT,id:a.id,phase:'completed',updated:Date.now(),prompt_id:'msg',inputs:[],replies:{},verification:[],stopped:true});
  };
  const s=await submit(f,[task('a'),task('b')],{settings:{concurrency:1}});
  await f.engine.tick();await f.engine.tick();
  const run=f.engine.getRun(s.run_id),a=run.tasks[0].attempts[0];
  assert.equal(a.state,'stop_uncertain');assert.equal(dispatches,1);assert.equal(run.tasks[1].attempts.length,0);
  const worker=readJson(path.join(a.job_dir,'worker.json'));
  writeJson(path.join(a.job_dir,'worker.json'),{...worker,phase:'cancelled',server:confirmFixtureProcesses(a.job_dir)});
  await f.engine.cancel(run);
});

test('reconciliation collects a stop record published during process ownership checks', async t=>{
  const f=await controlled(t);
  f.engine.options.spawn=async (_run,a)=>{
    writeJson(path.join(a.job_dir,'worker.json'),{protocol:WORKER_FORMAT,id:a.id,phase:'cancelling',updated:Date.now(),
      host:{pid:99999999,birth:'exited fixture host'},inputs:[],replies:{},verification:[]});
    fs.mkdirSync(path.join(a.job_dir,'process-intents'),{recursive:true});
  };
  const {run_id}=await submit(f,[task('a')]),run=f.engine.getRun(run_id);
  await f.engine.launch(run,run.tasks[0]);
  const a=run.tasks[0].attempts[0],file=path.join(a.job_dir,'worker.json');
  run.state='cancelling';a.state='cancelling';a.worker=readJson(file);f.store.save();
  const original=Engine.prototype.workerState;let reads=0;
  t.mock.method(Engine.prototype,'workerState',function(attempt){
    const state=original.call(this,attempt);
    // The worker finishes after reconciliation reads its starting snapshot,
    // before the slower OS ownership query reports that the host has exited.
    if(attempt.id===a.id&&++reads===2)writeJson(file,{...state,phase:'cancelled',stopped:true});
    return state;
  });
  await f.engine.reconcile(run);
  assert.equal(run.state,'cancelled');assert.equal(a.worker.stopped,true);assert.equal(a.worker.phase,'cancelled');
  assert.equal(new Store(f.data).state.runs[0].tasks[0].attempts[0].worker.stopped,true);
});
