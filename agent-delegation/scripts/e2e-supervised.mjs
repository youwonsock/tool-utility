// Real supervisor check: Claude Code plans with Haiku through the MCP tools and the delegate-agents
// skill, and Kilo implements with its free model. It spends model requests, so `npm run check` leaves
// it out. Logs stay on disk after a failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataRoot, readJson, remoteCall } from '../dist/index.mjs';

const supervisorModel = 'haiku';
const worker = { platform: 'kilo', model: { providerID: 'kilo', modelID: 'kilo-auto/free' } };
const budgetUsd = '1';
const timeoutMs = 20 * 60_000;

const installed = process.argv.includes('--installed');
const userData = dataRoot();
const cli = installed
  ? JSON.parse(fs.readFileSync(path.join(userData, 'install', 'current.json'), 'utf8')).cli
  : fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const profiles = readJson(path.join(userData, 'profiles.json'));
const claude = profiles?.profiles?.['claude-code-default']?.executable ?? 'claude';

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-delegation-e2e-supervised-')));
const data = path.join(work, 'data');
const repo = path.join(work, 'repo');
const supervisor = path.join(work, 'supervisor');
const transcript = path.join(work, 'supervisor.jsonl');

const log = (...values) => console.log(new Date().toISOString().slice(11, 19), ...values);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

function prepare() {
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  if (profiles) fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify(profiles));
  git('init', '-q', '-b', 'main', '.');
  git('config', 'user.name', 'e2e');
  git('config', 'user.email', 'e2e@localhost');
  fs.writeFileSync(path.join(repo, 'math.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(repo, 'greet.js'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(repo, 'check.js'),
    [
      'const part = process.argv[2];',
      "if (part !== 'greet') {",
      "  const { add } = require('./math.js');",
      "  if (add(2, 3) !== 5) throw new Error('add(2, 3) must be 5');",
      '}',
      "if (part !== 'math') {",
      "  const { greet } = require('./greet.js');",
      "  if (greet('Ann') !== 'Hello, Ann!') throw new Error(\"greet('Ann') must be 'Hello, Ann!'\");",
      '}',
      "console.log('ok');",
      '',
    ].join('\n'),
  );
  git('add', '.');
  git('commit', '-qm', 'initial');
  execFileSync(process.execPath, [cli, 'export-host', 'claude-code', supervisor], {
    env: { ...process.env, AGENT_DELEGATION_HOME: data },
    stdio: 'ignore',
  });
}

const prompt = `Use the delegate-agents skill. You are the supervisor: plan the change, delegate all edits, review the evidence and finish. Never edit files yourself.

Repository: ${repo}

Change to make:
- math.js exports add(a, b), which returns the sum.
- greet.js exports greet(name), which returns "Hello, <name>!".

Requirements for your plan:
- Use one task per file, with each task's scope limited to its own file.
- Set worker to exactly ${JSON.stringify(worker)} in create_run. Do not use any other platform or model.
- Verification commands: "node check.js math" for math.js, "node check.js greet" for greet.js, and "node check.js" as final_verification.

Wait with wait_run or get_run until each task is ready, approve it with approve_task only if its verification passed, and use request_changes if it did not. Then call validate_run, wait for it, and call finalize_run. Stop after finalize_run reports completed, and print its final state.`;

function runSupervisor() {
  const tools = ['Read', 'Glob', 'Grep', 'Skill', 'mcp__agent-delegation'];
  const args = [
    '-p',
    '--model',
    supervisorModel,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    budgetUsd,
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--mcp-config',
    path.join(supervisor, '.mcp.json'),
    '--add-dir',
    repo,
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    tools.join(','),
    '--disallowedTools',
    'Edit,Write,NotebookEdit,Bash,Task,Agent',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(claude, args, { cwd: supervisor, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = fs.createWriteStream(transcript);
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The supervisor timed out.'));
    }, timeoutMs);
    child.stdout.pipe(output);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: stderr.slice(-2000) });
    });
    child.stdin.end(prompt);
  });
}

