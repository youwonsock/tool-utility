import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, responseBytes, digest, inside, snapshot, materialize, worktree } from '../dist/index.mjs';
import { fixture, git } from './helpers.mjs';

test('journal replay survives a torn tail; completed request deduplication survives restart',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'journal-')); let store=new Store(root);
  const first=await store.mutation('one',{a:1},async()=>({value:42}));
  fs.rmSync(path.join(root,'state.json')); fs.appendFileSync(path.join(root,'journal.jsonl'),'{"torn":');
  store=new Store(root); assert.deepEqual(await store.mutation('one',{a:1},async()=>{throw new Error('must not execute')}),first);
  store.save(); fs.rmSync(path.join(root,'state.json')); assert.equal(new Store(root).state.requests.one.status,'done');
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
