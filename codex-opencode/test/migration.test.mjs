import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, Engine, migrate, digest, alive, sleep, processIdentity } from '../dist/index.mjs';
import { fixture,task,submit,cli,until,ready,callOk } from './helpers.mjs';

async function legacy(t) {
  const f=await fixture(t);f.engine.stop();
  const args={request_id:'legacy-request',repo:f.repo,tasks:[task('a')],final_verification:[]};
  await f.call('submit_tasks',args);
  const state=structuredClone(f.store.state);state.protocol=1;
  for(const run of state.runs){delete run.worker;for(const task of run.tasks)delete task.worker;}
  fs.writeFileSync(path.join(f.data,'state.json'),JSON.stringify(state));
  fs.writeFileSync(path.join(f.data,'journal.jsonl'),`${JSON.stringify({hash:digest(state),state})}\n`);
  return {...f,args,legacyState:state};
}
test('explicit offline migration preserves request hashes, IDs, revisions and cached responses',async t=>{
  const f=await legacy(t),before=fs.readFileSync(path.join(f.data,'state.json'));
  assert.throws(()=>new Store(f.data),e=>e.code==='UPDATE_PENDING');
  const dry=await migrate(f.data);assert.equal(dry.eligible,true);assert.deepEqual(fs.readFileSync(path.join(f.data,'state.json')),before);
  const result=await migrate(f.data,{apply:true,legacy:f.engine.options});assert.equal(result.to,2);
  const store=new Store(f.data),run=store.state.runs[0];
  assert.equal(run.worker.platform,'opencode');assert.equal(run.tasks[0].worker.platform,'opencode');
  assert.equal(run.revision,f.legacyState.runs[0].revision);assert.deepEqual(store.state.requests,f.legacyState.requests);
  const engine=new Engine(store,cli,f.engine.options);
  assert.deepEqual(await engine.call('submit_tasks',f.args),f.legacyState.requests['legacy-request'].result);
  assert.equal(store.state.runs.length,1);assert.equal(run.tasks[0].attempts.length,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup,'backup','state.json'))).protocol,1);
});
test('migration interruption fences service startup and can resume without dispatch',async t=>{
  const f=await legacy(t);
  await assert.rejects(()=>migrate(f.data,{apply:true,legacy:f.engine.options,onPhase:phase=>{if(phase==='written:state.json')throw new Error('power loss');}}),e=>e.code==='REQUEST_UNCERTAIN');
  assert.throws(()=>new Store(f.data),e=>e.code==='UPDATE_PENDING');
  await migrate(f.data,{apply:true});
  const store=new Store(f.data);assert.equal(store.state.runs[0].tasks[0].attempts.length,0);assert.deepEqual(store.state.requests,f.legacyState.requests);
});
test('incomplete migration rollback restores exact legacy bytes',async t=>{
  const f=await legacy(t),snapshot=fs.readFileSync(path.join(f.data,'state.json')),journal=fs.readFileSync(path.join(f.data,'journal.jsonl'));
  await assert.rejects(()=>migrate(f.data,{apply:true,legacy:f.engine.options,onPhase:phase=>{if(phase==='written:journal.jsonl')throw new Error('interruption');}}));
  await migrate(f.data,{rollback:true});assert.deepEqual(fs.readFileSync(path.join(f.data,'state.json')),snapshot);assert.deepEqual(fs.readFileSync(path.join(f.data,'journal.jsonl')),journal);
});
test('migration refuses unresolved requests and preserves externally changed files',async t=>{
  const f=await legacy(t);f.legacyState.requests.pending={hash:'unknown',status:'intent'};
  fs.writeFileSync(path.join(f.data,'state.json'),JSON.stringify(f.legacyState));fs.writeFileSync(path.join(f.data,'journal.jsonl'),`${JSON.stringify({hash:digest(f.legacyState),state:f.legacyState})}\n`);
  await assert.rejects(()=>migrate(f.data,{apply:true}),e=>e.code==='UPDATE_PENDING');
  delete f.legacyState.requests.pending;fs.writeFileSync(path.join(f.data,'state.json'),JSON.stringify(f.legacyState));fs.writeFileSync(path.join(f.data,'journal.jsonl'),`${JSON.stringify({hash:digest(f.legacyState),state:f.legacyState})}\n`);
  await assert.rejects(()=>migrate(f.data,{apply:true,legacy:f.engine.options,onPhase:phase=>{if(phase==='written:state.json')throw new Error('interruption');}}));
  fs.appendFileSync(path.join(f.data,'state.json'),' ');const edited=fs.readFileSync(path.join(f.data,'state.json'));
  await assert.rejects(()=>migrate(f.data,{rollback:true}),e=>e.code==='REQUEST_UNCERTAIN');assert.deepEqual(fs.readFileSync(path.join(f.data,'state.json')),edited);
});

