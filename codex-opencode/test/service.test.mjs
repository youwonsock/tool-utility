import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { remoteCall, connect, Store, sleep, exec, terminate, processIdentity, uid } from '../dist/index.mjs';
import { fixture, task, cli, fake, root, readState, temporaryRoot } from './helpers.mjs';

test('authenticated daemon survives MCP disconnect and restart without duplicate prompts',async t=>{
  const f=await fixture(t,{service:true}); const audit=path.join(f.dir,'audit.jsonl');
  const saved={...process.env}; Object.assign(process.env,f.env,{FAKE_AUDIT:audit});
  t.after(async()=>{ try { await remoteCall(f.data,cli,'',{},'/stop'); } catch{} for(const key of Object.keys(process.env)) if(!(key in saved)) delete process.env[key]; Object.assign(process.env,saved); });
  const client=new Client({name:'integration-test',version:'1'});
  t.after(()=>client.close());
  const transport=new StdioClientTransport({command:process.execPath,args:[cli,'mcp'],env:{...process.env},stderr:'pipe'}); await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,12);
  const result=await client.callTool({name:'submit_tasks',arguments:{request_id:'single',repo:f.repo,tasks:[task('a',{files:{'a.txt':'a'},delay:8000,drop_response:true})]}});
  const submitted=JSON.parse(result.content[0].text); assert.ok(submitted.run_id); await client.close();
  let state;
  for(let i=0;i<100;i++){state=readState(f.data);if(state.runs[0].tasks[0].attempts[0]?.worker?.prompt_intent)break;await sleep(100);}
  assert.ok(state.runs[0].tasks[0].attempts[0].worker.prompt_intent);
  let descriptor=JSON.parse(fs.readFileSync(path.join(f.data,'service.json')));
  assert.equal((await fetch(`${descriptor.url}/health`)).status,401);
  assert.equal((await fetch(`${descriptor.url}/health`,{headers:{Authorization:`Bearer ${descriptor.token}`,Origin:'https://outside.test'}})).status,403);
  if(process.platform==='win32') await terminate(descriptor.owner); else process.kill(descriptor.owner.pid,'SIGKILL');
  for(let i=0;i<100;i++){try{process.kill(descriptor.owner.pid,0);}catch{break;}await sleep(30);}
  await connect(f.data,cli);
  for(let i=0;i<150;i++){state=readState(f.data);if(state.runs[0].tasks[0].state==='needs_review')break;await sleep(100);}
  assert.equal(state.runs[0].tasks[0].state,'needs_review');
  const events=fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse); assert.equal(events.filter(e=>e.event==='prompt').length,1);
  const repeat=await remoteCall(f.data,cli,'submit_tasks',{request_id:'single',repo:f.repo,tasks:[task('a',{files:{'a.txt':'a'},delay:8000,drop_response:true})]}); assert.equal(repeat.run_id,submitted.run_id);
});

test('installed bundle works after its source is moved, without source node_modules',async t=>{
  const dir=fs.mkdtempSync(path.join(temporaryRoot,'설치 경로 space ')); const source=path.join(dir,'개발 source'),install=path.join(dir,'설치본'),data=path.join(dir,'state');fs.mkdirSync(source);
  for(const entry of ['dist','plugins','.agents','scripts','package.json'])fs.cpSync(path.join(root,entry),path.join(source,entry),{recursive:true,filter:()=>true});
  assert.ok(fs.existsSync(path.join(source,'scripts/install.mjs')), `Copied installer missing: ${JSON.stringify(fs.readdirSync(source))}`);
  const env={...process.env,CODEX_OPENCODE_INSTALL_ROOT:install,CODEX_OPENCODE_HOME:data,CODEX_OPENCODE_EXECUTABLE:process.execPath,CODEX_OPENCODE_EXECUTABLE_ARGS:JSON.stringify([fake])};
  const installed=await exec(process.execPath,[path.join(source,'scripts/install.mjs'),'--no-register'],{env,timeout:30000});assert.equal(installed.code,0,installed.stderr);
  const current=JSON.parse(fs.readFileSync(path.join(install,'current.json')));
  fs.renameSync(source,path.join(dir,'moved source'));
  const client=new Client({name:'installed-test',version:'1'});const transport=new StdioClientTransport({command:process.execPath,args:[current.cli,'mcp'],env,stderr:'pipe'});await client.connect(transport);
  try{const result=await client.callTool({name:'doctor',arguments:{}});const doctor=JSON.parse(result.content[0].text);assert.equal(doctor.connection.healthy,true);assert.equal(doctor.opencode,'1.18.30');}finally{await client.close();await exec(process.execPath,[current.cli,'stop'],{env});}
  assert.ok(!fs.readFileSync(path.join(current.release,'plugins/codex-opencode/.mcp.json'),'utf8').includes(source));
});

test('owned process tree termination includes a child that ignores SIGTERM',{skip:process.platform==='win32'?'Windows taskkill /T is covered by worker cancellation tests':false},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'process-tree-')),ready=path.join(dir,'ready'),marker=path.join(dir,'survived');
  const code=`import {spawn} from 'node:child_process';spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(`import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},'bad');process.exit(0)},5000);`)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{detached:true,stdio:'ignore'});child.unref();
  const identity=await processIdentity(child.pid);for(let i=0;i<50&&!fs.existsSync(ready);i++)await sleep(50);
  assert.equal(await terminate(identity,true),true);await sleep(100);assert.equal(fs.existsSync(marker),false);
});
