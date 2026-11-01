import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  toolPolicy,
  checkedMutationPath,
  scopeAllows,
  workerPermissionKey,
  ScopeGuard,
  awaitGuardedTermination,
  hash,
  readJson,
  sleep,
  git,
  resultCommit,
} from '../dist/index.mjs';
import { fixture, submit, task, until } from './helpers.mjs';

test('common scope semantics and direct mutation policy cover every edit, delete, rename and patch endpoint', async (t) => {
  const f = await fixture(t);
  f.engine.stop();
  fs.mkdirSync(path.join(f.repo, 'src'));
  fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), 'rules');
  const policy = (tool, input, scope = ['src/**']) => toolPolicy(tool, input, f.repo, ['AGENTS.md'], scope);
  assert.equal(scopeAllows(['src/**'], 'src/a.txt'), true);
  assert.equal(scopeAllows(['src/'], 'src2/a.txt'), false);
  assert.equal(scopeAllows(['src/a.txt'], 'src/a.txt/b'), false);
  assert.equal(scopeAllows(['**'], '.GiT/config'), false);
  assert.equal(policy('Write', { file_path: 'src/new.txt' }), 'allow');
  for (const [tool, input] of [
    ['Write', { file_path: 'outside.txt' }],
    ['Delete', { path: 'AGENTS.md' }],
    ['Delete', { path: '.' }],
    ['Rename', { old_path: 'src/a.txt', new_path: 'outside.txt' }],
    ['Rename', { old_path: 'outside.txt', new_path: 'src/a.txt' }],
    ['Edit', { files: [{ path: 'src/a.txt' }, { path: 'outside.txt' }] }],
    ['Edit', { path: 'src/../src/a.txt' }],
    ['Edit', { path: 'src/a.txt:stream' }],
    ['Edit', { path: 'src/a.txt.' }],
    ['Edit', { path: 'src/a.txt ' }],
    ['Edit', { path: 'src/a.txt', cwd: path.dirname(f.repo) }],
    ['Edit', {}],
    ['Edit', { path: 'src/a.txt', cwd: f.repo, workdir: path.dirname(f.repo) }],
    ['Edit', { paths: ['src/a.txt', 'outside.txt'] }],
    [
      'apply_patch',
      { input: '*** Begin Patch\n*** Update File: src/a.txt\n@@\n-a\n+b\n*** Move to: outside.txt\n*** End Patch' },
    ],
    [
      'apply_patch',
      { input: '*** Begin Patch\n*** Add File: src/a.txt\n+a\n*** Delete File: AGENTS.md\n*** End Patch' },
    ],
  ])
    assert.equal(policy(tool, input), 'deny', JSON.stringify({ tool, input }));
  assert.equal(
    policy('apply_patch', { input: '*** Begin Patch\n*** Add File: src/a.txt\n+a\n*** End Patch' }),
    'allow',
  );
  const canonicalPatch = '*** Begin Patch\n*** Add File: src/a.txt\n+a\n*** End Patch';
  assert.equal(policy('apply_patch', { command: canonicalPatch }), 'allow');
  assert.equal(policy('apply_patch', { input: canonicalPatch, command: canonicalPatch }), 'allow');
  for (const command of [
    '*** Begin Patch\n*** Add File: outside.txt\n+bad\n*** End Patch',
    '*** Begin Patch\n*** Update File: src/a.txt\n*** Move to: outside.txt\n@@\n-a\n+b\n*** End Patch',
    '*** Begin Patch\n*** Add File: src/a.txt\n+ok\n*** Delete File: AGENTS.md\n*** End Patch',
    '*** Begin Patch\n*** Add File: src/a.txt\n+missing terminator',
    '*** Begin Patch\r\n*** Delete File: AGENTS.md\r\n*** End Patch',
    '*** Begin Patch\n*** Delete File: AGENTS.md \n*** End Patch',
  ])
    assert.equal(policy('apply_patch', { command }), 'deny', command);
  assert.equal(
    policy('apply_patch', {
      command: canonicalPatch,
      input: '*** Begin Patch\n*** Add File: outside.txt\n+hidden\n*** End Patch',
    }),
    'deny',
  );
  assert.equal(policy('apply_patch', { command: { patch: canonicalPatch } }), 'deny');
  assert.equal(policy('mcp__files__write', { path: 'outside.txt' }), 'deny');
  assert.equal(policy('mcp__files__write', { path: 'src/a.txt' }), 'ask');
  assert.equal(policy('Bash', { command: 'node build.mjs' }), 'ask');
  assert.equal(policy('write_stdin', { chars: 'continue\n' }), 'ask');
  for (const command of [
    'git -C . reset --hard',
    'git update-ref HEAD bad',
    'codex exec x',
    'node script.mjs &',
    'nohup node script.mjs',
    'echo x > AGENTS.md',
    'echo x > .git/config',
  ])
    assert.equal(policy('Bash', { command }), 'deny', command);
  assert.equal(policy('Bash', { command: 'node script.mjs & wait' }), 'deny');
  assert.equal(policy('Bash', { command: 'node script.mjs 2>&1' }), 'ask');
  assert.equal(policy('Bash', { command: 'node build.mjs', run_in_background: true }), 'deny');
});

