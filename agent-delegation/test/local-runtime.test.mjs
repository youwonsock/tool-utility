import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as api from '../dist/index.mjs';
import { fixture, task, submit, callOk, review, cli } from './helpers.mjs';
import { mockProfiles, selection } from './native-helpers.mjs';
import { configFixture, decodeInlineToml, sentinel, inputSentinel } from './codex-toml-fixture.mjs';
const {uid}=api;

test('missing external SDK returns actionable doctor diagnostics without registering work', async t => {
  const f=await fixture(t);f.engine.stop();
  const profiles=JSON.parse(fs.readFileSync(path.join(f.data,'profiles.json')));
  profiles.profiles['opencode-default'].sdk_root=path.join(f.dir,'missing-sdk');
  fs.writeFileSync(path.join(f.data,'profiles.json'),JSON.stringify(profiles));
  const diagnostic=await f.engine.doctor({worker:{platform:'opencode'}});
  assert.equal(diagnostic.compatible,false);
  assert.equal(diagnostic.connection.code,'SDK_NOT_FOUND');
  assert.match(diagnostic.connection.details.guidance,/SDK_ROOT|sdk_root/);
  const result=await f.call('submit_tasks',{request_id:uid('missing'),repo:f.repo,tasks:[task('a')]});
  assert.equal(result.error.code,'SDK_NOT_FOUND');
  assert.equal(f.store.state.runs.length,0);
  assert.equal(fs.existsSync(path.join(f.data,'worktrees')),false);
});

test('Codex-only overrides do not require the unused OpenCode default SDK', async t => {
  const f=await fixture(t);f.engine.stop();mockProfiles(f);
  const profiles=JSON.parse(fs.readFileSync(path.join(f.data,'profiles.json')));
  profiles.profiles['opencode-default'].sdk_root=path.join(f.dir,'missing-sdk');
  fs.writeFileSync(path.join(f.data,'profiles.json'),JSON.stringify(profiles));
  const result=await submit(f,[task('a',{}, {worker:selection('codex')})]);
  assert.equal(f.engine.getRun(result.run_id).tasks[0].worker.platform,'codex');
});

