import path from 'node:path';
import { Store } from './store.js';
import { Fault, invariant, type Attempt, type Run, type WorkerState } from './types.js';
import { readJson } from './io.js';
import { holdsResources, validateWorkerState } from './lifecycle.js';
import { publicWorker } from './profiles.js';
import { publicRuntime } from './runtime.js';
import type { EffectRunner } from './effects.js';

export type EngineOptions = { concurrency: number; spawn?: EffectRunner['spawn'] };
// Read-only views of the store, shared by the controller and the effect runner.
// Null cost means at least one attempt's platform did not report one, so a sum would mislead.
function totalUsage(attempts: Attempt[]) {
  const reported = attempts.flatMap((attempt) => (attempt.usage ? [attempt.usage] : []));
  if (!reported.length) return undefined;
  return {
    input_tokens: reported.reduce((sum, usage) => sum + usage.input_tokens, 0),
    output_tokens: reported.reduce((sum, usage) => sum + usage.output_tokens, 0),
    cached_input_tokens: reported.reduce((sum, usage) => sum + usage.cached_input_tokens, 0),
    cost_usd: reported.every((usage) => usage.cost_usd !== null)
      ? reported.reduce((sum, usage) => sum + (usage.cost_usd ?? 0), 0)
      : null,
  };
}
export class EngineBase {
  constructor(
    public store: Store,
    public executableFile: string,
    public options: EngineOptions = {
      concurrency: Number(process.env.AGENT_DELEGATION_CONCURRENCY || 2),
    },
  ) {
    invariant(
      Number.isSafeInteger(options.concurrency) && options.concurrency > 0,
      'CONFIG',
      'Invalid service concurrency.',
    );
  }
  workerState(attempt: Attempt) {
    try {
      const state = readJson<WorkerState>(path.join(attempt.job_dir, 'worker.json'));
      if (state) validateWorkerState(state);
      return state;
    } catch (e) {
      if (e instanceof Fault) throw e;
      throw new Fault('STATE_CORRUPT', 'Worker record could not be read.', {
        attempt_id: attempt.id,
        reason: (e as Error).message,
      });
    }
  }
  getRun(id: string) {
    const run = this.store.run(id);
    invariant(run, 'NOT_FOUND', 'Run not found.');
    return run;
  }
  allAttempts(run?: Run) {
    return (run ? [run] : this.store.state.runs).flatMap((r) => [
      ...r.tasks.flatMap((t) => t.attempts),
      ...(r.validation ? [r.validation.attempt] : []),
    ]);
  }
  protected activeOperations() {
    return Object.values(this.store.state.operations).filter((operation) => operation.status !== 'completed');
  }
  lockedResources() {
    return new Set(
      this.allAttempts()
        .filter((a) => holdsResources(a))
        .flatMap((a) => a.resources),
    );
  }
  view(run: Run, cursor?: string) {
    return this.store.page(
      run.tasks.map((t) => {
        const a = t.attempts.at(-1);
        return {
          task_id: t.spec.id,
          state: t.state,
          dependencies: t.spec.dependencies,
          worker: publicWorker(t.worker),
          attempt: a && {
            id: a.id,
            number: a.number,
            state: a.state,
            directory: a.directory,
            commit: a.commit,
            model: a.model,
            usage: a.usage,
            backend: a.worker?.backend,
            backend_version: a.worker?.backend_version,
            runtime: publicRuntime(a.worker?.runtime ?? a.execution?.runtime),
            runtime_error: a.runtime_error,
            verification: a.verification,
            artifacts: a.artifacts,
            inputs: a.inputs,
            conflicts: a.conflicts && Object.keys(a.conflicts),
            error: a.error,
            integrated_commit: a.integrated_commit,
          },
        };
      }),
      cursor,
      {
        run_id: run.id,
        state: run.state,
        revision: run.revision,
        base: run.base,
        integration_commit: run.integration_commit,
        worker: publicWorker(run.worker),
        usage: totalUsage(this.allAttempts(run)),
        ended_at: run.ended_at,
        archived: this.store.isArchived(run.id),
        archived_at: this.store.state.archived_runs[run.id]?.archived_at ?? null,
        validation: run.validation && {
          id: run.validation.id,
          state: run.validation.state,
          commit: run.validation.commit,
          revision: run.validation.revision,
          attempt_id: run.validation.attempt.id,
          directory: run.validation.attempt.directory,
          artifacts: run.validation.attempt.artifacts,
          verification: run.validation.attempt.verification,
          inputs: run.validation.attempt.inputs,
          error: run.validation.attempt.error,
        },
        error: run.error,
        event_cursor: this.store.eventCursor(run.id),
        operations: this.activeOperations()
          .filter((operation) => operation.run_id === run.id)
          .map((operation) => ({
            id: operation.id,
            kind: operation.kind,
            status: operation.status,
            updated: operation.updated,
          })),
      },
    );
  }
}
