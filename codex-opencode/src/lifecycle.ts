import { invariant, runStates, taskStates, attemptStates, validationStates, workerPhases,
  type Run, type Task, type Attempt, type Validation, type WorkerState, type State,
  type RunState, type TaskState, type AttemptState, type ValidationState, type WorkerPhase } from './types.js';

type Graph<S extends string> = Record<S, readonly S[]>;
const runGraph: Graph<RunState> = {
  active: ['validating','cancelling','waiting_final_review'],
  validating: ['active','waiting_final_review','cancelling'],
  waiting_final_review: ['active','validating','finalizing','cancelling'],
  finalizing: ['completed','waiting_final_review','finalize_uncertain'],
  finalize_uncertain: ['completed','waiting_final_review'],
  cancelling: ['cancelled'], completed: [], cancelled: [],
};
const taskGraph: Graph<TaskState> = {
  queued: ['running','cancelled'], running: ['needs_input','needs_review','cancelled'],
  needs_input: ['running','needs_review','cancelled'], needs_review: ['queued','integrated','cancelled'],
  integrated: [], cancelled: [],
};
const executing: AttemptState[] = ['launching','running','needs_input','delivery_uncertain','orphaned','stop_uncertain'];
const ended: AttemptState[] = ['failed','cancelled','needs_review','scope_or_context_error','interrupted','verified'];
const executionTargets: AttemptState[] = [...executing,'cancelling',...ended];
const attemptGraph: Graph<AttemptState> = {
  launching: [...executionTargets,'resource_wait'], running: executionTargets,
  needs_input: executionTargets, delivery_uncertain: executionTargets,
  orphaned: executionTargets, stop_uncertain: executionTargets,
  resource_wait: ['launching','failed','orphaned','cancelled'],
  cancelling: ['cancelled','stop_uncertain','orphaned'],
  needs_review: ['integrating'], integrating: ['integrated','integration_conflict'],
  failed: [], cancelled: [], scope_or_context_error: [], integrated: [], integration_conflict: [], interrupted: [], verified: [],
};
const validationGraph: Graph<ValidationState> = {
  running: ['awaiting_resource','passed','failed','cancelled','invalidated'],
  awaiting_resource: ['running','failed','cancelled','invalidated'],
  passed: ['invalidated'], failed: ['invalidated'], cancelled: ['invalidated'], invalidated: [],
};
const workerGraph: Graph<WorkerPhase> = {
  doctor: [], starting: ['creating_session','failed','cancelled'],
  creating_session: ['implementing','verifying','failed','cancelled'],
  implementing: ['needs_input','reconciling_delivery','delivery_uncertain','verifying','cancelling','failed','cancelled'],
  reconciling_delivery: ['needs_input','delivery_uncertain','verifying','cancelling','failed','cancelled'],
  delivery_uncertain: ['needs_input','reconciling_delivery','verifying','cancelling','failed','cancelled'],
  needs_input: ['implementing','verifying','reconciling_delivery','delivery_uncertain','cancelling','failed','cancelled','completed'],
  verifying: ['needs_input','completed','cancelling','failed','cancelled'],
  cancelling: ['cancelled','stop_uncertain'], completed: ['stop_uncertain'], failed: ['stop_uncertain'], cancelled: ['stop_uncertain'], stop_uncertain: [],
};

function checkTransition<S extends string>(graph: Graph<S>, from: S, to: S, entity: string) {
  invariant(from in graph && (from === to || graph[from].includes(to)), 'STATE_TRANSITION', `Invalid ${entity} transition: ${from} -> ${to}`, { entity, from, to });
}
type Changes = {
  run?: [Run, RunState]; task?: [Task, TaskState]; attempt?: [Attempt, AttemptState]; validation?: [Validation, ValidationState];
};
// Validate the whole group before changing any entity. The caller durably saves it before external effects.
export function transition(changes: Changes) {
  if (changes.run) checkTransition(runGraph, changes.run[0].state, changes.run[1], 'run');
  if (changes.task) checkTransition(taskGraph, changes.task[0].state, changes.task[1], 'task');
  if (changes.attempt) checkTransition(attemptGraph, changes.attempt[0].state, changes.attempt[1], 'attempt');
  if (changes.validation) checkTransition(validationGraph, changes.validation[0].state, changes.validation[1], 'validation');
  if (changes.run) changes.run[0].state = changes.run[1];
  if (changes.task) changes.task[0].state = changes.task[1];
  if (changes.attempt) changes.attempt[0].state = changes.attempt[1];
  if (changes.validation) changes.validation[0].state = changes.validation[1];
}
export function moveRun(run: Run, to: RunState) { transition({run:[run,to]}); }
export function moveTask(task: Task, to: TaskState) { transition({task:[task,to]}); }
export function moveAttempt(attempt: Attempt, to: AttemptState) { transition({attempt:[attempt,to]}); }
export function moveValidation(validation: Validation, to: ValidationState) { transition({validation:[validation,to]}); }
export function moveWorker(worker: WorkerState, to: WorkerPhase) {
  checkTransition(workerGraph, worker.phase, to, 'worker'); worker.phase = to;
}

const leased = new Set<AttemptState>(['launching','running','needs_input','resource_wait','delivery_uncertain','cancelling','orphaned','stop_uncertain']);
export const holdsResources = (a: Attempt) => leased.has(a.state);
export const occupiesSlot = (a: Attempt) => holdsResources(a) && a.state !== 'resource_wait';
export const canSchedule = (run: Run, task: Task) => run.state === 'active' && task.state === 'queued' && task.spec.dependencies.every(id => run.tasks.find(t => t.spec.id === id)?.state === 'integrated');
export const canReview = (task: Task, a: Attempt) => task.state === 'needs_review' && task.attempts.at(-1) === a && !holdsResources(a);
export const canCleanup = (run: Run) => ['completed','cancelled'].includes(run.state);
export const workerTerminal = (state: WorkerState) => ['completed','failed','cancelled','stop_uncertain'].includes(state.phase);

function known(value: unknown, choices: readonly string[], entity: string) {
  invariant(typeof value === 'string' && choices.includes(value), 'STATE_CORRUPT', `Unknown ${entity} state.`, { entity, state: value });
}
export function validateWorkerState(worker: WorkerState) {
  known(worker?.phase, workerPhases, 'worker');
}
function validateAttempt(a: Attempt) {
  known(a?.state, attemptStates, 'attempt'); if (a.worker) validateWorkerState(a.worker);
}
export function validateStoredState(state: State) {
  for (const run of state.runs) {
    known(run.state, runStates, 'run');
    for (const task of run.tasks) { known(task.state, taskStates, 'task'); for (const a of task.attempts) validateAttempt(a); }
    for (const v of [...(run.validation ? [run.validation] : []), ...(run.validation_history ?? [])]) { known(v.state, validationStates, 'validation'); validateAttempt(v.attempt); }
  }
}
