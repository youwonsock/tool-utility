import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, Engine, exec, uid, sleep, remoteCall } from '../dist/index.mjs';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const cli = path.join(root,'dist/cli.mjs');
export const fake = path.join(root,'test/fake-opencode.mjs');
// Windows CI exposes an 8.3 TEMP alias; use its native long path for child Node
// entry points while preserving Korean names and spaces in every fixture.
export const temporaryRoot = fs.realpathSync.native(os.tmpdir());
export const readState = data => JSON.parse(fs.readFileSync(path.join(data,'state.json'),'utf8'));
export const git = async (repo,...args) => {
  const r = await exec('git',args,{ cwd:repo }); if (r.code !== 0) throw new Error(r.stderr); return r.stdout.trim();
};
export async function fixture(t, { service = false } = {}) {
  const dir = fs.mkdtempSync(path.join(temporaryRoot,'위임 test '));
  const repo = path.join(dir,'한글 project'), data = path.join(dir,'data'); fs.mkdirSync(repo);
  await git(repo,'init','-b','main'); await git(repo,'config','user.name','Test'); await git(repo,'config','user.email','test@localhost');
  fs.writeFileSync(path.join(repo,'.gitignore'),'AGENTS.md\n.specs/\nignored.txt\n'); fs.writeFileSync(path.join(repo,'base.txt'),'base\n');
  await git(repo,'add','.'); await git(repo,'commit','-m','initial');
  const store = new Store(data); const engine = new Engine(store,cli,{ opencode:process.execPath, opencode_args:[fake], concurrency:2 });
  const env = { ...process.env, CODEX_OPENCODE_HOME:data, CODEX_OPENCODE_EXECUTABLE:process.execPath, CODEX_OPENCODE_EXECUTABLE_ARGS:JSON.stringify([fake]) };
  if (!service) engine.start();
  t.after(async () => {
    engine.stop();
    for (const run of store.state.runs) if (!['completed','cancelled'].includes(run.state)) { await engine.cancel(run).catch(()=>{}); }
    for (let i=0;i<100;i++) { await engine.serial(()=>engine.tick()).catch(()=>{}); if (!engine.allAttempts().some(a=>['running','cancelling','launching','needs_input','delivery_uncertain'].includes(a.state))) break; await sleep(100); }
    // Temporary evidence is deliberately retained on test failure for diagnosis.
    if(fs.existsSync(path.join(data,'state.json'))) {
      const disk=readState(data);
      for(const run of disk.runs)for(const task of run.tasks)for(const a of task.attempts){
        if(!a.error && !['orphaned','stop_uncertain'].includes(a.state))continue;
        t.diagnostic(JSON.stringify({task:task.spec.id,attempt:a.state,error:a.error,phase:a.worker?.phase}));
      }
    }
  });
  return { dir,repo,data,store,engine,env, call:(name,args)=>engine.call(name,args) };
}
export const task = (id, action={}, extra={}) => ({ id, goal:`FAKE_ACTION:${JSON.stringify(action)}`, scope:[`${id}.txt`], acceptance:['Requested content exists'], verification:[{ command:'node -e "process.exit(0)"' }], ...extra });
export async function callOk(f,name,args) { const r = await f.call(name,args); if (r.error) throw new Error(JSON.stringify(r.error)); return r; }
export async function submit(f,tasks,extra={}) { return callOk(f,'submit_tasks',{ request_id:uid('request'),repo:f.repo,tasks,final_verification:[{ command:'node -e "process.exit(0)"' }],...extra }); }
export async function until(f,id,predicate,timeout=30000) {
  const end = Date.now()+timeout;
  while (Date.now()<end) { const run = f.store.state.runs.find(r=>r.id===id); if (predicate(run)) return run; await sleep(100); }
  throw new Error(`Timed out: ${JSON.stringify(f.store.state.runs.find(r=>r.id===id),null,2)}`);
}
export async function review(f,run,id,decision='approve',feedback) {
  const a = run.tasks.find(t=>t.spec.id===id).attempts.at(-1);
  return callOk(f,'review_task',{ request_id:uid('review'),run_id:run.id,task_id:id,attempt_id:a.id,commit:a.commit,decision,feedback });
}
export async function ready(f,run) {
  for (const t of run.tasks) await review(f,run,t.spec.id);
  await callOk(f,'validate_run',{ request_id:uid('validation'),run_id:run.id });
  return until(f,run.id,r=>r.state==='waiting_final_review');
}
export async function finalize(f,run) {
  return callOk(f,'finalize_run',{ request_id:uid('finalize'),run_id:run.id,validation_id:run.validation.id,commit:run.validation.commit,revision:run.revision });
}
