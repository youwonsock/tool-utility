// Real-model check on a throwaway repository: parallel tasks, a conflict, a correction, finalize.
// It spends model requests, so `npm run check` does not run it. Logs stay on disk after a failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataRoot, remoteCall } from '../dist/index.mjs';

const usage = 'Usage: npm run e2e -- <codex|opencode|claude-code|kilo> [model] [--installed]';
const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const installed = process.argv.includes('--installed');
const [platform, modelArg] = positional;
if (!['codex', 'opencode', 'claude-code', 'kilo'].includes(platform)) {
  console.error(usage);
  process.exit(2);
}

const nativeModel = (value) => {
  if (platform !== 'opencode' && platform !== 'kilo') return value;
  const [providerID, ...rest] = value.split('/');
  if (!rest.length) throw new Error(`${platform} models use provider/model.`);
  return { providerID, modelID: rest.join('/') };
};
const worker = { platform, ...(modelArg ? { model: nativeModel(modelArg) } : {}) };

const userData = dataRoot();
const cli = installed
  ? JSON.parse(fs.readFileSync(path.join(userData, 'install', 'current.json'), 'utf8')).cli
  : fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agent-delegation-e2e-${platform}-`)));
const data = path.join(work, 'data');
const repo = path.join(work, 'repo');
process.env.AGENT_DELEGATION_HOME = data;

const log = (...values) => console.log(new Date().toISOString().slice(11, 19), ...values);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

function prepare() {
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const profiles = path.join(userData, 'profiles.json');
  if (fs.existsSync(profiles)) fs.copyFileSync(profiles, path.join(data, 'profiles.json'));
  git('init', '-q', '-b', 'main', '.');
  git('config', 'user.name', 'e2e');
  git('config', 'user.email', 'e2e@localhost');
  fs.writeFileSync(path.join(repo, 'greeting.txt'), 'first\nsecond\nthird\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'out/\n');
  fs.writeFileSync(
    path.join(repo, 'check.js'),
    [
      "const text = require('fs').readFileSync('greeting.txt', 'utf8').replaceAll('\\r\\n', '\\n');",
      "if (/^(<{7}|={7}|>{7})/m.test(text)) { console.error('conflict markers'); process.exit(1); }",
      "const lines = text.trimEnd().split('\\n');",
      "if (lines.length !== 3 || lines[0] !== 'first' || lines[2] !== 'third') { console.error('other lines changed'); process.exit(1); }",
      '// Build output: thousands of ignored files must not trip the scope monitor.',
      "require('fs').mkdirSync('out', { recursive: true });",
      "for (let i = 0; i < 5000; i++) require('fs').writeFileSync('out/f' + i + '.js', 'x');",
      'console.log(lines[1]);',
      '',
    ].join('\n'),
  );
  git('add', '.');
  git('commit', '-qm', 'initial');
}

let counter = 0;
async function call(name, args) {
  const body = name === 'get_run' || name === 'doctor' ? args : { request_id: `e2e-${name}-${++counter}`, ...args };
  for (;;) {
    const result = await remoteCall(data, cli, name, body);
    if (!result?.in_progress) return result;
    await sleep(1000);
  }
}
async function loadRun(run_id) {
  let page = await call('get_run', { run_id });
  const top = page;
  let items = page.items;
  while (page.next_cursor) {
    page = await call('get_run', { run_id, cursor: page.next_cursor });
    items = [...items, ...page.items];
  }
  return { ...top, items };
}

const busyAttempts = [
  'launching',
  'running',
  'needs_input',
  'delivery_uncertain',
  'cancelling',
  'stop_uncertain',
  'orphaned',
];
const answered = new Set();
async function answerInputs(run_id, id, attempt) {
  for (const input of attempt?.inputs ?? []) {
    if (answered.has(input.id)) continue;
    answered.add(input.id);
    const details = JSON.stringify(input.details);
    const edit = input.kind === 'permission' && /greeting\.txt/.test(details) && !/bash|shell|command/i.test(details);
    const decision = input.kind === 'permission' ? (edit ? 'once' : 'reject') : 'answer';
    log(id, 'input', input.kind, decision, details.slice(0, 200));
    const reply = await call('respond_to_request', {
      run_id,
      attempt_id: attempt.id,
      input_id: input.id,
      decision,
      ...(decision === 'answer' ? { answers: [['Do not run commands. Edit the file and finish.']] } : {}),
    });
    if (reply?.error) log(id, 'input reply error', JSON.stringify(reply.error).slice(0, 300));
  }
}
async function settle(run_id, id, attempts, limit = 15 * 60_000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const run = await loadRun(run_id);
    const item = run.items.find((value) => value.task_id === id);
    await answerInputs(run_id, id, item?.attempt);
    if (
      item?.attempt?.number === attempts &&
      !busyAttempts.includes(item.attempt.state) &&
      !['queued', 'running'].includes(item.state)
    ) {
      const { state, error, verification, summary } = item.attempt;
      const statuses = verification?.map((value) => value.status);
      log(id, 'attempt', attempts, state, JSON.stringify(item.attempt.model), statuses, error ?? '');
      log(id, 'usage', JSON.stringify(item.attempt.usage ?? null));
      if (state !== 'needs_review' || statuses?.some((status) => status !== 'passed'))
        throw new Error(`${id} is not reviewable: ${state} ${error ?? ''} ${summary ?? ''}`.slice(0, 1200));
      return item;
    }
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for ${id}.`);
}

