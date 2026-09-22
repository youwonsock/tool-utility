import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../dist/index.mjs';
import { root, temporaryRoot } from './helpers.mjs';

test('installer updates its own marketplace, retains old releases, and rolls back failed registration',async()=>{
  const dir=fs.mkdtempSync(path.join(temporaryRoot,'업데이트 검증 ')),source=path.join(dir,'source'),install=path.join(dir,'install'),data=path.join(dir,'data');fs.mkdirSync(source);
  for(const entry of ['dist','plugins','.agents','scripts','package.json'])fs.cpSync(path.join(root,entry),path.join(source,entry),{recursive:true,filter:()=>true});
  assert.ok(fs.existsSync(path.join(source,'scripts/install.mjs')), `Copied installer missing: ${JSON.stringify(fs.readdirSync(source))}`);
  const stateFile=path.join(dir,'fake-codex-state.json');fs.writeFileSync(stateFile,JSON.stringify({marketplaces:[]}));
  const fakeScript=path.join(dir,'fake-codex.mjs');
  fs.writeFileSync(fakeScript,`import fs from 'node:fs';import path from 'node:path';const file=process.env.FAKE_CODEX_STATE;const state=JSON.parse(fs.readFileSync(file));const a=process.argv.slice(2);const save=()=>fs.writeFileSync(file,JSON.stringify(state));if(a[1]==='marketplace'&&a[2]==='list')console.log(JSON.stringify(state));else if(a[1]==='marketplace'&&a[2]==='remove'){state.marketplaces=state.marketplaces.filter(m=>m.name!==a[3]);save();}else if(a[1]==='marketplace'&&a[2]==='add'){const name=JSON.parse(fs.readFileSync(path.join(a[3],'.agents/plugins/marketplace.json'))).name;if(state.marketplaces.some(m=>m.name===name&&m.root!==a[3]))process.exit(1);state.marketplaces=[{name,root:a[3]}];save();}else if(a[1]==='add'){if(state.fail_next_add){state.fail_next_add=false;save();process.exit(1);}state.pluginRoot=state.marketplaces[0].root;save();}else process.exit(2);`);
  const fakeExe=path.join(dir,process.platform==='win32'?'fake codex.cmd':'fake codex');
  fs.writeFileSync(fakeExe,process.platform==='win32'?`@"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`,{mode:0o755});
  const env={...process.env,CODEX_EXECUTABLE:fakeExe,FAKE_CODEX_STATE:stateFile,CODEX_OPENCODE_INSTALL_ROOT:install,CODEX_OPENCODE_HOME:data};
  const run=()=>exec(process.execPath,[path.join(source,'scripts/install.mjs')],{env,timeout:30000});
  let result=await run();assert.equal(result.code,0,result.stderr);const first=JSON.parse(fs.readFileSync(path.join(install,'current.json')));
  const skill=path.join(source,'plugins/codex-opencode/skills/delegate-opencode/SKILL.md');fs.appendFileSync(skill,'\n');
  result=await run();assert.equal(result.code,0,result.stderr);const second=JSON.parse(fs.readFileSync(path.join(install,'current.json')));assert.notEqual(first.release,second.release);assert.ok(fs.existsSync(first.cli));
  const manifest=r=>JSON.parse(fs.readFileSync(path.join(r.release,'plugins/codex-opencode/.codex-plugin/plugin.json')));assert.notEqual(manifest(first).version,manifest(second).version);
  fs.appendFileSync(skill,'\n');const failing=JSON.parse(fs.readFileSync(stateFile));failing.fail_next_add=true;fs.writeFileSync(stateFile,JSON.stringify(failing));
  result=await run();assert.notEqual(result.code,0);assert.equal(JSON.parse(fs.readFileSync(path.join(install,'current.json'))).release,second.release);assert.equal(JSON.parse(fs.readFileSync(stateFile)).marketplaces[0].root,second.release);
  fs.mkdirSync(data,{recursive:true});fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({protocol:99}));result=await run();assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout).update_pending,true);assert.equal(JSON.parse(fs.readFileSync(path.join(install,'current.json'))).release,second.release);
});
