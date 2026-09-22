import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { uid, writeJson, bootId, terminate, sleep, Store, remoteCall, connect, alive } from '../dist/index.mjs';
import { fixture,task,submit,until,review,ready,git,callOk,cli,fake,readState } from './helpers.mjs';

test('source edits during final verification invalidate it',async t=>{
  const f=await fixture(t); const s=await submit(f,[task('a',{files:{'a.txt':'a'}})],{final_verification:[{command:'node -e "require(\'fs\').writeFileSync(\'base.txt\',\'modified\')"'}]});
  const r=await until(f,s.run_id,r=>r.tasks[0].state==='needs_review');await review(f,r,'a');await callOk(f,'validate_run',{request_id:uid('r'),run_id:r.id});
  await until(f,r.id,r=>r.validation.state==='failed');assert.equal(r.state,'active');assert.equal(await git(f.repo,'rev-parse','HEAD'),r.base);
});
test('a target commit added after validation is preserved and blocks finalization',async t=>{
  const f=await fixture(t);const s=await submit(f,[task('a',{files:{'a.txt':'a'}})]);const r=await until(f,s.run_id,r=>r.tasks[0].state==='needs_review');await ready(f,r);
  fs.writeFileSync(path.join(f.repo,'user.txt'),'outside change');await git(f.repo,'add','user.txt');await git(f.repo,'commit','-m','user work');const target=await git(f.repo,'rev-parse','HEAD');
  const out=await f.call('finalize_run',{request_id:uid('r'),run_id:r.id,validation_id:r.validation.id,commit:r.validation.commit,revision:r.revision});assert.equal(out.error.code,'TARGET_HEAD_CHANGED');assert.equal(await git(f.repo,'rev-parse','HEAD'),target);
});
test('result commit written before service failure is recovered as the same immutable commit',async t=>{
  const f=await fixture(t);const s=await submit(f,[task('a',{files:{'a.txt':'a'}})]);const r=await until(f,s.run_id,r=>r.tasks[0].state==='needs_review');const a=r.tasks[0].attempts[0],commit=a.commit;
  // Recreate the durable state immediately before recording the Git commit result.
  a.commit=undefined;a.state='running';a.commit_intent=true;r.tasks[0].state='running';f.store.save();await f.engine.serial(()=>f.engine.collect(r));
  assert.equal(a.commit,commit);assert.equal(a.state,'needs_review');
});
test('unknown launch holds leases; proven reboot interrupts without dispatch',async t=>{
  const f=await fixture(t);const s=await submit(f,[task('a',{files:{'a.txt':'a'}})]);const r=await until(f,s.run_id,r=>r.tasks[0].state==='needs_review');const a=r.tasks[0].attempts[0];
  const savedJob=a.job_dir;a.job_dir=path.join(f.dir,'unknown-job');fs.mkdirSync(a.job_dir);a.state='orphaned';a.worker=undefined;r.tasks[0].state='running';a.launch_boot=await bootId();
  await f.engine.reconcile(r);assert.equal(a.state,'orphaned');
  const denied=await f.call('review_task',{request_id:uid('r'),run_id:r.id,task_id:'a',attempt_id:a.id,commit:a.commit,decision:'request_changes',feedback:'Retry safely'});assert.equal(denied.error.code,'ATTEMPT');
  a.launch_boot='previous-boot';await f.engine.reconcile(r);assert.equal(a.state,'interrupted');assert.equal(r.tasks[0].attempts.length,1);a.job_dir=savedJob;
});
test('service restart during cancellation confirms stop and does not dispatch a replacement',async t=>{
  const f=await fixture(t,{service:true}),audit=path.join(f.dir,'audit.jsonl'),saved={...process.env};Object.assign(process.env,f.env,{FAKE_AUDIT:audit});
  t.after(async()=>{try{await remoteCall(f.data,cli,'',{},'/stop');}catch{}for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);});
  const s=await remoteCall(f.data,cli,'submit_tasks',{request_id:'cancel-case',repo:f.repo,tasks:[task('a',{delay:60000})]});
  let r;for(let i=0;i<150;i++){r=readState(f.data).runs[0];if(r?.tasks[0].attempts[0]?.worker?.prompt_intent)break;await sleep(100);}assert.ok(r.tasks[0].attempts[0].worker.prompt_intent);
  const cancel=await remoteCall(f.data,cli,'cancel_run',{request_id:'stop-request',run_id:s.run_id});assert.ok(['cancelling','cancelled'].includes(cancel.state));
  const descriptor=JSON.parse(fs.readFileSync(path.join(f.data,'service.json')));await terminate(descriptor.owner,false);await connect(f.data,cli);
  // Windows process-tree termination and CIM ownership checks can exceed 15 s
  // on hosted runners. Await the terminal state, then verify the actual server.
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){r=readState(f.data).runs[0];if(r.state==='cancelled')break;await sleep(100);}assert.equal(r.state,'cancelled');
  const stopped=r.tasks[0].attempts[0].worker;assert.equal(stopped.stopped,true);assert.equal(await alive(stopped.server),false);
  const events=fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse);assert.equal(events.filter(e=>e.event==='prompt').length,1);assert.equal(r.tasks[0].attempts.length,1);
});
