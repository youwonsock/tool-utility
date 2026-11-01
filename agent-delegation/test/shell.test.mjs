import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runVerification, resolveWorker, uid } from '../dist/index.mjs';
import { fixture, cli } from './helpers.mjs';

const variants=process.platform==='win32'?['default','cmd']:['default','bash'];
for(const variant of variants)test(`${variant} verification shell preserves exit codes, quotes, logs and the worktree directory`,async t=>{
  const f=await fixture(t);f.engine.stop();const worker=resolveWorker(f.data,{platform:'opencode'});
  if(variant!=='default')worker.shell={executable:variant==='cmd'?process.env.ComSpec??'cmd.exe':'/bin/bash',args:variant==='cmd'?['/d','/s','/c']:['-c']};
  const id=uid('verification'),job_dir=path.join(f.data,'jobs',id);fs.mkdirSync(job_dir,{recursive:true});
  const spec={protocol:2,id,job_dir,directory:f.repo,host_executable:cli,worker};
  const state={protocol:2,id,phase:'verifying',updated:Date.now(),prompt_id:'',verification:[],inputs:[],replies:{}};
  const context={spec,state,save:()=>fs.writeFileSync(path.join(job_dir,'worker.json'),JSON.stringify(state))};
  const failed=await runVerification(context,0,{command:'node -e "console.log(\'value with spaces\');process.exit(7)"',timeout_ms:30000},()=>false);
  assert.equal(failed.status,'failed');assert.equal(failed.exit_code,7);assert.match(fs.readFileSync(path.join(job_dir,'verification-0.log'),'utf8'),/value with spaces/);
  const passed=await runVerification(context,1,{command:'node -e "require(\'fs\').writeFileSync(\'quoted file.txt\',\'correct value\');console.log(process.cwd())"',timeout_ms:30000},()=>false);
  assert.equal(passed.status,'passed');assert.equal(fs.readFileSync(path.join(f.repo,'quoted file.txt'),'utf8'),'correct value');assert.ok(fs.readFileSync(path.join(job_dir,'verification-1.log'),'utf8').includes(f.repo));
  const receipt=JSON.parse(fs.readFileSync(path.join(job_dir,passed.artifact)));assert.equal(receipt.termination_confirmed,true);assert.ok(receipt.argv.length);assert.equal(receipt.directory,f.repo);
});
