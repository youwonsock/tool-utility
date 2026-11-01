import fs from 'node:fs';
import path from 'node:path';
import { ControlQueue, effectStore, publishChanges, withProgress } from './control.js';
import {
  Fault,
  invariant,
  schemas,
  type Attempt,
  type Run,
  type Task,
  type ToolName,
  type WorkerSpec,
  type WorkerState,
  type SubmitArgs,
  type WorkerSelection,
  type DurableOperation,
} from './types.js';
import { uid, digest, readJson, writeJson, alive } from './io.js';
import { moveRun, moveTask, holdsResources, occupiesSlot, canSchedule } from './lifecycle.js';
import { recoverSubmissions } from './submission.js';
import { confirmedStopped } from './process.js';
import { EngineBase } from './engine-base.js';
import { EffectRunner } from './effects.js';
export class Engine extends EngineBase {
  private queue = new ControlQueue();
  private operations = new Map<string, Promise<unknown>>();
  private recovery?: Promise<void>;
  private eventsChanged = new Set<() => void>();
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private preparationsRecovered = false;
  private nextArchiveScan = 0;
  private archiving = false;
  private archiveTask?: Promise<void>;
  private schedulerTask?: Promise<void>;
  serial<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.run(fn);
  }
  private notify() {
    for (const resolve of this.eventsChanged) resolve();
    this.eventsChanged.clear();
  }
  start() {
    this.timer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      this.schedulerTask = this.tick(false)
        .catch((error) => {
          process.stderr.write(`scheduler: ${(error as Error).message}\n`);
        })
        .finally(() => {
          this.polling = false;
        });
      void this.schedulerTask;
    }, 300);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  beginShutdown() {
    this.stopping = true;
    this.stop();
  }
  async drain() {
    await Promise.allSettled([
      ...this.operations.values(),
      ...(this.archiveTask ? [this.archiveTask] : []),
      ...(this.schedulerTask ? [this.schedulerTask] : []),
    ]);
  }
  async recoverPreparations() {
    if (this.preparationsRecovered) return;
    this.recovery ??= (async () => {
      await recoverSubmissions(this.store, (requestID) =>
        this.serial(async () => {
          invariant(
            !this.store.state.events.some(
              (event) => event.type === 'tasks_submitted' && (event.data as any)?.request_id === requestID,
            ),
            'REQUEST_UNCERTAIN',
            'Published submission cannot release its preparation reservation.',
          );
          for (const operation of Object.values(this.store.state.operations))
            if (operation.kind === 'submit' && operation.request_id === requestID)
              delete this.store.state.operations[operation.id];
          this.store.save();
        }),
      );
      await this.serial(async () => {
        for (const operation of Object.values(this.store.state.operations))
          if (operation.status === 'running' && !this.operations.has(operation.id)) {
            if (operation.request_id && this.store.state.requests[operation.request_id]?.status === 'done')
              delete this.store.state.operations[operation.id];
            else {
              operation.status = 'uncertain';
              operation.error = {
                code: 'REQUEST_UNCERTAIN',
                message: 'Service restarted during an external effect; no effect was replayed.',
              };
            }
          }
        this.store.save();
        this.preparationsRecovered = true;
      });
    })();
    await this.recovery;
    await this.settleDiagnostics();
  }
  private async settleDiagnostics() {
    const candidates = Object.values(this.store.state.operations)
      .filter((operation) => operation.kind === 'doctor' && !this.operations.has(operation.id))
      .map((operation) => ({ id: operation.id, job_dir: path.join(this.store.root, 'diagnostics', operation.id) }));
    for (const candidate of candidates) {
      const state = readJson<WorkerState>(path.join(candidate.job_dir, 'worker.json')),
        spec = readJson<WorkerSpec>(path.join(candidate.job_dir, 'spec.json'));
      if (!state?.stopped || !spec || !(await confirmedStopped(spec, state)) || (await alive(state.host))) continue;
      await this.serial(async () => {
        const current = this.store.state.operations[candidate.id];
        if (current && !this.operations.has(candidate.id)) {
          delete this.store.state.operations[candidate.id];
          this.store.save();
        }
      });
    }
  }
  async call(name: ToolName, raw: unknown): Promise<unknown> {
    const parsed: any = schemas[name].parse(raw);
    const kind =
      name === 'create_run' || name === 'add_tasks'
        ? 'submit'
        : name === 'approve_task' || name === 'request_changes'
          ? 'review'
          : name;
    const args: any =
      kind === 'review' ? { ...parsed, decision: name === 'approve_task' ? 'approve' : 'request_changes' } : parsed;
    if (name === 'wait_run') return this.wait(args);
    if (name === 'get_artifact') return this.store.artifactPage(args.artifact_id, args.offset, args.limit);
    if (name === 'list_runs') return this.serial(async () => this.store.page(this.store.summaries(), args.cursor));
    if (name === 'get_run') {
      const selected = await this.serial(async () => {
        if (this.store.isArchived(args.run_id)) return { archived: true as const };
        const run = this.store.state.runs.find((value) => value.id === args.run_id);
        invariant(run, 'NOT_FOUND', 'Run not found.');
        return { result: this.view(run, args.cursor) };
      });
      return 'result' in selected ? selected.result : this.store.getRunPageAsync(args.run_id, args.cursor);
    }
    await this.recoverPreparations();
    if (name === 'doctor') return this.doctor(args);
    const storedRequest = await this.store.requestAsync(args.request_id);
    const admitted = await this.serial(async () => {
      invariant(!this.stopping, 'SERVICE_STOPPING', 'Service is shutting down.');
      invariant(!this.store.uncertain, 'REQUEST_UNCERTAIN', 'Restart and reconcile storage before dispatch.');
      const key = digest({ name, args }),
        prior = this.store.state.requests[args.request_id] ?? storedRequest;
      if (prior) {
        invariant(prior.hash === key, 'IDEMPOTENCY_CONFLICT', 'Request ID was already used with different content.');
        if (prior.status === 'done') return { result: prior.result };
        const operation = prior.operation_id && this.store.state.operations[prior.operation_id];
        invariant(
          operation && operation.status === 'running' && this.operations.has(operation.id),
          'REQUEST_UNCERTAIN',
          'Previous request has no live owner. Reconcile before issuing new work.',
        );
        return { operation, promise: this.operations.get(operation.id)! };
      }
      this.store.state.requests[args.request_id] = { hash: key, status: 'intent' };
      this.store.state.metrics.mutations++;
      if (args.run_id && this.store.isArchived(args.run_id))
        return this.finishRequest(args.request_id, {
          error: { code: 'RUN_ARCHIVED', message: 'Archived runs are read-only.' },
        });
      if (name === 'cancel_run' || name === 'respond_to_request') {
        try {
          this.store.save();
          return this.finishRequest(
            args.request_id,
            name === 'cancel_run' ? await this.cancelIntent(this.getRun(args.run_id)) : await this.respond(args),
          );
        } catch (error) {
          return this.finishRequest(args.request_id, this.errorResult(error));
        }
      }
      try {
        const operation = this.admit(kind, args, args.request_id, key);
        return { operation, promise: this.execute(operation, args) };
      } catch (error) {
        return this.finishRequest(args.request_id, this.errorResult(error));
      }
    });
    if ('result' in admitted) return admitted.result;
    return withProgress(admitted.promise, 1000, () => this.pending(admitted.operation));
  }
  private finishRequest(id: string, result: unknown) {
    const prior = this.store.state.requests[id]!;
    this.store.state.requests[id] = { ...prior, status: 'done', result, completed_at: this.store.clock() };
    this.store.save();
    return { result };
  }
  private errorResult(error: unknown) {
    return {
      error: {
        code: error instanceof Fault ? error.code : 'INTERNAL',
        message: (error as Error).message,
        ...(error instanceof Fault && error.details !== undefined ? { details: error.details } : {}),
      },
    };
  }
  private pending(operation: DurableOperation) {
    return {
      in_progress: true,
      operation_id: operation.id,
      operation_status: operation.status,
      run_id: operation.run_id,
    };
  }
  busy() {
    return this.activeOperations().length > 0 || this.allAttempts().some(holdsResources);
  }
  private repositoryKey(value: string | undefined) {
    return value === undefined ? undefined : process.platform === 'win32' ? value.toLowerCase() : value;
  }
  private admit(
    kind: string,
    args: any,
    request_id?: string,
    request_hash?: string,
    providedRun?: Run,
  ): DurableOperation {
    invariant(!this.stopping, 'SERVICE_STOPPING', 'The service is shutting down; no external work was started.');
    if (args.run_id && kind !== 'cleanup')
      invariant(!this.store.isArchived(args.run_id), 'RUN_ARCHIVED', 'Archived runs are read-only.');
    const run =
      providedRun ?? (args.run_id ? this.store.state.runs.find((value) => value.id === args.run_id) : undefined);
    invariant(!args.run_id || run, 'NOT_FOUND', 'Run not found.');
    invariant(
      !run || kind === 'cleanup' || !this.store.isArchived(run.id),
      'RUN_ARCHIVED',
      'Archived runs are read-only.',
    );
    const active = this.activeOperations();
    invariant(
      !run ||
        !active.some(
          (op) => op.run_id === run.id && !(['reconcile_run', 'cleanup'].includes(kind) && op.status === 'uncertain'),
        ),
      'RUN_BUSY',
      'A durable operation is still using this run.',
    );
    const repository_key = this.repositoryKey(run?.common_dir ?? args.repo);
    const repositoryEffect = ['submit', 'review', 'finalize_run', 'cleanup'].includes(kind);
    invariant(
      !repositoryEffect ||
        !repository_key ||
        !active.some(
          (op) =>
            op.reservations.repository === repository_key &&
            !(['reconcile_run', 'cleanup'].includes(kind) && op.run_id === run?.id && op.status === 'uncertain'),
        ),
      'REPOSITORY_BUSY',
      'Another operation owns the repository.',
    );
    const task = kind === 'launch' ? run?.tasks.find((value) => value.spec.id === args.task_id) : undefined;
    const waiting =
      kind === 'reconcile_run' && run?.state !== 'cancelling'
        ? this.allAttempts(run).find((attempt) => attempt.state === 'resource_wait')
        : undefined;
    const slot = kind === 'launch' || kind === 'validate_run' || !!waiting;
    const resources =
      task?.spec.resources ??
      waiting?.resources ??
      (kind === 'validate_run' ? run?.tasks.flatMap((t) => t.spec.resources) : []) ??
      [];
    if (slot) {
      this.assertCapacity(
        run,
        resources,
        waiting?.id,
        (op) => kind === 'reconcile_run' && op.run_id === run?.id && op.status === 'uncertain',
      );
    }
    const now = this.store.clock();
    const operation: DurableOperation = {
      id: uid('operation'),
      kind,
      request_id,
      request_hash,
      run_id: run?.id,
      repository_key,
      status: 'running',
      created: now,
      updated: now,
      expected_revision: run?.revision,
      generation: run?.control_generation,
      inputs: JSON.parse(JSON.stringify(args)),
      reservations: {
        slot,
        resources: [...new Set<string>(resources)],
        repository: repositoryEffect ? repository_key : undefined,
      },
    };
    if (waiting) operation.reservations.attempt_id = waiting.id;
    this.store.state.operations[operation.id] = operation;
    if (request_id) this.store.state.requests[request_id]!.operation_id = operation.id;
    this.store.save();
    return JSON.parse(JSON.stringify(operation)) as DurableOperation;
  }
  // Counts attempts in progress and operations that have reserved a slot but not started their attempt.
  private assertCapacity(
    run: Run | undefined,
    resources: string[],
    attemptID: string | undefined,
    ignored: (operation: DurableOperation) => boolean,
  ) {
    const active = this.activeOperations().filter((operation) => !ignored(operation));
    const reserved = active.filter(
      (operation) =>
        operation.reservations.slot &&
        !this.allAttempts().some(
          (attempt) => occupiesSlot(attempt) && attempt.id === operation.reservations.attempt_id,
        ),
    );
    invariant(
      this.allAttempts().filter(occupiesSlot).length + reserved.length < this.options.concurrency,
      'CAPACITY',
      'Wait for a free service worker slot.',
    );
    invariant(
      !run ||
        this.allAttempts(run).filter(occupiesSlot).length +
          reserved.filter((operation) => operation.run_id === run.id).length <
          run.settings.concurrency,
      'CAPACITY',
      'Wait for a free run worker slot.',
    );
    const locks = new Set(
      this.allAttempts()
        .filter((attempt) => holdsResources(attempt) && attempt.id !== attemptID)
        .flatMap((attempt) => attempt.resources),
    );
    for (const operation of active) for (const key of operation.reservations.resources ?? []) locks.add(key);
    invariant(!resources.some((key) => locks.has(key)), 'RESOURCE_BUSY', 'A resource is reserved.');
  }
  private execute(operation: DurableOperation, args: any, archivedRun?: Run): Promise<unknown> {
    const isolated = effectStore(this.store, operation.run_id, archivedRun);
    if (operation.request_id)
      isolated.store.state.requests[operation.request_id] = JSON.parse(
        JSON.stringify(this.store.state.requests[operation.request_id]),
      );
    let cancellationObserved = false;
    const verify = () => {
      invariant(
        !this.stopping,
        'REQUEST_UNCERTAIN',
        'Service shutdown fenced the external completion; reconcile on restart.',
      );
      const live = this.store.state.operations[operation.id];
      invariant(live?.status === 'running', 'REQUEST_UNCERTAIN', 'Operation ownership changed.');
      const run = operation.run_id ? this.store.state.runs.find((value) => value.id === operation.run_id) : undefined;
      invariant(
        !run ||
          (run.control_generation === operation.generation && run.revision === operation.expected_revision) ||
          run.state === 'cancelling',
        'STALE_OPERATION',
        'Run generation or revision changed.',
      );
      return { live, run };
    };
    const bindRepository = async (commonDir: string) =>
      this.serial(async () => {
        verify();
        const key = this.repositoryKey(commonDir);
        invariant(
          !this.activeOperations().some((other) => other.id !== operation.id && other.reservations.repository === key),
          'REPOSITORY_BUSY',
          'Another operation owns this canonical repository.',
        );
        const live = this.store.state.operations[operation.id]!;
        live.repository_key = key;
        live.reservations.repository = key;
        operation.repository_key = key;
        this.store.save();
      });
    const reserveResume = async (snapshot: Run, attempt: Attempt) =>
      this.serial(async () => {
        verify();
        const run = this.store.state.runs.find((value) => value.id === snapshot.id);
        invariant(run, 'NOT_FOUND', 'Run not found.');
        invariant(run.state !== 'cancelling', 'CANCELLED', 'Cancellation prevents a resource resume.');
        const waiting = this.allAttempts(run).find((value) => value.id === attempt.id);
        invariant(
          waiting?.state === 'resource_wait',
          'STALE_OPERATION',
          'The waiting attempt changed before resource admission.',
        );
        this.assertCapacity(
          run,
          attempt.resources,
          attempt.id,
          (other) => other.id === operation.id || (other.run_id === run.id && other.status === 'uncertain'),
        );
        const live = this.store.state.operations[operation.id]!;
        live.reservations.slot = true;
        live.reservations.attempt_id = attempt.id;
        live.reservations.resources = [...attempt.resources];
        live.updated = this.store.clock();
        this.store.save();
      });
    const publish = (final = false) => {
      const { live, run } = verify();
      const cancelling = run?.state === 'cancelling';
      const cancelledAttempts = new Set(
        run && cancelling
          ? this.allAttempts(run)
              .filter(holdsResources)
              .map((attempt) => attempt.id)
          : [],
      );
      const cancelledTasks = new Set(
        run && cancelling ? run.tasks.filter((task) => task.state === 'cancelled').map((task) => task.spec.id) : [],
      );
      const batch = isolated.drain();
      if (!final && cancelling && operation.kind === 'submit')
        throw new Fault('CANCELLED', 'Cancellation rejected unpublished submission metadata.');
      if (
        !final &&
        cancelling &&
        batch.changes.some(
          (change) => change.path.length === 1 && change.path[0] === 'state' && change.value === 'finalizing',
        )
      )
        throw new Fault('CANCELLED', 'Cancellation won the finalization admission barrier.');
      publishChanges(this.store, batch.changes);
      if (!operation.run_id && operation.kind === 'submit') {
        const created = batch.changes.find((change) => change.path.length === 0);
        if (created) {
          operation.run_id = created.run_id;
          live.run_id = created.run_id;
          const published = this.getRun(created.run_id);
          operation.generation = published.control_generation;
          live.generation = operation.generation;
        }
      }
      const updated = operation.run_id
        ? this.store.state.runs.find((value) => value.id === operation.run_id)
        : undefined;
      if (cancelling || updated?.state === 'cancelling') {
        // A worker may finish while cancellation is waiting for this publication barrier.
        // Its stopped outcome is evidence, not authority to revive a task/validation.
        if (updated) {
          for (const task of updated.tasks) {
            const latest = task.attempts.at(-1);
            if (latest && cancelledAttempts.has(latest.id) && !holdsResources(latest)) {
              latest.state = 'cancelled';
              task.state = 'cancelled';
            } else if (cancelledTasks.has(task.spec.id)) task.state = 'cancelled';
          }
          const validation = updated.validation;
          if (validation && cancelledAttempts.has(validation.attempt.id) && !holdsResources(validation.attempt)) {
            validation.attempt.state = 'cancelled';
            validation.state = 'cancelled';
          }
        }
        const canFinish =
          updated?.state === 'cancelled' &&
          ['collect', 'reconcile_run'].includes(operation.kind) &&
          !this.allAttempts(updated).some(holdsResources);
        if (updated) {
          updated.state = canFinish ? 'cancelled' : 'cancelling';
          if (!canFinish) updated.ended_at = undefined;
          for (const task of updated.tasks) if (task.state === 'queued') task.state = 'cancelled';
        }
        const detached = operation.run_id ? actor.getRun(operation.run_id) : undefined;
        if (detached) detached.state = canFinish ? 'cancelled' : 'cancelling';
      }
      for (const event of batch.events) {
        this.store.state.events.push({ seq: ++this.store.state.event_seq, ...event });
      }
      if (['launch', 'validate_run'].includes(operation.kind) && updated) {
        const latest =
          operation.kind === 'launch'
            ? updated.tasks.find((task) => task.spec.id === args.task_id)?.attempts.at(-1)
            : updated.validation?.attempt;
        if (latest) live.reservations.attempt_id = latest.id;
      }
      live.updated = this.store.clock();
      if (updated) {
        operation.expected_revision = updated.revision;
        live.expected_revision = updated.revision;
      }
      if (operation.request_id && actor.publicationResult !== undefined)
        this.finishRequest(operation.request_id, actor.publicationResult);
      return (
        !final &&
        !cancellationObserved &&
        updated?.state === 'cancelling' &&
        ['launch', 'validate_run', 'submit'].includes(operation.kind)
      );
    };
    const checkpoint = async () =>
      this.serial(async () => {
        verify();
        let cancelled = false;
        this.store.transaction(() => {
          cancelled = publish();
        });
        this.notify();
        if (cancelled) {
          cancellationObserved = true;
          throw new Fault('CANCELLED', 'Operation cancelled before its next external effect.');
        }
      });
    const actor = new EffectRunner(isolated.store, this.executableFile, this.options, {
      checkpoint,
      bindRepository,
      reserveResume,
    });
    const promise = this.queue.outside(async () => {
      let result: unknown;
      try {
        switch (operation.kind) {
          case 'doctor':
            result = await actor.effectDoctor({ ...args, operation_id: operation.id });
            break;
          case 'submit':
            result = await actor.effectSubmit(args);
            break;
          case 'review':
            result = await actor.effectReview(args);
            break;
          case 'reconcile_run':
            result = await actor.effectReconcile(actor.getRun(args.run_id), args.recover_only !== true);
            result = actor.view(actor.getRun(args.run_id));
            break;
          case 'validate_run':
            result = await actor.effectValidate(actor.getRun(args.run_id));
            break;
          case 'finalize_run':
            result = await actor.effectFinalize(args);
            break;
          case 'launch':
            result = await actor.effectLaunch(
              actor.getRun(args.run_id),
              actor.getRun(args.run_id).tasks.find((task) => task.spec.id === args.task_id)!,
            );
            break;
          case 'collect':
            result = await actor.effectCollect(actor.getRun(args.run_id));
            break;
          case 'cleanup':
            result = await actor.effectCleanup(actor.getRun(args.run_id));
            if (archivedRun) {
              const seq = await this.serial(async () => {
                verify();
                this.store.state.event_seq++;
                this.store.save();
                return this.store.state.event_seq;
              });
              const prepared = await this.store.prepareArchivedEvent(args.run_id, 'worktrees_cleaned', {}, seq);
              await this.serial(async () => {
                verify();
                this.store.commitArchivedEvent(prepared);
                this.notify();
              });
            }
            break;
          default:
            throw new Fault('OPERATION', 'Unknown external operation.');
        }
      } catch (error) {
        result = this.errorResult(error);
      }
      return this.serial(async () => {
        if (this.stopping)
          return this.errorResult(
            new Fault('REQUEST_UNCERTAIN', 'Service stopped during the external effect. Reconcile before retrying.'),
          );
        const live = this.store.state.operations[operation.id]!;
        if (this.store.uncertain || ['REQUEST_UNCERTAIN', 'STALE_OPERATION'].includes((result as any)?.error?.code)) {
          live.status = 'uncertain';
          live.error = {
            code: 'REQUEST_UNCERTAIN',
            message: 'Reconcile durable operation evidence before further work.',
          };
          if (!this.store.uncertain) this.store.save();
          return result;
        }
        try {
          verify();
          return this.store.transaction(() => {
            publish(true);
            if (result && typeof result === 'object' && 'event_cursor' in result && (result as any).run_id)
              (result as any).event_cursor = this.store.eventCursor((result as any).run_id);
            if (operation.kind === 'reconcile_run' && operation.run_id) {
              const run = this.getRun(operation.run_id);
              if (
                !this.allAttempts(run).some((attempt) =>
                  ['orphaned', 'stop_uncertain', 'integrating'].includes(attempt.state),
                ) &&
                run.state !== 'finalize_uncertain'
              )
                for (const pending of this.activeOperations())
                  if (pending.id !== operation.id && pending.run_id === run.id && pending.status === 'uncertain') {
                    if (pending.request_id && this.store.state.requests[pending.request_id]?.status === 'intent') {
                      const prior = this.store.state.requests[pending.request_id]!;
                      this.store.state.requests[pending.request_id] = {
                        ...prior,
                        status: 'done',
                        completed_at: this.store.clock(),
                        result: {
                          reconciled: true,
                          run_id: run.id,
                          state: run.state,
                          operation_id: pending.id,
                          message:
                            'Interrupted operation was reconciled from durable process/Git evidence; it was not replayed.',
                        },
                      };
                    }
                    delete this.store.state.operations[pending.id];
                  }
            }
            if (operation.kind === 'cleanup' && !(result as any)?.error)
              for (const pending of this.activeOperations())
                if (
                  pending.id !== operation.id &&
                  pending.kind === 'cleanup' &&
                  pending.run_id === operation.run_id &&
                  pending.status === 'uncertain'
                )
                  delete this.store.state.operations[pending.id];
            delete this.store.state.operations[operation.id];
            if (operation.request_id) this.finishRequest(operation.request_id, result);
            else this.store.save();
            this.notify();
            return result;
          });
        } catch (error) {
          const pending = this.store.state.operations[operation.id];
          if (pending && !this.store.uncertain) {
            pending.status = 'uncertain';
            pending.error = {
              code: error instanceof Fault ? error.code : 'INTERNAL',
              message: (error as Error).message,
            };
            this.store.save();
          }
          throw error;
        }
      });
    });
    this.operations.set(operation.id, promise);
    void promise.finally(() => this.operations.delete(operation.id)).catch(() => undefined);
    return promise;
  }
  private async wait(args: { run_id: string; after: number; timeout_ms: number }) {
    const exists = this.store.isArchived(args.run_id) || this.store.state.runs.some((run) => run.id === args.run_id);
    invariant(exists, 'NOT_FOUND', 'Run not found.');
    if (
      !this.store.isArchived(args.run_id) &&
      !this.store.events(args.run_id).some((event) => event.seq > args.after) &&
      args.timeout_ms
    )
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.eventsChanged.delete(done);
          resolve();
        };
        const timer = setTimeout(done, args.timeout_ms);
        this.eventsChanged.add(done);
      });
    const events = await this.store.eventsAsync(args.run_id, args.after, 128);
    const page = this.store.page(events, undefined, { run_id: args.run_id, after: args.after });
    const consumed = page.next_cursor ? Number(page.next_cursor) : events.length;
    return { ...page, after: events[consumed - 1]?.seq ?? args.after, next_cursor: undefined };
  }
  private async runEffect(kind: string, args: any) {
    await this.recoverPreparations();
    const admitted = await this.serial(async () => {
      const operation = this.admit(kind, args);
      return { promise: this.execute(operation, args) };
    });
    return admitted.promise;
  }
  async doctor(args: { repo?: string; worker: WorkerSelection }) {
    const admitted = await this.serial(async () => {
      const operation = this.admit('doctor', args);
      return { operation, promise: this.execute(operation, args) };
    });
    return withProgress(admitted.promise, 35000, () => ({
      ...this.pending(admitted.operation),
      compatible: false,
      connection: {
        healthy: false,
        code: 'DIAGNOSTIC_PENDING',
        message: 'Diagnostic cleanup is still in progress; no model request was sent.',
      },
    }));
  }
  // The owned compatibility runner awaits one diagnostic through termination; MCP uses doctor().
  async diagnose(args: { repo?: string; worker: WorkerSelection }) {
    return this.runEffect('doctor', args);
  }
  async submit(args: SubmitArgs) {
    return this.runEffect('submit', args);
  }
  async launch(run: Run, task: Task) {
    return this.runEffect('launch', { run_id: run.id, task_id: task.spec.id });
  }
  async collect(run: Run) {
    return this.runEffect('collect', { run_id: run.id });
  }
  async review(args: any) {
    return this.runEffect('review', args);
  }
  async reconcile(run: Run, recoverOnly = false) {
    return this.runEffect('reconcile_run', { run_id: run.id, recover_only: recoverOnly });
  }
  async validate(run: Run) {
    return this.runEffect('validate_run', { run_id: run.id });
  }
  async finalize(args: any) {
    return this.runEffect('finalize_run', args);
  }
  async cleanup(id: string) {
    const hot = await this.serial(async () => {
      if (this.store.isArchived(id)) return;
      const operation = this.admit('cleanup', { run_id: id });
      return { operation, promise: this.execute(operation, { run_id: id }) };
    });
    let admitted = hot;
    if (!admitted) {
      const run = await this.store.runAsync(id);
      invariant(run, 'NOT_FOUND', 'Run not found.');
      admitted = await this.serial(async () => {
        const operation = this.admit('cleanup', { run_id: id }, undefined, undefined, run);
        return { operation, promise: this.execute(operation, { run_id: id }, run) };
      });
    }
    const selected = admitted;
    return withProgress(selected.promise, 1000, () => this.pending(selected.operation));
  }
  async tick(waitEffects = true) {
    if (this.store.uncertain) return;
    const pending: Promise<unknown>[] = [];
    await this.recoverPreparations();
    await this.settleDiagnostics();
    if (this.stopping) return;
    await this.serial(async () => {
      for (const run of this.store.state.runs) {
        if (this.activeOperations().some((op) => op.run_id === run.id)) continue;
        let kind: string | undefined, args: any;
        const locks = this.lockedResources();
        for (const active of this.activeOperations())
          for (const resource of active.reservations.resources ?? []) locks.add(resource);
        const queued = run.tasks.find(
          (task) => canSchedule(run, task) && !task.spec.resources.some((resource) => locks.has(resource)),
        );
        if (queued) {
          kind = 'launch';
          args = { run_id: run.id, task_id: queued.spec.id };
        } else if (
          this.allAttempts(run).some((attempt) => holdsResources(attempt) && attempt.state !== 'resource_wait') ||
          run.state === 'cancelling'
        ) {
          kind = run.state === 'cancelling' ? 'reconcile_run' : 'collect';
          args = { run_id: run.id };
        }
        if (!kind) continue;
        try {
          const operation = this.admit(kind, args);
          const effect = this.execute(operation, args);
          pending.push(effect);
          void effect.catch((error) => process.stderr.write(`effect: ${(error as Error).message}\n`));
        } catch (error) {
          if (
            !(error instanceof Fault) ||
            !['CAPACITY', 'RESOURCE_BUSY', 'RUN_BUSY', 'REPOSITORY_BUSY'].includes(error.code)
          )
            throw error;
          if (
            kind === 'launch' &&
            this.allAttempts(run).some((attempt) => holdsResources(attempt) && attempt.state !== 'resource_wait')
          )
            try {
              const fallback = this.admit('collect', { run_id: run.id });
              const effect = this.execute(fallback, { run_id: run.id });
              pending.push(effect);
              void effect.catch(() => undefined);
            } catch {
              /* Another run may own the repository until its effect completes. */
            }
        }
      }
    });
    if (!this.archiving && this.store.clock() >= this.nextArchiveScan) {
      this.nextArchiveScan = this.store.clock() + 3_600_000;
      this.archiving = true;
      this.archiveTask = (async () => {
        const prepared = await this.store.prepareArchive();
        if (prepared) {
          await this.serial(async () => {
            if (!this.stopping) this.store.commitArchive(prepared);
          });
          this.nextArchiveScan = this.store.clock();
        }
      })();
      try {
        await this.archiveTask;
      } finally {
        this.archiving = false;
        this.archiveTask = undefined;
      }
    }
    if (waitEffects) await Promise.allSettled(pending);
  }
  async respond(args: any) {
    const run = this.getRun(args.run_id);
    const attempt = this.allAttempts(run).find((a) => a.id === args.attempt_id);
    invariant(attempt && holdsResources(attempt), 'ATTEMPT', 'No active attempt.');
    const input = attempt.inputs.find((i) => i.id === args.input_id);
    invariant(input, 'INPUT', 'Input is no longer pending.');
    invariant(
      input.kind === 'permission'
        ? args.decision !== 'answer'
        : args.decision === 'answer' || args.decision === 'reject',
      'INPUT',
      'Decision type does not match input.',
    );
    invariant(
      !input.supported_decisions || input.supported_decisions.includes(args.decision),
      'INPUT_UNSUPPORTED',
      'This native input does not support the requested decision.',
    );
    if (input.kind === 'question' && args.decision === 'answer') {
      const details = input.details as any;
      const count = Array.isArray(details?.questions)
        ? details.questions.length
        : details?.requestedSchema?.properties
          ? Object.keys(details.requestedSchema.properties).length
          : undefined;
      invariant(
        Array.isArray(args.answers) &&
          args.answers.length > 0 &&
          (count === undefined || args.answers.length === count),
        'INPUT',
        'Answer count does not match the pending question.',
      );
    }
    if (args.decision === 'answer') invariant(args.answers, 'INPUT', 'Answers are required.');
    const file = path.join(attempt.job_dir, 'replies', `${Buffer.from(input.id).toString('hex')}.json`);
    invariant(
      !fs.existsSync(file),
      'INPUT_ALREADY_DECIDED',
      'This input already has a decision. Reconcile delivery instead of resending.',
    );
    writeJson(file, { decision: args.decision, answers: args.answers });
    this.store.state.events.push({
      seq: ++this.store.state.event_seq,
      run_id: run.id,
      type: 'input_answered',
      data: { attempt_id: attempt.id, input_id: input.id },
    });
    this.notify();
    return { state: 'queued_for_delivery', input_id: input.id };
  }
  private async cancelIntent(run: Run) {
    invariant(!this.stopping, 'SERVICE_STOPPING', 'Service is shutting down.');
    if (run.state === 'cancelled') return { run_id: run.id, state: run.state };
    invariant(
      !['completed', 'finalizing', 'finalize_uncertain'].includes(run.state),
      'RUN_FROZEN',
      'Cannot cancel a completed/finalizing run.',
    );
    moveRun(run, 'cancelling');
    run.control_generation = (run.control_generation ?? 0) + 1;
    for (const task of run.tasks) if (task.state === 'queued') moveTask(task, 'cancelled');
    this.store.event(run.id, 'cancel_requested', {});
    this.notify();
    // Control files are tiny. Slow process ownership checks and termination run in reconciliation.
    for (const attempt of this.allAttempts(run))
      if (holdsResources(attempt) && attempt.state !== 'resource_wait')
        writeJson(path.join(attempt.job_dir, 'cancel.json'), { at: this.store.clock() });
    if (!this.activeOperations().some((op) => op.run_id === run.id)) {
      const operation = this.admit('reconcile_run', { run_id: run.id });
      void this.execute(operation, { run_id: run.id }).catch(() => undefined);
    }
    return { run_id: run.id, state: run.state };
  }
  async cancel(run: Run) {
    return this.serial(() => this.cancelIntent(this.getRun(run.id)));
  }
}
