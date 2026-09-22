import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, uid, sleep, digest, writeJson, processIdentity } from '../dist/index.mjs';
import { fixture, task, submit, until, review, ready, finalize, git, callOk } from './helpers.mjs';

test('parallel implementation, ignored context, correction, exact approval and final fast-forward', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.repo,'AGENTS.md'),'Read .specs/spec.md\n'); fs.mkdirSync(path.join(f.repo,'.specs')); fs.writeFileSync(path.join(f.repo,'.specs/spec.md'),'the rules');
  const started = await submit(f,[task('a',{ files:{'a.txt':'first'}, require_context:{'AGENTS.md':'Read .specs/spec.md\n','.specs/spec.md':'the rules'}, delay:500 },{ context_files:['AGENTS.md','.specs/spec.md'] }),task('b',{ files:{'b.txt':'parallel'}, delay:500 })]);
  let run = await until(f,started.run_id,r=>r.tasks.every(t=>t.state==='needs_review'));
  assert.equal(run.tasks[0].attempts[0].verification[0].status,'passed');
  const first = run.tasks[0].attempts[0]; assert.ok(first.commit);
  assert.ok(! (await git(first.directory,'ls-tree','-r','--name-only','HEAD')).includes('AGENTS.md'));
  assert.equal(await git(f.repo,'rev-parse','HEAD'),run.base);
  await review(f,run,'a','request_changes','FAKE_ACTION:{"files":{"a.txt":"corrected"}}');
  run = await until(f,run.id,r=>r.tasks[0].attempts.length===2 && r.tasks[0].state==='needs_review');
  const stale = await f.call('review_task',{request_id:uid('r'),run_id:run.id,task_id:'a',attempt_id:first.id,commit:first.commit,decision:'approve'}); assert.equal(stale.error.code,'ATTEMPT');
  await ready(f,run); const result = await finalize(f,run);
  assert.equal(result.state,'completed'); assert.equal(fs.readFileSync(path.join(f.repo,'a.txt'),'utf8'),'corrected');
  assert.equal(fs.readFileSync(path.join(f.repo,'b.txt'),'utf8'),'parallel'); assert.equal(await git(f.repo,'status','--porcelain'),'');
});

test('idempotency, conflicting request IDs, dependency gating and delta cursors',async t=>{
  const f=await fixture(t); const args={request_id:'fixed',repo:f.repo,tasks:[task('a',{files:{'a.txt':'a'}}),task('b',{files:{'b.txt':'b'}},{dependencies:['a']})]};
  const one=await callOk(f,'submit_tasks',args), two=await callOk(f,'submit_tasks',args); assert.deepEqual(one,two);
  await assert.rejects(f.call('submit_tasks',{...args,tasks:[task('z')]}),/different content/);
  const run=await until(f,one.run_id,r=>r.tasks[0].state==='needs_review'); assert.equal(run.tasks[1].attempts.length,0);
  await review(f,run,'a'); await until(f,run.id,r=>r.tasks[1].state==='needs_review');
  const events=await f.call('wait_run',{run_id:run.id,after:0,timeout_ms:0}); assert.ok(events.items.length);
  let cursor=events.after, next;
  do { next=await f.call('wait_run',{run_id:run.id,after:cursor,timeout_ms:0}); cursor=next.after; } while(next.items.length);
  assert.deepEqual(next.items,[]);
});

test('model claims cannot override failed checks, scope violations or unavailable models',async t=>{
  const f=await fixture(t); const s=await submit(f,[task('a',{files:{'a.txt':'ok'},summary:'All checks passed!'},{verification:[{command:'node -e "process.exit(7)"'}]}),task('b',{files:{'outside.txt':'bad'}})]);
  const r=await until(f,s.run_id,r=>r.tasks.every(t=>t.state==='needs_review'));
  assert.equal(r.tasks[0].attempts[0].verification[0].exit_code,7);
  const a=r.tasks[0].attempts[0]; const out=await f.call('review_task',{request_id:uid('r'),run_id:r.id,task_id:'a',attempt_id:a.id,commit:a.commit,decision:'approve'}); assert.equal(out.error.code,'CHECKS_FAILED');
  assert.equal(r.tasks[1].attempts[0].state,'scope_or_context_error');
  await callOk(f,'submit_tasks',{request_id:uid('r'),run_id:r.id,tasks:[task('c',{}, {model:{providerID:'missing',modelID:'none'}})]});
  await until(f,r.id,r=>r.tasks[2].state==='needs_review'); assert.match(r.tasks[2].attempts[0].error,/unavailable/);
});

