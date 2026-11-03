import { publicWorker } from './profiles.js';
import { runtimeVersions } from './runtime.js';
import type { Attempt, Run, Task } from './types.js';

// The get_run fields shared by live and archived runs, so the two cannot drift apart.
// A verification entry already names its artifact, so get_run lists only the others.
export const otherArtifacts = (attempt: Pick<Attempt, 'artifacts' | 'verification'>) =>
  attempt.artifacts.filter((id) => !attempt.verification?.some((check) => check.artifact === id));
// What a supervisor needs to keep going when a task item does not fit in a page.
export const taskSummary = (item: any) => ({
  task_id: item.task_id,
  state: item.state,
  attempt: item.attempt && {
    id: item.attempt.id,
    state: item.attempt.state,
    commit: item.attempt.commit,
    verification: item.attempt.verification?.map((check: any) => ({
      status: check.status,
      exit_code: check.exit_code,
    })),
  },
});
export function taskView(task: Task) {
  const a = task.attempts.at(-1);
  return {
    task_id: task.spec.id,
    state: task.state,
    dependencies: task.spec.dependencies,
    worker: publicWorker(task.worker),
    attempt: a && {
      id: a.id,
      number: a.number,
      state: a.state,
      directory: a.directory,
      commit: a.commit,
      model: a.model,
      usage: a.usage,
      last_activity_at: a.last_activity_at,
      backend: a.worker?.backend,
      backend_version: a.worker?.backend_version,
      runtime: runtimeVersions(a.worker?.runtime ?? a.execution?.runtime),
      runtime_error: a.runtime_error,
      verification: a.verification,
      artifacts: otherArtifacts(a),
      inputs: a.inputs,
      conflicts: a.conflicts && Object.keys(a.conflicts),
      error: a.error,
      integrated_commit: a.integrated_commit,
    },
  };
}
export function runView(run: Run) {
  return {
    run_id: run.id,
    state: run.state,
    revision: run.revision,
    base: run.base,
    integration_commit: run.integration_commit,
    worker: publicWorker(run.worker),
    ended_at: run.ended_at,
    validation: run.validation && {
      id: run.validation.id,
      state: run.validation.state,
      commit: run.validation.commit,
      revision: run.validation.revision,
      directory: run.validation.attempt.directory,
      artifacts: otherArtifacts(run.validation.attempt),
      verification: run.validation.attempt.verification,
      inputs: run.validation.attempt.inputs,
      error: run.validation.attempt.error,
    },
    error: run.error,
  };
}