test('runtime resolver uses explicit SDK roots and detects changed entrypoints without loading them', async t => {
  const f=await fixture(t);f.engine.stop();
  assert.equal(typeof api.resolveRuntime,'function');
  const root=path.join(f.dir,'external-sdk');fs.mkdirSync(root);
  const marker=path.join(f.dir,'imported');
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@opencode-ai/sdk',version:'999.0.0',type:'module',exports:{'./v2/client':{types:'./missing.d.ts',import:'./client.mjs'}}}));
  fs.writeFileSync(path.join(root,'client.mjs'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'imported');export const createOpencodeClient=()=>({});`);
  const worker={...api.resolveWorker(f.data),sdk_root:root};
  const runtime=await api.resolveRuntime(worker,{global_root:null});
  assert.equal(runtime.sdk.version,'999.0.0');assert.equal(fs.existsSync(marker),false);
  fs.appendFileSync(path.join(root,'client.mjs'),'\n// changed\n');
  await assert.rejects(()=>api.assertRuntimeUnchanged(worker,runtime),error=>error.code==='RUNTIME_CHANGED');
});

test('CLI missing is detected before creating submission artifacts', async t => {
  const f=await fixture(t);f.engine.stop();mockProfiles(f);
  const profiles=JSON.parse(fs.readFileSync(path.join(f.data,'profiles.json')));
  profiles.profiles['mock-codex'].executable=path.join(f.dir,'missing-cli');
  fs.writeFileSync(path.join(f.data,'profiles.json'),JSON.stringify(profiles));
  const result=await f.call('submit_tasks',{request_id:uid('missing'),repo:f.repo,tasks:[task('a',{}, {worker:selection('codex')})]});
  assert.equal(result.error.code,'CLI_NOT_FOUND');assert.equal(f.store.state.runs.length,0);
  assert.equal(fs.existsSync(path.join(f.data,'worktrees')),false);
});

async function advance(f,predicate){
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){await f.engine.tick();if(predicate())return;await api.sleep(75);}
  assert.fail('Explicit scheduler ticks did not reach the expected process/task state.');
}

test('SDK changes between submission and launch are rejected without a model request',async t=>{
  const f=await fixture(t);f.engine.stop();
  const {run_id}=await submit(f,[task('a',{files:{'a.txt':'wrong'}})]),run=f.engine.getRun(run_id);
  fs.appendFileSync(path.join(f.sdks.opencode,'sdk.mjs'),'\n// replaced after submission\n');
  await f.engine.tick();
  assert.equal(run.tasks[0].state,'needs_review');
  const a=run.tasks[0].attempts[0];assert.match(a.error,/RUNTIME_CHANGED/);
  assert.equal(fs.existsSync(path.join(a.job_dir,'prompt.txt')),false);
  assert.equal(api.holdsResources(a),false);
});

test('SDK API initialization failures do not consume the model correction limit',async t=>{
  const f=await fixture(t);f.engine.stop();
  const file=path.join(f.sdks.opencode,'sdk.mjs'),original=fs.readFileSync(file);
  fs.writeFileSync(file,'export const createOpencodeClient=()=>({});\n');
  const {run_id}=await submit(f,[task('a',{files:{'a.txt':'success'}})],{settings:{max_retries:0}}),run=f.engine.getRun(run_id);
  await advance(f,()=>run.tasks[0].state==='needs_review');
  const first=run.tasks[0].attempts[0];assert.equal(first.worker.error_code,'SDK_INCOMPATIBLE');
  assert.equal(first.worker.prompt_intent,undefined);assert.equal(first.worker.stopped,true);
  fs.writeFileSync(file,original);
  await review(f,run,'a','request_changes','Use the now configured SDK and implement the original task.');
  await advance(f,()=>run.tasks[0].attempts.length===2&&run.tasks[0].state==='needs_review');
  const second=run.tasks[0].attempts[1];assert.ok(second.commit);assert.ok(second.worker.prompt_intent);
  const denied=await f.call('review_task',{request_id:uid('limit'),run_id,task_id:'a',attempt_id:second.id,commit:second.commit,decision:'request_changes',feedback:'Another model attempt'});
  assert.equal(denied.error.code,'RETRY_LIMIT');
  await review(f,run,'a');
  fs.rmSync(f.sdks.opencode,{recursive:true});
  await callOk(f,'validate_run',{request_id:uid('validate'),run_id});
  await advance(f,()=>run.state==='waiting_final_review');
  assert.equal(run.validation.state,'passed');
});

test('SDK removal during an owned session preserves locks and cancellation after restart',async t=>{
  const f=await fixture(t);f.engine.stop();
  const gate=path.join(f.dir,'gate'),audit=path.join(f.dir,'audit');
  const saved=process.env.FAKE_AUDIT;process.env.FAKE_AUDIT=audit;
  t.after(()=>{if(saved===undefined)delete process.env.FAKE_AUDIT;else process.env.FAKE_AUDIT=saved;});
  const {run_id}=await submit(f,[task('a',{files:{'a.txt':'a'},wait_file:gate})]),run=f.engine.getRun(run_id);
  await advance(f,()=>run.tasks[0].attempts[0]?.worker?.prompt_intent);
  fs.rmSync(f.sdks.opencode,{recursive:true});
  const store=new api.Store(f.data),engine=new api.Engine(store,cli,{concurrency:2}),restored=store.state.runs[0],a=restored.tasks[0].attempts[0];
  await engine.reconcile(restored);
  assert.equal(a.runtime_error.code,'RUNTIME_CHANGED');assert.equal(api.holdsResources(a),true);
  assert.ok(await api.alive(a.worker.host));
  await engine.cancel(restored);
  await advance({engine},()=>restored.state==='cancelled');
  assert.equal(api.holdsResources(a),false);assert.equal(a.worker.stopped,true);
  const events=fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event=>event.event==='prompt').length,1);
});

test('SDK-free completed records remain reviewable after restart',async t=>{
  const f=await fixture(t);f.engine.stop();
  const {run_id}=await submit(f,[task('a',{files:{'a.txt':'ready'}})]),run=f.engine.getRun(run_id);
  await advance(f,()=>run.tasks[0].state==='needs_review');
  fs.rmSync(f.sdks.opencode,{recursive:true});
  const store=new api.Store(f.data),engine=new api.Engine(store,cli,{concurrency:2});
  const restored=store.state.runs[0],a=restored.tasks[0].attempts[0];
  const response=await engine.call('review_task',{request_id:uid('approve'),run_id,task_id:'a',attempt_id:a.id,commit:a.commit,decision:'approve'});
  assert.equal(response.state,'integrated');
});

test('SDK discovery honors explicit, environment, owned CLI and direct global precedence',async t=>{
  const f=await fixture(t);f.engine.stop();
  const cliRoot=path.join(f.dir,'user-cli'),ownRoot=path.join(cliRoot,'node_modules','@opencode-ai/sdk');
  fs.mkdirSync(cliRoot);fs.writeFileSync(path.join(cliRoot,'package.json'),JSON.stringify({name:'opencode-ai'}));
  const script=path.join(cliRoot,'cli.mjs');fs.writeFileSync(script,'// CLI metadata fixture\n');
  // Use JS traversal on Node 22: native cpSync crashes on Unicode Windows paths.
  const copy={recursive:true,mode:fs.constants.COPYFILE_FICLONE,filter:()=>true};
  fs.cpSync(f.sdks.opencode,ownRoot,copy);
  const global=path.join(f.dir,'global'),globalSdk=path.join(global,'@opencode-ai/sdk');fs.cpSync(f.sdks.opencode,globalSdk,copy);
  const worker={...api.resolveWorker(f.data),executable_args:[script]};delete worker.sdk_root;
  const env={...process.env,AGENT_DELEGATION_OPENCODE_SDK_ROOT:f.sdks.opencode};
  let runtime=await api.resolveRuntime(worker,{env,global_root:global});assert.equal(runtime.sdk.source,'environment');
  runtime=await api.resolveRuntime({...worker,sdk_root:ownRoot},{env,global_root:global});assert.equal(runtime.sdk.root,fs.realpathSync.native(ownRoot));
  await assert.rejects(()=>api.resolveRuntime({...worker,sdk_root:path.join(f.dir,'absent')},{env,global_root:global}),e=>e.code==='SDK_NOT_FOUND');
  delete env.AGENT_DELEGATION_OPENCODE_SDK_ROOT;
  runtime=await api.resolveRuntime(worker,{env,global_root:global});assert.equal(runtime.sdk.source,'cli');
  fs.rmSync(ownRoot,{recursive:true});
  runtime=await api.resolveRuntime(worker,{env,global_root:global});assert.equal(runtime.sdk.source,'global');
  fs.writeFileSync(path.join(globalSdk,'package.json'),JSON.stringify({name:'wrong-package',version:'1'}));
  await assert.rejects(()=>api.resolveRuntime(worker,{env,global_root:global}),e=>e.code==='SDK_INCOMPATIBLE');
});

test('absolute CLI and SDK paths work without npm and preserve SDK symlink identity',async t=>{
  const f=await fixture(t);f.engine.stop();
  const alias=path.join(f.dir,'SDK alias');fs.symlinkSync(f.sdks.opencode,alias,process.platform==='win32'?'junction':'dir');
  const worker={...api.resolveWorker(f.data),sdk_root:alias};
  const runtime=await api.resolveRuntime(worker,{env:{PATH:''},global_root:null});
  assert.equal(runtime.sdk.root,fs.realpathSync.native(f.sdks.opencode));
  fs.writeFileSync(path.join(f.sdks.opencode,'implementation.mjs'),'export const newApi=1;\n');
  await assert.rejects(()=>api.assertRuntimeUnchanged(worker,runtime),e=>e.code==='RUNTIME_CHANGED');
});

test('doctor loads SDK code only in its isolated owned process',async t=>{
  const f=await fixture(t);f.engine.stop();
  const marker=path.join(f.dir,'SDK-process'),file=path.join(f.sdks.opencode,'sdk.mjs');
  fs.writeFileSync(file,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\n`+fs.readFileSync(file,'utf8'));
  const diagnostic=await f.engine.doctor({repo:f.repo});assert.equal(diagnostic.compatible,true,JSON.stringify(diagnostic));
  assert.notEqual(Number(fs.readFileSync(marker,'utf8')),process.pid);
});

