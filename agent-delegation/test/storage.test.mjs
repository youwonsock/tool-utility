import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, responseBytes, inside, snapshot, materialize, worktree, writeJson, readJson } from '../dist/index.mjs';
import { fixture, git } from './helpers.mjs';

function windows(t) {
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  t.after(()=>Object.defineProperty(process,'platform',descriptor));
}

test('transient Windows replacement locks preserve the old record until atomic publication',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atomic-lock-')),file=path.join(root,'worker.json');
  writeJson(file,{phase:'verifying'});windows(t);
  const rename=fs.renameSync;let blocked=0;
  t.mock.method(fs,'renameSync',(source,destination)=>{
    if(destination===file&&blocked++<3) {
      assert.deepEqual(readJson(file),{phase:'verifying'});
      throw Object.assign(new Error('Temporary sharing violation'),{code:['EPERM','EBUSY','EACCES'][blocked-1]});
    }
    return rename(source,destination);
  });
  writeJson(file,{phase:'completed',stopped:true});
  assert.deepEqual(readJson(file),{phase:'completed',stopped:true});
  assert.deepEqual(fs.readdirSync(root),['worker.json']);
});

test('persistent replacement failure remains explicit without damaging the prior record',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atomic-failure-')),file=path.join(root,'worker.json');
  writeJson(file,{phase:'verifying'});windows(t);
  const failure=Object.assign(new Error('Persistent sharing violation'),{code:'EPERM'});
  let attempts=0;
  const mock=t.mock.method(fs,'renameSync',()=>{attempts++;throw failure;});
  assert.throws(()=>writeJson(file,{phase:'completed'}),error=>error===failure);
  assert.ok(attempts>1&&attempts<20);
  assert.deepEqual(readJson(file),{phase:'verifying'});assert.deepEqual(fs.readdirSync(root),['worker.json']);
  const fatal=Object.assign(new Error('Non-transient failure'),{code:'EIO'});attempts=0;
  mock.mock.mockImplementation(()=>{attempts++;throw fatal;});
  assert.throws(()=>writeJson(file,{phase:'completed'}),error=>error===fatal);assert.equal(attempts,1);
  assert.deepEqual(readJson(file),{phase:'verifying'});assert.deepEqual(fs.readdirSync(root),['worker.json']);
});

test('journal replay survives a torn tail; completed request deduplication survives restart',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'journal-')); let store=new Store(root);
  const first=await store.mutation('one',{a:1},async()=>({value:42}));
  fs.appendFileSync(path.join(root,'journal.jsonl'),'{"torn":');
  store=new Store(root); assert.deepEqual(await store.mutation('one',{a:1},async()=>{throw new Error('must not execute')}),first);
  store.save(); assert.equal(new Store(root).state.requests.one.status,'done');
  await assert.rejects(store.mutation('one',{a:2},async()=>{}),/different content/);
});
test('response and artifact budgets account for UTF-8, escaping and MCP envelopes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pages-')),store=new Store(root);
  const content='한글 😀 "quoted"\\\n'.repeat(5000); const id=store.artifact('run','text',content);
  let offset=0,actual='';
  do { const page=store.artifactPage(id,offset,16384); assert.ok(responseBytes(page)<=16384); assert.ok(!page.text.includes('\ufffd')); actual+=page.text; offset=page.next_offset; } while(offset!==null);
  assert.equal(actual,content);
  const items=Array.from({length:100},(_,i)=>({id:i,text:'한글"'.repeat(80)}));
  let cursor,all=[]; do { const page=store.page(items,cursor); assert.ok(responseBytes(page)<=4096); all.push(...page.items); cursor=page.next_cursor; }while(cursor);
  assert.deepEqual(all,items);
  const bounded=store.bounded({text:content}); assert.ok(bounded.artifact_id); assert.ok(responseBytes(bounded)<=4096);
  assert.throws(()=>store.artifactPage('../../secret',0,100),/Unsafe path/);
});
test('context cannot escape, overwrite a tracked source or include common authentication files',async t=>{
  const f=await fixture(t); fs.writeFileSync(path.join(f.repo,'AGENTS.md'),'rules'); fs.writeFileSync(path.join(f.repo,'.env'),'SECRET=never');
  await assert.rejects(snapshot(f.store,'run',f.repo,['../escape']),/Unsafe path/);
  await assert.rejects(snapshot(f.store,'run',f.repo,['.env']),/Authentication/);
  const files=await snapshot(f.store,'run',f.repo,['base.txt']); const dir=path.join(f.dir,'context-worktree'); await worktree(f.repo,dir,await git(f.repo,'rev-parse','HEAD'));
  fs.writeFileSync(path.join(dir,'base.txt'),'different'); await assert.rejects(materialize(f.store,dir,files),/overwrite/);
});
