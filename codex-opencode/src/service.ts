import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Engine } from './engine.js';
import { Store } from './store.js';
import { PROTOCOL, VERSION, Fault, invariant, schemas, type ProcessIdentity, type ToolName } from './types.js';
import { mkdir, uid, readJson, writeJson, processIdentity, alive, sleep } from './io.js';
import { git } from './git.js';

type Descriptor = { protocol: number; version: string; url: string; token: string; owner: ProcessIdentity; executable: string };
export async function serve(root: string, executableFile: string) {
  mkdir(root); const lock = path.join(root, 'service.lock');
  const owner = await processIdentity(process.pid); invariant(owner, 'SERVICE_IDENTITY', 'Cannot verify the service process identity.');
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const reap = path.join(root, 'service-reaping.lock'); fs.mkdirSync(reap, { mode: 0o700 });
    try {
      const prior = readJson<{ owner: ProcessIdentity }>(path.join(lock, 'owner.json'));
      invariant(prior && !(await alive(prior.owner)), 'SERVICE_OWNED', 'Another service owns this data directory, or startup ownership is uncertain.');
      // Only one reaper may delete the old lock. A concurrent fresh owner wins mkdir atomically.
      fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock, { mode: 0o700 });
    } finally { fs.rmSync(reap, { recursive: true }); }
  }
  writeJson(path.join(lock, 'owner.json'), { owner });
  const store = new Store(root); const engine = new Engine(store, executableFile);
  const token = uid('auth');
  const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const server = http.createServer(async (req, res) => {
    if (!equal(req.headers.authorization || '', `Bearer ${token}`)) { res.writeHead(401); res.end(); return; }
    if (req.headers.origin) { res.writeHead(403); res.end(); return; }
    const send = (status: number, value: unknown, artifact = false, count = false) => {
      const response = store.bounded(value, artifact ? 16350 : 4000, count);
      const data = JSON.stringify(response); res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(data);
    };
    try {
      if (req.url === '/health' && req.method === 'GET') { send(200, { protocol: PROTOCOL, version: VERSION, owner }); return; }
      invariant(req.method === 'POST', 'METHOD', 'POST required.');
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; invariant(length <= 2 * 1024 * 1024, 'BODY_LIMIT', 'Request too large.'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      invariant(input.protocol === PROTOCOL, 'UPDATE_PENDING', 'Protocol mismatch. Keep the active release until its work finishes.');
      if (req.url === '/stop') {
        await engine.serial(async () => {
          const running = engine.allAttempts().filter(a => ['launching','running','needs_input','resource_wait','delivery_uncertain','orphaned','stop_uncertain','cancelling'].includes(a.state));
          if (running.length && input.cancel === true) for (const run of store.state.runs.filter(r => !['completed','cancelled'].includes(r.state))) await engine.cancel(run);
          invariant(!running.length, 'JOBS_ACTIVE', 'Jobs are active. Cancellation has been requested if --cancel was supplied; wait for confirmed termination before stopping.');
          engine.stop(); store.save();
        });
        send(200, { stopped: true }); server.close(); return;
      }
      if (req.url === '/cleanup') {
        await engine.serial(async () => {
          const run = engine.getRun(input.run_id);
          invariant(['completed','cancelled'].includes(run.state), 'JOBS_ACTIVE', 'Only completed or confirmed-cancelled runs can be cleaned.');
          for (const a of engine.allAttempts(run)) invariant(!await alive(a.worker?.host) && !await alive(a.worker?.server), 'JOBS_ACTIVE', 'An owned process is still alive.');
          const worktrees = [run.integration_dir, ...engine.allAttempts(run).map(a => a.directory), ...(run.validation_history ?? []).map(v => v.attempt.directory)];
          for (const directory of [...new Set(worktrees)]) if (fs.existsSync(directory)) await git(run.repo, ['worktree','remove','--force',directory]);
          // Preserve durable metadata and evidence. Cleanup is only about owned disposable worktrees.
          store.event(run.id, 'worktrees_cleaned', {});
        }); send(200, { cleaned: input.run_id, evidence_retained: true }); return;
      }
      invariant(req.url === '/call' && typeof input.name === 'string' && input.name in schemas, 'TOOL', 'Unknown endpoint or tool.');
      send(200, await engine.call(input.name as ToolName, input.args), input.name === 'get_artifact', input.source === 'mcp');
    } catch (e) { send(400, { error: { code: e instanceof Fault ? e.code : 'INVALID_REQUEST', message: (e as Error).message } }); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); invariant(address && typeof address !== 'string', 'SERVICE', 'No service address.');
  writeJson(path.join(root, 'service.json'), { protocol: PROTOCOL, version: VERSION, owner, token, url: `http://127.0.0.1:${address.port}`, executable: executableFile } satisfies Descriptor);
  for (const run of store.state.runs.filter(r => !['completed','cancelled'].includes(r.state))) await engine.reconcile(run);
  engine.start();
  const closed = new Promise<void>(resolve => server.on('close', resolve));
  const shutdown = () => { engine.stop(); server.close(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  await closed; await engine.serial(async () => { store.save(); });
  const current = readJson<Descriptor>(path.join(root, 'service.json'));
  if (current?.token === token) { fs.rmSync(path.join(root, 'service.json'), { force: true }); fs.rmSync(lock, { recursive: true, force: true }); }
}
export async function connect(root: string, executableFile: string, start = true): Promise<Descriptor> {
  invariant(process.env.CODEX_OPENCODE_WORKER !== '1', 'RECURSION', 'Workers cannot invoke the delegation service.');
  mkdir(root);
  const health = async () => {
    const descriptor = readJson<Descriptor>(path.join(root, 'service.json')); if (!descriptor) return undefined;
    invariant(/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.url), 'ENDPOINT', 'Service endpoint must be localhost.');
    try {
      const response = await fetch(`${descriptor.url}/health`, { headers: { Authorization: `Bearer ${descriptor.token}` }, signal: AbortSignal.timeout(1500) });
      if (response.ok) { const data = await response.json() as { protocol: number }; invariant(data.protocol === PROTOCOL, 'UPDATE_PENDING', 'An incompatible service is running. Finish its work before updating.'); return descriptor; }
    } catch (e) { if (e instanceof Fault) throw e; }
    return undefined;
  };
  const existing = await health(); if (existing) return existing;
  invariant(start, 'SERVICE_OFFLINE', 'Service is not running.');
  const prior = readJson<Descriptor>(path.join(root, 'service.json'));
  if (!prior || !await alive(prior.owner)) {
    const log = fs.openSync(path.join(root, 'service.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [executableFile,'service',root], { detached: true, stdio: ['ignore',log,log], windowsHide: true });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    } finally { fs.closeSync(log); }
  }
  for (let i = 0; i < 100; i++) { await sleep(100); const ready = await health(); if (ready) return ready; }
  throw new Fault('SERVICE_START', 'Service did not become ready. Inspect service.log; no active process was replaced.');
}
export async function remoteCall(root: string, executableFile: string, name: string, args: unknown, endpoint = '/call', source = 'cli') {
  const service = await connect(root, executableFile, endpoint !== '/stop');
  const response = await fetch(`${service.url}${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: PROTOCOL, name, args, source, ...(endpoint !== '/call' ? args as object : {}) }), signal: AbortSignal.timeout(45000) });
  return response.json();
}