async function verify(exit) {
  const frames = fs
    .readFileSync(transcript, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const result = frames.findLast((frame) => frame.type === 'result');
  const uses = frames.flatMap((frame) =>
    frame.type === 'assistant' ? frame.message.content.filter((part) => part.type === 'tool_use') : [],
  );
  const toolNames = uses.map((use) => use.name.replace('mcp__agent-delegation__', ''));
  const models = [...new Set(frames.flatMap((frame) => (frame.type === 'assistant' ? [frame.message.model] : [])))];
  log('supervisor exit', exit.code, 'models', models.join(','), 'cost', result?.total_cost_usd);
  log('supervisor tools', toolNames.join(' '));
  log(
    'supervisor result',
    String(result?.result ?? '')
      .slice(0, 300)
      .replaceAll('\n', ' '),
  );
  if (exit.code !== 0 || result?.is_error) throw new Error(`The supervisor failed: ${exit.stderr}`);
  if (!models.length || !models.every((model) => model.includes(supervisorModel)))
    throw new Error(`The supervisor did not use ${supervisorModel}: ${models}`);
  for (const tool of ['create_run', 'approve_task', 'validate_run', 'finalize_run'])
    if (!toolNames.includes(tool)) throw new Error(`The supervisor never called ${tool}.`);
  for (const tool of ['Edit', 'Write', 'Bash'])
    if (toolNames.includes(tool)) throw new Error(`The supervisor used ${tool} itself.`);

  process.env.AGENT_DELEGATION_HOME = data;
  const listed = await remoteCall(data, cli, 'list_runs', {});
  const runId = listed.items?.at(-1)?.run_id ?? listed.items?.at(-1)?.id;
  if (!runId) throw new Error(`No run was created: ${JSON.stringify(listed).slice(0, 300)}`);
  let page = await remoteCall(data, cli, 'get_run', { run_id: runId });
  const run = page;
  let items = page.items;
  while (page.next_cursor) {
    page = await remoteCall(data, cli, 'get_run', { run_id: runId, cursor: page.next_cursor });
    items = [...items, ...page.items];
  }
  // A task too large for its response page arrives as an artifact reference.
  log('oversized task items', items.filter((item) => item.artifact_id).length);
  items = await Promise.all(
    items.map(async (item) =>
      item.artifact_id
        ? JSON.parse((await remoteCall(data, cli, 'get_artifact', { artifact_id: item.artifact_id })).text)
        : item,
    ),
  );
  log('run', runId, run.state, 'tasks', items.length, 'usage', JSON.stringify(run.usage ?? null));
  for (const item of items) {
    log(item.task_id, item.state, JSON.stringify(item.attempt?.model), JSON.stringify(item.attempt?.usage ?? null));
    if (item.attempt?.backend !== worker.platform) throw new Error(`${item.task_id} ran on ${item.attempt?.backend}.`);
    if (JSON.stringify(item.attempt?.model) !== JSON.stringify(worker.model))
      throw new Error(`${item.task_id} used ${JSON.stringify(item.attempt?.model)}.`);
  }
  if (run.state !== 'completed') throw new Error(`The run ended as ${run.state}.`);
  if (items.length < 2) throw new Error('The plan did not use one task per file.');
  execFileSync(process.execPath, ['check.js'], { cwd: repo, stdio: 'pipe' });
  if (git('status', '--short')) throw new Error('The repository is not clean.');
  log('git', git('log', '--format=%s', '-6').replaceAll('\n', ' | '));
}

let failure;
try {
  prepare();
  log('supervisor', supervisorModel, 'worker', JSON.stringify(worker));
  await verify(await runSupervisor());
} catch (error) {
  failure = error;
}
process.env.AGENT_DELEGATION_HOME = data;
await remoteCall(data, cli, '', { cancel: true }, '/stop').catch(() => {});
if (failure) {
  console.error(failure.stack ?? failure);
  console.error(`E2E FAILED. Logs are in ${work}`);
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
log('E2E PASSED', `${supervisorModel} supervisor`, JSON.stringify(worker.model));
process.exit(0);
