import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBackend, resolveWorker, uid, sleep, connection, restrictions } from '../dist/index.mjs';
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
