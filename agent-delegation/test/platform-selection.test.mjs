import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { schemas } from '../dist/index.mjs';
import { fixture, task, submit, callOk } from './helpers.mjs';

test('worker selection accepts four platforms and retains the OpenCode default', () => {
  for (const platform of ['opencode','codex','claude-code','kilo']) {
    const model = ['opencode','kilo'].includes(platform) ? {providerID:'test',modelID:'test'} : 'test';
    const input = schemas.submit_tasks.parse({request_id:'selection',tasks:[task('a')],worker:{platform,model}});
    assert.equal(input.worker.platform,platform);
    assert.deepEqual(input.worker.model,model);
  }
  const defaults=schemas.submit_tasks.parse({request_id:'default',tasks:[task('a')]});
  assert.equal(defaults.worker,undefined);
  assert.equal(defaults.tasks[0].worker,undefined);
});

test('worker selection rejects wrong model shapes and unknown platforms', () => {
  for (const worker of [{platform:'unknown'},{platform:'codex',model:{providerID:'x',modelID:'y'}},{platform:'kilo',model:'x'}]) {
    assert.throws(()=>schemas.submit_tasks.parse({request_id:'bad',tasks:[task('a')],worker}));
  }
});

test('registered worker selection is frozen and append cannot change the run default',async t=>{
  const f=await fixture(t);f.engine.stop();
  const s=await submit(f,[task('a')],{worker:{platform:'opencode'}});
  const run=f.engine.getRun(s.run_id);
  assert.equal(run.worker.platform,'opencode');
  assert.equal(run.tasks[0].worker.platform,'opencode');
  const change=await f.call('submit_tasks',{request_id:'change-default',run_id:run.id,worker:{platform:'codex'},tasks:[task('b')]});
  assert.equal(change.error.code,'RUN_CONFIG');
  assert.equal(run.tasks.length,1);
  await callOk(f,'submit_tasks',{request_id:'append-default',run_id:run.id,tasks:[task('b')]});
  assert.deepEqual(run.tasks[1].worker,run.tasks[0].worker);
});

test('unknown execution profiles fail preflight without registering a task set',async t=>{
  const f=await fixture(t);f.engine.stop();
  const result=await f.call('submit_tasks',{request_id:'unknown-profile',repo:f.repo,tasks:[task('a')],worker:{platform:'opencode',profile:'missing-profile'}});
  assert.equal(result.error.code,'WORKER_PROFILE');
  assert.equal(f.store.state.runs.length,0);
});

test('invalid unused resources fail complete submission preflight without partial registration',async t=>{
  const f=await fixture(t);f.engine.stop();
  const result=await f.call('submit_tasks',{request_id:'unused-invalid-resource',repo:f.repo,tasks:[task('a')],resources:[{resource_key:'unused',connection:{name:'editor',config:{type:'unsupported'}},probe:{executable:process.execPath,args:[],read_only:true},expected_instance:'editor'}]});
  assert.equal(result.error.code,'MCP_POLICY');assert.equal(f.store.state.runs.length,0);assert.equal(fs.existsSync(path.join(f.data,'worktrees')),false);
});
