import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { BASELINE, Fault, invariant, type Model, type Resource, type WorkerSpec, type WorkerState } from './types.js';
import { exec, readJson, samePath, sleep, processIdentity, writeJson, terminate, digest } from './io.js';

export async function resolvedConfig(executable: string, args: string[], directory: string, env = process.env) {
  const r = await exec(executable, [...args, 'debug','config','--pure'], { cwd: directory, env, timeout: 60000 });
  invariant(r.code === 0, 'OPENCODE_CONFIG', 'OpenCode could not resolve configuration. Run opencode debug config locally for details.');
  try { return JSON.parse(r.stdout) as Record<string, any>; } catch { throw new Fault('OPENCODE_CONFIG', 'OpenCode configuration output was not JSON.'); }
}
export async function probeResources(resources: Resource[], directory: string) {
  for (const resource of resources) {
    const replace = (s: string) => s.replaceAll('{{worktree}}', directory);
    const r = await exec(replace(resource.probe.executable), resource.probe.args.map(replace), { cwd: directory, timeout: 15000, limit: 65536 });
    let result; try { result = JSON.parse(r.stdout); } catch { throw new Fault('RESOURCE_UNVERIFIED', `Probe did not return JSON for ${resource.resource_key}`); }
    invariant(r.code === 0 && result.instance_id === resource.expected_instance, 'RESOURCE_MISMATCH', `Wrong or unverified instance for ${resource.resource_key}`);
    if (resource.project_bound) invariant(typeof result.project_path === 'string' && samePath(fs.realpathSync(result.project_path), fs.realpathSync(directory)), 'RESOURCE_PROJECT_MISMATCH', `Resource ${resource.resource_key} must bind to ${directory}`);
  }
}
export function restrictions(config: Record<string, any>, resources: Resource[], directory: string) {
  const mcp: Record<string, any> = Object.fromEntries(Object.keys(config.mcp ?? {}).map(name => [name, { enabled: false }]));
  const permission: Record<string, any> = {
    '*': 'deny', read: 'allow', edit: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
    bash: { '*': 'allow', '*codex-opencode*': 'deny', '*codex *': 'deny', '*opencode *': 'deny', 'git push*': 'deny', 'git reset*': 'deny', 'git checkout*': 'deny', 'git switch*': 'deny', 'git commit*': 'deny' },
    question: 'allow', webfetch: 'ask', external_directory: 'ask', task: 'deny', skill: 'deny',
  };
  for (const r of resources) {
    invariant(!/codex|delegat|opencode/i.test(r.connection.name + JSON.stringify(r.connection.config)), 'RECURSION', 'Delegation MCP connections cannot be exposed to workers.');
    const expand = (value: unknown): unknown => typeof value === 'string' ? value.replaceAll('{{worktree}}', directory) : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value;
    mcp[r.connection.name] = expand({ ...r.connection.config, enabled: true });
    permission[`${r.connection.name}_*`] = 'ask';
  }
  return { mcp, permission, share: 'disabled', autoupdate: false, snapshot: false,
    agent: { 'delegate-worker': { description: 'Implementation worker supervised by Codex', mode: 'primary', permission } },
    default_agent: 'delegate-worker', tools: { task: false },
  };
}
export async function selectModel(client: ReturnType<typeof createOpencodeClient>, config: Record<string, any>, spec: Pick<WorkerSpec, 'model'|'executable'|'executable_args'|'directory'>): Promise<Model> {
  const providers = (await client.provider.list({}, { throwOnError: true })).data!;
  let model = spec.model;
  const configured = config.model ?? config.agent?.build?.model;
  if (!model && configured) { const [providerID, ...rest] = String(configured).split('/'); model = { providerID: providerID!, modelID: rest.join('/') }; }
  if (!model) {
    const r = await exec(spec.executable, [...spec.executable_args, 'debug','paths'], { cwd: spec.directory });
    const statePath = r.stdout.match(/^state\s+(.+)$/m)?.[1];
    if (statePath) model = readJson<{ recent?: Model[] }>(path.join(statePath.trim(), 'model.json'))?.recent?.[0];
  }
  if (!model) {
    const configuredProviders = Object.keys(config.provider ?? {});
    const provider = providers.all.find(p => providers.connected.includes(p.id) && (!configuredProviders.length || configuredProviders.includes(p.id)));
    if (provider && providers.default[provider.id]) model = { providerID: provider.id, modelID: providers.default[provider.id]! };
  }
  invariant(model, 'MODEL_UNAVAILABLE', 'No existing OpenCode default model could be resolved. Specify a model.');
  const provider = providers.all.find(p => p.id === model!.providerID);
  invariant(providers.connected.includes(model.providerID) && provider?.models[model.modelID], 'MODEL_UNAVAILABLE', `Configured model is unavailable: ${model.providerID}/${model.modelID}. No fallback was used.`);
  return model;
}
export async function launchOpenCode(spec: WorkerSpec, state: WorkerState, save: () => void) {
  const version = await exec(spec.executable, [...spec.executable_args, '--version']);
  invariant(version.code === 0 && version.stdout.trim() === BASELINE, 'OPENCODE_VERSION', `Expected OpenCode ${BASELINE}; found ${version.stdout.trim()}. Validate a newer version before changing the baseline.`);
  const initial = await resolvedConfig(spec.executable, spec.executable_args, spec.directory);
  const overlay = restrictions(initial, spec.resources, spec.directory);
  const env = { ...process.env, OPENCODE_SERVER_PASSWORD: spec.password, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay), CODEX_OPENCODE_WORKER: '1' };
  // Resolve twice before starting the server, so managed config cannot silently re-enable a connection.
  const effective = await resolvedConfig(spec.executable, spec.executable_args, spec.directory, env);
  const allowed = new Set(spec.resources.map(r => r.connection.name));
  invariant(Object.entries(effective.mcp ?? {}).every(([name, cfg]) => (cfg as any).enabled === false || allowed.has(name)), 'MCP_POLICY', 'Managed configuration enables an unregistered MCP connection.');
  for (const name of allowed) for (const [key, value] of Object.entries(overlay.mcp[name])) invariant(digest(effective.mcp?.[name]?.[key]) === digest(value), 'MCP_POLICY', `Effective MCP connection differs from the verified profile: ${name}.${key}`);
  invariant(effective.agent?.['delegate-worker']?.permission?.task === 'deny' && effective.tools?.task === false, 'MCP_POLICY', 'Managed configuration overrides worker restrictions.');
  writeJson(path.join(spec.job_dir, 'server-intent.json'), { at: Date.now() });
  const child: ChildProcess = spawn(spec.executable, [...spec.executable_args, 'serve', '--hostname=127.0.0.1','--port=0','--pure'], { cwd: spec.directory, env, detached: true, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  child.on('error', error => { state.error = error.message; save(); });
  invariant(child.pid, 'SPAWN', 'OpenCode failed to start.');
  state.server = await processIdentity(child.pid); save();
  let output = '';
  const log = fs.createWriteStream(path.join(spec.job_dir, 'server.log'), { flags: 'a', mode: 0o600 });
  child.stdout!.on('data', data => { log.write(data); output = (output + data.toString()).slice(-65536); });
  child.stderr!.on('data', data => log.write(data));
  for (let i = 0; i < 300; i++) {
    const url = output.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) { state.url = url; save(); break; }
    invariant(child.exitCode === null && !state.error, 'OPENCODE_START', 'OpenCode exited before listening. See the local server log.');
    await sleep(100);
  }
  invariant(state.url, 'OPENCODE_START', 'OpenCode did not announce its localhost endpoint.');
  const client = createOpencodeClient({ baseUrl: state.url, directory: spec.directory,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${spec.password}`).toString('base64')}` },
    fetch: ((input: any, init?: any) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30000) })) as typeof fetch,
  });
  const health = (await client.global.health({ throwOnError: true })).data!;
  invariant(health.healthy && health.version === BASELINE, 'OPENCODE_HEALTH', 'Unexpected OpenCode API version.');
  state.model = await selectModel(client, initial, spec); save();
  return { client, child, log };
}

export async function inspectSession(spec: WorkerSpec, state: WorkerState) {
  invariant(state.url && /^http:\/\/127\.0\.0\.1:\d+$/.test(state.url), 'ENDPOINT', 'Expected an owned localhost endpoint.');
  const client = createOpencodeClient({ baseUrl: state.url, directory: spec.directory, headers: { authorization: `Basic ${Buffer.from(`opencode:${spec.password}`).toString('base64')}` } });
  const options = { throwOnError: true as const, signal: AbortSignal.timeout(3000) };
  const health = (await client.global.health(options)).data!;
  if (!state.session_id) return { healthy: health.healthy, session_present: false, prompt_present: false };
  const session = (await client.session.get({ sessionID: state.session_id }, options)).data!;
  const statuses = (await client.session.status({}, options)).data!;
  const messages = (await client.session.messages({ sessionID: state.session_id }, options)).data!;
  return { healthy: health.healthy, session_present: session.id === state.session_id, status: statuses[session.id]?.type ?? 'idle', prompt_present: messages.some(m => m.info.id === state.prompt_id), messages: messages.length };
}
