import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { platforms, sleep, uid } from '../dist/index.mjs';
import { fixture, task, submit, until, review, ready, finalize, callOk } from './helpers.mjs';
import { mockProfiles, selection } from './native-helpers.mjs';
for (const platform of platforms) {
  test(`${platform} worker implements, answers a question, verifies, integrates and finalizes`, async (t) => {
    const f = await fixture(t);
    mockProfiles(f);
    const s = await submit(f, [task('a', { files: { 'a.txt': platform }, input: 'question' })], {
      worker: selection(platform),
    });
    let run = await until(f, s.run_id, (r) => r.tasks[0].attempts[0]?.inputs.length);
    const a = run.tasks[0].attempts[0];
    assert.equal(a.worker.backend, platform);
    const invalid = await f.call('respond_to_request', {
      request_id: `invalid-${platform}`,
      run_id: run.id,
      attempt_id: a.id,
      input_id: a.inputs[0].id,
      decision: 'answer',
      answers: [],
    });
    assert.equal(invalid.error.code, 'INPUT');
    await callOk(f, 'respond_to_request', {
      request_id: `answer-${platform}`,
      run_id: run.id,
      attempt_id: a.id,
      input_id: a.inputs[0].id,
      decision: 'answer',
      answers: [['Proceed']],
    });
    run = await until(f, run.id, (r) => r.tasks[0].state === 'needs_review');
    assert.equal(a.verification[0].exit_code, 0);
    assert.equal(a.worker.stopped, true);
    await ready(f, run);
    assert.equal(run.validation.attempt.worker.backend, undefined);
    assert.equal(run.validation.attempt.worker.session_id, undefined);
    assert.equal((await finalize(f, run)).state, 'completed');
    assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), platform);
  });
}

test('mixed workers preserve dependency gates, resource leases and correction configuration', async (t) => {
  const f = await fixture(t);
  f.engine.stop();
  mockProfiles(f);
  const resource = {
    resource_key: 'editor',
    connection: { name: 'editor', config: { type: 'http', url: 'http://127.0.0.1:59999/mcp' } },
    probe: {
      executable: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({instance_id:"editor"}))'],
      read_only: true,
    },
    expected_instance: 'editor',
  };
  const s = await submit(
    f,
    [
      task(
        'a',
        { files: { 'a.txt': 'first' }, input: 'question' },
        { worker: selection('codex'), resources: ['editor'] },
      ),
      task('b', { files: { 'b.txt': 'kilo' } }, { worker: selection('kilo'), resources: ['editor'] }),
      task('c', { files: { 'c.txt': 'claude' } }, { worker: selection('claude-code'), dependencies: ['a'] }),
      task('d', { files: { 'd.txt': 'opencode' } }, { worker: selection('opencode'), dependencies: ['c'] }),
    ],
    { resources: [resource] },
  );
  const run = f.store.state.runs.find((r) => r.id === s.run_id);
  const advance = async (predicate) => {
    const deadline = Date.now() + 90000;
    do {
      await f.engine.tick();
      if (predicate()) return;
      await sleep(100);
    } while (Date.now() < deadline);
    assert.fail('Mixed-worker scheduler did not converge.');
  };
  await advance(() => run.tasks[0].attempts[0]?.inputs.length);
  assert.equal(run.tasks[1].attempts.length, 0);
  assert.equal(run.tasks[2].attempts.length, 0);
  const first = run.tasks[0].attempts[0],
    frozen = JSON.parse(JSON.stringify(run.tasks[0].worker));
  await callOk(f, 'respond_to_request', {
    request_id: uid('answer'),
    run_id: run.id,
    attempt_id: first.id,
    input_id: first.inputs[0].id,
    decision: 'answer',
    answers: [['Proceed']],
  });
  await advance(() => run.tasks[0].state === 'needs_review' && run.tasks[1].state === 'needs_review');
  assert.equal(run.tasks[2].attempts.length, 0);
  const profiles = JSON.parse(fs.readFileSync(path.join(f.data, 'profiles.json')));
  profiles.profiles['mock-codex'].executable = 'missing-codex';
  fs.writeFileSync(path.join(f.data, 'profiles.json'), JSON.stringify(profiles));
  await review(f, run, 'a', 'request_changes', 'FAKE_ACTION:{"files":{"a.txt":"corrected"}}');
  const stale = await f.call('approve_task', {
    request_id: uid('stale'),
    run_id: run.id,
    task_id: 'a',
    attempt_id: first.id,
    commit: first.commit,
  });
  assert.ok(stale.error);
  await advance(() => run.tasks[0].attempts.length === 2 && run.tasks[0].state === 'needs_review');
  assert.deepEqual(run.tasks[0].attempts[1].execution, frozen);
  assert.equal(run.tasks[0].attempts[1].worker.backend, 'codex');
  await review(f, run, 'a');
  await review(f, run, 'b');
  await advance(() => run.tasks[2].state === 'needs_review');
  assert.equal(run.tasks[3].attempts.length, 0);
  await review(f, run, 'c');
  await advance(() => run.tasks[3].state === 'needs_review');
  await review(f, run, 'd');
  await callOk(f, 'validate_run', { request_id: uid('validate'), run_id: run.id });
  await advance(() => run.state === 'waiting_final_review');
  assert.equal((await finalize(f, run)).state, 'completed');
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'corrected');
});
