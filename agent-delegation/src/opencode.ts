import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { Fault, invariant, type Model, type Resource, type WorkerSpec, type WorkerState } from './types.js';
import { exec, readJson, samePath, sleep, digest } from './io.js';
import { beginProcess, registerProcess } from './backends/process.js';
import { workerEnvironment } from './profiles.js';
import { connection } from './backends/policy.js';
import { verificationShell } from './shell.js';
import { executableVersion, reportedVersion } from './backends/version.js';
import { loadSdk, requireSdkMethods, callSdkFactory } from './runtime.js';

export async function resolvedConfig(executable: string, args: string[], directory: string, env = process.env) {
  const r = await exec(executable, [...args, 'debug','config','--pure'], { cwd: directory, env, timeout: 60000 });
  invariant(r.code === 0, 'OPENCODE_CONFIG', 'OpenCode could not resolve configuration. Run opencode debug config locally for details.');
  try { return JSON.parse(r.stdout) as Record<string, any>; } catch { throw new Fault('OPENCODE_CONFIG', 'OpenCode configuration output was not JSON.'); }
}
export async function probeResources(resources: Resource[], directory: string) {
  for (const resource of resources) {
    const replace = (s: string) => s.replaceAll('{{worktree}}', directory);
    const r = await exec(replace(resource.probe.executable), resource.probe.args.map(replace), { cwd: directory, timeout: 15000, limit: 65536 }).catch(e => { throw new Fault('RESOURCE_UNVERIFIED', `Probe failed for ${resource.resource_key}: ${(e as Error).message}`, { worktree: directory }); });
    let result; try { result = JSON.parse(r.stdout); } catch { throw new Fault('RESOURCE_UNVERIFIED', `Probe did not return JSON for ${resource.resource_key}`); }
    const details = { resource_key: resource.resource_key, worktree: directory, expected_instance: resource.expected_instance, observed_instance: result.instance_id, observed_project: result.project_path };
    invariant(r.code === 0 && result.instance_id === resource.expected_instance, 'RESOURCE_MISMATCH', `Wrong or unverified instance for ${resource.resource_key}`, details);
    if (resource.project_bound) {
      let matches = false; try { matches = typeof result.project_path === 'string' && samePath(fs.realpathSync(result.project_path), fs.realpathSync(directory)); } catch { /* Unknown paths are not verified. */ }
      invariant(matches, 'RESOURCE_PROJECT_MISMATCH', `Resource ${resource.resource_key} must bind to ${directory}. Rebind it and call reconcile_run.`, details);
    }
  }
}
export function restrictions(config: Record<string, any>, resources: Resource[], directory: string) {
  const mcp: Record<string, any> = Object.fromEntries(Object.keys(config.mcp ?? {}).map(name => [name, { enabled: false }]));
  const permission: Record<string, any> = {
    '*': 'deny', read: 'allow', edit: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
    bash: { '*': 'allow', '*agent-delegation*': 'deny', '*codex *': 'deny', '*opencode *': 'deny', '*claude *':'deny', '*kilo *':'deny', 'git push*': 'deny', 'git reset*': 'deny', 'git checkout*': 'deny', 'git switch*': 'deny', 'git commit*': 'deny' },
    question: 'allow', webfetch: 'ask', external_directory: 'ask', task: 'deny', skill: 'deny',
  };
  for (const r of resources) {
    invariant(!/codex|delegat|opencode/i.test(r.connection.name + JSON.stringify(r.connection.config)), 'RECURSION', 'Delegation MCP connections cannot be exposed to workers.');
    const expand = (value: unknown): unknown => typeof value === 'string' ? value.replaceAll('{{worktree}}', directory) : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value;
    const portable=connection(r,directory);
    const native=portable.type==='stdio'?{type:'local',command:[portable.command,...portable.args],...(portable.env?{environment:portable.env}:{})}
      :{type:'remote',url:portable.url,...(portable.headers?{headers:portable.headers}:{})};
    mcp[r.connection.name] = expand({ ...native,...(r.connection.config.timeout===undefined?{}:{timeout:r.connection.config.timeout}),...(r.connection.config.oauth===undefined?{}:{oauth:r.connection.config.oauth}), enabled: true });
    permission[`${r.connection.name}_*`] = 'ask';
  }
  return { mcp, permission, share: 'disabled', autoupdate: false, snapshot: false,
    agent: { 'delegate-worker': { description: 'Implementation worker supervised by the current planning agent', mode: 'primary', permission } },
    default_agent: 'delegate-worker', tools: { task: false },
  };
}
export function enforceHttpPolicy(effective:Record<string,any>,overlay:ReturnType<typeof restrictions>) {
  invariant(effective.tools?.task===false&&effective.default_agent==='delegate-worker','MCP_POLICY','Managed configuration overrides the selected worker or enables delegation.');
  for(const [key,value]of Object.entries(overlay.permission)) {
    invariant(digest(effective.permission?.[key])===digest(value)&&digest(effective.agent?.['delegate-worker']?.permission?.[key])===digest(value),'MCP_POLICY',`Managed configuration changes worker permission: ${key}`);
  }
}
export async function selectModel(client: any, config: Record<string, any>, spec: Pick<WorkerSpec, 'model'|'executable'|'executable_args'|'directory'>): Promise<Model> {
  const providers = (await client.provider.list({}, { throwOnError: true })).data!;
  invariant(providers&&Array.isArray(providers.all)&&Array.isArray(providers.connected)&&providers.default&&typeof providers.default==='object','BACKEND_API','OpenCode provider API returned an incompatible response.');
  invariant(spec.model===undefined || typeof spec.model==='object','MODEL','OpenCode requires providerID/modelID.');
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
    const provider = providers.all.find((p:any) => providers.connected.includes(p.id) && (!configuredProviders.length || configuredProviders.includes(p.id)));
    if (provider && providers.default[provider.id]) model = { providerID: provider.id, modelID: providers.default[provider.id]! };
  }
  invariant(model, 'MODEL_UNAVAILABLE', 'No existing OpenCode default model could be resolved. Specify a model.');
  const provider = providers.all.find((p:any) => p.id === model!.providerID);
  invariant(providers.connected.includes(model.providerID) && provider?.models[model.modelID], 'MODEL_UNAVAILABLE', `Configured model is unavailable: ${model.providerID}/${model.modelID}. No fallback was used.`);
  return model;
}
export async function launchOpenCode(spec: WorkerSpec, state: WorkerState, save: () => void) {
  const sdk=await loadSdk(spec.worker,state.runtime!);
  const version = await executableVersion(spec);
  const initial = await resolvedConfig(spec.executable, spec.executable_args, spec.directory,spec.worker?workerEnvironment(spec.worker):process.env);
  state.verification_shell=verificationShell(spec.worker?.shell,initial.shell);save();
  const overlay = restrictions(initial, spec.resources, spec.directory);
  const env = { ...(spec.worker?workerEnvironment(spec.worker):process.env), OPENCODE_SERVER_PASSWORD: spec.password, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay), AGENT_DELEGATION_WORKER: '1' };
  // Resolve twice before starting the server, so managed config cannot silently re-enable a connection.
  const effective = await resolvedConfig(spec.executable, spec.executable_args, spec.directory, env);
  const allowed = new Set(spec.resources.map(r => r.connection.name));
  invariant(Object.entries(effective.mcp ?? {}).every(([name, cfg]) => (cfg as any).enabled === false || allowed.has(name)), 'MCP_POLICY', 'Managed configuration enables an unregistered MCP connection.');
  for (const name of allowed) for (const [key, value] of Object.entries(overlay.mcp[name])) invariant(digest(effective.mcp?.[name]?.[key]) === digest(value), 'MCP_POLICY', `Effective MCP connection differs from the verified profile: ${name}.${key}`);
  enforceHttpPolicy(effective,overlay);
  const context={spec,state,save},intent=beginProcess(context);
  const child: ChildProcess = spawn(spec.executable, [...spec.executable_args, 'serve', '--hostname=127.0.0.1','--port=0','--pure'], { cwd: spec.directory, env, detached: process.platform!=='win32', windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  child.on('error', error => { state.error = error.message; save(); });
  invariant(child.pid, 'SPAWN', 'OpenCode failed to start.');
  await registerProcess(context,child,intent);
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
  const client = callSdkFactory(sdk,spec.worker,{ baseUrl: state.url, directory: spec.directory,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${spec.password}`).toString('base64')}` },
    fetch: ((input: any, init?: any) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30000) })) as typeof fetch,
  });
  requireSdkMethods(client,httpSdkMethods,spec.worker);
  const health = (await client.global.health({ throwOnError: true })).data!;
  invariant(health?.healthy===true&&reportedVersion(health.version,'OpenCode')===version,'OPENCODE_HEALTH','OpenCode health API did not identify the launched runtime.');
  state.backend='opencode';state.backend_version=health.version;
  try {state.model = await selectModel(client, initial, spec);}
  catch(e){if(!spec.diagnostic||spec.model!==undefined||!(e instanceof Fault)||e.code!=='MODEL_UNAVAILABLE')throw e;}
  save();
  return { client, child, log };
}

