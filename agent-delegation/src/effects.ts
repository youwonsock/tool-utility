import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './store.js';
import {
  PROTOCOL,
  STORE_FORMAT,
  WORKER_FORMAT,
  VERSION,
  Fault,
  invariant,
  type Attempt,
  type AttemptState,
  type Run,
  type Task,
  type TaskSpec,
  type WorkerSpec,
  type WorkerState,
  type Resource,
  type SubmitArgs,
  type WorkerSelection,
  type WorkerConfig,
  type WorkerModel,
} from './types.js';
import {
  uid,
  digest,
  readJson,
  writeJson,
  mkdir,
  alive,
  terminate,
  inside,
  processIdentity,
  bootId,
  treeAlive,
  exec,
} from './io.js';
import {
  branch,
  clean,
  git,
  head,
  repository,
  worktree,
  materialize,
  validateScope,
  resultCommit,
  integrate,
  targetReady,
  checkContext,
  contextHash,
  unmergedFiles,
  conflictHashes,
  unresolvedConflicts,
} from './git.js';
import { probeResources } from './resources.js';
import {
  transition,
  moveRun,
  moveTask,
  moveAttempt,
  moveValidation,
  moveWorker,
  workerTerminal,
  holdsResources,
  occupiesSlot,
  canReview,
  validateWorkerState,
} from './lifecycle.js';
import { submitTasks } from './submission.js';
import { rejectedEvidence } from './evidence.js';
import { resolveWorker, publicWorker } from './profiles.js';
import { resolveRuntime, assertRuntimeUnchanged, publicRuntime } from './runtime.js';
import { inspectHttpSession } from './backends/http.js';
import { attemptsStopped } from './persistence.js';
import { confirmedStopped, stopOwned, processEvidence } from './process.js';
import { deploymentVersion } from './deployment.js';
import { EngineBase, type EngineOptions } from './engine-base.js';

