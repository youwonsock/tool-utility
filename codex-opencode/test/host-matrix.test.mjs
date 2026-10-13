import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { platforms,exportHost,remoteCall,sleep,uid } from '../dist/index.mjs';
import { fixture,root,cli,task } from './helpers.mjs';
import { mockProfiles,selection } from './native-helpers.mjs';
const body=fs.readFileSync(path.join(root,'docs','workflow.md'),'utf8');

for(const supervisor of platforms)test(`${supervisor} supervisor export runs the MCP contract with all four mock implementation platforms`,async t=>{
  const f=await fixture(t,{service:true});mockProfiles(f);
  const exported=exportHost(supervisor,path.join(f.dir,'host'),cli,body,f.data);
  const binding=JSON.parse(fs.readFileSync(path.join(exported.output,'binding.json')));
  assert.equal(binding.platform,supervisor);assert.equal(binding.support.model_tasks,'not exercised');assert.equal(binding.support.ide_desktop_gui,'unconfirmed');
  assert.ok(fs.existsSync(path.join(exported.output,binding.skills,'delegate-agents','SKILL.md')));
  const client=new Client({name:`contract-${supervisor}`,version:'1'},{capabilities:{}});
  await client.connect(new StdioClientTransport({...binding.stdio,env:{...f.env,...binding.stdio.env,CODEX_OPENCODE_WORKER:'0'},stderr:'pipe'}));
  const invoke=async(name,args)=>{const response=await client.callTool({name,arguments:args});const value=JSON.parse(response.content[0].text);assert.ok(!value.error,JSON.stringify(value));return value;};
  const snapshot=async id=>{let cursor,result,items=[];do{result=await invoke('get_run',{run_id:id,...(cursor?{cursor}:{})});items.push(...result.items);cursor=result.next_cursor;}while(cursor);return {...result,items};};
  const converge=async(id,predicate)=>{const deadline=Date.now()+90000;while(Date.now()<deadline){const run=await snapshot(id);if(predicate(run))return run;await sleep(100);}assert.fail('MCP contract did not converge.');};
  let runID;
  try {
    assert.equal((await client.listTools()).tools.length,12);
    const submitted=await invoke('submit_tasks',{request_id:uid('matrix'),repo:f.repo,tasks:platforms.map(platform=>task(platform,{files:{[`${platform}.txt`]:`${supervisor}/${platform}`}},{worker:selection(platform)})),final_verification:[{command:'node -e "process.exit(0)"'}]});runID=submitted.run_id;
    const run=await converge(runID,r=>r.items.length===4&&r.items.every(t=>t.state==='needs_review'));
    for(const item of run.items){assert.equal(item.worker.platform,item.task_id);assert.equal(item.attempt.backend,item.task_id);await invoke('review_task',{request_id:uid('review'),run_id:runID,task_id:item.task_id,attempt_id:item.attempt.id,commit:item.attempt.commit,decision:'approve'});}
    await invoke('validate_run',{request_id:uid('validate'),run_id:runID});
    const validated=await converge(runID,r=>r.state==='waiting_final_review');
    await invoke('finalize_run',{request_id:uid('finalize'),run_id:runID,validation_id:validated.validation.id,commit:validated.validation.commit,revision:validated.revision});
    for(const platform of platforms)assert.equal(fs.readFileSync(path.join(f.repo,`${platform}.txt`),'utf8'),`${supervisor}/${platform}`);
  }finally {
    if(runID)await invoke('cancel_run',{request_id:uid('cleanup'),run_id:runID}).catch(()=>{});
    await client.close();
    for(let i=0;i<80;i++){try{await remoteCall(f.data,cli,'',{},'/stop');break;}catch{await sleep(100);}}
  }
});
