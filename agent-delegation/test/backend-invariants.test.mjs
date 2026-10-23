import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackend, resolveWorker, uid, sleep, connection, restrictions, workerPolicyHash, exec } from '../dist/index.mjs';
import { fixture, cli } from './helpers.mjs';
import { mockProfiles, selection } from './native-helpers.mjs';

async function diagnose(t,platform,args=[]) {
  const f=await fixture(t);f.engine.stop();mockProfiles(f);
  const file=path.join(f.data,'profiles.json'),profiles=JSON.parse(fs.readFileSync(file));
  const audit=path.join(f.dir,'native-audit.jsonl');
  const previous=process.env.AGENT_DELEGATION_TEST_AUDIT;
  process.env.AGENT_DELEGATION_TEST_AUDIT=audit;
  t.after(()=>{if(previous===undefined)delete process.env.AGENT_DELEGATION_TEST_AUDIT;else process.env.AGENT_DELEGATION_TEST_AUDIT=previous;});
  Object.assign(profiles.profiles[`mock-${platform}`],{args:[...profiles.profiles[`mock-${platform}`].args,...args],env_refs:{FAKE_AUDIT:'AGENT_DELEGATION_TEST_AUDIT'}});
  fs.writeFileSync(file,JSON.stringify(profiles));
  const result=await f.engine.doctor({worker:selection(platform),repo:f.repo});
  const events=fs.existsSync(audit)?fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse):[];
  assert.equal(events.filter(e=>e.event==='prompt').length,0);
  return result;
}

for(const [platform,version]of Object.entries({opencode:'1.19.0',codex:'0.162.1','claude-code':'2.1.300',kilo:'7.4.24'})) {
  test(`${platform} accepts an installed CLI with matching APIs and a different version`,async t=>{
    const result=await diagnose(t,platform,[`--native-version=${version}`,...(platform==='codex'?['--untrusted-unsupported']:[])]);
    assert.equal(result.connection.healthy,true,JSON.stringify(result));
    assert.equal(result.compatible,true);assert.equal(result.backend_version,version);
  });
  test(`${platform} rejects incompatible policy even when the CLI version is recognized`,async t=>{
    const result=await diagnose(t,platform,['--incompatible-policy']);
    assert.equal(result.connection.healthy,false);assert.equal(result.compatible,false);
    assert.match(result.connection.error,/policy|configuration|hook/i);
  });
}

