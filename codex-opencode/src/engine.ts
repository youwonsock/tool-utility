import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './store.js';
import { BASELINE, PROTOCOL, VERSION, Fault, invariant, schemas, type Attempt, type Run, type Task, type TaskSpec, type ToolName, type WorkerSpec, type WorkerState, type Resource } from './types.js';
import { uid, digest, readJson, writeJson, mkdir, exec, alive, terminate, sleep, inside, processIdentity, bootId, treeAlive } from './io.js';
import { branch, clean, git, head, repository, worktree, snapshot, materialize, validateScope, resultCommit, integrate, targetReady, checkContext, contextHash } from './git.js';
import { probeResources, resolvedConfig, launchOpenCode, inspectSession } from './opencode.js';

const active = new Set(['launching','running','needs_input','resource_wait','delivery_uncertain','cancelling','orphaned','stop_uncertain']);
const occupiesSlot = (a: Attempt) => active.has(a.state) && a.state !== 'resource_wait';
export class Engine {
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private polling = false;
  constructor(public store: Store, public executableFile: string, public options = {
    opencode: process.env.CODEX_OPENCODE_EXECUTABLE || 'opencode',
    opencode_args: JSON.parse(process.env.CODEX_OPENCODE_EXECUTABLE_ARGS || '[]') as string[],
    concurrency: Number(process.env.CODEX_OPENCODE_CONCURRENCY || 2),
  }) { invariant(Number.isSafeInteger(options.concurrency) && options.concurrency > 0, 'CONFIG', 'Invalid service concurrency.'); }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn); this.tail = next.catch(() => undefined); return next;
  }
  start() {
    this.timer = setInterval(() => {
      if (this.polling) return; this.polling = true;
      void this.serial(() => this.tick()).catch(error => { process.stderr.write(`scheduler: ${(error as Error).message}\n`); }).finally(() => { this.polling = false; });
    }, 300);
  }
  stop() { if (this.timer) clearInterval(this.timer); }
  getRun(id: string) { const run = this.store.state.runs.find(r => r.id === id); invariant(run, 'NOT_FOUND', 'Run not found.'); return run; }
  allAttempts(run?: Run) { return (run ? [run] : this.store.state.runs).flatMap(r => [...r.tasks.flatMap(t => t.attempts), ...(r.validation ? [r.validation.attempt] : [])]); }
  async call(name: ToolName, raw: unknown): Promise<unknown> {
    const args: any = schemas[name].parse(raw);
    if (name === 'wait_run') {
      const deadline = Date.now() + args.timeout_ms;
      this.getRun(args.run_id);
      while (!this.store.state.events.some(e => e.run_id === args.run_id && e.seq > args.after) && Date.now() < deadline) await sleep(100);
      return this.serial(async () => {
        const events = this.store.state.events.filter(e => e.run_id === args.run_id && e.seq > args.after);
        const page = this.store.page(events, undefined, { run_id: args.run_id, after: args.after });
        const consumed = page.next_cursor ? Number(page.next_cursor) : events.length;
        return { ...page, after: events[consumed - 1]?.seq ?? args.after, next_cursor: undefined };
      });
    }
    return this.serial(async () => {
      const action = async () => this.dispatch(name, args);
      return args.request_id ? this.store.mutation(args.request_id, { name, args }, action) : action();
    });
  }
  private async dispatch(name: ToolName, args: any): Promise<unknown> {
    switch (name) {
      case 'doctor': return this.doctor(args);
      case 'submit_tasks': return this.submit(args);
      case 'list_runs': return this.store.page(this.store.state.runs.map(r => ({ run_id: r.id, repo: r.repo, branch: r.branch, state: r.state, revision: r.revision, tasks: r.tasks.length, created: r.created })), args.cursor);
      case 'get_run': return this.view(this.getRun(args.run_id), args.cursor);
      case 'get_artifact': return this.store.artifactPage(args.artifact_id, args.offset, args.limit);
      case 'review_task': return this.review(args);
      case 'respond_to_request': return this.respond(args);
      case 'reconcile_run': await this.reconcile(this.getRun(args.run_id)); return this.view(this.getRun(args.run_id));
      case 'cancel_run': return this.cancel(this.getRun(args.run_id));
      case 'validate_run': return this.validate(this.getRun(args.run_id));
      case 'finalize_run': return this.finalize(args);
      default: throw new Fault('TOOL', 'Unknown tool.');
    }
  }
  view(run: Run, cursor?: string) {
    return this.store.page(run.tasks.map(t => {
      const a = t.attempts.at(-1);
      return { task_id: t.spec.id, state: t.state, dependencies: t.spec.dependencies, attempt: a && { id: a.id, number: a.number, state: a.state, directory: a.directory, commit: a.commit, model: a.model, verification: a.verification, artifacts: a.artifacts, inputs: a.inputs, error: a.error, integrated_commit: a.integrated_commit } };
    }), cursor, { run_id: run.id, state: run.state, revision: run.revision, base: run.base, integration_commit: run.integration_commit,
      validation: run.validation && { id: run.validation.id, state: run.validation.state, commit: run.validation.commit, revision: run.validation.revision, attempt_id: run.validation.attempt.id, directory: run.validation.attempt.directory, artifacts: run.validation.attempt.artifacts, verification: run.validation.attempt.verification, inputs: run.validation.attempt.inputs, error: run.validation.attempt.error }, error: run.error,
      event_cursor: this.store.state.events.filter(e => e.run_id === run.id).at(-1)?.seq ?? 0,
    });
  }
  async doctor(args: { repo?: string; model?: unknown }) {
    const version = await exec(this.options.opencode, [...this.options.opencode_args, '--version']);
    const repo = args.repo ? await repository(args.repo) : undefined;
    const config = await resolvedConfig(this.options.opencode, this.options.opencode_args, args.repo || this.store.root);
    const doctorID = uid('doctor'), jobDir = path.join(this.store.root, 'diagnostics', doctorID); mkdir(jobDir);
    const state: WorkerState = { protocol: PROTOCOL, id: doctorID, phase: 'doctor', updated: Date.now(), prompt_id: '', verification: [], inputs: [], replies: {} };
    let connection: { healthy: boolean; model?: unknown; error?: string } = { healthy: false };
    try {
      const api = await launchOpenCode({ id: doctorID, directory: args.repo || this.store.root, job_dir: jobDir, goal: '', acceptance: [], scope: [], verification: [], resources: [], context: [], timeout_ms: 30000, validation: true, model: args.model as WorkerSpec['model'], executable: this.options.opencode, executable_args: this.options.opencode_args, password: uid('secret') }, state, () => {});
      connection = { healthy: true, model: state.model }; api.log.end();
    } catch (e) { connection.error = (e as Error).message; }
    finally { if (state.server) await terminate(state.server, true); }
    return { version: VERSION, protocol: PROTOCOL, node: process.versions.node, platform: process.platform,
      opencode: version.stdout.trim(), baseline: BASELINE, compatible: version.code === 0 && version.stdout.trim() === BASELINE,
      connection, provider_authentication: 'Not exercised by doctor; a real model request is required to verify provider credentials.',
      inherited_mcp_disabled: Object.keys(config.mcp ?? {}), repo,
      resources: this.store.state.runs.flatMap(r => r.resources.map(p => ({ run_id: r.id, resource_key: p.resource_key, expected_instance: p.expected_instance, project_bound: p.project_bound }))),
      running: this.allAttempts().filter(a => active.has(a.state)).map(a => a.id),
      metrics: this.store.state.metrics,
    };
  }
  validateGraph(specs: TaskSpec[]) {
    const ids = new Set(specs.map(t => t.id)); invariant(ids.size === specs.length, 'TASK_ID', 'Duplicate task ID.');
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => {
      invariant(!visiting.has(id), 'DEPENDENCY_CYCLE', 'Task dependency cycle.'); if (visited.has(id)) return;
      const task = specs.find(t => t.id === id)!; visiting.add(id);
      for (const dep of task.dependencies) { invariant(ids.has(dep), 'DEPENDENCY', `Unknown dependency ${dep}`); visit(dep); }
      visiting.delete(id); visited.add(id); validateScope(task.scope);
    };
    for (const t of specs) visit(t.id);
  }
  async submit(args: any) {
    let run: Run;
    const specs = args.tasks as TaskSpec[];
    if (args.run_id) {
      run = this.getRun(args.run_id);
      invariant(!['validating','finalizing','completed','cancelled','cancelling','finalize_uncertain'].includes(run.state), 'RUN_FROZEN', 'Run does not accept new tasks in its current state.');
      invariant(!args.repo || args.repo === run.repo, 'REPO', 'Cannot change run repository.');
      invariant(!args.settings && args.resources.length === 0 && args.context_files.length === 0, 'RUN_CONFIG', 'Run settings, resources and shared context are immutable.');
      this.validateGraph([...run.tasks.map(t => t.spec), ...specs]);
    } else {
      invariant(args.repo, 'REPO', 'A repository root is required for a new run.');
      this.validateGraph(specs);
      const repo = await repository(args.repo); const id = uid('run');
      run = { id, ...repo, integration_branch: `codex/opencode-${id}`, integration_dir: path.join(this.store.root, 'worktrees', id, 'integration'), integration_commit: repo.base,
        state: 'active', revision: 1, created: Date.now(), tasks: [], context: [], final_verification: args.final_verification ?? [], resources: args.resources,
        settings: { concurrency: 2, timeout_ms: 3600000, max_retries: 3, ...args.settings } };
      const keys = run.resources.map(r => r.resource_key); invariant(new Set(keys).size === keys.length, 'RESOURCE', 'Duplicate resource key.');
      for (const profile of run.resources) {
        for (const other of this.store.state.runs.flatMap(r => r.resources)) if (other.resource_key === profile.resource_key) invariant(digest(other) === digest(profile), 'RESOURCE_PROFILE', 'The same resource_key must refer to the same profile service-wide.');
      }
      run.context = await snapshot(this.store, id, repo.repo, args.context_files);
      this.store.state.runs.push(run); this.store.save();
      await worktree(repo.repo, run.integration_dir, repo.base, run.integration_branch);
    }
    for (const spec of specs) invariant(spec.resources.every(key => run.resources.some(r => r.resource_key === key)), 'RESOURCE', `Task ${spec.id} references an unregistered resource.`);
    // Snapshot all explicitly referenced files before changing the task revision.
    const contexts = await Promise.all(specs.map(t => snapshot(this.store, run.id, run.repo, [...new Set([...run.context.map(c => c.path), ...t.context_files])])));
    for (let i = 0; i < specs.length; i++) {
      const task: Task = { spec: specs[i]!, state: 'queued', attempts: [], revision: 1 };
      task.spec.context_files = contexts[i]!.map(c => c.path);
      // Store each specification and snapshot as evidence; the scheduler recaptures only after checking hashes.
      const metadata = { spec: task.spec, context: contexts[i] };
      writeJson(path.join(this.store.root, 'runs', run.id, `${task.spec.id}.json`), metadata);
      run.tasks.push(task);
    }
    if (args.run_id) { run.revision++; this.invalidate(run); }
    if (args.final_verification) run.final_verification = args.final_verification;
    run.state = 'active'; this.store.event(run.id, 'tasks_submitted', { revision: run.revision, tasks: specs.map(t => t.id) });
    return { run_id: run.id, revision: run.revision, tasks: specs.map(t => t.id) };
  }
  invalidate(run: Run) {
    if (run.validation) { run.validation.state = 'invalidated'; (run.validation_history ??= []).push(run.validation); run.validation = undefined; }
  }
  lockedResources() { return new Set(this.allAttempts().filter(a => active.has(a.state)).flatMap(a => a.resources)); }
  async tick() {
    for (const run of this.store.state.runs) await this.collect(run);
    let count = this.allAttempts().filter(occupiesSlot).length;
    for (const run of this.store.state.runs) {
      if (run.state !== 'active') continue;
      for (const task of run.tasks) {
        if (count >= this.options.concurrency) break;
        if (this.allAttempts(run).filter(occupiesSlot).length >= run.settings.concurrency) break;
        if (task.state !== 'queued' || !task.spec.dependencies.every(dep => run.tasks.find(t => t.spec.id === dep)?.state === 'integrated')) continue;
        const locks = this.lockedResources(); if (task.spec.resources.some(key => locks.has(key))) continue;
        await this.launch(run, task); count = this.allAttempts().filter(occupiesSlot).length;
      }
    }
  }
  async launch(run: Run, task: Task) {
    const prior = task.attempts.at(-1);
    const base = run.integration_commit;
    const id = uid('attempt');
    const metadata = readJson<{ context: Attempt['context'] }>(path.join(this.store.root, 'runs', run.id, `${task.spec.id}.json`))!;
    const attempt: Attempt = { id, number: task.attempts.length + 1, base, directory: path.join(this.store.root, 'worktrees', run.id, id), job_dir: path.join(this.store.root, 'jobs', id), state: 'launching', artifacts: [], verification: [], context: metadata.context, resources: task.spec.resources, inputs: [], feedback: prior?.feedback };
    task.attempts.push(attempt); task.state = 'running'; this.store.save();
    try {
      checkContext(run.repo, attempt.context);
      await worktree(run.repo, attempt.directory, base);
      await materialize(this.store, attempt.directory, attempt.context);
      if (prior?.commit) {
        const diff = (await git(prior.directory, ['diff','--binary', prior.base, prior.commit])).stdout;
        mkdir(attempt.job_dir); const patch = path.join(attempt.job_dir, 'previous.patch'); fs.writeFileSync(patch, diff);
        const applied = diff ? await git(attempt.directory, ['apply','--3way','--index', patch], true) : { code: 0, stdout: '', stderr: '' };
        attempt.artifacts.push(this.store.artifact(run.id, 'patch-application.json', JSON.stringify(applied)));
      }
      await probeResources(this.resources(run, attempt), attempt.directory);
      const goal = `${task.spec.goal}${attempt.feedback ? `\n\nCodex correction instructions:\n${attempt.feedback}` : ''}`;
      await this.spawn(run, attempt, { goal, acceptance: task.spec.acceptance, verification: task.spec.verification, scope: task.spec.scope, model: task.spec.model ?? prior?.model, validation: false });
    } catch (e) { await this.launchFailure(run, attempt, e); task.state = attempt.state === 'resource_wait' ? 'needs_input' : 'needs_review'; }
    this.store.event(run.id, 'attempt_started', { task_id: task.spec.id, attempt_id: id, state: attempt.state });
  }
  resources(run: Run, attempt: Attempt): Resource[] { return attempt.resources.map(key => run.resources.find(r => r.resource_key === key)!); }
  async spawn(run: Run, attempt: Attempt, task: Pick<WorkerSpec, 'goal'|'acceptance'|'verification'|'scope'|'model'|'validation'>) {
    mkdir(attempt.job_dir);
    const spec: WorkerSpec = { id: attempt.id, directory: attempt.directory, job_dir: attempt.job_dir, ...task, resources: this.resources(run, attempt), context: attempt.context,
      timeout_ms: run.settings.timeout_ms, executable: this.options.opencode, executable_args: this.options.opencode_args, password: uid('secret') };
    writeJson(path.join(attempt.job_dir, 'spec.json'), spec);
    attempt.state = 'launching'; attempt.launch_boot = await bootId(); this.store.save(); // durable launch intent precedes spawn
    const logFd = fs.openSync(path.join(attempt.job_dir, 'host.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [this.executableFile, 'worker', attempt.job_dir], { detached: true, stdio: ['ignore',logFd,logFd], windowsHide: true });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      // Independent host identity is a recovery hint. Its own exclusive record is authoritative.
      writeJson(path.join(attempt.job_dir, 'launch.json'), { host: await processIdentity(child.pid!), at: Date.now() });
      child.unref(); attempt.state = 'running'; this.store.save();
    } finally { fs.closeSync(logFd); }
  }
  async launchFailure(run: Run, attempt: Attempt, e: unknown) {
    attempt.error = (e as Error).message;
    attempt.artifacts.push(this.store.artifact(run.id, 'error.json', JSON.stringify({ message: (e as Error).message, details: e instanceof Fault ? e.details : undefined })));
    attempt.state = e instanceof Fault && e.code.startsWith('RESOURCE_') ? 'resource_wait' : fs.existsSync(path.join(attempt.job_dir, 'spec.json')) ? 'orphaned' : 'failed'; this.store.save();
  }
  async collect(run: Run) {
    for (const attempt of this.allAttempts(run).filter(a => active.has(a.state))) {
      const state = readJson<WorkerState>(path.join(attempt.job_dir, 'worker.json'));
      if (!state) continue;
      const progress = (w?: WorkerState) => digest(w && { phase: w.phase, inputs: w.inputs, session_id: w.session_id, prompt_intent: w.prompt_intent, prompt_accepted: w.prompt_accepted, model: w.model, shell_intent: w.shell_intent, verification: w.verification });
      const prior = progress(attempt.worker);
      attempt.worker = state; attempt.model = state.model; attempt.inputs = state.inputs;
      if (!state.stopped) {
        attempt.state = ['needs_input','delivery_uncertain','cancelling','stop_uncertain'].includes(state.phase) ? state.phase : 'running';
        if (prior !== progress(state)) this.store.event(run.id, 'worker_state', { attempt_id: attempt.id, phase: state.phase, input_ids: state.inputs.map(i => i.id), prompt_dispatched: !!state.prompt_intent, verified_commands: state.verification.length });
        continue;
      }
      if (state.server && await treeAlive(state.server)) { attempt.state = 'stop_uncertain'; continue; }
      attempt.error = state.error;
      for (const file of ['prompt.txt','transcript.json','server.log','host.log', ...state.verification.map(v => v.artifact)]) {
        const source = inside(attempt.job_dir, file); if (fs.existsSync(source)) attempt.artifacts.push(this.store.artifact(run.id, path.basename(file), fs.readFileSync(source)));
      }
      attempt.artifacts.push(this.store.artifact(run.id, 'worker-report.json', JSON.stringify({ model_report: state.summary ?? null, reported_usage: state.usage ?? null, observed_verification: state.verification, session_id: state.session_id, model: state.model })));
      attempt.verification = state.verification.map(v => ({ ...v, artifact: attempt.artifacts.find(a => a.endsWith(`-${v.artifact}`)) ?? v.artifact }));
      attempt.inputs = [];
      const task = run.tasks.find(t => t.attempts.includes(attempt));
      if (state.phase === 'cancelled') { attempt.state = 'cancelled'; if (task) task.state = 'cancelled'; }
      else if (state.phase !== 'completed') { attempt.state = 'failed'; if (task) task.state = 'needs_review'; }
      else if (task) {
        try {
          const title = `OpenCode ${task.spec.id} attempt ${attempt.number} (${attempt.id})`;
          const current = await head(attempt.directory);
          if (attempt.commit_intent && current !== attempt.base) {
            invariant((await git(attempt.directory, ['show','-s','--format=%s',current])).stdout.trim() === title && (await git(attempt.directory, ['rev-parse',`${current}^`])).stdout.trim() === attempt.base, 'COMMIT_UNCERTAIN', 'Interrupted result commit does not match its durable intent.');
            await clean(attempt.directory, attempt.context.filter(c => !c.tracked).map(c => c.path)); checkContext(attempt.directory, attempt.context); attempt.commit = current;
          } else {
            attempt.commit_intent = true; this.store.save();
            attempt.commit = await resultCommit(attempt.directory, attempt.base, task.spec.scope, attempt.context, title);
          }
          attempt.artifacts.push(this.store.artifact(run.id, 'diff.patch', (await git(attempt.directory, ['show','--format=fuller','--binary',attempt.commit])).stdout));
          attempt.state = 'needs_review'; task.state = 'needs_review';
        } catch (e) { attempt.error = (e as Error).message; attempt.state = 'scope_or_context_error'; task.state = 'needs_review'; attempt.artifacts.push(this.store.artifact(run.id, 'rejected-diff.patch', (await git(attempt.directory, ['diff','HEAD','--binary'])).stdout)); }
      } else if (run.validation?.attempt === attempt) {
        const validation = run.validation;
        try {
          invariant(await head(attempt.directory) === validation.commit, 'VALIDATION_CHANGED', 'Validation changed HEAD.');
          await clean(attempt.directory, attempt.context.filter(c => !c.tracked).map(c => c.path)); checkContext(attempt.directory, attempt.context);
          invariant(attempt.verification.length === run.final_verification.length && attempt.verification.every(v => v.status === 'passed'), 'VALIDATION_FAILED', 'Final verification has failed, incomplete or unknown commands.');
          invariant(validation.revision === run.revision && validation.commands_hash === digest(run.final_verification) && validation.context_hash === contextHash(attempt.context), 'STALE_VALIDATION', 'Frozen validation inputs changed.');
          validation.state = 'passed'; attempt.state = 'verified'; run.state = 'waiting_final_review';
        } catch (e) { validation.state = 'failed'; attempt.state = 'failed'; attempt.error = (e as Error).message; run.state = 'active'; }
      }
      if (!task && run.validation?.attempt === attempt && ['failed','cancelled'].includes(attempt.state)) { run.validation.state = 'failed'; if (run.state !== 'cancelling') run.state = 'active'; }
      this.store.event(run.id, 'attempt_finished', { attempt_id: attempt.id, state: attempt.state, commit: attempt.commit, error: attempt.error });
    }
    if (run.state === 'cancelling' && !this.allAttempts(run).some(a => active.has(a.state))) { run.state = 'cancelled'; this.store.event(run.id, 'cancelled', {}); }
  }
  async review(args: any) {
    const run = this.getRun(args.run_id);
    invariant(!['validating','finalizing','completed','cancelling','cancelled'].includes(run.state), 'RUN_FROZEN', 'Run is frozen.');
    const task = run.tasks.find(t => t.spec.id === args.task_id); invariant(task, 'TASK', 'Task not found.');
    const attempt = task.attempts.at(-1); invariant(attempt && attempt.id === args.attempt_id && !active.has(attempt.state), 'ATTEMPT', 'Review must name the latest stopped attempt.');
    invariant(attempt.commit === args.commit, 'STALE_APPROVAL', 'Result commit does not match the attempt.');
    invariant(task.state !== 'integrated', 'IMMUTABLE', 'Integrated tasks are immutable; submit a new correction task.');
    if (args.decision === 'request_changes') {
      invariant(args.feedback?.trim(), 'FEEDBACK', 'Correction instructions from Codex are required.');
      invariant(attempt.number <= run.settings.max_retries, 'RETRY_LIMIT', 'Correction limit reached. Submit a new task.');
      attempt.feedback = args.feedback; attempt.approval = undefined; task.state = 'queued'; task.revision++; run.revision++; this.invalidate(run); run.state = 'active';
      this.store.event(run.id, 'correction_requested', { task_id: task.spec.id, previous_attempt: attempt.id });
      return { run_id: run.id, task_id: task.spec.id, state: task.state, revision: run.revision };
    }
    invariant(attempt.commit && attempt.state === 'needs_review', 'REVIEW', 'Only an immutable implementation result can be approved.');
    invariant(attempt.verification.length === task.spec.verification.length && attempt.verification.every(v => v.status === 'passed'), 'CHECKS_FAILED', 'All declared commands must have observed successful exits before approval.');
    invariant(await head(attempt.directory) === attempt.commit, 'STALE_APPROVAL', 'Attempt checkout HEAD changed.');
    await clean(attempt.directory, attempt.context.filter(c => !c.tracked).map(c => c.path)); checkContext(attempt.directory, attempt.context);
    attempt.approval = { commit: args.commit, at: Date.now() }; attempt.state = 'integrating'; this.store.save();
    try {
      run.integration_commit = await integrate(run.integration_dir, run.integration_commit, attempt.commit);
      attempt.integrated_commit = run.integration_commit; attempt.state = 'integrated'; task.state = 'integrated';
    } catch (e) { attempt.state = 'integration_conflict'; task.state = 'needs_review'; attempt.error = (e as Error).message; attempt.artifacts.push(this.store.artifact(run.id, 'integration-error.json', JSON.stringify({ message: attempt.error, details: e instanceof Fault ? e.details : undefined }))); }
    this.store.event(run.id, 'reviewed', { task_id: task.spec.id, attempt_id: attempt.id, state: attempt.state, integration_commit: run.integration_commit });
    return { task_id: task.spec.id, state: attempt.state, integration_commit: run.integration_commit, artifacts: attempt.artifacts };
  }
  async respond(args: any) {
    const run = this.getRun(args.run_id); const attempt = this.allAttempts(run).find(a => a.id === args.attempt_id);
    invariant(attempt && active.has(attempt.state), 'ATTEMPT', 'No active attempt.');
    const input = attempt.inputs.find(i => i.id === args.input_id); invariant(input, 'INPUT', 'Input is no longer pending.');
    invariant(input.kind === 'permission' ? args.decision !== 'answer' : args.decision === 'answer' || args.decision === 'reject', 'INPUT', 'Decision type does not match input.');
    if (args.decision === 'answer') invariant(args.answers, 'INPUT', 'Answers are required.');
    const file = path.join(attempt.job_dir, 'replies', `${Buffer.from(input.id).toString('hex')}.json`);
    invariant(!fs.existsSync(file), 'INPUT_ALREADY_DECIDED', 'This input already has a decision. Reconcile delivery instead of resending.');
    writeJson(file, { decision: args.decision, answers: args.answers }); this.store.event(run.id, 'input_answered', { attempt_id: attempt.id, input_id: input.id });
    return { state: 'queued_for_delivery', input_id: input.id };
  }
  async cancel(run: Run) {
    invariant(run.state !== 'completed' && run.state !== 'finalizing', 'RUN_FROZEN', 'Cannot cancel a completed/finalizing run.');
    run.state = 'cancelling';
    for (const task of run.tasks) if (task.state === 'queued') task.state = 'cancelled';
    for (const a of this.allAttempts(run)) if (active.has(a.state)) {
      if (a.state === 'resource_wait') { a.state = 'cancelled'; const task = run.tasks.find(t => t.attempts.includes(a)); if (task) task.state = 'cancelled'; if (run.validation?.attempt === a) run.validation.state = 'cancelled'; }
      else { writeJson(path.join(a.job_dir, 'cancel.json'), { at: Date.now() }); a.state = 'cancelling'; }
    }
    this.store.event(run.id, 'cancel_requested', {}); await this.reconcile(run); return { run_id: run.id, state: run.state };
  }
  async reconcile(run: Run) {
    for (const attempt of this.allAttempts(run).filter(a => active.has(a.state))) {
      if (attempt.state === 'resource_wait') {
        if (this.allAttempts().filter(occupiesSlot).length >= this.options.concurrency || this.allAttempts(run).filter(occupiesSlot).length >= run.settings.concurrency) continue;
        const task = run.tasks.find(t => t.attempts.includes(attempt));
        try {
          checkContext(run.repo, attempt.context); checkContext(attempt.directory, attempt.context);
          await probeResources(this.resources(run, attempt), attempt.directory);
          invariant(!fs.existsSync(path.join(attempt.job_dir, 'spec.json')), 'DISPATCH_UNCERTAIN', 'An execution intent already exists; it cannot be dispatched again.');
          const spec = task ? { goal: `${task.spec.goal}${attempt.feedback ? `\n\nCodex correction instructions:\n${attempt.feedback}` : ''}`, acceptance: task.spec.acceptance, verification: task.spec.verification, scope: task.spec.scope, model: task.spec.model ?? task.attempts.at(-2)?.model, validation: false }
            : { goal: 'Execute the frozen final verification commands.', acceptance: [], verification: run.final_verification, scope: [], model: run.tasks.at(-1)?.attempts.at(-1)?.model, validation: true };
          await this.spawn(run, attempt, spec); attempt.error = undefined;
          if (task) task.state = 'running'; else if (run.validation) run.validation.state = 'running';
          this.store.event(run.id, 'resource_binding_verified', { attempt_id: attempt.id, directory: attempt.directory });
        } catch (e) { await this.launchFailure(run, attempt, e); if (attempt.state !== 'resource_wait') { if (task) task.state = 'needs_review'; else if (run.validation) { run.validation.state = 'failed'; run.state = 'active'; } } }
        continue;
      }
      const state = readJson<WorkerState>(path.join(attempt.job_dir, 'worker.json'));
      if (attempt.launch_boot && attempt.launch_boot !== await bootId() && !state?.stopped) {
        attempt.state = run.state === 'cancelling' ? 'cancelled' : 'interrupted'; attempt.error = 'The computer rebooted; prior processes cannot still be running. No model request was replayed.';
        const task = run.tasks.find(t => t.attempts.includes(attempt)); if (task) task.state = run.state === 'cancelling' ? 'cancelled' : 'needs_review';
        if (run.validation?.attempt === attempt) { run.validation.state = 'failed'; if (run.state !== 'cancelling') run.state = 'active'; }
        continue;
      }
      const owner = state?.host ?? readJson<{ host: WorkerState['host'] }>(path.join(attempt.job_dir, 'started.json'))?.host ?? readJson<{ host: WorkerState['host'] }>(path.join(attempt.job_dir, 'launch.json'))?.host;
      if (state?.url && !state.stopped) {
        const spec = readJson<WorkerSpec>(path.join(attempt.job_dir, 'spec.json'));
        if (spec) {
          const evidence = await inspectSession(spec, state).catch(e => ({ error: (e as Error).message, outcome: 'unverified' }));
          attempt.artifacts.push(this.store.artifact(run.id, 'session-reconciliation.json', JSON.stringify(evidence)));
        }
      }
      if (owner && await alive(owner)) continue;
      if (state?.server && await treeAlive(state.server)) {
        if (run.state === 'cancelling') { const stopped = await terminate(state.server, true); if (stopped) { state.phase = 'cancelled'; state.stopped = true; writeJson(path.join(attempt.job_dir, 'worker.json'), state); } }
        else { attempt.state = 'orphaned'; attempt.error = 'Worker host exited while its OpenCode server is still alive. Cancel to stop the owned process before correction; no request was replayed.'; }
      } else if (state?.stopped) continue;
      else if (owner && ((state?.server && process.platform !== 'win32') || !fs.existsSync(path.join(attempt.job_dir, 'server-intent.json')))) {
        attempt.state = run.state === 'cancelling' ? 'cancelled' : 'interrupted'; attempt.error = 'Worker process exited; no automatic retry was made.';
        const task = run.tasks.find(t => t.attempts.includes(attempt)); if (task) task.state = run.state === 'cancelling' ? 'cancelled' : 'needs_review';
        if (run.validation?.attempt === attempt) { run.validation.state = 'failed'; run.state = 'active'; }
      } else { attempt.state = 'orphaned'; attempt.error = 'Launch ownership is uncertain. Resource leases remain held. Inspect the job directory/processes before cleanup.'; }
    }
    await this.collect(run);
    for (const task of run.tasks) {
      const a = task.attempts.at(-1); if (a?.state !== 'integrating') continue;
      const actual = await head(run.integration_dir);
      const expectedDiff = a.commit ? (await git(a.directory, ['diff','--binary',a.base,a.commit])).stdout : '';
      const actualDiff = (await git(run.integration_dir, ['diff','--binary',run.integration_commit,actual])).stdout;
      if (actual !== run.integration_commit && expectedDiff === actualDiff && (await git(run.integration_dir, ['rev-parse',`${actual}^`])).stdout.trim() === run.integration_commit) {
        await clean(run.integration_dir); run.integration_commit = actual; a.integrated_commit = actual; a.state = 'integrated'; task.state = 'integrated';
      } else { a.state = 'integration_conflict'; task.state = 'needs_review'; a.error = 'Interrupted integration requires review of the integration worktree.'; }
    }
    if (run.finalize_intent && run.state !== 'completed') {
      const actual = await head(run.repo); const name = await branch(run.repo);
      if (actual === run.finalize_intent.commit && name === run.branch) {
        try { await clean(run.repo); run.state = 'completed'; run.error = undefined; } catch { run.state = 'finalize_uncertain'; run.error = 'Target reached the intended commit but has external working tree changes. Changes were preserved.'; }
      } else if (actual === run.base && name === run.branch) { run.state = 'waiting_final_review'; run.finalize_intent = undefined; }
      else { run.state = 'finalize_uncertain'; run.error = 'Target differs from the recorded pre/post-finalize state. No reset was attempted.'; }
    }
    this.store.event(run.id, 'reconciled', { state: run.state });
  }
  async validate(run: Run) {
    invariant(run.state === 'active' || run.state === 'waiting_final_review', 'RUN_FROZEN', 'Run cannot enter validation.');
    invariant(run.tasks.length && run.tasks.every(t => t.state === 'integrated'), 'TASKS_PENDING', 'All tasks must be reviewed and integrated.');
    invariant(run.final_verification.length > 0, 'VALIDATION_COMMANDS', 'At least one explicit final verification command is required.');
    invariant(this.allAttempts().filter(occupiesSlot).length < this.options.concurrency, 'CAPACITY', 'Wait for a free worker slot before final validation.');
    const resources = [...new Set(run.tasks.flatMap(t => t.spec.resources))]; const locks = this.lockedResources();
    invariant(!resources.some(key => locks.has(key)), 'RESOURCE_BUSY', 'A shared resource is in use.');
    await clean(run.integration_dir); invariant(await head(run.integration_dir) === run.integration_commit, 'INTEGRATION_MOVED', 'Integration branch changed.');
    const allContext = [...run.context, ...run.tasks.flatMap(t => t.attempts.at(-1)!.context)];
    for (const file of allContext) invariant(allContext.every(other => other.path !== file.path || other.hash === file.hash), 'CONTEXT_CHANGED', 'Tasks used different snapshots of the same context file. Start a run with consistent rules.');
    const context = [...new Map(allContext.map(c => [c.path, c])).values()];
    checkContext(run.repo, context);
    this.invalidate(run); const id = uid('validation');
    const attempt: Attempt = { id, number: 1, base: run.integration_commit, directory: path.join(this.store.root, 'worktrees', run.id, id), job_dir: path.join(this.store.root, 'jobs', id), state: 'launching', context, resources, artifacts: [], verification: [], inputs: [] };
    run.validation = { id, revision: run.revision, commit: run.integration_commit, context_hash: contextHash(context), commands_hash: digest(run.final_verification), attempt, state: 'running' }; run.state = 'validating'; this.store.save();
    try {
      await worktree(run.repo, attempt.directory, run.integration_commit); await materialize(this.store, attempt.directory, context);
      await probeResources(this.resources(run, attempt), attempt.directory);
      await this.spawn(run, attempt, { goal: 'Execute only the frozen final verification commands.', acceptance: [], verification: run.final_verification, scope: [], validation: true, model: run.tasks.at(-1)?.attempts.at(-1)?.model });
    } catch (e) { await this.launchFailure(run, attempt, e); run.validation.state = attempt.state === 'resource_wait' ? 'awaiting_resource' : 'failed'; if (attempt.state !== 'resource_wait') run.state = 'active'; }
    this.store.event(run.id, 'validation_started', { validation_id: id, commit: run.integration_commit, revision: run.revision });
    return { validation_id: id, commit: run.integration_commit, revision: run.revision, state: run.state };
  }
  async finalize(args: any) {
    const run = this.getRun(args.run_id), validation = run.validation;
    invariant(run.state === 'waiting_final_review' && validation?.state === 'passed', 'VALIDATION_REQUIRED', 'A successful final validation and Codex review are required.');
    invariant(args.validation_id === validation.id && args.commit === validation.commit && args.revision === run.revision && validation.revision === run.revision && run.integration_commit === validation.commit, 'STALE_APPROVAL', 'Final approval is bound to a different validation, commit or task revision.');
    invariant(validation.commands_hash === digest(run.final_verification) && validation.context_hash === contextHash(validation.attempt.context), 'STALE_VALIDATION', 'Frozen commands/context changed.');
    invariant(await head(run.integration_dir) === validation.commit && await head(validation.attempt.directory) === validation.commit, 'VALIDATION_CHANGED', 'Validated commit changed.');
    await clean(run.integration_dir); await clean(validation.attempt.directory, validation.attempt.context.filter(c => !c.tracked).map(c => c.path));
    checkContext(run.repo, validation.attempt.context); checkContext(validation.attempt.directory, validation.attempt.context);
    await targetReady(run.repo, run.branch, run.base);
    run.finalize_intent = { validation_id: validation.id, commit: validation.commit, revision: run.revision, started: Date.now() }; run.state = 'finalizing'; this.store.save();
    const result = await git(run.repo, ['-c','core.hooksPath=/dev/null','merge','--ff-only','--no-overwrite-ignore',validation.commit], true);
    const artifact = this.store.artifact(run.id, 'finalize.json', JSON.stringify(result));
    await this.reconcile(run);
    if (result.code !== 0 && run.state !== 'completed') { run.error = 'Fast-forward was not applied. Inspect the Git evidence; user changes were preserved.'; this.store.save(); }
    return { run_id: run.id, state: run.state, head: await head(run.repo), artifact_id: artifact, error: run.error };
  }
}