test('path checks reject existing and new paths through links and protect case aliases and parent deletes', async (t) => {
  const f = await fixture(t);
  f.engine.stop();
  const outside = path.join(f.dir, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.repo, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const file of ['escape/new.txt', 'AGENTS.md', '.GIT/config'])
    assert.throws(
      () => checkedMutationPath(f.repo, file, ['**'], ['AGENTS.md']),
      (e) => ['SCOPE_VIOLATION', 'CONTEXT_CHANGED'].includes(e.code),
    );
  fs.mkdirSync(path.join(f.repo, 'rules'));
  fs.writeFileSync(path.join(f.repo, 'rules', 'AGENTS.md'), 'rules');
  assert.throws(
    () => checkedMutationPath(f.repo, 'rules', ['**'], ['rules/AGENTS.md']),
    (e) => e.code === 'CONTEXT_CHANGED',
  );
  assert.equal(checkedMutationPath(f.repo, 'new/future.txt', ['new/**'], []), 'new/future.txt');
});

test('permission grants bind exact command, cwd, attempt, scope and context policy', async (t) => {
  const f = await fixture(t);
  f.engine.stop();
  const spec = { id: 'a', directory: f.repo, scope: ['a.txt'], context: [] };
  const key = workerPermissionKey(spec, 'Bash', { command: 'node x', cwd: f.repo });
  for (const [other, input] of [
    [
      { ...spec, id: 'b' },
      { command: 'node x', cwd: f.repo },
    ],
    [
      { ...spec, scope: ['**'] },
      { command: 'node x', cwd: f.repo },
    ],
    [spec, { command: 'node y', cwd: f.repo }],
    [spec, { command: 'node x', cwd: path.join(f.repo, 'src') }],
  ])
    assert.notEqual(workerPermissionKey(other, 'Bash', input), key);
});

