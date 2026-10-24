import { invariant, platforms, workerSchema, WORKER_FORMAT, STORE_FORMAT, runStates, taskStates, attemptStates, validationStates, workerPhases,
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
  starting: ['creating_session','cancelling','failed','cancelled'],
  creating_session: ['implementing','verifying','cancelling','failed','cancelled'],
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
  if (changes.run) {
    changes.run[0].state = changes.run[1];
    if (['completed','cancelled'].includes(changes.run[1])) changes.run[0].ended_at ??= Date.now();
  }
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
  invariant(worker.protocol===WORKER_FORMAT,'STATE_CORRUPT','Unknown worker record format.');
  if(worker.backend!==undefined)known(worker.backend,platforms,'backend');
}
export function validateStoredAttempt(a: Attempt) {
  known(a?.state, attemptStates, 'attempt'); if (a.worker) validateWorkerState(a.worker);
}
export function validateStoredState(state: State) {
  invariant(state.protocol===STORE_FORMAT,'STATE_CORRUPT','Unknown stored state format.');
  invariant(Number.isSafeInteger(state.event_seq) && state.event_seq >= 0 && state.archived_runs && state.archived_requests && state.resource_hashes && state.operations, 'STATE_CORRUPT', 'Missing storage indexes.');
  invariant(state.events.every(e => Number.isSafeInteger(e.seq) && e.seq > 0 && e.seq <= state.event_seq), 'STATE_CORRUPT', 'Invalid event sequence.');
  invariant(Number.isSafeInteger(state.revision)&&state.revision>=0,'STATE_CORRUPT','Invalid stored revision.');
  let previousEvent=0;for(const event of state.events){invariant(event.seq>previousEvent,'STATE_CORRUPT','Stored event sequences are not unique and ordered.');previousEvent=event.seq;}
  for(const[id,operation]of Object.entries(state.operations))invariant(operation&&operation.id===id&&['running','completed','uncertain'].includes(operation.status)&&typeof operation.kind==='string'&&Number.isFinite(operation.created)&&Number.isFinite(operation.updated)&&operation.reservations&&typeof operation.reservations==='object','STATE_CORRUPT','Invalid durable operation.');
  const activeIDs=new Set(state.runs.map(run=>run.id));
  invariant(activeIDs.size===state.runs.length,'STATE_CORRUPT','Duplicate live run identity.');
  for (const [id, ref] of Object.entries(state.archived_runs)) {
    invariant(ref.summary.run_id === id && ['completed','cancelled'].includes(ref.summary.state) && !activeIDs.has(id), 'STATE_CORRUPT', 'Invalid archived run summary.');
    invariant(ref.summary.event_cursor <= state.event_seq, 'STATE_CORRUPT', 'Archived event cursor exceeds sequence.');
  }
  for (const ref of [...Object.values(state.archived_runs), ...Object.values(state.archived_requests)]) {
    invariant(typeof ref.file === 'string' && /^archives\/(runs|requests)\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/.test(ref.file) && /^[a-f0-9]{64}$/.test(ref.hash) && Number.isFinite(ref.archived_at), 'STATE_CORRUPT', 'Invalid archive reference.');
  }
  for (const run of state.runs) validateStoredRun(run);
}
export function validateStoredRun(run: Run) {
    known(run?.state, runStates, 'run');
    invariant(Array.isArray(run.tasks),'STATE_CORRUPT','Missing run tasks.');
    invariant(run.worker&&workerSchema.safeParse({platform:run.worker.platform,model:run.worker.model,profile:run.worker.profile}).success,'STATE_CORRUPT','Unknown stored run worker selection.');
    for (const task of run.tasks) validateStoredTask(task);
    for (const v of [...(run.validation ? [run.validation] : []), ...(run.validation_history ?? [])]) { known(v.state, validationStates, 'validation'); validateStoredAttempt(v.attempt); }
}

export function validateStoredTask(task: Task) {
  known(task?.state,taskStates,'task');invariant(task.worker&&workerSchema.safeParse({platform:task.worker.platform,model:task.worker.model,profile:task.worker.profile}).success,'STATE_CORRUPT','Unknown stored task worker selection.');invariant(Array.isArray(task.attempts),'STATE_CORRUPT','Missing task attempts.');for(const attempt of task.attempts)validateStoredAttempt(attempt);
}
