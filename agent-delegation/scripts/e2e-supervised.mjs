// Real supervisor check: one platform plans through the MCP tools and the delegate-agents skill, and
// another implements. It spends model requests, so `npm run check` leaves it out. Logs stay on disk
// after a failure. --user-data runs in the real data folder, whose run record stays after the test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataRoot, readJson, remoteCall } from '../dist/index.mjs';

const haiku = { platform: 'claude-code', model: 'haiku' };
const luna = { platform: 'codex', model: 'gpt-6-luna' };
const kiloFree = { platform: 'kilo', model: { providerID: 'kilo', modelID: 'kilo-auto/free' } };
const pairings = {
  'haiku-kilo': { supervisor: haiku, worker: kiloFree },
  'haiku-luna': { supervisor: haiku, worker: luna },
  'luna-haiku': { supervisor: luna, worker: haiku },
};
const name = process.argv.slice(2).find((value) => !value.startsWith('--')) ?? 'haiku-kilo';
if (!pairings[name]) {
  console.error(`Usage: e2e-supervised.mjs [${Object.keys(pairings).join('|')}] [--installed] [--user-data]`);
  process.exit(2);
}
const { supervisor: lead, worker } = pairings[name];
const budgetUsd = '1';
const timeoutMs = 20 * 60_000;

const installed = process.argv.includes('--installed');
const useUserData = process.argv.includes('--user-data');
const userData = dataRoot();
const cli = installed
  ? JSON.parse(fs.readFileSync(path.join(userData, 'install', 'current.json'), 'utf8')).cli
  : fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const profiles = readJson(path.join(userData, 'profiles.json'));
const claude = profiles?.profiles?.['claude-code-default']?.executable ?? 'claude';

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-delegation-e2e-supervised-')));
const data = useUserData ? userData : path.join(work, 'data');
const repo = path.join(work, 'repo');
const supervisor = path.join(work, 'supervisor');
const transcript = path.join(work, 'supervisor.jsonl');

const log = (...values) => console.log(new Date().toISOString().slice(11, 19), ...values);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

function prepare() {
  fs.mkdirSync(repo, { recursive: true });
  if (!useUserData) {
    fs.mkdirSync(data, { recursive: true });
    if (profiles) fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify(profiles));
  }
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
  execFileSync(process.execPath, [cli, 'export-host', lead.platform, supervisor], {
    env: { ...process.env, AGENT_DELEGATION_HOME: data },
    stdio: 'ignore',
  });
}

const skill = lead.platform === 'codex' ? '$delegate-agents' : 'the delegate-agents skill';
const prompt = `Use ${skill}. You are the supervisor: plan the change, delegate all edits, review the evidence and finish. Never edit files yourself.

Repository: ${repo}

Change to make:
- math.js exports add(a, b), which returns the sum.
- greet.js exports greet(name), which returns "Hello, <name>!".

Requirements for your plan:
- Use one task per file, with each task's scope limited to its own file.
- Set worker to exactly ${JSON.stringify(worker)} in create_run. Do not use any other platform or model.
- Verification commands: "node check.js math" for math.js, "node check.js greet" for greet.js, and "node check.js" as final_verification.

Wait with wait_run or get_run until each task is ready, approve it with approve_task only if its verification passed, and use request_changes if it did not. Then call validate_run, wait for it, and call finalize_run. Stop after finalize_run reports completed, and print its final state.`;

function claudeCommand() {
  const tools = ['Read', 'Glob', 'Grep', 'Skill', 'mcp__agent-delegation'];
  return [
    claude,
    [
      '-p',
      '--model',
      lead.model,
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
    ],
  ];
}

// The read-only sandbox stops Codex editing, and the exported MCP server replaces the user's plugin.
function codexCommand() {
  const { stdio } = readJson(path.join(supervisor, 'binding.json'));
  const server = 'mcp_servers.agent-delegation';
  const settings = [
    `${server}.command=${JSON.stringify(stdio.command)}`,
    `${server}.args=${JSON.stringify(stdio.args)}`,
    `${server}.default_tools_approval_mode="approve"`,
    ...Object.entries(stdio.env ?? {}).map(([key, value]) => `${server}.env.${key}=${JSON.stringify(value)}`),
    'approval_policy="never"',
    `projects.${JSON.stringify(supervisor)}.trust_level="trusted"`,
  ];
  return [
    process.env.AGENT_DELEGATION_CODEX_EXECUTABLE ?? 'codex',
    [
      'exec',
      '--json',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--model',
      lead.model,
      '--sandbox',
      'read-only',
      '--cd',
      supervisor,
      ...settings.flatMap((setting) => ['-c', setting]),
      '-',
    ],
  ];
}