async function run() {
  const check = { command: 'node check.js' };
  const task = (id) => ({
    id,
    goal: `Replace the second line of greeting.txt with exactly "${id}". Keep the other lines. Edit only that file with your file editing tool. Do not run any commands; the supervisor runs the checks.`,
    scope: ['greeting.txt'],
    acceptance: [`The second line of greeting.txt is ${id}`],
    verification: [check],
  });

  const doctor = await call('doctor', { repo, worker });
  log('doctor', doctor.compatible, doctor.runtime?.cli?.version, doctor.runtime?.sdk?.version ?? '');
  if (!doctor.compatible) throw new Error(JSON.stringify(doctor.connection));

  const created = await call('create_run', {
    repo,
    worker,
    tasks: [task('alpha'), task('beta')],
    final_verification: [check],
    settings: { timeout_ms: 900000 },
  });
  if (created.error) throw new Error(JSON.stringify(created.error));
  const run_id = created.run_id;
  log('run', run_id);

  const alpha = await settle(run_id, 'alpha', 1);
  const beta = await settle(run_id, 'beta', 1);
  const approve = (item) =>
    call('approve_task', { run_id, task_id: item.task_id, attempt_id: item.attempt.id, commit: item.attempt.commit });
  log('approve alpha', (await approve(alpha)).state);
  const conflict = await approve(beta);
  log('approve beta', conflict.state);
  if (conflict.state !== 'integration_conflict') throw new Error('Expected an integration conflict.');

  await call('request_changes', {
    run_id,
    task_id: 'beta',
    attempt_id: beta.attempt.id,
    feedback:
      'Resolve the conflict so that the second line of greeting.txt is exactly "alpha beta". Keep the other lines and leave no conflict markers.',
  });
  const corrected = await settle(run_id, 'beta', 2);
  log('conflicts', corrected.attempt.conflicts);
  log('approve correction', (await approve(corrected)).state);

  await call('validate_run', { run_id });
  let current;
  for (let i = 0; i < 100; i++) {
    current = await loadRun(run_id);
    if (current.state === 'waiting_final_review' && current.validation?.state === 'passed') break;
    await sleep(3000);
  }
  log('validated', current.state, current.validation?.state);
  log('run usage', JSON.stringify(current.usage ?? null));
  if (current.validation?.state !== 'passed') throw new Error(`Validation did not pass: ${current.state}`);

  const finalized = await call('finalize_run', {
    run_id,
    validation_id: current.validation.id,
    commit: current.validation.commit,
    revision: current.revision,
  });
  log('finalize', finalized.state, finalized.error ?? '');
  const text = fs.readFileSync(path.join(repo, 'greeting.txt'), 'utf8').replaceAll('\r\n', '\n');
  log('greeting.txt', JSON.stringify(text));
  if (finalized.state !== 'completed' || text !== 'first\nalpha beta\nthird\n')
    throw new Error('Final state is wrong.');
  if (git('status', '--short')) throw new Error('The repository is not clean.');
}

let failure;
try {
  prepare();
  await run();
} catch (error) {
  failure = error;
}
await remoteCall(data, cli, '', { cancel: true }, '/stop').catch(() => {});
if (failure) {
  console.error(failure.stack ?? failure);
  console.error(`E2E FAILED. Logs are in ${work}`);
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
log('E2E PASSED', platform, modelArg ?? 'default model');
