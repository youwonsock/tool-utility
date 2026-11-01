import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { schemas } from '../dist/index.mjs';
import { fixture, task, submit, callOk, runDefaults } from './helpers.mjs';

const newRun = (fields) => ({
  request_id: 'run',
  repo: '/repo',
  tasks: [task('a')],
  worker: { platform: 'opencode' },
  final_verification: [{ command: 'node a.js' }],
  ...fields,
});

test('worker selection accepts four platforms', () => {
  for (const platform of ['opencode', 'codex', 'claude-code', 'kilo']) {
    const model = ['opencode', 'kilo'].includes(platform) ? { providerID: 'test', modelID: 'test' } : 'test';
    const input = schemas.create_run.parse(newRun({ worker: { platform, model } }));
    assert.equal(input.worker.platform, platform);
    assert.deepEqual(input.worker.model, model);
  }
  assert.equal(schemas.create_run.parse(newRun()).tasks[0].worker, undefined);
});

test('a new run must name its worker, final verification and task verification', () => {
  for (const fields of [
    { worker: undefined },
    { final_verification: undefined },
    { final_verification: [] },
    { repo: undefined },
    { tasks: [task('a', {}, { verification: [] })] },
  ])
    assert.throws(() => schemas.create_run.parse(newRun(fields)));
  assert.throws(() => schemas.doctor.parse({}));
});

test('added tasks cannot change run configuration', () => {
  for (const fields of [
    { worker: { platform: 'codex' } },
    { repo: '/other' },
    { settings: {} },
    { resources: [] },
    { context_files: [] },
  ])
    assert.throws(() => schemas.add_tasks.parse({ request_id: 'add', run_id: 'run', tasks: [task('a')], ...fields }));
  assert.equal(schemas.add_tasks.parse({ request_id: 'add', run_id: 'run', tasks: [task('a')] }).run_id, 'run');
});

test('worker selection rejects wrong model shapes and unknown platforms', () => {
  for (const worker of [
    { platform: 'unknown' },
    { platform: 'codex', model: { providerID: 'x', modelID: 'y' } },
    { platform: 'kilo', model: 'x' },
  ]) {
    assert.throws(() => schemas.create_run.parse(newRun({ worker })));
  }
});

test('registered worker selection is frozen and append cannot change the run default', async (t) => {
  const f = await fixture(t);
  f.engine.stop();
  const s = await submit(f, [task('a')], { worker: { platform: 'opencode' } });
  const run = f.engine.getRun(s.run_id);
  assert.equal(run.worker.platform, 'opencode');
  assert.equal(run.tasks[0].worker.platform, 'opencode');
  assert.equal(run.tasks.length, 1);
  await callOk(f, 'add_tasks', { request_id: 'append-default', run_id: run.id, tasks: [task('b')] });
  assert.deepEqual(run.tasks[1].worker, run.tasks[0].worker);
});

test('unknown execution profiles fail preflight without registering a task set', async (t) => {
  const f = await fixture(t);
  f.engine.stop();
  const result = await f.call('create_run', {
    request_id: 'unknown-profile',
    ...runDefaults,
    repo: f.repo,
    tasks: [task('a')],
    worker: { platform: 'opencode', profile: 'missing-profile' },
  });
  assert.equal(result.error.code, 'WORKER_PROFILE');
  assert.equal(f.store.state.runs.length, 0);
});

test('invalid unused resources fail complete submission preflight without partial registration', async (t) => {
  const f = await fixture(t);
  f.engine.stop();
  const result = await f.call('create_run', {
    request_id: 'unused-invalid-resource',
    ...runDefaults,
    repo: f.repo,
    tasks: [task('a')],
    resources: [
      {
        resource_key: 'unused',
        connection: { name: 'editor', config: { type: 'unsupported' } },
        probe: { executable: process.execPath, args: [], read_only: true },
        expected_instance: 'editor',
      },
    ],
  });
  assert.equal(result.error.code, 'MCP_POLICY');
  assert.equal(f.store.state.runs.length, 0);
  assert.equal(fs.existsSync(path.join(f.data, 'worktrees')), false);
});
