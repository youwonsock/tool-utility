import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { platforms } from '../dist/index.mjs';
import { fixture,task,submit,until,review,ready,finalize,callOk } from './helpers.mjs';
import { mockProfiles,selection } from './native-helpers.mjs';
for(const platform of platforms) {
  test(`${platform} worker implements, answers a question, verifies, integrates and finalizes`,async t=>{
    const f=await fixture(t);mockProfiles(f);
    const s=await submit(f,[task('a',{files:{'a.txt':platform},input:'question'})],{worker:selection(platform)});
    let run=await until(f,s.run_id,r=>r.tasks[0].attempts[0]?.inputs.length);
    const a=run.tasks[0].attempts[0];assert.equal(a.worker.backend,platform);
    const invalid=await f.call('respond_to_request',{request_id:`invalid-${platform}`,run_id:run.id,attempt_id:a.id,input_id:a.inputs[0].id,decision:'answer',answers:[]});assert.equal(invalid.error.code,'INPUT');
    await callOk(f,'respond_to_request',{request_id:`answer-${platform}`,run_id:run.id,attempt_id:a.id,input_id:a.inputs[0].id,decision:'answer',answers:[['Proceed']]});
    run=await until(f,run.id,r=>r.tasks[0].state==='needs_review');
    assert.equal(a.verification[0].exit_code,0);assert.equal(a.worker.stopped,true);
    await ready(f,run);assert.equal(run.validation.attempt.worker.backend,undefined);assert.equal(run.validation.attempt.worker.session_id,undefined);
    assert.equal((await finalize(f,run)).state,'completed');assert.equal(fs.readFileSync(path.join(f.repo,'a.txt'),'utf8'),platform);
  });
}
