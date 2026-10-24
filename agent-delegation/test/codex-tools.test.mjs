import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { codexDynamicTools, readCodexFile, codexCommand, codexWindowsSandbox, workerPolicyHash } from '../dist/index.mjs';
import { fixture, cli } from './helpers.mjs';

test('Codex selects an invocation-only Windows sandbox without replacing explicit or legacy implementations',()=>{
  assert.equal(codexWindowsSandbox({},'win32'),'unelevated');
  assert.equal(codexWindowsSandbox({windows:{sandbox:null}},'win32'),'unelevated');
  assert.equal(codexWindowsSandbox({features:{elevated_windows_sandbox:true}},'win32'),'elevated');
  for(const mode of ['mxc','elevated','unelevated']) {
    const config={windows:{sandbox:mode},features:{elevated_windows_sandbox:true}},before=JSON.stringify(config);
    assert.equal(codexWindowsSandbox(config,'win32'),mode);assert.equal(JSON.stringify(config),before);
  }
  for(const mode of ['disabled','danger-full-access','unknown',false,{}])assert.throws(()=>codexWindowsSandbox({windows:{sandbox:mode}},'win32'),e=>e.code==='MCP_POLICY');
  for(const platform of ['darwin','linux'])assert.equal(codexWindowsSandbox({},platform),undefined);
});

test('Codex read adapter bounds source reads and allows exact protected context without mutation grants',async t=>{
  const f=await fixture(t);f.engine.stop();fs.mkdirSync(path.join(f.repo,'src'));fs.writeFileSync(path.join(f.repo,'src','a.txt'),'hello world');fs.writeFileSync(path.join(f.repo,'AGENTS.md'),'protected rules');
  const spec={directory:f.repo,scope:['src/**'],context:[{path:'AGENTS.md'}]};
  assert.equal(codexDynamicTools.length,2);
  const first=readCodexFile(spec,{path:'src/a.txt',limit:5});
  assert.deepEqual(first,{path:'src/a.txt',offset:0,next_offset:5,total_bytes:11,truncated:true,text:'hello'});
  assert.equal(readCodexFile(spec,{path:'src/a.txt',offset:first.next_offset}).text,' world');
  assert.equal(readCodexFile(spec,{path:'AGENTS.md'}).text,'protected rules');
  assert.equal(readCodexFile(spec,{path:'src/a.txt',offset:11}).text,'');
  fs.writeFileSync(path.join(f.repo,'src','large.txt'),'a'.repeat(2*1024*1024));
  const bounded=readCodexFile(spec,{path:'src/large.txt',limit:65536});
  assert.equal(bounded.text.length,65536);assert.equal(bounded.next_offset,65536);assert.equal(bounded.truncated,true);
  for(const input of [{path:'base.txt'},{path:'../outside.txt'},{path:'.git/config'},{path:'src/../src/a.txt'},{path:'src'},{path:'src/a.txt',limit:65537},{path:'src/a.txt',offset:12},{path:'src/a.txt',limit:1.1},{path:'src/a.txt',extra:true}])assert.throws(()=>readCodexFile(spec,input));
  const outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'secret.txt'),'not visible');
  fs.symlinkSync(outside,path.join(f.repo,'src','escape'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>readCodexFile(spec,{path:'src/escape/secret.txt'}));
});

