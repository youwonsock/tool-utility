import fs from 'node:fs';
import path from 'node:path';
import { invariant, type Model, type InputRequest, type WorkerSpec } from '../types.js';
import { sleep, writeJson, digest } from '../io.js';
import {
  launchOpenCode,
  resolvedConfig,
  restrictions,
  enforceHttpPolicy,
  httpSdkMethods,
  inspectSession,
} from '../opencode.js';
import { workerEnvironment } from '../profiles.js';
import { spawnRuntime, stopOwned } from './process.js';
import type { Answer, BackendContext, Observation, WorkerBackend } from './contract.js';
import { workerPermissionKey, toolPolicy, mutationPaths } from './policy.js';
import { verificationShell } from '../shell.js';
import { executableVersion, reportedVersion } from './version.js';
import { loadSdk, requireSdkMethods, callSdkFactory } from '../runtime.js';
import { assertScopeMonitor, scopeMonitorHealthy } from '../scope.js';

// Each generated SDK remains owned by its corresponding native runtime.
export class HttpBackend implements WorkerBackend {
  private client: any;
  private log?: fs.WriteStream;
  constructor(private context: BackendContext) {}
  async start() {
    const { spec, state, save } = this.context;
    if (spec.worker?.platform !== 'kilo') {
      const api = await launchOpenCode(spec, state, save);
      this.client = api.client;
      this.log = api.log;
      save();
      return;
    }
    const worker = spec.worker;
    const sdk = await loadSdk(worker, state.runtime!);
    const version = await executableVersion(spec);
    const initial = await resolvedConfig(
      spec.worker.executable,
      spec.worker.executable_args,
      spec.directory,
      workerEnvironment(worker),
    );
    state.verification_shell = verificationShell(worker.shell, initial.shell);
    save();
    const overlay = restrictions(
      initial,
      spec.resources,
      spec.directory,
      spec.context.map((c) => c.path),
    );
    const env = {
      ...workerEnvironment(worker),
      KILO_SERVER_PASSWORD: spec.password,
      KILO_SERVER_USERNAME: 'kilo',
      KILO_NO_DAEMON: '1',
      KILO_CONFIG_CONTENT: JSON.stringify(overlay),
    };
    const effective = await resolvedConfig(spec.worker.executable, spec.worker.executable_args, spec.directory, env);
    const allowed = new Set(spec.resources.map((r) => r.connection.name));
    invariant(
      Object.entries(effective.mcp ?? {}).every(([name, cfg]) => (cfg as any).enabled === false || allowed.has(name)),
      'MCP_POLICY',
      'Inherited MCP connection remains enabled.',
    );
    for (const name of allowed)
      for (const [key, value] of Object.entries(overlay.mcp[name]))
        invariant(
          digest(effective.mcp?.[name]?.[key]) === digest(value),
          'MCP_POLICY',
          'Effective resource connection differs.',
        );
    enforceHttpPolicy(effective, overlay);
    const runtime = await spawnRuntime(
      this.context,
      spec.worker.executable,
      [...spec.worker.executable_args, 'serve', '--hostname=127.0.0.1', '--port=0', '--pure'],
      env,
    );
    this.log = runtime.log;
    let output = '';
    runtime.child.stdout!.on('data', (data) => {
      this.log!.write(data);
      output = (output + data.toString()).slice(-65536);
    });
    for (let i = 0; i < 300; i++) {
      const url = output.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) {
        state.url = url;
        save();
        break;
      }
      invariant(
        runtime.child.exitCode === null && !state.error,
        'BACKEND_START',
        'Kilo exited before announcing its endpoint.',
      );
      await sleep(100);
    }
    invariant(state.url, 'BACKEND_START', 'Kilo did not announce its endpoint.');
    this.client = callSdkFactory(sdk, worker, {
      baseUrl: state.url,
      directory: spec.directory,
      headers: { authorization: `Basic ${Buffer.from(`kilo:${spec.password}`).toString('base64')}` },
      fetch: ((input: any, init: any) =>
        fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30000) })) as typeof fetch,
    });
    requireSdkMethods(this.client, httpSdkMethods, worker);
    const health = (await this.client.global.health({ throwOnError: true })).data;
    invariant(
      health?.healthy === true && reportedVersion(health.version, 'Kilo') === version,
      'BACKEND_API',
      'Kilo health API did not identify the launched runtime.',
    );
    const providers = (await this.client.provider.list({}, { throwOnError: true })).data;
    invariant(
      providers &&
        Array.isArray(providers.all) &&
        Array.isArray(providers.connected) &&
        providers.default &&
        typeof providers.default === 'object',
      'BACKEND_API',
      'Kilo provider API returned an incompatible response.',
    );
    let model = spec.worker.model as Model | undefined;
    if (!model && initial.model) {
      const [providerID, ...parts] = String(initial.model).split('/');
      model = { providerID: providerID!, modelID: parts.join('/') };
    }
    if (!model) {
      const provider = providers.all.find((p: any) => providers.connected.includes(p.id));
      if (provider) model = { providerID: provider.id, modelID: providers.default[provider.id] };
    }
    invariant(
      (spec.diagnostic && spec.worker.model === undefined) ||
        (model &&
          providers.connected.includes(model.providerID) &&
          providers.all.find((p: any) => p.id === model!.providerID)?.models[model.modelID]),
      'MODEL_UNAVAILABLE',
      'Configured Kilo model is unavailable. No fallback was used.',
    );
    state.model = model;
    state.backend = 'kilo';
    state.backend_version = health.version;
    save();
  }
  async createSession() {
    const { spec, state, save } = this.context;
    writeJson(path.join(spec.job_dir, 'session-intent.json'), { at: Date.now(), title: `delegation:${spec.id}` });
    let session: any;
    try {
      session = (
        await this.client.session.create(
          {
            title: `delegation:${spec.id}`,
            agent: 'delegate-worker',
            ...(state.model
              ? { model: { id: (state.model as Model).modelID, providerID: (state.model as Model).providerID } }
              : {}),
          },
          { throwOnError: true },
        )
      ).data;
    } catch {
      const matches = (await this.client.session.list({}, { throwOnError: true })).data.filter(
        (s: any) => s.title === `delegation:${spec.id}`,
      );
      invariant(matches.length === 1, 'SESSION_UNCERTAIN', 'Session response was lost; no session was created again.');
      session = matches[0];
    }
    invariant(
      typeof session?.id === 'string' && session.id.length > 0,
      'BACKEND_API',
      'Native session API did not return a session ID. No session was created again.',
    );
    state.session_id = session.id;
    save();
  }
  async dispatch(prompt: string, requestID: string) {
    const { state } = this.context;
    assertScopeMonitor(this.context.spec, state);
    await this.client.session.promptAsync(
      {
        sessionID: state.session_id,
        messageID: requestID,
        model: state.model,
        agent: 'delegate-worker',
        parts: [{ type: 'text', text: prompt }],
      },
      { throwOnError: true },
    );
  }
  async observe(): Promise<Observation> {
    const { state } = this.context;
    const messages = (await this.client.session.messages({ sessionID: state.session_id }, { throwOnError: true })).data;
    const statuses = (await this.client.session.status({}, { throwOnError: true })).data;
    const permissions = (await this.client.permission.list({}, { throwOnError: true })).data;
    const questions = (await this.client.question.list({}, { throwOnError: true })).data;
    const allowedPermissions: any[] = [];
    for (const permission of permissions.filter((p: any) => p.sessionID === state.session_id)) {
      const decision = this.permissionDecision(permission);
      if (decision === 'ask') allowedPermissions.push(permission);
      else
        await this.client.permission.reply(
          { requestID: permission.id, reply: decision === 'allow' ? 'once' : 'reject' },
          { throwOnError: true },
        );
    }
    const inputs: InputRequest[] = [
      ...allowedPermissions.map((p: any) => ({
        id: p.id,
        kind: 'permission',
        details: p,
        grant_key: this.permissionGrant(p),
        supported_decisions: ['once', 'always', 'reject'],
      })),
      ...questions
        .filter((q: any) => q.sessionID === state.session_id)
        .map((q: any) => ({ id: q.id, kind: 'question', details: q, supported_decisions: ['answer', 'reject'] })),
    ];
    const accepted = messages.some((m: any) => m.info.id === state.prompt_id && m.info.role === 'user');
    const replies = messages.filter((m: any) => m.info.role === 'assistant' && m.info.parentID === state.prompt_id),
      last = replies.at(-1);
    const complete = !!(
      accepted &&
      last?.info.time?.completed &&
      (!statuses[state.session_id!] || statuses[state.session_id!].type === 'idle') &&
      !inputs.length &&
      !last.parts.some((p: any) => p.type === 'tool' && ['pending', 'running'].includes(p.state.status))
    );
    return {
      accepted,
      complete,
      inputs,
      transcript: messages,
      summary: replies
        .flatMap((m: any) => m.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text))
        .join('\n'),
      usage: replies.map((m: any) => ({
        model: `${m.info.providerID}/${m.info.modelID}`,
        tokens: m.info.tokens,
        cost: m.info.cost,
      })),
      error: last?.info.error
        ? JSON.stringify(last.info.error)
        : complete && ['tool-calls', 'unknown'].includes(last.info.finish)
          ? 'Assistant did not finish its implementation turn.'
          : undefined,
    };
  }
  private permissionInput(permission: any): Record<string, unknown> {
    if (/bash|shell|exec|command/i.test(permission.permission))
      return { ...permission.metadata, command: permission.metadata?.command ?? permission.patterns };
    // Native patterns must enumerate all touched files. Metadata supplies rename
    // endpoints and multichange patch paths as well; opaque globs fail closed.
    const patterns = permission.patterns;
    if (
      !Array.isArray(patterns) ||
      !patterns.length ||
      patterns.some((p) => typeof p !== 'string' || /[*?\[\]]/.test(p))
    )
      return {};
    // Preserve both sources independently: neither a metadata key nor a native
    // pattern may erase another native edit/rename/patch endpoint.
    return { ...permission.metadata, native_paths: patterns, metadata_paths: permission.metadata ?? {} };
  }
  private permissionGrant(permission: any) {
    return workerPermissionKey(this.context.spec, permission.permission, {
      patterns: permission.patterns,
      metadata: permission.metadata ?? {},
      input: this.permissionInput(permission),
    });
  }
  private permissionDecision(permission: any) {
    const { spec, state } = this.context;
    if (!scopeMonitorHealthy(spec, state)) return 'deny';
    if (typeof permission.permission !== 'string') return 'deny';
    if (permission.permission === 'external_directory' || /task|skill|background/i.test(permission.permission))
      return 'deny';
    const input = this.permissionInput(permission);
    if (
      /edit|write|delete|rename|patch/i.test(permission.permission) &&
      !mutationPaths(permission.permission, input)?.length
    )
      return 'deny';
    return toolPolicy(
      permission.permission,
      input,
      spec.directory,
      spec.context.map((c) => c.path),
      spec.scope,
    );
  }
  async reply(input: InputRequest, answer: Answer): Promise<'sent'> {
    if (input.kind === 'permission') {
      const latest = (await this.client.permission.list({}, { throwOnError: true })).data.find(
        (p: any) => p.id === input.id && p.sessionID === this.context.state.session_id,
      );
      invariant(latest, 'INPUT', 'Native permission is no longer pending.');
      invariant(
        this.permissionGrant(latest) === input.grant_key,
        'MCP_POLICY',
        'Native permission changed before the reply.',
      );
      invariant(
        answer.decision === 'reject' || this.permissionDecision(latest) !== 'deny',
        'MCP_POLICY',
        'Permission no longer satisfies the hard worker policy.',
      );
      // Framework grants are attempt-local. Never save native global permission rules.
      await this.client.permission.reply(
        { requestID: input.id, reply: answer.decision === 'always' ? 'once' : answer.decision },
        { throwOnError: true },
      );
    } else if (answer.decision === 'reject')
      await this.client.question.reject({ requestID: input.id }, { throwOnError: true });
    else await this.client.question.reply({ requestID: input.id, answers: answer.answers }, { throwOnError: true });
    return 'sent';
  }
  async cancel() {
    if (this.context.state.session_id)
      await this.client?.session
        .abort({ sessionID: this.context.state.session_id }, { throwOnError: true, signal: AbortSignal.timeout(5000) })
        .catch(() => undefined);
  }
  async confirmStopped() {
    const stopped = await stopOwned(this.context);
    this.log?.end();
    return stopped;
  }
}
export async function inspectHttpSession(spec: WorkerSpec, state: WorkerStateLike) {
  return inspectSession(spec, state, spec.worker.platform === 'kilo' ? 'kilo' : 'opencode');
}
type WorkerStateLike = BackendContext['state'];