test('migration preserves reviewed commits, validation history, context and rejected artifacts',async t=>{
  const f=await fixture(t);fs.writeFileSync(path.join(f.repo,'AGENTS.md'),'preserved rule\n');
  const s=await submit(f,[task('a',{files:{'a.txt':'approved'}},{context_files:['AGENTS.md']})]);
  const run=await until(f,s.run_id,r=>r.tasks[0].state==='needs_review');await ready(f,run);
  await callOk(f,'submit_tasks',{request_id:'legacy-append',run_id:run.id,tasks:[task('b',{files:{'outside.txt':'rejected evidence'}})]});
  await until(f,run.id,r=>r.tasks[1].state==='needs_review');f.engine.stop();await f.engine.serial(async()=>{});
  const attempts=[...run.tasks.flatMap(task=>task.attempts),...run.validation_history.map(v=>v.attempt)];
  const deadline=Date.now()+30000;
  while((await Promise.all(attempts.map(a=>alive(a.worker?.host)))).some(Boolean)){assert.ok(Date.now()<deadline,'Worker hosts must exit before migration');await sleep(100);}
  const prior=JSON.parse(JSON.stringify(f.store.state));prior.protocol=1;
  for(const r of prior.runs){delete r.worker;for(const task of r.tasks)delete task.worker;}
  for(const a of [...prior.runs[0].tasks.flatMap(t=>t.attempts),...prior.runs[0].validation_history.map(v=>v.attempt)]) {
    delete a.execution;if(a.worker){a.worker.protocol=1;delete a.worker.backend;delete a.worker.backend_version;delete a.worker.processes;}
    const specFile=path.join(a.job_dir,'spec.json'),spec=JSON.parse(fs.readFileSync(specFile));delete spec.protocol;delete spec.worker;delete spec.host_executable;fs.writeFileSync(specFile,JSON.stringify(spec));
    fs.writeFileSync(path.join(a.job_dir,'worker.json'),JSON.stringify(a.worker));
  }
  fs.writeFileSync(path.join(f.data,'state.json'),JSON.stringify(prior));fs.writeFileSync(path.join(f.data,'journal.jsonl'),`${JSON.stringify({hash:digest(prior),state:prior})}\n`);
  const artifactFiles=attempts.flatMap(a=>a.artifacts).map(file=>path.join(f.data,'artifacts',file));
  assert.ok(artifactFiles.some(file=>file.endsWith('rejected-result.json')));
  const bytes=new Map([...artifactFiles,...attempts.flatMap(a=>['spec.json','worker.json'].map(name=>path.join(a.job_dir,name)))].map(file=>[file,fs.readFileSync(file)]));
  await migrate(f.data,{apply:true,legacy:f.engine.options});const after=new Store(f.data).state;
  assert.deepEqual(after.requests,prior.requests);assert.deepEqual(after.events,prior.events);
  const next=after.runs[0];assert.equal(next.revision,prior.runs[0].revision);assert.deepEqual(next.context,prior.runs[0].context);
  assert.equal(next.tasks[0].state,'integrated');assert.deepEqual(next.tasks[0].attempts[0].approval,prior.runs[0].tasks[0].attempts[0].approval);
  assert.equal(next.tasks[0].attempts[0].commit,prior.runs[0].tasks[0].attempts[0].commit);assert.equal(next.tasks[1].attempts[0].state,'scope_or_context_error');
  assert.equal(next.validation_history[0].state,'invalidated');assert.deepEqual(next.validation_history[0].attempt.verification,prior.runs[0].validation_history[0].attempt.verification);
  for(const [file,expected]of bytes)assert.deepEqual(fs.readFileSync(file),expected,file);
});