function runSupervisor() {
  const [command, args] = lead.platform === 'codex' ? codexCommand() : claudeCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: supervisor, stdio: ['pipe', 'pipe', 'pipe'] });
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

const readFrames = () =>
  fs
    .readFileSync(transcript, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));

function claudeReport() {
  const frames = readFrames();
  const result = frames.findLast((frame) => frame.type === 'result');
  const uses = frames.flatMap((frame) =>
    frame.type === 'assistant' ? frame.message.content.filter((part) => part.type === 'tool_use') : [],
  );
  const tools = uses.map((use) => use.name.replace('mcp__agent-delegation__', ''));
  return {
    models: [...new Set(frames.flatMap((frame) => (frame.type === 'assistant' ? [frame.message.model] : [])))],
    tools,
    edits: tools.filter((tool) => ['Edit', 'Write', 'Bash'].includes(tool)),
    usage: { cost_usd: result?.total_cost_usd },
    text: result?.result,
    failed: result?.is_error,
  };
}

// Codex events name no model, so the session's own record is the evidence.
function codexModels(threadId) {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
  const file = fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .find((entry) => entry.endsWith(`${threadId}.jsonl`));
  if (!file) return [];
  const records = fs
    .readFileSync(path.join(root, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return [...new Set(records.flatMap((record) => (record.type === 'turn_context' ? [record.payload.model] : [])))];
}

function codexReport() {
  const frames = readFrames();
  const items = frames.flatMap((frame) => (frame.type === 'item.completed' ? [frame.item] : []));
  const usage = frames.findLast((frame) => frame.type === 'turn.completed')?.usage;
  return {
    models: codexModels(frames.find((frame) => frame.type === 'thread.started')?.thread_id),
    tools: items
      .filter((item) => ['mcp_tool_call', 'command_execution', 'file_change'].includes(item.type))
      .map((item) => item.tool ?? item.type),
    edits: items.filter((item) => item.type === 'file_change').map((item) => item.type),
    usage,
    text: items.findLast((item) => item.type === 'agent_message')?.text,
    failed: frames.some((frame) => frame.type === 'turn.failed'),
  };
}

// Run IDs are not ordered, and the real data folder holds other runs.
async function findRun() {
  let cursor;
  do {
    const page = await remoteCall(data, cli, 'list_runs', { cursor });
    const found = page.items?.find((item) => item.repo === repo);
    if (found) return found.run_id;
    cursor = page.next_cursor;
  } while (cursor);
}

// Claude reports the model an alias resolved to, such as claude-haiku-5-5 for haiku.
const sameModel = (model) =>
  typeof worker.model === 'string'
    ? String(model).includes(worker.model)
    : JSON.stringify(model) === JSON.stringify(worker.model);

let runId;
async function verify(exit) {
  const report = lead.platform === 'codex' ? codexReport() : claudeReport();
  log('supervisor exit', exit.code, 'models', report.models.join(','), 'usage', JSON.stringify(report.usage));
  log('supervisor tools', report.tools.join(' '));
  log(
    'supervisor result',
    String(report.text ?? '')
      .slice(0, 300)
      .replaceAll('\n', ' '),
  );
  if (exit.code !== 0 || report.failed) throw new Error(`The supervisor failed: ${exit.stderr}`);
  if (!report.models.length || !report.models.every((model) => model.includes(lead.model)))
    throw new Error(`The supervisor did not use ${lead.model}: ${report.models}`);
  for (const tool of ['create_run', 'approve_task', 'validate_run', 'finalize_run'])
    if (!report.tools.includes(tool)) throw new Error(`The supervisor never called ${tool}.`);
  if (report.edits.length) throw new Error(`The supervisor used ${report.edits.join(', ')} itself.`);

  process.env.AGENT_DELEGATION_HOME = data;
  runId = await findRun();
  if (!runId) throw new Error('No run was created.');
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
    if (!sameModel(item.attempt?.model))
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
  log(name, 'supervisor', JSON.stringify(lead), 'worker', JSON.stringify(worker), 'data', data);
  await verify(await runSupervisor());
} catch (error) {
  failure = error;
}
process.env.AGENT_DELEGATION_HOME = data;
// The real service may be doing other work, so leave it running and remove only this run's worktrees.
if (!useUserData) await remoteCall(data, cli, '', { cancel: true }, '/stop').catch(() => {});
else if (runId && !failure)
  await remoteCall(data, cli, '', { run_id: runId }, '/cleanup').catch((error) => log('cleanup failed', error.message));
if (failure) {
  console.error(failure.stack ?? failure);
  console.error(`E2E FAILED. Logs are in ${work}`);
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
log('E2E PASSED', name, runId);
process.exit(0);
