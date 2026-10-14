import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schemas, validateWorkerState, resolveWorker, workerEnvironment, dataRoot, connect, exec } from '../dist/index.mjs';
import { root, cli } from './helpers.mjs';

function environment(values, action) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const restore = () => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } };
  try { const result = action(); if (result?.then) return result.finally(restore); restore(); return result; }
  catch (error) { restore(); throw error; }
}

test('model selection uses worker.model exclusively', () => {
  const model = { providerID: 'test', modelID: 'test' };
  const task = { id: 'a', goal: 'Implement a', scope: ['a.txt'], acceptance: ['a exists'] };
  assert.throws(() => schemas.doctor.parse({ model }));
  assert.throws(() => schemas.submit_tasks.parse({ request_id: 'model', tasks: [{ ...task, model }] }));
  assert.deepEqual(schemas.submit_tasks.parse({ request_id: 'model', tasks: [{ ...task, worker: { platform: 'opencode', model } }] }).tasks[0].worker.model, model);
});

test('only current worker records are accepted', () => {
  for (const protocol of [undefined, 1, 99]) assert.throws(() => validateWorkerState({ protocol, phase: 'starting' }), error => error.code === 'STATE_CORRUPT');
  assert.doesNotThrow(() => validateWorkerState({ protocol: 2, phase: 'starting' }));
});

test('new environment settings select data and each native executable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  environment({ AGENT_DELEGATION_HOME: directory }, () => assert.equal(dataRoot(), directory));
  for (const [platform, name] of [['opencode', 'OPENCODE'], ['codex', 'CODEX'], ['claude-code', 'CLAUDE'], ['kilo', 'KILO']]) {
    environment({ [`AGENT_DELEGATION_${name}_EXECUTABLE`]: process.execPath, [`AGENT_DELEGATION_${name}_EXECUTABLE_ARGS`]: '["example"]' }, () => {
      const worker = resolveWorker(directory, { platform });
      assert.equal(worker.executable, process.execPath);
      assert.deepEqual(worker.executable_args, ['example']);
    });
  }
  assert.equal(resolveWorker(directory).platform, 'opencode');
});

test('workers cannot enter the service or override the recursion guard', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const worker = resolveWorker(directory);
  assert.equal(workerEnvironment(worker).AGENT_DELEGATION_WORKER, '1');
  assert.throws(() => workerEnvironment({ ...worker, env_refs: { AGENT_DELEGATION_WORKER: 'PATH' } }), error => error.code === 'WORKER_PROFILE');
  await environment({ AGENT_DELEGATION_WORKER: '1' }, () => assert.rejects(connect(directory, cli, false), error => error.code === 'RECURSION'));
});

test('unknown CLI commands fail without starting a service', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'command-'));
  const result = await exec(process.execPath, [cli, 'unknown-command'], { env: { ...process.env, AGENT_DELEGATION_HOME: directory } });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown command/);
  assert.equal(fs.existsSync(path.join(directory, 'service.json')), false);
});

test('invalid worker specifications are rejected before recording a launch', async () => {
  for (const fields of [{}, { protocol: 1 }, { protocol: 2 }]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-spec-'));
    fs.writeFileSync(path.join(directory, 'spec.json'), JSON.stringify({ job_dir: directory, ...fields }));
    const result = await exec(process.execPath, [cli, 'worker', directory], { timeout: 10000 });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /specification/);
    assert.equal(fs.existsSync(path.join(directory, 'started.json')), false);
  }
});

test('standalone skills contain the current tool contract without aliases', () => {
  const skills = path.join(root, 'dist', 'skills');
  assert.deepEqual(fs.readdirSync(skills), ['delegate-agents']);
  assert.ok(fs.existsSync(path.join(skills, 'delegate-agents', 'references', 'contract.md')));
});