async function monitored(t, scope = ['a.txt'], prepare) {
  const f = await fixture(t);
  f.engine.stop();
  await prepare?.(f);
  const job_dir = path.join(f.data, 'guard');
  fs.mkdirSync(job_dir);
  fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), 'rules');
  const state = { phase: 'implementing' },
    spec = {
      id: 'guard',
      directory: f.repo,
      job_dir,
      scope,
      context: [{ path: 'AGENTS.md', hash: hash('rules'), tracked: false }],
    };
  let stopped = 0;
  const guard = new ScopeGuard({ spec, state, save: () => {} }, async () => {
    stopped++;
  });
  t.after(() => guard.stop());
  await guard.start();
  return { ...f, guard, state, spec, stopped: () => stopped };
}
test('worker-local monitor allows ignored generated outputs but stops out-of-scope writes and preserves files', async (t) => {
  const f = await monitored(t);
  fs.writeFileSync(path.join(f.repo, 'ignored.txt'), 'generated');
  await f.guard.check();
  f.guard.assertHealthy();
  fs.writeFileSync(path.join(f.repo, 'outside.txt'), 'preserve this evidence');
  for (let i = 0; i < 50 && !f.guard.fault(); i++) await sleep(20);
  await f.guard.check();
  assert.equal(f.guard.fault().code, 'SCOPE_VIOLATION');
  assert.equal(f.stopped(), 1);
  assert.equal(fs.readFileSync(path.join(f.repo, 'outside.txt'), 'utf8'), 'preserve this evidence');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.spec.job_dir, 'scope-violation.json'))).code, 'SCOPE_VIOLATION');
});
test('monitor tolerates an atomic save of an in-scope file but not one outside scope or left behind', async (t) => {
  const f = await monitored(t),
    temp = path.join(f.repo, 'a.txt.tmp.65502.78d4486ba9cb');
  fs.writeFileSync(temp, 'saved');
  await f.guard.check();
  f.guard.assertHealthy();
  fs.renameSync(temp, path.join(f.repo, 'a.txt'));
  await sleep(40);
  await f.guard.check();
  f.guard.assertHealthy();
  fs.writeFileSync(temp, 'left behind');
  const base = (await git(f.repo, ['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(
    resultCommit(f.repo, base, ['a.txt'], f.spec.context, 'title'),
    (e) => e.code === 'SCOPE_VIOLATION',
  );
  const g = await monitored(t);
  fs.writeFileSync(path.join(g.repo, 'outside.txt.tmp.65502.78d4486ba9cb'), 'x');
  await g.guard.check();
  assert.equal(g.guard.fault().code, 'SCOPE_VIOLATION');
  assert.equal(g.stopped(), 1);
});
async function settled(f, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !f.guard.fault()) {
    await sleep(100);
    if (!f.guard.pending.size && !f.guard.collapsed.size && !f.guard.checking) break;
  }
  await f.guard.check();
}
function exclude(f, pattern) {
  fs.appendFileSync(path.join(f.repo, '.git', 'info', 'exclude'), `${pattern}\n`);
}
function burst(f, directory, count, extension = 'js') {
  fs.mkdirSync(path.join(f.repo, directory), { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(f.repo, directory, `f${i}.${extension}`), 'x');
}
test('monitor survives a burst of ignored build output past its notification limit', async (t) => {
  const f = await monitored(t);
  exclude(f, 'out/');
  const started = Date.now();
  burst(f, 'out', 20000);
  burst(f, 'out/nested', 2000);
  await settled(f);
  assert.equal(f.guard.fault(), undefined);
  assert.equal(f.stopped(), 0);
  assert.ok(Date.now() - started < 10000, 'Inspection must stay inside its heartbeat window.');
});
test('monitor batches ignored files whose directory is not ignored', async (t) => {
  const f = await monitored(t);
  exclude(f, '*.log');
  burst(f, '.', 3000, 'log');
  await settled(f);
  assert.equal(f.guard.fault(), undefined);
  assert.equal(f.stopped(), 0);
});
test('monitor still stops a transient out-of-scope write hidden in an ignored burst', async (t) => {
  const f = await monitored(t);
  exclude(f, 'out/');
  burst(f, 'out', 6000);
  fs.writeFileSync(path.join(f.repo, 'leak.txt'), 'x');
  fs.rmSync(path.join(f.repo, 'leak.txt'));
  for (let i = 0; i < 100 && !f.guard.fault(); i++) await sleep(50);
  assert.equal(f.guard.fault()?.code, 'SCOPE_VIOLATION');
  assert.equal(f.stopped(), 1);
});
test('monitor allows a burst inside a recursive scope and fails closed outside it', async (t) => {
  const inside = await monitored(t, ['gen/**']);
  burst(inside, 'gen', 6000);
  await settled(inside);
  assert.equal(inside.guard.fault(), undefined);
  const outside = await monitored(t);
  burst(outside, 'gen', 6000);
  for (let i = 0; i < 100 && !outside.guard.fault(); i++) await sleep(50);
  assert.ok(['SCOPE_VIOLATION', 'SCOPE_GUARD_UNKNOWN'].includes(outside.guard.fault()?.code));
  assert.equal(outside.stopped(), 1);
});
test('monitor still stops an edit to a tracked file inside an ignored directory', async (t) => {
  const f = await monitored(t, ['a.txt'], async (prepared) => {
    fs.mkdirSync(path.join(prepared.repo, 'out'));
    fs.writeFileSync(path.join(prepared.repo, 'out', 'tracked.txt'), 'one');
    await git(prepared.repo, ['add', '-f', 'out/tracked.txt']);
    await git(prepared.repo, ['commit', '-qm', 'tracked', '--no-verify']);
    exclude(prepared, 'out/');
  });
  burst(f, 'out', 50);
  await settled(f);
  assert.equal(f.guard.fault(), undefined);
  fs.writeFileSync(path.join(f.repo, 'out', 'tracked.txt'), 'two');
  for (let i = 0; i < 100 && !f.guard.fault(); i++) await sleep(50);
  assert.equal(f.guard.fault()?.code, 'SCOPE_VIOLATION');
});
test('monitor forgets ignore verdicts when a gitignore file changes', async (t) => {
  const f = await monitored(t, ['.gitignore', 'a.txt']);
  exclude(f, 'out/');
  burst(f, 'out', 5);
  await settled(f);
  assert.ok(f.guard.ignoredDirectories.has('out'));
  fs.appendFileSync(path.join(f.repo, '.gitignore'), '\n# changed\n');
  await sleep(100);
  assert.equal(f.guard.ignoredDirectories.has('out'), false);
});
test('monitor permits creating directories needed by exact and recursive scopes and fails closed on watcher errors', async (t) => {
  const f = await monitored(t, ['new/**']);
  fs.mkdirSync(path.join(f.repo, 'new'));
  fs.writeFileSync(path.join(f.repo, 'new', 'a.txt'), 'ok');
  await f.guard.check();
  f.guard.assertHealthy();
  f.guard.watcher.emit('error', new Error('injected watcher loss'));
  await sleep(1);
  assert.equal(f.guard.fault().code, 'SCOPE_GUARD_UNKNOWN');
  assert.equal(f.stopped(), 1);
});
test('monitor detects ignored protected context and freezes all source during declared verification', async (t) => {
  const f = await monitored(t, ['**']);
  await f.guard.beginVerification();
  fs.writeFileSync(path.join(f.repo, 'base.txt'), 'verification side effect');
  await f.guard.check();
  assert.equal(f.guard.fault().code, 'VERIFICATION_CHANGED');
  const g = await monitored(t, ['**']);
  fs.writeFileSync(path.join(g.repo, 'AGENTS.md'), 'mutated rules');
  await g.guard.check();
  assert.equal(g.guard.fault().code, 'CONTEXT_CHANGED');
});
test('source snapshots hash unchanged files once and still see every rewrite', async (t) => {
  const f = await monitored(t, ['**']);
  fs.writeFileSync(path.join(f.repo, 'big.txt'), 'one');
  await f.guard.beginVerification();
  await f.guard.check();
  assert.equal(f.guard.fault(), undefined);
  const known = f.guard.digests.get('base.txt');
  assert.ok(known);
  await f.guard.check();
  assert.equal(f.guard.digests.get('base.txt'), known);
  const original = fs.statSync(path.join(f.repo, 'big.txt'));
  fs.writeFileSync(path.join(f.repo, 'big.txt'), 'two');
  fs.utimesSync(path.join(f.repo, 'big.txt'), original.atime, original.mtime);
  await f.guard.check();
  assert.equal(f.guard.fault().code, 'VERIFICATION_CHANGED');
});
test('evidence publication failure still records the original scope violation and stops the runtime', async (t) => {
  const f = await monitored(t),
    rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (String(destination).endsWith('scope-violation.json')) throw new Error('injected evidence write failure');
    return rename(source, destination);
  });
  fs.writeFileSync(path.join(f.repo, 'outside.txt'), 'keep');
  await f.guard.check();
  assert.equal(f.guard.fault().code, 'SCOPE_VIOLATION');
  assert.equal(f.stopped(), 1);
  assert.equal(f.state.error_code, 'SCOPE_VIOLATION');
  assert.match(f.state.error_details.collection_error, /injected/);
});
test('uncertain owned stop keeps monitoring with bounded backoff and never repeats an external task', async () => {
  let confirms = 0,
    checks = 0;
  const waits = [];
  await awaitGuardedTermination(
    {
      check: async () => {
        checks++;
      },
    },
    async () => ++confirms === 5,
    async (delay) => {
      waits.push(delay);
    },
  );
  assert.equal(confirms, 5);
  assert.equal(checks, 5);
  assert.deepEqual(waits, [100, 200, 400, 800]);
});
test('independent heartbeat stops owned execution while an inspection is held without another native callback', async (t) => {
  const f = await monitored(t);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(f.guard, 'inspect', () => held);
  const checking = f.guard.check();
  f.guard.checkHeartbeat(Date.now() + 11000);
  assert.equal(f.guard.fault().code, 'SCOPE_GUARD_UNKNOWN');
  assert.equal(f.stopped(), 1);
  assert.equal(f.state.scope_guard.status, 'unknown');
  release();
  await checking;
  assert.equal(f.state.scope_guard.status, 'unknown');
});

