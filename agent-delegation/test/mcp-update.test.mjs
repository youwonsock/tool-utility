import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { exec, remoteCall, writeJson, loadState } from '../dist/index.mjs';
import { cli, temporaryRoot } from './helpers.mjs';

function release(install,name,body) {
  const root=path.join(install,'releases',name),file=path.join(root,'plugins/agent-delegation/runtime/cli.mjs');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);
  writeJson(path.join(root,'plugins/agent-delegation/.codex-plugin/plugin.json'),{version:`1.0.0+codex.${name}`});
  return {release:root,cli:file};
}
async function bridge(t,old,data) {
  const client=new Client({name:'mcp-update-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[old.cli,'mcp'],env:{...process.env,AGENT_DELEGATION_HOME:data,AGENT_DELEGATION_WORKER:'0'},stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());return client;
}
const result=raw=>JSON.parse(raw.content[0].text);

test('a live installed MCP bridge hands off across storage versions and starts only the current service',async t=>{
  const dir=fs.mkdtempSync(path.join(temporaryRoot,'MCP 업데이트 ')),install=path.join(dir,'설치'),data=path.join(dir,'data');
  const body=fs.readFileSync(cli,'utf8');assert.ok(body.includes('var STORE_FORMAT = 4;'));
  const old=release(install,'old',body.replace('var STORE_FORMAT = 4;','var STORE_FORMAT = 3;'));
  const current=release(install,'current',body);writeJson(path.join(install,'current.json'),old);
  const client=await bridge(t,old,data);assert.equal(client.getServerVersion().version,'1.0.0+codex.old');assert.equal((await client.listTools()).tools.length,12);
  // The already initialized transport must survive the pointer change. There is
  // no daemon yet, so accidentally starting the pinned old CLI is also detected.
  writeJson(path.join(install,'current.json'),current);
  t.after(async()=>{try{await remoteCall(data,current.cli,'',{},'/stop');}catch{}});
  const list=await client.callTool({name:'list_runs',arguments:{}});assert.notEqual(list.isError,true,JSON.stringify(list));assert.deepEqual(result(list).items,[]);
  const descriptor=JSON.parse(fs.readFileSync(path.join(data,'service.json')));assert.equal(descriptor.executable,current.cli);assert.equal(loadState(data).state.protocol,4);
  const pinned=await exec(process.execPath,[old.cli,'call','list_runs'],{env:{...process.env,AGENT_DELEGATION_HOME:data}});assert.equal(pinned.code,1);assert.match(pinned.stderr,/incompatible service/);
  const doctor=result(await client.callTool({name:'doctor',arguments:{worker:{platform:'codex',profile:'missing-profile'}}}));assert.equal(doctor.deployment.executable,current.cli);assert.equal(doctor.deployment.version,'1.0.0+codex.current');
  const missing=await client.callTool({name:'get_run',arguments:{run_id:'missing'}});assert.equal(missing.isError,true);assert.equal(result(missing).error.code,'NOT_FOUND');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'service.json'))).owner.pid,descriptor.owner.pid);
});

test('a live bridge rejects broken, foreign and recursive deployment pointers and can recover',async t=>{
  const dir=fs.mkdtempSync(path.join(temporaryRoot,'MCP 포인터 ')),install=path.join(dir,'install'),data=path.join(dir,'data');
  const old=release(install,'old',fs.readFileSync(cli)),current=release(install,'current',fs.readFileSync(cli));writeJson(path.join(install,'current.json'),old);
  const client=await bridge(t,old,data);const pointer=path.join(install,'current.json');
  const foreign=release(path.join(dir,'foreign'),'other',fs.readFileSync(cli));
  for(const value of [null,'invalid-json',foreign,{...current,release:old.release},{...current,cli:path.join(install,'releases','missing','plugins/agent-delegation/runtime/cli.mjs')}]){
    if(value===null)fs.rmSync(pointer);else if(value==='invalid-json')fs.writeFileSync(pointer,value);else writeJson(pointer,value);
    const response=await client.callTool({name:'list_runs',arguments:{}});assert.equal(response.isError,true);assert.equal(fs.existsSync(path.join(data,'service.json')),false);
  }
  writeJson(pointer,current);t.after(async()=>{try{await remoteCall(data,current.cli,'',{},'/stop');}catch{}});
  const recovered=await client.callTool({name:'list_runs',arguments:{}});assert.notEqual(recovered.isError,true,JSON.stringify(recovered));assert.deepEqual(result(recovered).items,[]);
  // A forwarded child must not chase a second pointer change indefinitely.
  const nested=new Client({name:'nested-relay-test',version:'1'});t.after(()=>nested.close());
  await nested.connect(new StdioClientTransport({command:process.execPath,args:[old.cli,'mcp'],env:{...process.env,AGENT_DELEGATION_HOME:data,AGENT_DELEGATION_MCP_RELAY:'1'},stderr:'pipe'}));
  const refused=await nested.callTool({name:'list_runs',arguments:{}});assert.equal(refused.isError,true);assert.match(result(refused).error,/changed during MCP handoff/);
});

test('a handoff with a lost response is sent once and never falls back to the old client',async t=>{
  const dir=fs.mkdtempSync(path.join(temporaryRoot,'MCP 불확실 ')),install=path.join(dir,'install'),data=path.join(dir,'data'),audit=path.join(dir,'calls.jsonl');
  const old=release(install,'old',fs.readFileSync(cli));const require=createRequire(import.meta.url);
  const fake=`const {McpServer}=require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/mcp.js'))});const {StdioServerTransport}=require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});const fs=require('node:fs');const server=new McpServer({name:'lost-response',version:'1'});server.registerTool('list_runs',{inputSchema:{}},async()=>{fs.appendFileSync(${JSON.stringify(audit)},'called\\n');process.exit(3)});server.connect(new StdioServerTransport());`;
  // The selected path uses .mjs like an installed CLI; supply require explicitly.
  const current=release(install,'lost',`import {createRequire} from 'node:module';const require=createRequire(import.meta.url);${fake}`);writeJson(path.join(install,'current.json'),old);
  const client=await bridge(t,old,data);writeJson(path.join(install,'current.json'),current);
  const response=await client.callTool({name:'list_runs',arguments:{}});assert.equal(response.isError,true);assert.match(result(response).error,/closed/i);
  assert.equal(fs.readFileSync(audit,'utf8'),'called\n');assert.equal(fs.existsSync(path.join(data,'service.json')),false);
});
