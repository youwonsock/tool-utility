import path from 'node:path';
import { Fault, invariant, type InputRequest } from '../types.js';
import { writeJson, digest } from '../io.js';
import { workerEnvironment } from '../profiles.js';
import { connection, workerPermissionKey, toolPolicy } from '../policy.js';
import { spawnRuntime, stopOwned } from '../process.js';
import { JsonRpcPeer, type RpcFrame } from './json-rpc.js';
import type { Answer, BackendContext, Observation, WorkerBackend } from './contract.js';
import { executableVersion } from './version.js';
import { assertScopeMonitor, scopeMonitorHealthy } from '../scope.js';
import {
  CODEX_COMMAND_TOOL,
  CODEX_READ_TOOL,
  codexCommand,
  codexDynamicTools,
  codexWindowsSandbox,
  readCodexFile,
} from './codex-tools.js';
import { runSupervisedCommand } from '../verification.js';
import { codexToml } from './codex-toml.js';

function quote(value: string) {
  if (process.platform === 'win32') {
    invariant(!/["%\r\n]/.test(value), 'PATH', 'Native hook path cannot be quoted safely.');
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export class CodexBackend implements WorkerBackend {
  private peer?: JsonRpcPeer;
  private frames: RpcFrame[] = [];
  private pending = new Map<string, { frame: RpcFrame; input: InputRequest }>();
  private answered = new Map<string, string>();
  private confirmed = new Set<string>();
  private dynamicAnswers = new Map<string, string>();
  private executing = new Set<string>();
  private cancelled = false;
  private rolloutReadDeadline = 0;
  private accepted = false;
  private complete = false;
  private error?: string;
  private thread?: any;
  private model?: string;
  private windowsSandbox?: string;
  constructor(private context: BackendContext) {}
  private receive(frame: RpcFrame) {
    const { state, save, spec } = this.context;
    this.frames.push(frame);
    const p = frame.params ?? {};
    if (p.threadId && p.threadId !== state.session_id) {
      if (frame.id !== undefined && frame.method === 'item/tool/call')
        this.dynamicResult(frame, false, { error: 'Dynamic call is not owned by this worker thread.' });
      return;
    }
    if (frame.method === 'serverRequest/resolved') {
      for (const [key, pending] of this.pending)
        if (String(pending.frame.id) === String(p.requestId)) this.pending.delete(key);
      if (!this.complete) {
        const key = this.answered.get(String(p.requestId));
        if (key) this.confirmed.add(key);
      }
    }
    if (frame.method === 'item/completed' && p.item?.type === 'dynamicToolCall') {
      const key = this.dynamicAnswers.get(String(p.item.id));
      if (key) this.confirmed.add(key);
    }
    if (frame.method === 'turn/started') {
      state.turn_id = p.turn?.id;
      this.accepted = true;
      save();
    }
    if (frame.method === 'turn/completed') {
      this.complete = true;
      this.error =
        p.turn?.error?.message ?? (p.turn?.status !== 'completed' ? `Native turn ${p.turn?.status}.` : undefined);
    }
    if (frame.method === 'item/started' && p.item?.type === 'userMessage' && p.item.id === state.prompt_id)
      this.accepted = true;
    if (frame.id === undefined || !frame.method) return;
    const id = `input_${digest({ method: frame.method, id: frame.id, session: state.session_id }).slice(0, 32)}`;
    if (frame.method === 'item/tool/call') {
      try {
        assertScopeMonitor(spec, state);
        invariant(
          !this.cancelled &&
            p.threadId === state.session_id &&
            p.turnId === state.turn_id &&
            p.namespace == null &&
            typeof p.callId === 'string' &&
            p.callId.length > 0 &&
            p.callId.length <= 4096 &&
            !/[\x00-\x1f\x7f]/.test(p.callId),
          'MCP_POLICY',
          'Dynamic call is not owned by this worker turn.',
        );
        if (p.tool === CODEX_READ_TOOL) {
          this.dynamicResult(frame, true, readCodexFile(spec, p.arguments));
          return;
        }
        invariant(p.tool === CODEX_COMMAND_TOOL, 'MCP_POLICY', 'Unknown dynamic worker tool.');
        const command = codexCommand(spec, p.arguments);
        const input: InputRequest = {
          id,
          kind: 'permission',
          details: { tool: p.tool, ...command },
          supported_decisions: ['once', 'always', 'reject'],
          grant_key: workerPermissionKey(spec, p.tool, command),
        };
        this.pending.set(id, { frame, input });
      } catch (error) {
        this.dynamicResult(frame, false, { error: (error as Error).message });
      }
      return;
    }
    const question = frame.method === 'item/tool/requestUserInput' || frame.method === 'mcpServer/elicitation/request';
    const supported = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
    ];
    if (!supported.includes(frame.method)) {
      this.error = `Unsupported native server request: ${frame.method}`;
      this.peer?.write({
        id: frame.id,
        error: { code: -32601, message: 'Worker backend does not support this request.' },
      });
      return;
    }
    const decision = question ? 'ask' : this.permissionDecision(frame.method, p);
    if (!question && decision !== 'ask') {
      this.peer!.write({
        id: frame.id,
        result:
          frame.method === 'item/permissions/requestApproval'
            ? { permissions: {}, scope: 'turn' }
            : { decision: decision === 'deny' ? 'decline' : 'accept' },
      });
      return;
    }
    if (frame.method === 'mcpServer/elicitation/request') {
      const server = p.serverName ?? p.server_name;
      if (server && !spec.resources.some((r) => r.connection.name === server)) {
        this.peer!.write({ id: frame.id, result: { action: 'decline' } });
        this.error = 'Undeclared MCP server requested input.';
        return;
      }
    }
    const logical = { ...p };
    delete logical.threadId;
    delete logical.turnId;
    delete logical.itemId;
    const input: InputRequest = {
      id,
      kind: question ? 'question' : 'permission',
      details: p,
      supported_decisions: question ? ['answer', 'reject'] : ['once', 'always', 'reject'],
      ...(question ? {} : { grant_key: workerPermissionKey(spec, frame.method, logical) }),
    };
    this.pending.set(id, { frame, input });
  }
  private dynamicResult(frame: RpcFrame, success: boolean, value: unknown) {
    this.peer!.write({
      id: frame.id,
      result: { contentItems: [{ type: 'inputText', text: JSON.stringify(value) }], success },
    });
  }
  private permissionDecision(method: string, params: Record<string, any>) {
    const { spec, state } = this.context;
    if (!scopeMonitorHealthy(spec, state)) return 'deny';
    if (method === 'item/permissions/requestApproval') return 'deny'; // Native broad grants cannot override the path policy.
    if (method === 'item/commandExecution/requestApproval') {
      return 'deny'; // Native hooks cannot implement `ask`; shell uses the owned dynamic gateway.
    }
    if (method === 'item/fileChange/requestApproval')
      return toolPolicy(
        'fileChange',
        params,
        spec.directory,
        spec.context.map((c) => c.path),
        spec.scope,
      );
    return 'ask';
  }
  private async launch(overrides: Record<string, unknown>) {
    const { spec } = this.context;
    const args = [
      ...spec.worker.executable_args,
      ...(spec.worker?.native_profile ? ['--profile', spec.worker.native_profile] : []),
      ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${codexToml(value)}`]),
      'app-server',
      '--listen',
      'stdio://',
    ];
    const runtime = await spawnRuntime(this.context, spec.worker.executable, args, workerEnvironment(spec.worker!));
    this.peer = new JsonRpcPeer(runtime.child, (frame) => this.receive(frame));
    const initialization = await this.peer.request('initialize', {
      clientInfo: { name: 'delegate-worker', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    invariant(
      typeof initialization?.userAgent === 'string',
      'BACKEND_API',
      'Codex initialize API returned an incompatible response.',
    );
    this.peer.write({ method: 'initialized' });
  }
  async start() {
    const { spec, state, save } = this.context;
    const version = await executableVersion(spec);
    const features = {
      multi_agent: false,
      multi_agent_v2: false,
      apps: false,
      plugins: false,
      remote_plugin: false,
      goals: false,
      memories: false,
      browser_use: false,
      computer_use: false,
      image_generation: false,
      code_mode_host: false,
      hooks: false,
    };
    // Probe configuration without starting a thread or model; stop it before the owned execution server.
    await this.launch({ features });
    const initial = (await this.peer!.request('config/read', { cwd: spec.directory, includeLayers: false })).config;
    invariant(
      initial && typeof initial === 'object',
      'BACKEND_API',
      'Codex config/read API returned an incompatible response.',
    );
    invariant(await stopOwned(this.context), 'STOP_UNCERTAIN', 'Codex configuration probe did not stop.');
    this.windowsSandbox = codexWindowsSandbox(initial);
    const mcp: Record<string, unknown> = Object.fromEntries(
      Object.keys(initial.mcp_servers ?? {}).map((name) => [name, { enabled: false }]),
    );
    for (const resource of spec.resources) {
      const c = connection(resource, spec.directory);
      invariant(c.type !== 'sse', 'MCP_POLICY', 'Codex requires stdio or streamable HTTP resources.');
      mcp[resource.connection.name] =
        c.type === 'stdio'
          ? { command: c.command, args: c.args, env: c.env, enabled: true }
          : { url: c.url, http_headers: c.headers, enabled: true };
    }
    const cli = spec.host_executable;
    const hookCommand = [process.execPath, cli, 'policy-hook', spec.job_dir].map(quote).join(' ');
    const hooks: Record<string, unknown> = Object.fromEntries(
      Object.keys(initial.hooks ?? {})
        .filter((event) => event !== 'state')
        .map((event) => [event, []]),
    );
    hooks.state = {};
    hooks.PreToolUse = [{ matcher: '.*', hooks: [{ type: 'command', command: hookCommand, timeout: 15 }] }];
    const discovery = {
      features: { ...features, hooks: true, default_mode_request_user_input: true },
      mcp_servers: mcp,
      hooks,
      web_search: 'disabled',
      approval_policy: 'on-request',
      approvals_reviewer: 'user',
      ...(this.windowsSandbox ? { 'windows.sandbox': this.windowsSandbox } : {}),
    };
    await this.launch(discovery);
    const inspectHook = async (trusted: boolean, key?: string, hash?: string) => {
      const listing = await this.peer!.request('hooks/list', { cwds: [spec.directory] });
      invariant(
        Array.isArray(listing?.data) && listing.data.length === 1,
        'MCP_POLICY',
        'Codex hook inventory is unavailable.',
      );
      const entry = listing.data[0];
      invariant(
        entry.cwd === spec.directory &&
          Array.isArray(entry.hooks) &&
          entry.hooks.length === 1 &&
          !entry.errors?.length &&
          !entry.warnings?.length,
        'MCP_POLICY',
        'Codex hook inventory contains unexpected entries or errors.',
      );
      const hook = entry.hooks[0];
      invariant(
        hook.eventName === 'preToolUse' &&
          hook.source === 'sessionFlags' &&
          hook.handlerType === 'command' &&
          hook.command === hookCommand &&
          hook.matcher === '.*' &&
          hook.async === false &&
          hook.enabled === true &&
          hook.timeoutSec === 15 &&
          typeof hook.key === 'string' &&
          hook.key.length > 0 &&
          hook.key.length <= 8192 &&
          !/[\x00-\x1f\x7f]/.test(hook.key) &&
          typeof hook.currentHash === 'string' &&
          /^sha256:[a-f0-9]{64}$/.test(hook.currentHash),
        'MCP_POLICY',
        'Codex did not retain the exact owned synchronous tool hook.',
      );
      invariant(
        !trusted || (hook.trustStatus === 'trusted' && hook.key === key && hook.currentHash === hash),
        'MCP_POLICY',
        'Codex worker hook is not trusted with the discovered content hash.',
      );
      return hook;
    };
    const discovered = await inspectHook(false);
    invariant(await stopOwned(this.context), 'STOP_UNCERTAIN', 'Codex hook discovery did not stop.');
    hooks.state = { [discovered.key]: { enabled: true, trusted_hash: discovered.currentHash } };
    const overrides = { ...discovery, features: { ...discovery.features, code_mode_host: true } };
    await this.launch(overrides);
    const trusted = await inspectHook(true, discovered.key, discovered.currentHash);
    const effective = (await this.peer!.request('config/read', { cwd: spec.directory, includeLayers: false })).config;
    invariant(
      effective && typeof effective === 'object',
      'BACKEND_API',
      'Codex config/read API returned an incompatible response.',
    );
    invariant(
      Object.entries(overrides.features).every(([key, value]) => effective.features?.[key] === value) &&
        effective.web_search === 'disabled',
      'MCP_POLICY',
      'Effective Codex feature policy differs.',
    );
    invariant(
      effective.approval_policy === 'on-request' && effective.approvals_reviewer === 'user',
      'MCP_POLICY',
      'Effective Codex approval policy differs.',
    );
    invariant(
      !this.windowsSandbox || effective.windows?.sandbox === this.windowsSandbox,
      'MCP_POLICY',
      'Effective Codex Windows sandbox implementation differs.',
      {
        requested_windows_sandbox: this.windowsSandbox ?? null,
        observed_windows_sandbox: ['mxc', 'elevated', 'unelevated'].includes(effective.windows?.sandbox)
          ? effective.windows.sandbox
          : 'unsupported',
      },
    );
    const actualHooks = effective.hooks?.PreToolUse;
    const hookCheck =
      Array.isArray(actualHooks) &&
      actualHooks.length === 1 &&
      actualHooks[0].matcher === '.*' &&
      actualHooks[0].hooks?.length === 1 &&
      actualHooks[0].hooks[0].type === 'command' &&
      actualHooks[0].hooks[0].command === hookCommand &&
      actualHooks[0].hooks[0].async !== true;
    writeJson(path.join(spec.job_dir, 'hook-policy.json'), {
      confirmed: hookCheck,
      trusted: trusted.trustStatus === 'trusted',
      key: trusted.key,
      hash: trusted.currentHash,
      groups: Array.isArray(actualHooks)
        ? actualHooks.map((g: any) => ({
            keys: Object.keys(g),
            matcher: g.matcher,
            handlers: g.hooks?.map((h: any) => ({
              keys: Object.keys(h),
              type: h.type,
              command_matches: h.command === hookCommand,
              async: h.async,
            })),
          }))
        : null,
    });
    invariant(hookCheck, 'MCP_POLICY', 'Effective Codex tool hook differs.');
    const allowed = new Set(spec.resources.map((r) => r.connection.name));
    invariant(
      Object.entries(effective.mcp_servers ?? {}).every(
        ([name, cfg]) => (cfg as any).enabled === false || allowed.has(name),
      ),
      'MCP_POLICY',
      'Undeclared Codex MCP server remains enabled.',
    );
    for (const name of allowed) {
      const expected = mcp[name] as Record<string, unknown>,
        observed = effective.mcp_servers?.[name];
      for (const [key, value] of Object.entries(expected))
        if (value !== undefined)
          invariant(
            digest(observed?.[key]) === digest(value),
            'MCP_POLICY',
            'Effective Codex resource differs from its verified profile.',
          );
    }
    this.model =
      typeof spec.worker.model === 'string'
        ? spec.worker.model
        : typeof initial.model === 'string' && initial.model.length
          ? initial.model
          : undefined;
    state.backend = 'codex';
    state.backend_version = version;
    save();
  }
  async createSession() {
    const { spec, state, save } = this.context;
    writeJson(path.join(spec.job_dir, 'session-intent.json'), { at: Date.now(), id: spec.id, ephemeral: false });
    // Durable owned threads support thread/read(includeTurns); ephemeral threads
    // reject that API after an accepted prompt. Never retry a turn to recover it.
    const response = await this.peer!.request('thread/start', {
      cwd: spec.directory,
      model: this.model ?? null,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      ephemeral: false,
      dynamicTools: codexDynamicTools,
      developerInstructions:
        'Implement only the assigned task. Do not delegate, commit, change branches, or modify protected context files. Read source and protected context with delegate_read_file. Use delegate_run_command for foreground shell commands; it waits for supervisor approval. Ask questions with request_user_input. Native shell and other native tools are blocked. Edit only scoped files with apply_patch.',
    });
    invariant(
      response.thread?.id && response.approvalPolicy === 'on-request' && response.approvalsReviewer === 'user',
      'MCP_POLICY',
      'Native thread did not retain worker approval policy.',
    );
    invariant(
      response.sandbox?.type === 'workspaceWrite',
      'MCP_POLICY',
      'Native thread did not retain the worker workspace-write sandbox.',
      {
        requested_sandbox_type: 'workspaceWrite',
        observed_sandbox_type: ['workspaceWrite', 'readOnly', 'dangerFullAccess', 'externalSandbox'].includes(
          response.sandbox?.type,
        )
          ? response.sandbox.type
          : 'unknown',
        windows_sandbox: this.windowsSandbox ?? null,
      },
    );
    invariant(
      typeof response.model === 'string' &&
        response.model.length > 0 &&
        (this.model === undefined || response.model === this.model),
      'MODEL_UNAVAILABLE',
      'Codex did not resolve the requested model. No substitute model will be dispatched.',
    );
    state.session_id = response.thread.id;
    state.model = response.model;
    this.thread = response.thread;
    save();
  }
  async dispatch(prompt: string, requestID: string) {
    const { state, save, spec } = this.context;
    assertScopeMonitor(spec, state);
    this.rolloutReadDeadline = Date.now() + 30000;
    const response = await this.peer!.request('turn/start', {
      threadId: state.session_id,
      clientUserMessageId: requestID,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    });
    state.turn_id = response.turn?.id;
    this.accepted = true;
    save();
  }
  async observe(): Promise<Observation> {
    let materializing = false;
    if (this.context.state.session_id) {
      try {
        const response = await this.peer!.request('thread/read', {
          threadId: this.context.state.session_id,
          includeTurns: true,
        });
        this.thread = response.thread;
      } catch (error) {
        const details =
          error instanceof Fault && error.code === 'BACKEND_RPC'
            ? (error.details as { code?: number; message?: string })
            : undefined;
        const match =
          typeof details?.message === 'string'
            ? details.message.match(
                /^failed to read thread: thread-store internal error: failed to read session metadata (.+): rollout at (.+) is empty$/,
              )
            : null;
        const filename = match?.[1]?.replaceAll('\\', '/').split('/').at(-1);
        // A just-accepted durable turn can precede its first rollout flush. Only
        // these exact owned-session read errors are transient; never resend a turn.
        const flushing =
          (details?.code === -32601 && details.message === 'list_turns is not supported yet') ||
          (details?.code === -32603 &&
            match?.[1] === match?.[2] &&
            filename?.endsWith(`-${this.context.state.session_id}.jsonl`));
        if (!this.cancelled && this.accepted && Date.now() < this.rolloutReadDeadline && flushing) materializing = true;
        else throw error;
      }
      const turn =
        this.thread.turns?.find((t: any) => t.id === this.context.state.turn_id) ?? this.thread.turns?.at(-1);
      if (turn) {
        this.accepted ||=
          turn.items?.some((i: any) => i.type === 'userMessage' && i.id === this.context.state.prompt_id) ?? false;
        if (['completed', 'failed', 'interrupted'].includes(turn.status)) {
          this.complete = true;
          this.error ??=
            turn.error?.message ?? (turn.status === 'completed' ? undefined : `Native turn ${turn.status}.`);
        }
      }
    }
    const summary = this.thread?.turns
      ?.flatMap((t: any) => t.items ?? [])
      .filter((i: any) => i.type === 'agentMessage')
      .map((i: any) => i.text)
      .join('\n');
    return {
      accepted: this.accepted,
      complete: this.complete && !this.pending.size && !materializing,
      inputs: [...this.pending.values()].map((p) => p.input),
      transcript: { thread: this.thread, events: this.frames },
      summary,
      error: this.error,
      reply_confirmations: [...this.confirmed],
    };
  }
  async reply(input: InputRequest, answer: Answer): Promise<'uncertain'> {
    const pending = this.pending.get(input.id);
    invariant(pending, 'INPUT', 'Native request is no longer pending.');
    const { frame } = pending,
      p = frame.params ?? {};
    let result: unknown;
    if (frame.method === 'item/tool/call') {
      invariant(
        ['once', 'always', 'reject'].includes(answer.decision),
        'INPUT_UNSUPPORTED',
        'Dynamic shell requires a permission decision.',
      );
      invariant(
        !this.executing.has(input.id),
        'INPUT',
        'Dynamic command is already executing and will not be replayed.',
      );
      invariant(
        answer.decision === 'reject' ||
          (!this.cancelled &&
            p.threadId === this.context.state.session_id &&
            p.turnId === this.context.state.turn_id &&
            scopeMonitorHealthy(this.context.spec, this.context.state)),
        'MCP_POLICY',
        'Permission no longer satisfies the hard worker policy.',
      );
      const command = codexCommand(this.context.spec, p.arguments);
      this.executing.add(input.id);
      let value: unknown = { error: 'Supervisor rejected command.' },
        success = false;
      if (answer.decision !== 'reject') {
        value = await runSupervisedCommand(
          this.context,
          input.id,
          command,
          command.cwd,
          () =>
            this.cancelled ||
            !this.pending.has(input.id) ||
            p.turnId !== this.context.state.turn_id ||
            !scopeMonitorHealthy(this.context.spec, this.context.state),
        );
        success = (value as { status: string }).status === 'passed';
      }
      this.answered.set(String(frame.id), input.id);
      this.dynamicAnswers.set(String(p.callId), input.id);
      this.dynamicResult(frame, success, value);
      this.pending.delete(input.id);
      return 'uncertain';
    }
    invariant(
      input.kind === 'question' || answer.decision === 'reject' || this.permissionDecision(frame.method!, p) !== 'deny',
      'MCP_POLICY',
      'Permission no longer satisfies the hard worker policy.',
    );
    if (frame.method === 'item/tool/requestUserInput') {
      const questions = p.questions ?? [];
      invariant(
        answer.decision === 'reject' || answer.answers?.length === questions.length,
        'INPUT',
        'Answer count differs from question count.',
      );
      result = {
        answers: Object.fromEntries(
          questions.map((q: any, i: number) => [
            q.id,
            { answers: answer.decision === 'reject' ? [] : answer.answers![i] },
          ]),
        ),
      };
    } else if (frame.method === 'mcpServer/elicitation/request') {
      if (answer.decision === 'reject') result = { action: 'decline' };
      else {
        const schema = p.requestedSchema ?? p.requested_schema;
        invariant(
          schema?.type === 'object' && schema.properties,
          'BACKEND_UNSUPPORTED',
          'Only object-form MCP elicitation is supported.',
        );
        const entries = Object.entries(schema.properties) as [string, any][];
        invariant(answer.answers?.length === entries.length, 'INPUT', 'MCP answer count differs from the form.');
        const content = Object.fromEntries(
          entries.map(([key, field], i) => {
            const raw = answer.answers![i]![0] ?? '';
            const value =
              field.type === 'boolean'
                ? raw === 'true'
                : field.type === 'number' || field.type === 'integer'
                  ? Number(raw)
                  : field.type === 'array'
                    ? answer.answers![i]
                    : raw;
            invariant(
              !['number', 'integer'].includes(field.type) || Number.isFinite(value),
              'INPUT',
              'Invalid numeric form answer.',
            );
            return [key, value];
          }),
        );
        result = { action: 'accept', content };
      }
    } else if (frame.method === 'item/permissions/requestApproval')
      result = { permissions: answer.decision === 'reject' ? {} : p.permissions, scope: 'turn' };
    else result = { decision: answer.decision === 'reject' ? 'decline' : 'accept' };
    this.answered.set(String(frame.id), input.id);
    this.peer!.write({ id: frame.id, result });
    this.pending.delete(input.id);
    return 'uncertain';
  }
  async cancel() {
    this.cancelled = true;
    if (this.context.state.session_id && this.context.state.turn_id)
      await this.peer
        ?.request(
          'turn/interrupt',
          { threadId: this.context.state.session_id, turnId: this.context.state.turn_id },
          5000,
        )
        .catch(() => undefined);
  }
  async confirmStopped() {
    return stopOwned(this.context);
  }
}
