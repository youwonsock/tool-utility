import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store,loadState,emptyState,writeJson,exec,connect,serve} from '../dist/index.mjs';
import {root as source,cli,temporaryRoot} from './helpers.mjs';
import {storageTree} from './storage-preservation.mjs';

function setup(t) {
  const root=fs.mkdtempSync(path.join(temporaryRoot,'current-storage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
async function unsupported(root,kind) {
  fs.mkdirSync(root,{recursive:true});
  if(kind==='null-checkpoint'||kind==='other-checkpoint') {
    const store=new Store(root);await store.close();
    writeJson(path.join(root,'checkpoint.json'),kind==='null-checkpoint'?null:{protocol:99});
  } else {
    const value=kind==='state-null'?null:kind==='state-false'?false:kind==='state-missing'?{revision:0,runs:[],events:[]}:{...emptyState(),protocol:99};
    writeJson(path.join(root,'state.json'),value);
  }
}
const kinds=['state-99','state-missing','state-null','state-false','null-checkpoint','other-checkpoint'];

for(const kind of kinds)test(`${kind} cannot initialize a store or service and remains untouched`,async t=>{
  const root=setup(t);await unsupported(root,kind);const before=storageTree(root);
  assert.throws(()=>loadState(root),error=>error.code==='UPDATE_PENDING');assert.throws(()=>new Store(root),error=>error.code==='UPDATE_PENDING');
  await assert.rejects(serve(root,cli),error=>error.code==='UPDATE_PENDING');await assert.rejects(connect(root,cli),error=>error.code==='UPDATE_PENDING');
  assert.deepEqual(storageTree(root),before);
});

for(const kind of kinds)test(`${kind} blocks installation without changing data or the current install`,async t=>{
  const root=setup(t),data=path.join(root,'data'),install=path.join(root,'install');await unsupported(data,kind);
  fs.mkdirSync(install);fs.writeFileSync(path.join(install,'current.json'),'previous immutable pointer\n');
  const beforeData=storageTree(data),beforeInstall=storageTree(install);
  const result=await exec(process.execPath,[path.join(source,'scripts','install.mjs')],{env:{...process.env,
    AGENT_DELEGATION_HOME:data,AGENT_DELEGATION_INSTALL_ROOT:install,AGENT_DELEGATION_CODEX_EXECUTABLE:path.join(root,'must-not-run-cli')},timeout:30000});
  assert.equal(result.code,0,result.stderr);const response=JSON.parse(result.stdout);assert.equal(response.code,'UPDATE_PENDING');assert.equal(response.update_pending,true);
  assert.deepEqual(storageTree(data),beforeData);assert.deepEqual(storageTree(install),beforeInstall);
});
