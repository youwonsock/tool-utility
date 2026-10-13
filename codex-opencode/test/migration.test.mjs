import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, Engine, migrate, digest } from '../dist/index.mjs';
import { fixture,task,submit,cli } from './helpers.mjs';

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