test('dropped prompt response is reconciled without a second invocation; input is explicit',async t=>{
  const f=await fixture(t); const s=await submit(f,[task('a',{files:{'a.txt':'one'},drop_response:true}),task('b',{files:{'b.txt':'two'},input:'question'})]);
  const r=await until(f,s.run_id,r=>r.tasks[0].state==='needs_review' && r.tasks[1].attempts[0]?.inputs.length);
  const a=r.tasks[0].attempts[0]; const transcript=a.artifacts.find(p=>p.endsWith('-transcript.json'));
  const messages=JSON.parse(fs.readFileSync(path.join(f.data,'artifacts',transcript))); assert.equal(messages.filter(m=>m.info.role==='user').length,1);
  const b=r.tasks[1].attempts[0]; await callOk(f,'respond_to_request',{request_id:uid('r'),run_id:r.id,attempt_id:b.id,input_id:'req_test',decision:'answer',answers:[['Proceed']]});
  await until(f,r.id,r=>r.tasks[1].state==='needs_review');
});

test('global resource serialization and actual project identity check',async t=>{
  const f=await fixture(t);
  const profile={resource_key:'editor',connection:{name:'editor',config:{type:'remote',url:'http://localhost:59999/mcp'}},probe:{executable:process.execPath,args:['-e','console.log(JSON.stringify({instance_id:"editor-1",project_path:process.cwd()}))'],read_only:true},expected_instance:'editor-1',project_bound:true};
  const one=await submit(f,[task('a',{files:{'a.txt':'a'},delay:1300},{resources:['editor']})],{resources:[profile]});
  const two=await submit(f,[task('b',{files:{'b.txt':'b'},delay:1300},{resources:['editor']})],{resources:[profile]});
  await until(f,one.run_id,r=>r.tasks[0].attempts[0]?.worker?.prompt_intent);
  assert.equal(f.store.state.runs.find(r=>r.id===two.run_id).tasks[0].attempts.length,0);
  await until(f,two.run_id,r=>r.tasks[0].state==='needs_review');
  const bad={...profile,resource_key:'wrong',expected_instance:'other'};
  const three=await submit(f,[task('c',{}, {resources:['wrong']})],{resources:[bad]});
  const r=await until(f,three.run_id,r=>r.tasks[0].state==='needs_review'); assert.match(r.tasks[0].attempts[0].error,/Wrong or unverified/); assert.ok(!r.tasks[0].attempts[0].worker);
  const wrongPath={...profile,resource_key:'wrongpath',probe:{...profile.probe,args:['-e','console.log(JSON.stringify({instance_id:"editor-1",project_path:process.argv[1]}))',f.repo]}};
  const four=await submit(f,[task('d',{}, {resources:['wrongpath']})],{resources:[wrongPath]}); const p=await until(f,four.run_id,r=>r.tasks[0].state==='needs_review'); assert.match(p.tasks[0].attempts[0].error,/must bind/);
});

test('validation freezes tasks, rejects changed source/commands and invalidates on append',async t=>{
  const f=await fixture(t); const s=await submit(f,[task('a',{files:{'a.txt':'a'}})],{final_verification:[{command:'node -e "setTimeout(()=>{},600)"'}]});
  const r=await until(f,s.run_id,r=>r.tasks[0].state==='needs_review'); await review(f,r,'a'); await callOk(f,'validate_run',{request_id:uid('r'),run_id:r.id});
  const blocked=await f.call('submit_tasks',{request_id:uid('r'),run_id:r.id,tasks:[task('b')]}); assert.equal(blocked.error.code,'RUN_FROZEN');
  await until(f,r.id,r=>r.state==='waiting_final_review');
  const old={validation_id:r.validation.id,commit:r.validation.commit,revision:r.revision};
  r.final_verification[0].command='node -e "process.exit(1)"';
  let failed=await f.call('finalize_run',{request_id:uid('r'),run_id:r.id,...old}); assert.equal(failed.error.code,'STALE_VALIDATION');
  r.final_verification[0].command='node -e "setTimeout(()=>{},600)"';
  fs.writeFileSync(path.join(r.validation.attempt.directory,'base.txt'),'changed');
  failed=await f.call('finalize_run',{request_id:uid('r'),run_id:r.id,...old}); assert.equal(failed.error.code,'DIRTY_WORKTREE');
  await callOk(f,'submit_tasks',{request_id:uid('r'),run_id:r.id,tasks:[task('b')]}); assert.equal(r.validation,undefined); assert.ok(r.revision>old.revision);
  failed=await f.call('finalize_run',{request_id:uid('r'),run_id:r.id,...old}); assert.equal(failed.error.code,'VALIDATION_REQUIRED');
});