test('a running worker does not rewrite its state and transcript on every poll', async (t) => {
  const f = await fixture(t);
  const started = await submit(f, [task('a', { files: { 'a.txt': 'x' }, delay: 7000 })]);
  const attempt = (await until(f, started.run_id, (run) => fs.existsSync(run.tasks[0].attempts[0]?.job_dir ?? '')))
    .tasks[0].attempts[0];
  const report = path.join(attempt.job_dir, 'worker.json');
  for (let i = 0; i < 200 && readJson(report)?.phase !== 'implementing'; i++) await sleep(50);
  const writes = { 'worker.json': new Set(), 'transcript.json': new Set() };
  const watcher = fs.watch(attempt.job_dir, (_event, name) => {
    for (const file of Object.keys(writes)) if (String(name).startsWith(`${file}.`)) writes[file].add(String(name));
  });
  t.after(() => watcher.close());
  await sleep(4000);
  watcher.close();
  assert.ok(writes['worker.json'].size >= 1, 'The monitor must still refresh its durable state.');
  assert.ok(writes['worker.json'].size <= 6, `worker.json was written ${writes['worker.json'].size} times.`);
  assert.ok(
    writes['transcript.json'].size <= 3,
    `transcript.json was written ${writes['transcript.json'].size} times.`,
  );
  const finished = await until(f, started.run_id, (run) => run.tasks[0].state === 'needs_review', 60000);
  assert.ok(fs.existsSync(path.join(finished.tasks[0].attempts[0].job_dir, 'transcript.json')));
});
