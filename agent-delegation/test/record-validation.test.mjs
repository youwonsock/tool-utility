import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, Engine, digest, hash, uid, writeJson, processIdentity, processEvidence, stopOwned, confirmedStopped } from '../dist/index.mjs';
import { cli, temporaryRoot } from './helpers.mjs';

function directory(t) {
  const root=fs.mkdtempSync(path.join(temporaryRoot,'current-records-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
function context(root,state={}) {return {spec:{job_dir:root},state,save:()=>assert.fail('uncertain process evidence must not rewrite the snapshot')};}
function intent(root,{record,id=uid('process')}={}) {
  writeJson(path.join(root,'process-intents',`${id}.json`),{id,at:Date.now()});
  if(record)writeJson(path.join(root,'process-records',`${id}.json`),record);return id;
}
const dead={pid:99999999,birth:'owned fixture stopped'};

test('process ownership uses only the launch ledger and permits a job that never launched',async t=>{
  const root=directory(t),ctx=context(root);
  assert.deepEqual(processEvidence(root,ctx.state),{identities:[],uncertain:false,ledger:false});
  assert.equal(await stopOwned(ctx),true);assert.equal(await confirmedStopped(ctx.spec,ctx.state),true);
  intent(root,{record:{identity:dead,stopped:true}});
  assert.equal(processEvidence(root,ctx.state).uncertain,false);
  assert.equal(await stopOwned(ctx),true);assert.equal(await confirmedStopped(ctx.spec,ctx.state),true);
  intent(root,{record:{failed:true,stopped:true}});
  assert.equal(await stopOwned(ctx),true);assert.equal(await confirmedStopped(ctx.spec,ctx.state),true);
});

for(const scenario of ['missing ledger','empty ledger','orphan record','unknown intent','unregistered intent','invalid identity','failed record with identity'])test(`process ${scenario} stays uncertain without terminating from snapshot pointers`,async t=>{
  const root=directory(t),live=await processIdentity(process.pid),state={stopped:true},ctx=context(root,state);
  if(scenario==='missing ledger')state.server=live;
  if(scenario==='empty ledger'){fs.mkdirSync(path.join(root,'process-intents'));state.processes=[live];}
  if(scenario==='orphan record')writeJson(path.join(root,'process-records',`${uid('process')}.json`),{identity:live,stopped:true});
  if(scenario==='unknown intent')writeJson(path.join(root,'process-intents','unknown.json'),{id:'unknown'});
  if(scenario==='unregistered intent')intent(root);
  if(scenario==='invalid identity')intent(root,{record:{identity:{pid:0,birth:''},stopped:true}});
  if(scenario==='failed record with identity')intent(root,{record:{identity:live,stopped:true,failed:true}});
  assert.equal(processEvidence(root,state).uncertain,true);
  assert.equal(await stopOwned(ctx),false);assert.equal(await confirmedStopped(ctx.spec,state),false);
  assert.equal(state.stopped,true);
});

for(const protocol of [3,4])test(`monolithic format-${protocol} run archives are rejected without conversion`,async t=>{
  const root=directory(t),store=new Store(root),id='archived',run={id,repo:root,common_dir:path.join(root,'.git'),branch:'main',base:'base',integration_branch:`codex/${id}`,integration_dir:path.join(root,'worktrees',id),integration_commit:'base',state:'cancelled',revision:1,created:0,ended_at:1,tasks:[],context:[],worker:{platform:'codex',profile:'codex-default',executable:process.execPath,executable_args:[],baseline:'test',config_hash:'test'},resources:[],final_verification:[],settings:{concurrency:1,timeout_ms:1000,max_retries:0}},value={protocol,run,events:[]},hash=digest(value),file=`archives/runs/${digest(id)}/${hash}.json`;
  writeJson(path.join(root,file),value);const original=fs.readFileSync(path.join(root,file));
  store.state.archived_runs[id]={file,hash,archived_at:0,summary:{run_id:id,repo:'repo',branch:'main',state:'cancelled',revision:1,tasks:0,created:0,event_cursor:0}};store.save();
  assert.throws(()=>store.run(id),error=>error.code==='STATE_CORRUPT');
  assert.throws(()=>store.events(id),error=>error.code==='STATE_CORRUPT');
  await assert.rejects(store.runAsync(id),error=>error.code==='STATE_CORRUPT');
  await assert.rejects(store.getRunPageAsync(id),error=>error.code==='STATE_CORRUPT');
  assert.throws(()=>store.event(id,'cleanup',{}),error=>error.code==='STATE_CORRUPT');
  assert.deepEqual(fs.readFileSync(path.join(root,file)),original);await store.close();
});

for(const protocol of [undefined,2,3,99])test(`submission preparation format ${protocol} is preserved and rejected before recovery`,async t=>{
  const root=directory(t),store=new Store(root),requestID=uid('request'),manifest=path.join(root,'submissions',requestID,'manifest.json');
  store.state.requests[requestID]={hash:'request-hash',status:'intent'};store.save();
  const runID=uid('run'),file=`runs/${runID}/a.json`,prepared='prepared metadata';
  fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),prepared);
  writeJson(manifest,{protocol,request_id:requestID,request_hash:'request-hash',run_id:runID,repo:root,base:'base',new_run:false,integration_dir:path.join(root,'worktrees',runID,'integration'),integration_branch:`codex/agent-delegation-${runID}`,files:[{path:file,hash:hash(prepared)}],result:{run_id:runID,revision:1,tasks:['a']}});
  const original=fs.readFileSync(manifest),journal=fs.readFileSync(path.join(root,'journal.jsonl'));
  const engine=new Engine(store,cli,{concurrency:1});
  await assert.rejects(engine.recoverPreparations(),error=>error.code==='STATE_CORRUPT');
  assert.deepEqual(fs.readFileSync(manifest),original);assert.deepEqual(fs.readFileSync(path.join(root,'journal.jsonl')),journal);
  assert.equal(store.state.requests[requestID].status,'intent');assert.equal(store.state.runs.length,0);assert.equal(fs.readFileSync(path.join(root,file),'utf8'),prepared);await store.close();
});