test('Kilo diagnostic retains the original 30s startup budget after a successful provider response',async t=>{
  const f=await fixture(t);f.engine.stop();mockProfiles(f);
  const flag=path.join(f.dir,'provider-ready'),clock=path.join(f.dir,'diagnostic-clock.mjs');
  fs.writeFileSync(clock,`import fs from 'node:fs';const original=Date.now.bind(Date);Date.now=()=>original()+(fs.existsSync(${JSON.stringify(flag)})?16000:0);`);
  const file=path.join(f.data,'profiles.json'),profiles=JSON.parse(fs.readFileSync(file));
  profiles.profiles['mock-kilo'].args.push(`--advance-clock-after-provider=${flag}`);fs.writeFileSync(file,JSON.stringify(profiles));
  const before=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${before??''} --import=${pathToFileURL(clock).href}`.trim();
  t.after(()=>{if(before===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=before;});
  const result=await f.engine.doctor({repo:f.repo,worker:selection('kilo')});
  assert.equal(fs.existsSync(flag),true);assert.equal(result.connection.healthy,true,JSON.stringify(result.connection));assert.equal(result.connection.stage,'termination');
});

for(const platform of ['opencode','kilo'])test(`${platform} rejects an incompatible session API without dispatching a prompt`,async t=>{
  const result=await diagnose(t,platform,['--invalid-session']);
  assert.equal(result.connection.healthy,false);assert.equal(result.compatible,false);
  assert.match(result.connection.error,/session/i);
});

async function native(t,platform,model,extraArgs=[]) {
  const f=await fixture(t);f.engine.stop();mockProfiles(f);
  if(extraArgs.length){const file=path.join(f.data,'profiles.json'),profiles=JSON.parse(fs.readFileSync(file));profiles.profiles[`mock-${platform}`].args.push(...extraArgs);fs.writeFileSync(file,JSON.stringify(profiles));}
  const worker=resolveWorker(f.data,{...selection(platform),...(model===null?{model:undefined}:model?{model}:{})});
  const id=uid('native'),job_dir=path.join(f.data,'jobs',id);fs.mkdirSync(job_dir,{recursive:true});
  const spec={protocol:2,id,job_dir,directory:f.repo,goal:'',acceptance:[],scope:['a.txt'],verification:[],resources:[],context:[],timeout_ms:60000,validation:false,host_executable:cli,worker,model:worker.model,executable:worker.executable,executable_args:worker.executable_args,password:uid('secret')};
  const state={protocol:2,id,phase:'starting',updated:Date.now(),prompt_id:uid('msg'),verification:[],inputs:[],replies:{}};
  state.scope_guard={status:'healthy',checked_at:Date.now(),policy_hash:workerPolicyHash(spec)};
  const backend=createBackend({spec,state,save:()=>fs.writeFileSync(path.join(job_dir,'worker.json'),JSON.stringify(state))});
  t.after(async()=>{await backend.cancel();assert.equal(await backend.confirmStopped(),true);});
  await backend.start();return {backend,state,spec};
}

test('Codex rejects a native model substitution before implementation dispatch',async t=>{
  const {backend}=await native(t,'codex','unavailable-model');
  await assert.rejects(()=>backend.createSession(),e=>e.code==='MODEL_UNAVAILABLE');
});

test('Codex resolves its native default when the configuration model is null',async t=>{
  const {backend,state}=await native(t,'codex',null,['--default-model-null']);await backend.createSession();assert.equal(state.model,'fake-model');
});

test('Codex observes accepted owned turns with includeTurns without ephemeral API errors or prompt replay',async t=>{
  const {backend,state,spec}=await native(t,'codex');await backend.createSession();
  assert.equal(JSON.parse(fs.readFileSync(path.join(spec.job_dir,'session-intent.json'))).ephemeral,false);
  await backend.dispatch('FAKE_ACTION:{"files":{"a.txt":"once"}}',state.prompt_id);
  let observed;for(let i=0;i<100;i++){observed=await backend.observe();if(observed.complete)break;await sleep(50);}
  assert.equal(observed.accepted,true);assert.equal(observed.complete,true);
  assert.equal(observed.transcript.thread.turns.flatMap(t=>t.items).filter(i=>i.type==='userMessage').length,1);
});

for(const platform of ['opencode','codex','claude-code','kilo'])test(`${platform} rejects out-of-scope direct edits before native file mutation`,async t=>{
  const {backend,state,spec}=await native(t,platform);await backend.createSession();
  const permission=platform==='codex'?{method:'item/fileChange/requestApproval',params:{changes:{'outside.txt':{type:'add'}}}}
    :platform==='claude-code'?{tool:'Write',input:{file_path:'outside.txt',content:'bad'}}:{permission:'edit',patterns:['outside.txt'],metadata:{files:[{path:'a.txt'}]}};
  await backend.dispatch(`FAKE_ACTION:${JSON.stringify({permission,files:{'outside.txt':'bad'}})}`,state.prompt_id);
  let observed;for(let i=0;i<100;i++){observed=await backend.observe();if(observed.complete)break;assert.equal(observed.inputs.length,0);await sleep(50);}
  assert.equal(observed.complete,true);assert.equal(fs.existsSync(path.join(spec.directory,'outside.txt')),false);
});

for(const platform of ['opencode','kilo'])test(`${platform} rejects multi-file edits, rename endpoints and opaque permissions without grants`,async t=>{
  const {backend,state,spec}=await native(t,platform);await backend.createSession();
  for(const permission of [
    {permission:'edit',patterns:['a.txt','outside.txt'],metadata:{files:[{path:'a.txt'}]}},
    {permission:'edit',patterns:['a.txt'],metadata:{files:[{path:'outside.txt'}]}},
    {permission:'edit',patterns:['a.txt'],metadata:{paths:['a.txt','outside.txt']}},
    {permission:'edit',patterns:['a.txt'],metadata:{files:{'outside.txt':{type:'add'}}}},
    {permission:'edit',patterns:['a.txt'],metadata:{native_paths:['outside.txt'],metadata_paths:{path:'a.txt'}}},
    {permission:'edit',patterns:['a.txt'],metadata:{old_path:'outside.txt',new_path:'a.txt'}},
    {permission:'edit',patterns:['**'],metadata:{path:'a.txt'}},
    {permission:'edit',patterns:['a.txt'],metadata:{cwd:path.dirname(spec.directory)}},
    {permission:'edit',patterns:['a.txt'],metadata:{workdir:path.dirname(spec.directory)}},
    {permission:'edit',patterns:['a.txt'],metadata:{cwd:spec.directory,workdir:path.dirname(spec.directory)}},
  ]) {
    await backend.dispatch(`FAKE_ACTION:${JSON.stringify({permission,files:{'outside.txt':'bad'}})}`,state.prompt_id);
    let observed;for(let i=0;i<100;i++){observed=await backend.observe();if(observed.complete)break;assert.equal(observed.inputs.length,0);await sleep(50);}
    assert.equal(observed.complete,true);assert.equal(fs.existsSync(path.join(spec.directory,'outside.txt')),false);
  }
});

for(const platform of ['opencode','codex','claude-code','kilo'])test(`${platform} fails closed when the independent scope monitor is missing or stale`,async t=>{
  const {backend,state}=await native(t,platform);await backend.createSession();state.scope_guard.checked_at=Date.now()-11000;
  await assert.rejects(()=>backend.dispatch('FAKE_ACTION:{}',state.prompt_id),e=>e.code==='SCOPE_GUARD_UNKNOWN');
});

function shellPermission(platform,command,cwd) {
  return platform==='codex'?{method:'item/commandExecution/requestApproval',params:{command,cwd}}
    :platform==='claude-code'?{tool:'Bash',input:{command,cwd}}:{permission:'bash',patterns:[command],metadata:{command,cwd}};
}
for(const platform of ['opencode','codex','claude-code','kilo'])test(`${platform} asks for arbitrary shell and rejects late or duplicate grants`,async t=>{
  const {backend,state,spec}=await native(t,platform);await backend.createSession();
  await backend.dispatch(`FAKE_ACTION:${JSON.stringify({permission:shellPermission(platform,'node read-only-probe',spec.directory)})}`,state.prompt_id);
  let observed;for(let i=0;i<100;i++){observed=await backend.observe();if(observed.inputs.length)break;await sleep(50);}
  assert.equal(observed.inputs.length,1);assert.equal(observed.inputs[0].kind,'permission');assert.ok(observed.inputs[0].grant_key);
  state.scope_guard.status='violated';
  await assert.rejects(()=>backend.reply(observed.inputs[0],{decision:'always'}),e=>e.code==='MCP_POLICY');
  state.scope_guard.status='healthy';state.scope_guard.checked_at=Date.now();
  await backend.reply(observed.inputs[0],{decision:'always'});
  await assert.rejects(()=>backend.reply(observed.inputs[0],{decision:'once'}),e=>e.code==='INPUT');
});
for(const platform of ['opencode','codex','claude-code','kilo'])test(`${platform} never offers an approval grant for background or Git ownership commands`,async t=>{
  const {backend,state,spec}=await native(t,platform);await backend.createSession();
  await backend.dispatch(`FAKE_ACTION:${JSON.stringify({permission:shellPermission(platform,'git update-ref HEAD bad',spec.directory),files:{'outside.txt':'must never write'}})}`,state.prompt_id);
  let observed;for(let i=0;i<100;i++){observed=await backend.observe();if(observed.complete)break;assert.equal(observed.inputs.length,0);await sleep(50);}
  assert.equal(observed.complete,true);assert.equal(fs.existsSync(path.join(spec.directory,'outside.txt')),false);
});

test('a monitor violation kills blocked native observe without losing its original reason or evidence',async t=>{
  const {backend,spec}=await native(t,'codex');await backend.confirmStopped();
  spec.id=uid('blocked');spec.job_dir=path.join(path.dirname(spec.job_dir),spec.id);fs.mkdirSync(spec.job_dir);
  spec.goal='FAKE_ACTION:{"block_observe":true,"files":{"outside.txt":"preserved evidence"}}';
  fs.writeFileSync(path.join(spec.job_dir,'spec.json'),JSON.stringify(spec));
  const result=await exec(process.execPath,[cli,'worker',spec.job_dir],{cwd:spec.directory,timeout:15000});assert.equal(result.code,0,result.stderr);
  const state=JSON.parse(fs.readFileSync(path.join(spec.job_dir,'worker.json')));
  assert.equal(state.error_code,'SCOPE_VIOLATION');assert.equal(state.phase,'failed');assert.equal(state.stopped,true);
  assert.equal(fs.readFileSync(path.join(spec.directory,'outside.txt'),'utf8'),'preserved evidence');
  assert.equal(JSON.parse(fs.readFileSync(path.join(spec.job_dir,'scope-violation.json'))).code,'SCOPE_VIOLATION');
});

test('Claude rejects an advertised alias resolved to a different model family',async t=>{
  await assert.rejects(()=>native(t,'claude-code','sonnet'),e=>e.code==='MODEL_UNAVAILABLE');
});

for(const platform of ['opencode','codex','kilo'])test(`${platform} reconciles a lost prompt acknowledgement without a second native prompt`,async t=>{
  const {backend,state}=await native(t,platform);await backend.createSession();
  await assert.rejects(()=>backend.dispatch('FAKE_ACTION:{"files":{"a.txt":"once"},"drop_response":true}',state.prompt_id));
  let observed;const deadline=Date.now()+15000;
  do{observed=await backend.observe();if(observed.complete)break;await sleep(100);}while(Date.now()<deadline);
  assert.equal(observed.accepted,true);assert.equal(observed.complete,true);
  const users=platform==='codex'?observed.transcript.thread.turns.flatMap(turn=>turn.items).filter(item=>item.type==='userMessage'):observed.transcript.filter(message=>message.info.role==='user');
  assert.equal(users.length,1);assert.equal(users[0].id??users[0].info.id,state.prompt_id);
});

test('resource normalization rejects conflicting or disabled connection settings',()=>{
  const resource=config=>({connection:{name:'editor',config}});
  for(const config of [
    {type:'stdio',command:['node','server.mjs'],args:['ignored.mjs']},
    {type:'stdio',command:'node',args:[],env:{A:'first'},environment:{A:'second'}},
    {type:'http',url:'https://example.invalid/mcp',enabled:false},
  ])assert.throws(()=>connection(resource(config),'/tmp/worktree'),e=>e.code==='MCP_POLICY');
});

test('HTTP backends translate portable stdio fields without leaking unsupported native keys',()=>{
  const result=restrictions({},[{connection:{name:'editor',config:{type:'stdio',command:'node',args:['server.mjs'],env:{PROJECT:'{{worktree}}'},timeout:1500}}}],'/tmp/worktree');
  assert.deepEqual(result.mcp.editor,{type:'local',command:['node','server.mjs'],environment:{PROJECT:'/tmp/worktree'},timeout:1500,enabled:true});
});
