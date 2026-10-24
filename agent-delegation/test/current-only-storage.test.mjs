import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store,loadState,emptyState,writeJson,deltaRecord,digest,exec,connect,serve} from '../dist/index.mjs';
import {root as source,cli,temporaryRoot} from './helpers.mjs';
import {storageTree} from './storage-preservation.mjs';

function setup(t) {
  const root=fs.mkdtempSync(path.join(temporaryRoot,'current-storage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
async function unsupported(root,kind) {
  fs.mkdirSync(root,{recursive:true});
  if(kind==='marker-only')fs.writeFileSync(path.join(root,'migration.json'),'interrupted preparation');
  else if(kind.startsWith('journal-only-')) {
    const state={...emptyState(),protocol:2};
    const record=kind==='journal-only-full'?JSON.stringify({hash:digest(state),state})+'\n':kind==='journal-only-delta'?deltaRecord({protocol:4,previous:0,revision:1,changes:[]}):kind==='journal-only-torn'?'{"state":':'';
    fs.writeFileSync(path.join(root,'journal.jsonl'),record);
  } else if(['current-marker','full-state-current','null-checkpoint','old-checkpoint'].includes(kind)) {
    const store=new Store(root);await store.close();
    if(kind==='current-marker')fs.writeFileSync(path.join(root,'migration.json'),'null');
    if(kind==='null-checkpoint')writeJson(path.join(root,'checkpoint.json'),null);
    if(kind==='old-checkpoint')writeJson(path.join(root,'checkpoint.json'),{protocol:3});
    if(kind==='full-state-current'){const state=loadState(root).state;fs.appendFileSync(path.join(root,'journal.jsonl'),JSON.stringify({hash:digest(state),state})+'\n');}
  } else {
    const value=kind==='state-null'?null:kind==='state-false'?false:kind==='state-missing'?{revision:0,runs:[],events:[]}:{...emptyState(),protocol:Number(kind.slice('state-'.length))};
    writeJson(path.join(root,'state.json'),value);
  }
  writeJson(path.join(root,'archives','retained.json'),{evidence:'original bytes must survive'});
}

for(const kind of ['journal-only-full','journal-only-delta','journal-only-empty','journal-only-torn','marker-only','current-marker'])test(`${kind} cannot initialize a store or service and remains untouched`,async t=>{
  const root=setup(t);await unsupported(root,kind);const before=storageTree(root);
  assert.throws(()=>loadState(root),error=>error.code==='UPDATE_PENDING');assert.throws(()=>new Store(root),error=>error.code==='UPDATE_PENDING');
  await assert.rejects(serve(root,cli),error=>error.code==='UPDATE_PENDING');await assert.rejects(connect(root,cli),error=>error.code==='UPDATE_PENDING');
  assert.deepEqual(storageTree(root),before);
});

for(const kind of ['state-2','state-3','state-99','state-missing','state-null','state-false','journal-only-full','journal-only-delta','journal-only-empty','journal-only-torn','marker-only','current-marker','full-state-current','null-checkpoint','old-checkpoint'])test(`installer rejects ${kind} before staging or registration and preserves original data`,async t=>{
  const root=setup(t),data=path.join(root,'data'),install=path.join(root,'install');await unsupported(data,kind);
  fs.mkdirSync(install);fs.writeFileSync(path.join(install,'current.json'),'previous immutable pointer\n');
  const beforeData=storageTree(data),beforeInstall=storageTree(install);
  const result=await exec(process.execPath,[path.join(source,'scripts','install.mjs')],{env:{...process.env,
    AGENT_DELEGATION_HOME:data,AGENT_DELEGATION_INSTALL_ROOT:install,AGENT_DELEGATION_CODEX_EXECUTABLE:path.join(root,'must-not-run-cli')},timeout:30000});
  assert.equal(result.code,0,result.stderr);const response=JSON.parse(result.stdout);assert.equal(response.code,'UPDATE_PENDING');assert.equal(response.update_pending,true);
  assert.deepEqual(storageTree(data),beforeData);assert.deepEqual(storageTree(install),beforeInstall);
});