test('SDK constructor API failures are actionable and stop the owned native process',async t=>{
  const f=await fixture(t);f.engine.stop();
  fs.writeFileSync(path.join(f.sdks.opencode,'sdk.mjs'),'export function createOpencodeClient(){throw new TypeError("Changed SDK constructor API");}\n');
  const diagnostic=await f.engine.doctor({repo:f.repo});
  assert.equal(diagnostic.compatible,false);assert.equal(diagnostic.connection.code,'SDK_INCOMPATIBLE');
  assert.match(diagnostic.connection.details.guidance,/sdk_root/);assert.match(diagnostic.connection.error,/constructor API/);
  const folders=fs.readdirSync(path.join(f.data,'diagnostics'));
  const state=JSON.parse(fs.readFileSync(path.join(f.data,'diagnostics',folders[0],'worker.json')));
  assert.equal(state.stopped,true);assert.equal(state.prompt_intent,undefined);
});

function assertDiagnosticReceipt(f,diagnostic,executable) {
  assert.equal(diagnostic.compatible,true,JSON.stringify(diagnostic));assert.equal(diagnostic.runtime.cli.path,executable);
  assert.equal(Object.values(f.store.state.operations).filter(operation=>operation.kind==='doctor').length,0);
  const jobs=fs.readdirSync(path.join(f.data,'diagnostics'));assert.equal(jobs.length,1);
  const directory=path.join(f.data,'diagnostics',jobs[0]),spec=JSON.parse(fs.readFileSync(path.join(directory,'spec.json')));
  const receipt=JSON.parse(fs.readFileSync(path.join(directory,'diagnostic.json'))),worker=JSON.parse(fs.readFileSync(path.join(directory,'worker.json')));
  assert.equal(spec.id,jobs[0]);assert.equal(spec.worker.executable,executable);assert.equal(receipt.healthy,true);
  assert.equal(worker.phase,'completed');assert.equal(worker.stopped,true);assert.equal(worker.prompt_intent,undefined);
}
test('owned Codex diagnosis awaits one final receipt and retires its operation without a model request',async t=>{
  const f=await fixture(t);f.engine.stop();mockProfiles(f);
  const diagnostic=await f.engine.diagnose({repo:f.repo,worker:selection('codex')});
  assertDiagnosticReceipt(f,diagnostic,process.execPath);
});
test('Windows cmd wrappers preserve the selected executable',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);f.engine.stop();
  const command=path.join(f.dir,'wrapper.cmd');fs.writeFileSync(command,`@"${process.execPath}" "${path.resolve('test/fake-codex.mjs')}" %*\r\n`);
  const profiles=JSON.parse(fs.readFileSync(path.join(f.data,'profiles.json')));profiles.profiles.wrapper={platform:'codex',executable:command};fs.writeFileSync(path.join(f.data,'profiles.json'),JSON.stringify(profiles));
  // This test owns one diagnostic through process cleanup. The MCP doctor's
  // bounded DIAGNOSTIC_PENDING envelope is progress, not a compatibility result.
  const diagnostic=await f.engine.diagnose({repo:f.repo,worker:{platform:'codex',profile:'wrapper'}});
  assertDiagnosticReceipt(f,diagnostic,command);
});
test('Windows custom.cmd arguments retain exact Codex TOML keys and values without redirection',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);f.engine.stop();const receiver=path.join(f.dir,'argv.mjs'),command=path.join(f.dir,'arguments.cmd');
  fs.writeFileSync(receiver,'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  fs.writeFileSync(command,'@setlocal EnableDelayedExpansion\r\n@"%AGENT_DELEGATION_TEST_NODE%" "%AGENT_DELEGATION_TEST_RECEIVER%" %*\r\n');
  const args=['-c',`hooks=${api.codexToml(configFixture)}`],result=await api.exec(command,args,{cwd:f.repo,timeout:10000,env:{...process.env,
    AGENT_DELEGATION_TEST_NODE:process.execPath,AGENT_DELEGATION_TEST_RECEIVER:receiver,AGENT_DELEGATION_CMD_SENTINEL:'UNEXPECTED-ENV-EXPANSION'}});
  assert.equal(result.code,0,result.stderr);const observed=JSON.parse(result.stdout);
  assert.deepEqual(observed,args);assert.deepEqual(decodeInlineToml(observed[1].slice('hooks='.length)),configFixture);
  assert.equal(result.stdout.includes('UNEXPECTED-ENV-EXPANSION'),false,'A literal config key/value expanded a CMD environment variable.');
  assert.equal(fs.existsSync(path.join(f.repo,sentinel)),false,'A literal config value was interpreted as CMD redirection.');
  assert.equal(fs.existsSync(path.join(f.repo,inputSentinel)),false);
});