export type EffectHooks = {
  checkpoint: () => Promise<void>;
  bindRepository: (commonDir: string) => Promise<void>;
  reserveResume: (run: Run, attempt: Attempt) => Promise<void>;
};
// Runs one operation's external work against an isolated store. Only the controller
// in engine.ts publishes its changes, through the hooks it supplies.
export class EffectRunner extends EngineBase {
  publicationResult?: unknown;
  constructor(
    store: Store,
    executableFile: string,
    options: EngineOptions,
    private hooks: EffectHooks,
  ) {
    super(store, executableFile, options);
  }
  private persist() {
    return this.hooks.checkpoint();
  }
  private async emit(run_id: string, type: string, data: unknown, durable = true) {
    this.store.event(run_id, type, data);
    if (durable) await this.hooks.checkpoint();
  }
  async effectDoctor(args: { repo?: string; worker: WorkerSelection; operation_id?: string }) {
    const doctorID = args.operation_id ?? uid('doctor'),
      jobDir = path.join(this.store.root, 'diagnostics', doctorID);
    mkdir(jobDir);
    let selected: WorkerConfig | undefined,
      repo: Awaited<ReturnType<typeof repository>> | undefined,
      state: WorkerState | undefined;
    let connection: {
      healthy: boolean;
      model?: unknown;
      error?: string;
      code?: string;
      details?: unknown;
      stage?: string;
    } = { healthy: false, stage: 'configuration' };
    try {
      selected = resolveWorker(this.store.root, args.worker);
      repo = args.repo ? await repository(args.repo) : undefined;
      connection.stage = 'installation';
      selected.runtime = await resolveRuntime(selected);
      const spec: WorkerSpec = {
        protocol: WORKER_FORMAT,
        host_executable: this.executableFile,
        diagnostic: true,
        worker: selected,
        id: doctorID,
        directory: args.repo || this.store.root,
        job_dir: jobDir,
        goal: '',
        acceptance: [],
        scope: [],
        verification: [],
        resources: [],
        context: [],
        timeout_ms: 30000,
        validation: false,
        password: uid('secret'),
      };
      writeJson(path.join(jobDir, 'spec.json'), spec);
      connection.stage = 'initialization';
      const result = await exec(process.execPath, [this.executableFile, 'worker', jobDir], {
        env: { ...process.env, AGENT_DELEGATION_WORKER: '1' },
        timeout: 45000,
      });
      state = readJson<WorkerState>(path.join(jobDir, 'worker.json'));
      invariant(result.code === 0 && state, 'CLI_INCOMPATIBLE', 'Diagnostic worker could not initialize.', {
        stderr: result.stderr,
      });
      validateWorkerState(state);
      connection = {
        healthy: state.phase === 'completed' && state.stopped === true,
        model: state.model,
        error: state.error,
        code: state.error_code,
        details: state.error_details,
        stage: state.diagnostic_stage,
      };
    } catch (e) {
      connection.error = (e as Error).message;
      connection.code = e instanceof Fault ? e.code : 'WORKER_PROFILE';
      connection.details = e instanceof Fault ? e.details : undefined;
    } finally {
      state ??= readJson<WorkerState>(path.join(jobDir, 'worker.json'));
      const spec = readJson<WorkerSpec>(path.join(jobDir, 'spec.json'));
      if (state && spec) {
        const stopped = await stopOwned({
          spec,
          state,
          save: () => writeJson(path.join(jobDir, 'worker.json'), state),
        });
        if (state.host) await terminate(state.host);
        state.stopped = stopped;
        writeJson(path.join(jobDir, 'worker.json'), state);
        if (!stopped) {
          connection.healthy = false;
          connection.code = 'STOP_UNCERTAIN';
          connection.error = 'Diagnostic runtime termination could not be confirmed.';
        }
      }
    }
    writeJson(path.join(jobDir, 'diagnostic.json'), connection);
    return {
      version: VERSION,
      protocol: PROTOCOL,
      node: process.versions.node,
      platform: process.platform,
      deployment: { version: deploymentVersion(this.executableFile), executable: this.executableFile },
      storage_format: STORE_FORMAT,
      worker_format: WORKER_FORMAT,
      worker: publicWorker(selected),
      backend_version: state?.backend_version,
      runtime: publicRuntime(state?.runtime ?? selected?.runtime),
      compatible: connection.healthy,
      connection,
      repo,
      resources: this.store.state.runs.flatMap((r) =>
        r.resources.map((p) => ({
          run_id: r.id,
          resource_key: p.resource_key,
          expected_instance: p.expected_instance,
          project_bound: p.project_bound,
        })),
      ),
      running: this.allAttempts()
        .filter((a) => holdsResources(a))
        .map((a) => a.id),
      metrics: this.store.state.metrics,
    };
  }
  validateGraph(specs: TaskSpec[]) {
    const ids = new Set(specs.map((t) => t.id));
    invariant(ids.size === specs.length, 'TASK_ID', 'Duplicate task ID.');
    const visited = new Set<string>(),
      visiting = new Set<string>();
    const visit = (id: string) => {
      invariant(!visiting.has(id), 'DEPENDENCY_CYCLE', 'Task dependency cycle.');
      if (visited.has(id)) return;
      const task = specs.find((t) => t.id === id)!;
      visiting.add(id);
      for (const dep of task.dependencies) {
        invariant(ids.has(dep), 'DEPENDENCY', `Unknown dependency ${dep}`);
        visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
      validateScope(task.scope);
    };
    for (const t of specs) visit(t.id);
  }
  async effectSubmit(args: SubmitArgs) {
    return submitTasks(
      this.store,
      args,
      (specs) => this.validateGraph(specs),
      undefined,
      async (result) => {
        this.publicationResult = result;
        await this.persist();
      },
      (commonDir) => this.hooks.bindRepository(commonDir),
    );
  }
  async effectCleanup(run: Run) {
    invariant(['completed', 'cancelled'].includes(run.state), 'JOBS_ACTIVE', 'Only finished runs can be cleaned.');
    invariant(await attemptsStopped(run), 'JOBS_ACTIVE', 'Owned process termination is not confirmed.');
    const directories = [
      run.integration_dir,
      ...this.allAttempts(run).map((attempt) => attempt.directory),
      ...(run.validation_history ?? []).map((validation) => validation.attempt.directory),
    ];
    for (const directory of new Set(directories))
      if (fs.existsSync(directory)) await git(run.repo, ['worktree', 'remove', '--force', directory]);
    if (!this.store.isArchived(run.id)) await this.emit(run.id, 'worktrees_cleaned', {}, false);
    return { cleaned: run.id, evidence_retained: true };
  }
  async effectLaunch(run: Run, task: Task) {
    const prior = task.attempts.at(-1);
    const base = run.integration_commit;
    const id = uid('attempt');
    const metadata = readJson<{ context: Attempt['context'] }>(
      path.join(this.store.root, 'runs', run.id, `${task.spec.id}.json`),
    )!;
    let attempt: Attempt = {
      id,
      number: task.attempts.length + 1,
      base,
      directory: path.join(this.store.root, 'worktrees', run.id, id),
      job_dir: path.join(this.store.root, 'jobs', id),
      state: 'launching',
      artifacts: [],
      verification: [],
      context: metadata.context,
      resources: task.spec.resources,
      inputs: [],
      feedback: prior?.feedback,
      execution: JSON.parse(JSON.stringify(task.worker)),
    };
    moveTask(task, 'running');
    task.attempts.push(attempt);
    attempt = task.attempts.at(-1)!;
    await this.persist();
    try {
      const runtime = prior
        ? await resolveRuntime(task.worker)
        : task.worker.runtime
          ? await assertRuntimeUnchanged(task.worker, task.worker.runtime)
          : await resolveRuntime(task.worker);
      attempt.execution!.runtime = runtime;
      await this.persist();
      checkContext(run.repo, attempt.context);
      await worktree(run.repo, attempt.directory, base);
      await materialize(this.store, attempt.directory, attempt.context);
      const previous = task.attempts.slice(0, -1).findLast((candidate) => candidate.commit);
      if (previous) {
        const diff = (await git(previous.directory, ['diff', '--binary', previous.base, previous.commit!])).stdout;
        mkdir(attempt.job_dir);
        const patch = path.join(attempt.job_dir, 'previous.patch');
        fs.writeFileSync(patch, diff);
        const applied = diff
          ? await git(attempt.directory, ['apply', '--3way', '--index', patch], true)
          : { code: 0, stdout: '', stderr: '' };
        attempt.artifacts.push(this.store.artifact(run.id, 'patch-application.json', JSON.stringify(applied)));
        const unmerged = await unmergedFiles(attempt.directory);
        invariant(
          applied.code === 0 || unmerged.length > 0,
          'CORRECTION_APPLY_FAILED',
          'The previous result could not be applied to the current integration commit, and no model request was sent. A further correction starts from the same result, so submit a new task if this repeats.',
          { stderr: applied.stderr },
        );
        const carried = previous.state === 'conflict_unresolved' ? Object.keys(previous.conflicts ?? {}) : [];
        const conflicts = [...new Set([...unmerged, ...carried])];
        if (conflicts.length) attempt.conflicts = conflictHashes(attempt.directory, conflicts);
      }
      await probeResources(this.resources(run, attempt), attempt.directory);
      await (this.options.spawn ?? this.spawn).call(this, run, attempt, {
        goal: this.attemptGoal(task, attempt),
        acceptance: task.spec.acceptance,
        verification: task.spec.verification,
        scope: task.spec.scope,
        model: task.worker.model ?? prior?.model,
        validation: false,
      });
    } catch (e) {
      await this.launchFailure(run, attempt, e);
    }
    await this.emit(run.id, 'attempt_started', { task_id: task.spec.id, attempt_id: id, state: attempt.state }, false);
  }
  resources(run: Run, attempt: Attempt): Resource[] {
    return attempt.resources.map((key) => run.resources.find((r) => r.resource_key === key)!);
  }
  async spawn(
    run: Run,
    attempt: Attempt,
    {
      model,
      ...task
    }: Pick<WorkerSpec, 'goal' | 'acceptance' | 'verification' | 'scope' | 'validation'> & {
      model?: WorkerModel;
    },
  ) {
    invariant(run.state !== 'cancelling', 'CANCELLED', 'Cancellation prevents worker dispatch.');
    mkdir(attempt.job_dir);
    const selected = attempt.execution ?? run.worker;
    const spec: WorkerSpec = {
      protocol: WORKER_FORMAT,
      host_executable: this.executableFile,
      worker: { ...selected, model: model ?? selected.model },
      id: attempt.id,
      directory: attempt.directory,
      job_dir: attempt.job_dir,
      ...task,
      resources: this.resources(run, attempt),
      context: attempt.context,
      timeout_ms: run.settings.timeout_ms,
      password: uid('secret'),
    };
    writeJson(path.join(attempt.job_dir, 'spec.json'), spec);
    moveAttempt(attempt, 'launching');
    attempt.launch_boot = await bootId();
    await this.persist(); // durable launch intent precedes spawn
    invariant((run.state as string) !== 'cancelling', 'CANCELLED', 'Cancellation won the durable launch barrier.');
    const logFd = fs.openSync(path.join(attempt.job_dir, 'host.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [this.executableFile, 'worker', attempt.job_dir], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      // Independent host identity is a recovery hint. Its own exclusive record is authoritative.
      writeJson(path.join(attempt.job_dir, 'launch.json'), { host: await processIdentity(child.pid!), at: Date.now() });
      child.unref();
      moveAttempt(attempt, 'running');
      await this.persist();
    } finally {
      fs.closeSync(logFd);
    }
  }
  private attemptGoal(task: Task, attempt: Attempt) {
    const conflicts = Object.keys(attempt.conflicts ?? {});
    return [
      task.spec.goal,
      ...(conflicts.length
        ? [
            `The previous result was reapplied to the current integration commit with merge conflicts in: ${conflicts.join(', ')}. Resolve these files and remove every conflict marker. The result cannot be approved otherwise.`,
          ]
        : []),
      ...(attempt.feedback
        ? [
            `Supervisor correction instructions. These override the goal and acceptance wherever they conflict:\n${attempt.feedback}`,
          ]
        : []),
    ].join('\n\n');
  }
  async launchFailure(run: Run, attempt: Attempt, e: unknown) {
    if (this.store.uncertain || (e instanceof Fault && e.code === 'REQUEST_UNCERTAIN')) throw e;
    if (e instanceof Fault && e.code === 'CANCELLED') {
      if (
        fs.existsSync(path.join(attempt.job_dir, 'launch.json')) ||
        fs.existsSync(path.join(attempt.job_dir, 'started.json'))
      )
        moveAttempt(attempt, 'cancelling');
      else this.finishAttempt(run, attempt, 'cancelled');
      attempt.error = e.message;
      await this.persist();
      return;
    }
    attempt.error = e instanceof Fault ? `${e.code}: ${e.message}` : (e as Error).message;
    attempt.artifacts.push(
      this.store.artifact(
        run.id,
        'error.json',
        JSON.stringify({ message: (e as Error).message, details: e instanceof Fault ? e.details : undefined }),
      ),
    );
    const next =
      e instanceof Fault && e.code.startsWith('RESOURCE_')
        ? 'resource_wait'
        : fs.existsSync(path.join(attempt.job_dir, 'spec.json'))
          ? 'orphaned'
          : 'failed';
    const task = run.tasks.find((t) => t.attempts.includes(attempt));
    transition({
      attempt: [attempt, next],
      task: task && [task, next === 'resource_wait' ? 'needs_input' : 'needs_review'],
    });
    await this.persist();
  }
  finishAttempt(
    run: Run,
    attempt: Attempt,
    result: Extract<
      AttemptState,
      | 'failed'
      | 'cancelled'
      | 'interrupted'
      | 'verified'
      | 'needs_review'
      | 'scope_or_context_error'
      | 'conflict_unresolved'
    >,
  ) {
    const next = run.state === 'cancelling' ? 'cancelled' : result;
    const task = run.tasks.find((t) => t.attempts.includes(attempt));
    const validation = run.validation?.attempt === attempt ? run.validation : undefined;
    transition({
      attempt: [attempt, next],
      task: task && [task, next === 'cancelled' ? 'cancelled' : 'needs_review'],
      validation: validation && [
        validation,
        next === 'verified' ? 'passed' : next === 'cancelled' ? 'cancelled' : 'failed',
      ],
      run:
        validation && run.state !== 'cancelling'
          ? [run, next === 'verified' ? 'waiting_final_review' : 'active']
          : undefined,
    });
  }
  async effectCollect(run: Run) {
    for (const attempt of this.allAttempts(run).filter((a) => holdsResources(a))) {
      if (
        run.state === 'cancelling' &&
        attempt.state !== 'resource_wait' &&
        !fs.existsSync(path.join(attempt.job_dir, 'cancel.json'))
      )
        writeJson(path.join(attempt.job_dir, 'cancel.json'), { at: Date.now() });
      const state = this.workerState(attempt);
      if (!state) continue;
      const progress = (w?: WorkerState) =>
        digest(
          w && {
            phase: w.phase,
            inputs: w.inputs,
            session_id: w.session_id,
            prompt_intent: w.prompt_intent,
            prompt_accepted: w.prompt_accepted,
            model: w.model,
            shell_intent: w.shell_intent,
            verification: w.verification,
          },
        );
      const prior = progress(attempt.worker);
      attempt.worker = state;
      attempt.model = state.model;
      attempt.usage = state.usage;
      attempt.inputs = state.inputs;
      const ownerTask = run.tasks.find((t) => t.attempts.includes(attempt));
      if (ownerTask && state.model && ownerTask.worker.model === undefined) {
        ownerTask.worker.model = state.model;
        if (attempt.execution) attempt.execution.model = state.model;
      }
      if (ownerTask && state.verification_shell && ownerTask.worker.shell === undefined) {
        ownerTask.worker.shell ??= JSON.parse(JSON.stringify(state.verification_shell));
        if (attempt.execution) attempt.execution.shell ??= JSON.parse(JSON.stringify(state.verification_shell));
        if (run.worker.config_hash === ownerTask.worker.config_hash)
          run.worker.shell ??= JSON.parse(JSON.stringify(state.verification_shell));
      }
      if (!state.stopped) {
        const observed: AttemptState =
          state.phase === 'needs_input' ||
          state.phase === 'delivery_uncertain' ||
          state.phase === 'cancelling' ||
          state.phase === 'stop_uncertain'
            ? state.phase
            : 'running';
        const uncertainOwner = ['orphaned', 'stop_uncertain'].includes(attempt.state) && !(await alive(state.host));
        if (!uncertainOwner)
          moveAttempt(attempt, run.state === 'cancelling' && observed !== 'stop_uncertain' ? 'cancelling' : observed);
        if (prior !== progress(state))
          await this.emit(run.id, 'worker_state', {
            attempt_id: attempt.id,
            phase: state.phase,
            input_ids: state.inputs.map((i) => i.id),
            prompt_dispatched: !!state.prompt_intent,
            verified_commands: state.verification.length,
          });
        continue;
      }
      const spec = readJson<WorkerSpec>(path.join(attempt.job_dir, 'spec.json'));
      if (!(await confirmedStopped(spec ?? ({ job_dir: attempt.job_dir } as WorkerSpec), state))) {
        if (attempt.state !== 'stop_uncertain' || prior !== progress(state)) {
          moveAttempt(attempt, 'stop_uncertain');
          await this.emit(run.id, 'worker_stop_unverified', { attempt_id: attempt.id });
        }
        continue;
      }
      attempt.error = state.error;
      for (const file of [
        'prompt.txt',
        'transcript.json',
        'server.log',
        'host.log',
        'scope-violation.json',
        ...state.verification.flatMap((v, i) => [v.artifact, `verification-${i}.log`]),
      ]) {
        const source = inside(attempt.job_dir, file);
        if (fs.existsSync(source))
          attempt.artifacts.push(this.store.artifact(run.id, path.basename(file), fs.readFileSync(source)));
      }
      attempt.artifacts.push(
        this.store.artifact(
          run.id,
          'worker-report.json',
          JSON.stringify({
            model_report: state.summary ?? null,
            reported_usage: state.usage ?? null,
            scope_notifications_lost: state.scope_guard?.notifications_lost ?? 0,
            observed_verification: state.verification,
            session_id: state.session_id,
            model: state.model,
          }),
        ),
      );
      attempt.verification = state.verification.map((v) => ({
        ...v,
        artifact: attempt.artifacts.find((a) => a.endsWith(`-${v.artifact}`)) ?? v.artifact,
      }));
      attempt.inputs = [];
      const task = run.tasks.find((t) => t.attempts.includes(attempt));
      if (run.state === 'cancelling' || state.phase === 'cancelled') this.finishAttempt(run, attempt, 'cancelled');
      else if (
        [
          'SCOPE_VIOLATION',
          'CONTEXT_CHANGED',
          'WORKER_CHANGED_HEAD',
          'SCOPE_GUARD_UNKNOWN',
          'VERIFICATION_CHANGED',
        ].includes(state.error_code ?? '')
      ) {
        attempt.error = state.error?.replace(new RegExp(`^${state.error_code}:\\s*`), '');
        const fault = new Fault(
          state.error_code!,
          attempt.error ?? 'Worker scope protection rejected the result.',
          state.error_details,
        );
        attempt.artifacts.push(...(await rejectedEvidence(this.store, run.id, attempt, fault)));
        this.finishAttempt(run, attempt, 'scope_or_context_error');
      } else if (state.phase !== 'completed') this.finishAttempt(run, attempt, 'failed');
      else if (task) {
        try {
          const title = `Delegate ${task.spec.id} attempt ${attempt.number} (${attempt.id})`;
          const current = await head(attempt.directory);
          if (attempt.commit_intent && current !== attempt.base) {
            invariant(
              (await git(attempt.directory, ['show', '-s', '--format=%s', current])).stdout.trim() === title &&
                (await git(attempt.directory, ['rev-parse', `${current}^`])).stdout.trim() === attempt.base,
              'COMMIT_UNCERTAIN',
              'Interrupted result commit does not match its durable intent.',
            );
            await clean(
              attempt.directory,
              attempt.context.filter((c) => !c.tracked).map((c) => c.path),
            );
            checkContext(attempt.directory, attempt.context);
            attempt.commit = current;
          } else {
            attempt.commit_intent = true;
            await this.persist();
            attempt.commit = await resultCommit(
              attempt.directory,
              attempt.base,
              task.spec.scope,
              attempt.context,
              title,
            );
          }
          attempt.artifacts.push(
            this.store.artifact(
              run.id,
              'diff.patch',
              (await git(attempt.directory, ['show', '--format=fuller', '--binary', attempt.commit])).stdout,
            ),
          );
          const unresolved = unresolvedConflicts(attempt.directory, attempt.conflicts ?? {});
          if (unresolved.length) attempt.error = `Merge conflicts remain in: ${unresolved.join(', ')}`;
          this.finishAttempt(run, attempt, unresolved.length ? 'conflict_unresolved' : 'needs_review');
        } catch (e) {
          if (this.store.uncertain) throw e;
          attempt.error = (e as Error).message;
          this.finishAttempt(run, attempt, 'scope_or_context_error');
          attempt.artifacts.push(...(await rejectedEvidence(this.store, run.id, attempt, e)));
        }
      } else if (run.validation?.attempt === attempt) {
        const validation = run.validation;
        try {
          invariant(
            validation.state === 'running',
            'VALIDATION_FAILED',
            'This validation is no longer awaiting execution. Start a new validation after termination.',
          );
          invariant(
            (await head(attempt.directory)) === validation.commit,
            'VALIDATION_CHANGED',
            'Validation changed HEAD.',
          );
          await clean(
            attempt.directory,
            attempt.context.filter((c) => !c.tracked).map((c) => c.path),
          );
          checkContext(attempt.directory, attempt.context);
          invariant(
            attempt.verification.length === run.final_verification.length &&
              attempt.verification.every((v) => v.status === 'passed'),
            'VALIDATION_FAILED',
            'Final verification has failed, incomplete or unknown commands.',
          );
          invariant(
            validation.revision === run.revision &&
              validation.commands_hash === digest(run.final_verification) &&
              validation.context_hash === contextHash(attempt.context),
            'STALE_VALIDATION',
            'Frozen validation inputs changed.',
          );
          this.finishAttempt(run, attempt, 'verified');
        } catch (e) {
          attempt.error = (e as Error).message;
          this.finishAttempt(run, attempt, 'failed');
        }
      }
      await this.emit(
        run.id,
        'attempt_finished',
        { attempt_id: attempt.id, state: attempt.state, commit: attempt.commit, error: attempt.error },
        false,
      );
    }
    if (run.state === 'cancelling' && !this.allAttempts(run).some(holdsResources)) {
      moveRun(run, 'cancelled');
      await this.emit(run.id, 'cancelled', {}, false);
    }
  }
  async effectReview(args: any) {
    const run = this.getRun(args.run_id);
    invariant(['active', 'waiting_final_review'].includes(run.state), 'RUN_FROZEN', 'Run is frozen.');
    const task = run.tasks.find((t) => t.spec.id === args.task_id);
    invariant(task, 'TASK', 'Task not found.');
    const attempt = task.attempts.at(-1);
    invariant(
      attempt && attempt.id === args.attempt_id && !holdsResources(attempt),
      'ATTEMPT',
      'Review must name the latest stopped attempt.',
    );
    invariant(
      task.state !== 'integrated',
      'IMMUTABLE',
      'Integrated tasks are immutable; submit a new correction task.',
    );
    invariant(
      canReview(task, attempt),
      'REVIEW',
      'This task is not awaiting review. Its prior result cannot be reviewed after a correction request.',
    );
    if (args.decision === 'request_changes') {
      invariant(args.feedback?.trim(), 'FEEDBACK', 'Correction instructions from the supervisor are required.');
      const dispatched = task.attempts.filter(
        (a) => !!(a.worker?.prompt_intent || this.workerState(a)?.prompt_intent),
      ).length;
      invariant(dispatched <= run.settings.max_retries, 'RETRY_LIMIT', 'Correction limit reached. Submit a new task.');
      transition({ task: [task, 'queued'], run: [run, 'active'] });
      attempt.feedback = args.feedback;
      attempt.approval = undefined;
      task.revision++;
      run.revision++;
      this.invalidate(run);
      await this.emit(run.id, 'correction_requested', { task_id: task.spec.id, previous_attempt: attempt.id }, false);
      return { run_id: run.id, task_id: task.spec.id, state: task.state, revision: run.revision };
    }
    invariant(attempt.commit === args.commit, 'STALE_APPROVAL', 'Result commit does not match the attempt.');
    invariant(
      attempt.state !== 'conflict_unresolved',
      'UNRESOLVED_CONFLICT',
      'Merge conflicts remain in this result. Request a correction.',
    );
    invariant(
      attempt.commit && attempt.state === 'needs_review',
      'REVIEW',
      'Only an immutable implementation result can be approved.',
    );
    invariant(
      attempt.verification.length === task.spec.verification.length &&
        attempt.verification.every((v) => v.status === 'passed'),
      'CHECKS_FAILED',
      'All declared commands must have observed successful exits before approval.',
    );
    invariant((await head(attempt.directory)) === attempt.commit, 'STALE_APPROVAL', 'Attempt checkout HEAD changed.');
    await clean(
      attempt.directory,
      attempt.context.filter((c) => !c.tracked).map((c) => c.path),
    );
    checkContext(attempt.directory, attempt.context);
    moveAttempt(attempt, 'integrating');
    attempt.approval = { commit: args.commit, at: Date.now() };
    await this.persist();
    try {
      run.integration_commit = await integrate(run.integration_dir, run.integration_commit, attempt.commit);
      transition({ attempt: [attempt, 'integrated'], task: [task, 'integrated'] });
      attempt.integrated_commit = run.integration_commit;
    } catch (e) {
      transition({ attempt: [attempt, 'integration_conflict'], task: [task, 'needs_review'] });
      attempt.error = (e as Error).message;
      attempt.artifacts.push(
        this.store.artifact(
          run.id,
          'integration-error.json',
          JSON.stringify({ message: attempt.error, details: e instanceof Fault ? e.details : undefined }),
        ),
      );
    }
    await this.emit(
      run.id,
      'reviewed',
      {
        task_id: task.spec.id,
        attempt_id: attempt.id,
        state: attempt.state,
        integration_commit: run.integration_commit,
      },
      false,
    );
    return {
      task_id: task.spec.id,
      state: attempt.state,
      integration_commit: run.integration_commit,
      artifacts: attempt.artifacts,
    };
  }
  invalidate(run: Run) {
    if (run.validation) {
      moveValidation(run.validation, 'invalidated');
      (run.validation_history ??= []).push(run.validation);
      run.validation = undefined;
    }
  }
  async effectReconcile(run: Run, resume = true) {
    for (const attempt of this.allAttempts(run).filter((a) => holdsResources(a))) {
      const stateForRuntime = this.workerState(attempt),
        specForRuntime = readJson<WorkerSpec>(path.join(attempt.job_dir, 'spec.json'));
      const implementation = !!run.tasks.find((task) => task.attempts.includes(attempt));
      if (implementation && run.state !== 'cancelling') {
        try {
          const expected = stateForRuntime?.runtime ?? attempt.execution?.runtime;
          invariant(
            expected,
            'RUNTIME_CHANGED',
            'This unfinished attempt has no execution identity. Use the previous release to finish or cancel it; no model request was replayed.',
          );
          await assertRuntimeUnchanged(specForRuntime?.worker ?? attempt.execution ?? run.worker, expected);
        } catch (error) {
          if (!attempt.runtime_error) {
            attempt.runtime_error = { code: 'RUNTIME_CHANGED', message: (error as Error).message };
            attempt.artifacts.push(
              this.store.artifact(run.id, 'runtime-change.json', JSON.stringify(attempt.runtime_error)),
            );
            await this.emit(run.id, 'runtime_changed', { attempt_id: attempt.id, ...attempt.runtime_error });
          }
        }
      }
      if (attempt.state === 'resource_wait') {
        if (run.state === 'cancelling') {
          this.finishAttempt(run, attempt, 'cancelled');
          continue;
        }
        if (!resume || attempt.runtime_error) continue;
        const task = run.tasks.find((t) => t.attempts.includes(attempt));
        try {
          await this.hooks.reserveResume(run, attempt);
          checkContext(run.repo, attempt.context);
          checkContext(attempt.directory, attempt.context);
          await probeResources(this.resources(run, attempt), attempt.directory);
          invariant(
            !fs.existsSync(path.join(attempt.job_dir, 'spec.json')),
            'DISPATCH_UNCERTAIN',
            'An execution intent already exists; it cannot be dispatched again.',
          );
          const spec = task
            ? {
                goal: this.attemptGoal(task, attempt),
                acceptance: task.spec.acceptance,
                verification: task.spec.verification,
                scope: task.spec.scope,
                model: task.worker.model ?? task.attempts.at(-2)?.model,
                validation: false,
              }
            : {
                goal: 'Execute the frozen final verification commands.',
                acceptance: [],
                verification: run.final_verification,
                scope: [],
                validation: true,
              };
          await (this.options.spawn ?? this.spawn).call(this, run, attempt, spec);
          attempt.error = undefined;
          if (task) moveTask(task, 'running');
          else if (run.validation) moveValidation(run.validation, 'running');
          await this.emit(run.id, 'resource_binding_verified', {
            attempt_id: attempt.id,
            directory: attempt.directory,
          });
        } catch (e) {
          if (e instanceof Fault && ['CAPACITY', 'RESOURCE_BUSY'].includes(e.code)) {
            attempt.error = e.message;
            await this.persist();
            continue;
          }
          await this.launchFailure(run, attempt, e);
          if (!holdsResources(attempt) && !task && run.validation) {
            moveValidation(run.validation, 'failed');
            if ((run.state as string) !== 'cancelling') moveRun(run, 'active');
          }
        }
        continue;
      }
      const state = this.workerState(attempt);
      if (
        !attempt.launch_boot &&
        !state &&
        !fs.existsSync(path.join(attempt.job_dir, 'started.json')) &&
        !fs.existsSync(path.join(attempt.job_dir, 'launch.json'))
      ) {
        this.finishAttempt(run, attempt, 'interrupted');
        attempt.error =
          'No durable process launch intent exists; the external preparation was interrupted and was not replayed.';
        continue;
      }
      if (run.state === 'cancelling' && !fs.existsSync(path.join(attempt.job_dir, 'cancel.json')))
        writeJson(path.join(attempt.job_dir, 'cancel.json'), { at: Date.now() });
      if (attempt.launch_boot && attempt.launch_boot !== (await bootId()) && !state?.stopped) {
        this.finishAttempt(run, attempt, 'interrupted');
        attempt.error =
          'The computer rebooted; prior processes cannot still be running. No model request was replayed.';
        continue;
      }
      const owner =
        state?.host ??
        readJson<{ host: WorkerState['host'] }>(path.join(attempt.job_dir, 'started.json'))?.host ??
        readJson<{ host: WorkerState['host'] }>(path.join(attempt.job_dir, 'launch.json'))?.host;
      if (state?.url && !state.stopped) {
        const spec = readJson<WorkerSpec>(path.join(attempt.job_dir, 'spec.json'));
        if (spec) {
          const evidence = await inspectHttpSession(spec, state).catch((e) => ({
            error: (e as Error).message,
            outcome: 'unverified',
          }));
          attempt.artifacts.push(this.store.artifact(run.id, 'session-reconciliation.json', JSON.stringify(evidence)));
        }
      }
      if (owner && (await alive(owner))) continue;
      const evidence = state ? processEvidence(attempt.job_dir, state) : undefined;
      const processesAlive = evidence
        ? (await Promise.all(evidence.identities.map((identity) => treeAlive(identity)))).some(Boolean)
        : false;
      if (state && processesAlive) {
        if (run.state === 'cancelling') {
          const spec = readJson<WorkerSpec>(path.join(attempt.job_dir, 'spec.json'));
          const stopped = spec
            ? await stopOwned({ spec, state, save: () => writeJson(path.join(attempt.job_dir, 'worker.json'), state) })
            : false;
          if (stopped) {
            if (!workerTerminal(state)) moveWorker(state, 'cancelled');
            state.stopped = true;
            writeJson(path.join(attempt.job_dir, 'worker.json'), state);
          }
        } else {
          moveAttempt(attempt, 'orphaned');
          attempt.error =
            'Worker host exited while an owned runtime is still alive. Cancel to stop the owned process before correction; no request was replayed.';
        }
      } else if (state?.stopped || this.workerState(attempt)?.stopped) {
        // OS ownership probes may outlive the worker's final atomic write. Let
        // collection verify that newer stop record before ending the attempt.
        continue;
      } else if (
        owner &&
        evidence &&
        !evidence.uncertain &&
        (process.platform !== 'win32' || evidence.identities.length === 0)
      ) {
        this.finishAttempt(run, attempt, 'interrupted');
        attempt.error = 'Worker process exited; no automatic retry was made.';
      } else {
        moveAttempt(attempt, 'orphaned');
        attempt.error =
          'Launch ownership is uncertain. Resource leases remain held. Inspect the job directory/processes before cleanup.';
      }
    }
    await this.effectCollect(run);
    for (const task of run.tasks) {
      const a = task.attempts.at(-1);
      if (a?.state !== 'integrating') continue;
      const actual = await head(run.integration_dir);
      const expectedDiff = a.commit ? (await git(a.directory, ['diff', '--binary', a.base, a.commit])).stdout : '';
      const actualDiff = (await git(run.integration_dir, ['diff', '--binary', run.integration_commit, actual])).stdout;
      if (
        actual !== run.integration_commit &&
        expectedDiff === actualDiff &&
        (await git(run.integration_dir, ['rev-parse', `${actual}^`])).stdout.trim() === run.integration_commit
      ) {
        await clean(run.integration_dir);
        transition({ attempt: [a, 'integrated'], task: [task, 'integrated'] });
        run.integration_commit = actual;
        a.integrated_commit = actual;
      } else {
        transition({ attempt: [a, 'integration_conflict'], task: [task, 'needs_review'] });
        a.error = 'Interrupted integration requires review of the integration worktree.';
      }
    }
    if (run.finalize_intent && run.state !== 'completed') {
      const actual = await head(run.repo);
      const name = await branch(run.repo);
      if (actual === run.finalize_intent.commit && name === run.branch) {
        try {
          await clean(run.repo);
          moveRun(run, 'completed');
          run.error = undefined;
        } catch (e) {
          if (e instanceof Fault && e.code === 'STATE_TRANSITION') throw e;
          moveRun(run, 'finalize_uncertain');
          run.error =
            'Target reached the intended commit but has external working tree changes. Changes were preserved.';
        }
      } else if (actual === run.base && name === run.branch) {
        moveRun(run, 'waiting_final_review');
        run.finalize_intent = undefined;
      } else {
        moveRun(run, 'finalize_uncertain');
        run.error = 'Target differs from the recorded pre/post-finalize state. No reset was attempted.';
      }
    }
    await this.emit(run.id, 'reconciled', { state: run.state }, false);
  }
  async effectValidate(run: Run) {
    invariant(
      run.state === 'active' || run.state === 'waiting_final_review',
      'RUN_FROZEN',
      'Run cannot enter validation.',
    );
    invariant(
      run.tasks.length && run.tasks.every((t) => t.state === 'integrated'),
      'TASKS_PENDING',
      'All tasks must be reviewed and integrated.',
    );
    invariant(
      run.final_verification.length > 0,
      'VALIDATION_COMMANDS',
      'At least one explicit final verification command is required.',
    );
    invariant(
      this.allAttempts().filter(occupiesSlot).length < this.options.concurrency,
      'CAPACITY',
      'Wait for a free worker slot before final validation.',
    );
    const resources = [...new Set(run.tasks.flatMap((t) => t.spec.resources))];
    const locks = this.lockedResources();
    invariant(!resources.some((key) => locks.has(key)), 'RESOURCE_BUSY', 'A shared resource is in use.');
    await clean(run.integration_dir);
    invariant(
      (await head(run.integration_dir)) === run.integration_commit,
      'INTEGRATION_MOVED',
      'Integration branch changed.',
    );
    const allContext = [...run.context, ...run.tasks.flatMap((t) => t.attempts.at(-1)!.context)];
    for (const file of allContext)
      invariant(
        allContext.every((other) => other.path !== file.path || other.hash === file.hash),
        'CONTEXT_CHANGED',
        'Tasks used different snapshots of the same context file. Start a run with consistent rules.',
      );
    const context = [...new Map(allContext.map((c) => [c.path, c])).values()];
    checkContext(run.repo, context);
    this.invalidate(run);
    const id = uid('validation');
    let attempt: Attempt = {
      id,
      number: 1,
      base: run.integration_commit,
      directory: path.join(this.store.root, 'worktrees', run.id, id),
      job_dir: path.join(this.store.root, 'jobs', id),
      state: 'launching',
      context,
      resources,
      artifacts: [],
      verification: [],
      inputs: [],
      execution: JSON.parse(JSON.stringify(run.worker)),
    };
    moveRun(run, 'validating');
    run.validation = {
      id,
      revision: run.revision,
      commit: run.integration_commit,
      context_hash: contextHash(context),
      commands_hash: digest(run.final_verification),
      attempt,
      state: 'running',
    };
    attempt = run.validation.attempt;
    await this.persist();
    try {
      await worktree(run.repo, attempt.directory, run.integration_commit);
      await materialize(this.store, attempt.directory, context);
      await probeResources(this.resources(run, attempt), attempt.directory);
      await (this.options.spawn ?? this.spawn).call(this, run, attempt, {
        goal: 'Execute only the frozen final verification commands.',
        acceptance: [],
        verification: run.final_verification,
        scope: [],
        validation: true,
      });
    } catch (e) {
      await this.launchFailure(run, attempt, e);
      if (attempt.state === 'resource_wait') moveValidation(run.validation, 'awaiting_resource');
      else if (!holdsResources(attempt)) this.finishAttempt(run, attempt, 'failed');
    }
    await this.emit(
      run.id,
      'validation_started',
      { validation_id: id, commit: run.integration_commit, revision: run.revision },
      false,
    );
    return { validation_id: id, commit: run.integration_commit, revision: run.revision, state: run.state };
  }
  async effectFinalize(args: any) {
    const run = this.getRun(args.run_id),
      validation = run.validation;
    invariant(
      run.state === 'waiting_final_review' && validation?.state === 'passed',
      'VALIDATION_REQUIRED',
      'A successful final validation and supervisor review are required.',
    );
    invariant(
      args.validation_id === validation.id &&
        args.commit === validation.commit &&
        args.revision === run.revision &&
        validation.revision === run.revision &&
        run.integration_commit === validation.commit,
      'STALE_APPROVAL',
      'Final approval is bound to a different validation, commit or task revision.',
    );
    invariant(
      validation.commands_hash === digest(run.final_verification) &&
        validation.context_hash === contextHash(validation.attempt.context),
      'STALE_VALIDATION',
      'Frozen commands/context changed.',
    );
    invariant(
      (await head(run.integration_dir)) === validation.commit &&
        (await head(validation.attempt.directory)) === validation.commit,
      'VALIDATION_CHANGED',
      'Validated commit changed.',
    );
    await clean(run.integration_dir);
    await clean(
      validation.attempt.directory,
      validation.attempt.context.filter((c) => !c.tracked).map((c) => c.path),
    );
    checkContext(run.repo, validation.attempt.context);
    checkContext(validation.attempt.directory, validation.attempt.context);
    await targetReady(run.repo, run.branch, run.base);
    moveRun(run, 'finalizing');
    run.finalize_intent = {
      validation_id: validation.id,
      commit: validation.commit,
      revision: run.revision,
      started: Date.now(),
    };
    await this.persist();
    const result = await git(
      run.repo,
      ['-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', '--no-overwrite-ignore', validation.commit],
      true,
    );
    const artifact = this.store.artifact(run.id, 'finalize.json', JSON.stringify(result));
    await this.effectReconcile(run);
    if (result.code !== 0 && this.getRun(run.id).state !== 'completed') {
      run.error = 'Fast-forward was not applied. Inspect the Git evidence; user changes were preserved.';
      await this.persist();
    }
    return { run_id: run.id, state: run.state, head: await head(run.repo), artifact_id: artifact, error: run.error };
  }
}