test('Codex reads preserve UTF-8 boundaries and reject binary, malformed text and file swaps',async t=>{
  const f=await fixture(t);f.engine.stop();const file=path.join(f.repo,'text.txt'),spec={directory:f.repo,scope:['text.txt'],context:[]};
  fs.writeFileSync(file,'a한글z');
  assert.equal(readCodexFile(spec,{path:'text.txt',limit:5}).text,'a한');
  assert.equal(readCodexFile(spec,{path:'text.txt',offset:4}).text,'글z');
  assert.throws(()=>readCodexFile(spec,{path:'text.txt',offset:2}));
  assert.throws(()=>readCodexFile(spec,{path:'text.txt',limit:1,offset:1}));
  for(const bytes of [Buffer.from([0,1,2]),Buffer.from([0xff,0xff]),Buffer.from([0xe2,0x82])]){fs.writeFileSync(file,bytes);assert.throws(()=>readCodexFile(spec,{path:'text.txt'}));}
  fs.writeFileSync(file,'before');const read=fs.readSync;
  t.mock.method(fs,'readSync',(...args)=>{const count=read(...args);fs.writeFileSync(file,'changed');return count;});
  assert.throws(()=>readCodexFile(spec,{path:'text.txt'}),e=>e.code==='SCOPE_VIOLATION');
});

test('Codex shell adapter normalizes an exact foreground command and cannot elevate hard policy',async t=>{
  const f=await fixture(t);f.engine.stop();fs.mkdirSync(path.join(f.repo,'src'));
  const spec={directory:f.repo,scope:['src/**'],context:[{path:'AGENTS.md'}]};
  assert.deepEqual(codexCommand(spec,{command:'node build.mjs'}),{command:'node build.mjs',cwd:f.repo,timeout_ms:600000});
  assert.equal(codexCommand(spec,{command:'node build.mjs',cwd:'src',timeout_ms:100}).cwd,path.join(f.repo,'src'));
  for(const input of [{command:'git commit -am x'},{command:'node x &'},{command:'codex exec x'},{command:'cat AGENTS.md'},{command:'node x',cwd:path.dirname(f.repo)},{command:'node x',cwd:'.git'},{command:'node x',timeout_ms:99},{command:'node x',background:true},{command:'node x',cwd:12},{command:'node\0x'}])assert.throws(()=>codexCommand(spec,input));
});

test('Codex hook emits supported fail-closed decisions for canonical patch, owned gateways and every native shell',async t=>{
  const f=await fixture(t);f.engine.stop();const job_dir=path.join(f.data,'hook');fs.mkdirSync(job_dir);fs.mkdirSync(path.join(f.repo,'src'));
  const spec={id:'hook',directory:f.repo,job_dir,scope:['src/**'],context:[{path:'AGENTS.md',hash:'rules'}]},state={id:spec.id,scope_guard:{status:'healthy',checked_at:Date.now(),policy_hash:workerPolicyHash(spec)}};
  fs.writeFileSync(path.join(job_dir,'spec.json'),JSON.stringify(spec));fs.writeFileSync(path.join(job_dir,'worker.json'),JSON.stringify(state));
  const hook=(tool,input={},cwd=f.repo)=>{
    const result=spawnSync(process.execPath,[cli,'policy-hook',job_dir],{input:JSON.stringify({hook_event_name:'PreToolUse',cwd,tool_name:tool,tool_input:input}),encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);const decision=JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;assert.ok(['allow','deny'].includes(decision));return decision;
  };
  for(const tool of ['Bash','exec_command','write_stdin','functions.exec','Agent','mcp__files__write','unknown'])assert.equal(hook(tool,{command:'node harmless',path:'src/a.txt'}),'deny',tool);
  for(const tool of ['delegate_read_file','delegate_run_command','request_user_input'])assert.equal(hook(tool),'allow');
  assert.equal(hook('apply_patch',{command:'*** Begin Patch\n*** Add File: src/a.txt\n+ok\n*** End Patch'}),'allow');
  assert.equal(hook('apply_patch',{command:'*** Begin Patch\n*** Delete File: AGENTS.md\n*** End Patch'}),'deny');
  assert.equal(hook('delegate_read_file',{},path.dirname(f.repo)),'deny');
  state.scope_guard.checked_at=Date.now()-11000;fs.writeFileSync(path.join(job_dir,'worker.json'),JSON.stringify(state));assert.equal(hook('delegate_read_file'),'deny');
});
