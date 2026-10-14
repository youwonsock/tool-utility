import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Store, Engine, exec, platforms } from '../dist/index.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'agent-connections '));
const repo=path.join(root,'repository');fs.mkdirSync(repo);
for(const args of [['init','-b','main'],['config','user.name','Connection check'],['config','user.email','connection@localhost']])assert.equal((await exec('git',args,{cwd:repo})).code,0);
fs.writeFileSync(path.join(repo,'base.txt'),'read-only connection checks\n');
for(const args of [['add','.'],['commit','-m','initial']])assert.equal((await exec('git',args,{cwd:repo})).code,0);
const engine=new Engine(new Store(path.join(root,'data')),path.join(source,'dist','cli.mjs'));
const external=process.argv[2];
if(external) {
  if(!path.isAbsolute(external)||!fs.existsSync(path.join(external,'.agent-delegation-test-environment.json')))throw new Error('Expected an explicitly prepared, owned test environment.');
  const packages={opencode:'@opencode-ai/sdk','claude-code':'@anthropic-ai/claude-agent-sdk',kilo:'@kilocode/sdk'};
  const commands={opencode:'opencode',codex:'codex','claude-code':'claude',kilo:'kilo'};
  const profiles=Object.fromEntries(platforms.map(platform=>[`${platform}-default`,{platform,executable:path.join(external,'node_modules','.bin',commands[platform]),...(packages[platform]?{sdk_root:path.join(external,'node_modules',packages[platform])}:{})}]));
  fs.writeFileSync(path.join(engine.store.root,'profiles.json'),JSON.stringify({profiles},null,2));
}
const results=[];
for(const platform of platforms) {
  const result=await engine.call('doctor',{repo,worker:{platform}});
  results.push({platform,compatible:result.compatible,backend_version:result.backend_version,runtime:result.runtime,connection:result.connection,error:result.error});
  console.log(JSON.stringify(results.at(-1)));
}
fs.writeFileSync(path.join(root,'connections.json'),JSON.stringify({paid_model_requests:0,root,results},null,2));
console.log(JSON.stringify({evidence:path.join(root,'connections.json'),model_tasks:'not exercised',gui:'not exercised'}));
assert.ok(results.every(result=>result.compatible&&result.connection?.healthy),'One or more native connection checks failed. Inspect the evidence directory.');