test('migration converts committed preparation records and refuses unresolved preparation',async t=>{
  const f=await legacy(t),id=f.args.request_id,folder=path.join(f.data,'submissions',id);fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,'manifest.json'),manifest={protocol:1,request_id:id,request_hash:f.legacyState.requests[id].hash,run_id:f.legacyState.runs[0].id,phase:'registered',owned:[]};
  fs.writeFileSync(file,JSON.stringify(manifest));await migrate(f.data,{apply:true,legacy:f.engine.options});
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),{...manifest,protocol:2});
  const unresolved=await legacy(t),bad=path.join(unresolved.data,'submissions','unresolved');fs.mkdirSync(bad,{recursive:true});fs.writeFileSync(path.join(bad,'manifest.json'),JSON.stringify({protocol:1,request_id:'unresolved'}));
  await assert.rejects(()=>migrate(unresolved.data,{apply:true}),e=>e.code==='UPDATE_PENDING');assert.equal(JSON.parse(fs.readFileSync(path.join(unresolved.data,'state.json'))).protocol,1);
});

test('migration rejects a corrupt committed journal and Store rejects mixed storage formats',async t=>{
  const f=await legacy(t),journal=path.join(f.data,'journal.jsonl');
  fs.writeFileSync(journal,`${JSON.stringify({hash:'corrupt',state:f.legacyState})}\n`);
  await assert.rejects(()=>migrate(f.data,{apply:true}),e=>e.code==='JOURNAL_CORRUPT');
  fs.writeFileSync(journal,`${JSON.stringify({hash:digest(f.legacyState),state:f.legacyState})}\n`);await migrate(f.data,{apply:true,legacy:f.engine.options});
  fs.appendFileSync(journal,`${JSON.stringify({hash:digest(f.legacyState),state:f.legacyState})}\n`);assert.throws(()=>new Store(f.data),e=>e.code==='UPDATE_PENDING');
});

test('migration blocks an unreferenced diagnostic launch with uncertain ownership',async t=>{
  const f=await legacy(t),job=path.join(f.data,'diagnostics','old-doctor');fs.mkdirSync(job,{recursive:true});fs.writeFileSync(path.join(job,'server-intent.json'),JSON.stringify({at:Date.now()}));
  const before=fs.readFileSync(path.join(f.data,'state.json'));await assert.rejects(()=>migrate(f.data,{apply:true}),e=>e.code==='UPDATE_PENDING');assert.deepEqual(fs.readFileSync(path.join(f.data,'state.json')),before);
});

test('migration resume and rollback recheck processes created after interruption',async t=>{
  const f=await legacy(t);await assert.rejects(()=>migrate(f.data,{apply:true,legacy:f.engine.options,onPhase:phase=>{if(phase==='written:state.json')throw new Error('interruption');}}));
  const job=path.join(f.data,'diagnostics','later-process');fs.mkdirSync(job,{recursive:true});fs.writeFileSync(path.join(job,'worker.json'),JSON.stringify({protocol:1,phase:'doctor',host:await processIdentity(process.pid)}));
  for(const options of [{apply:true},{rollback:true}])await assert.rejects(()=>migrate(f.data,options),e=>e.code==='UPDATE_PENDING');
  assert.ok(fs.existsSync(path.join(f.data,'migration.json')));fs.rmSync(job,{recursive:true});await migrate(f.data,{apply:true});assert.equal(new Store(f.data).state.protocol,2);
});