test('safe finalization preserves ignored collisions, dirty source and changed target branch',async t=>{
  const f=await fixture(t); const s=await submit(f,[task('a',{files:{'new.txt':'result'}},{scope:['new.txt']})]);
  const r=await until(f,s.run_id,r=>r.tasks[0].state==='needs_review'); await ready(f,r);
  fs.writeFileSync(path.join(f.repo,'base.txt'),'user edit');
  let out=await f.call('finalize_run',{request_id:uid('r'),run_id:r.id,validation_id:r.validation.id,commit:r.validation.commit,revision:r.revision}); assert.equal(out.error.code,'DIRTY_WORKTREE'); assert.equal(fs.readFileSync(path.join(f.repo,'base.txt'),'utf8'),'user edit');
  fs.writeFileSync(path.join(f.repo,'base.txt'),'base\n'); await git(f.repo,'switch','-c','user-branch');
  out=await f.call('finalize_run',{request_id:uid('r'),run_id:r.id,validation_id:r.validation.id,commit:r.validation.commit,revision:r.revision}); assert.equal(out.error.code,'TARGET_BRANCH_CHANGED');
  await git(f.repo,'switch','main');
  const exclude=path.join(f.repo,'.git/info/exclude'); fs.appendFileSync(exclude,'\nnew.txt\n'); fs.writeFileSync(path.join(f.repo,'new.txt'),'ignored user data');
  out=await f.call('finalize_run',{request_id:uid('r'),run_id:r.id,validation_id:r.validation.id,commit:r.validation.commit,revision:r.revision}); assert.notEqual(out.state,'completed'); assert.equal(fs.readFileSync(path.join(f.repo,'new.txt'),'utf8'),'ignored user data'); assert.equal(await git(f.repo,'rev-parse','HEAD'),r.base);
});

test('recovery after merge observes the actual HEAD instead of applying twice',async t=>{
  const f=await fixture(t); const s=await submit(f,[task('a',{files:{'a.txt':'a'}})]); const r=await until(f,s.run_id,r=>r.tasks[0].state==='needs_review'); await ready(f,r);
  r.finalize_intent={validation_id:r.validation.id,commit:r.validation.commit,revision:r.revision,started:Date.now()}; r.state='finalizing'; f.store.save();
  await git(f.repo,'merge','--ff-only','--no-overwrite-ignore',r.validation.commit);
  await callOk(f,'reconcile_run',{request_id:uid('r'),run_id:r.id}); assert.equal(r.state,'completed');
  const recovered=new Store(f.data); assert.equal(recovered.state.runs[0].state,'completed');
});

test('integration conflict returns evidence and awaits Codex correction',async t=>{
  const f=await fixture(t); const s=await submit(f,[task('a',{files:{'base.txt':'one'}},{scope:['base.txt']}),task('b',{files:{'base.txt':'two'}},{scope:['base.txt']})]);
  const r=await until(f,s.run_id,r=>r.tasks.every(t=>t.state==='needs_review')); await review(f,r,'a'); const conflict=await review(f,r,'b'); assert.equal(conflict.state,'integration_conflict');
  await review(f,r,'b','request_changes','FAKE_ACTION:{"files":{"base.txt":"resolved"}}');
  await until(f,r.id,r=>r.tasks[1].attempts.length===2&&r.tasks[1].state==='needs_review'); await review(f,r,'b'); assert.equal(r.tasks[1].state,'integrated');
});

test('cancellation confirms termination before releasing resource leases',async t=>{
  const f=await fixture(t); const s=await submit(f,[task('a',{delay:60000})]); const r=await until(f,s.run_id,r=>r.tasks[0].attempts[0]?.worker?.prompt_intent);
  const out=await callOk(f,'cancel_run',{request_id:uid('r'),run_id:r.id}); assert.equal(out.state,'cancelling');
  await until(f,r.id,r=>r.state==='cancelled'); assert.equal(r.tasks[0].attempts[0].worker.stopped,true);
});