export const httpSdkMethods=['global.health','provider.list','session.create','session.list','session.get','session.messages','session.status','session.promptAsync','session.abort','permission.list','permission.reply','question.list','question.reply','question.reject'];
export async function inspectSession(spec: WorkerSpec, state: WorkerState, username='opencode') {
  invariant(state.url && /^http:\/\/127\.0\.0\.1:\d+$/.test(state.url), 'ENDPOINT', 'Expected an owned localhost endpoint.');
  // Recovery reads only the already-owned endpoint and never imports a replacement SDK.
  const read=async (pathname:string)=>{
    const response=await fetch(new URL(pathname,state.url),{headers:{authorization:`Basic ${Buffer.from(`${username}:${spec.password}`).toString('base64')}`,'x-opencode-directory':encodeURIComponent(spec.directory)},signal:AbortSignal.timeout(3000)});
    invariant(response.ok,'BACKEND_API','Owned session evidence could not be read.');return response.json() as Promise<any>;
  };
  const health=await read('/global/health');
  if (!state.session_id) return { healthy: health.healthy, session_present: false, prompt_present: false };
  const session=await read(`/session/${encodeURIComponent(state.session_id)}`);
  const statuses=await read('/session/status'),messages=await read(`/session/${encodeURIComponent(state.session_id)}/message`);
  invariant(Array.isArray(messages)&&statuses&&typeof statuses==='object','BACKEND_API','Owned session evidence has an incompatible shape.');
  return { healthy: health.healthy, session_present: session.id === state.session_id, status: statuses[session.id]?.type ?? 'idle', prompt_present: messages.some((m:any) => m.info.id === state.prompt_id), messages: messages.length };
}
