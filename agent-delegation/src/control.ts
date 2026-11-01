import { AsyncLocalStorage } from 'node:async_hooks';
import type { Store } from './store.js';
import { invariant, type Run, type State } from './types.js';

/** Only admission, durable barriers and publication enter this queue. */
export class ControlQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private context = new AsyncLocalStorage<boolean>();
  outside<T>(fn: () => T): T {
    return this.context.exit(fn);
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return fn();
    const next = this.tail.then(
      () => this.context.run(true, fn),
      () => this.context.run(true, fn),
    );
    this.tail = next.catch(() => undefined);
    return next;
  }
}
export type EffectChange = { run_id: string; path: (string | number)[]; value?: unknown; remove?: boolean };
export type EffectEvent = { run_id: string; type: string; data: unknown };
const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

// Published specifications and stopped history are immutable while a run reservation is held.
// Borrow them through read-only views instead of cloning every historical transcript each poll.
const immutableCache = new WeakMap<object, object>();
function immutable<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const cached = immutableCache.get(value as object);
  if (cached) return cached as T;
  const proxy = new Proxy(value as object, {
    get: (target, key) => immutable(Reflect.get(target, key)),
    set: () => {
      throw new Error('Immutable effect input.');
    },
    deleteProperty: () => {
      throw new Error('Immutable effect input.');
    },
  });
  immutableCache.set(value as object, proxy);
  return proxy as T;
}
function mutableAttempt(attempt: Run['tasks'][number]['attempts'][number]) {
  const { worker, ...fields } = attempt;
  const result = {
    ...fields,
    artifacts: [...attempt.artifacts],
    context: immutable(attempt.context),
    resources: [...attempt.resources],
    verification: immutable(attempt.verification),
    inputs: immutable(attempt.inputs),
    execution: copy(attempt.execution),
    approval: copy(attempt.approval),
    runtime_error: copy(attempt.runtime_error),
  };
  // Polling only compares execution/control fields. Large completed model reports remain
  // in immutable history and are read from worker.json when completion is collected.
  return {
    ...result,
    worker: worker && copy({ ...worker, summary: undefined, transcript: undefined, usage: undefined }),
  };
}
function mutableRun(run: Run): Run {
  return {
    ...run,
    context: immutable(run.context),
    resources: immutable(run.resources),
    final_verification: immutable(run.final_verification),
    worker: copy(run.worker),
    tasks: run.tasks.map((task) => ({
      ...task,
      spec: immutable(task.spec),
      worker: copy(task.worker),
      attempts: task.attempts.map((attempt, index) =>
        index === task.attempts.length - 1 ? mutableAttempt(attempt) : immutable(attempt),
      ),
    })),
    validation: run.validation ? { ...run.validation, attempt: mutableAttempt(run.validation.attempt) } : undefined,
    validation_history: run.validation_history?.map((validation) => immutable(validation)),
    finalize_intent: copy(run.finalize_intent),
  };
}

/** The effect has private mutable inputs. Publication consists solely of captured writes. */
export function effectStore(source: Store, runID: string | undefined, archivedRun?: Run) {
  const changes: EffectChange[] = [],
    events: EffectEvent[] = [];
  const originals = source.state.runs;
  const runs = originals.map((run) =>
    run.id === runID
      ? mutableRun(run)
      : ({
          id: run.id,
          resources: copy(run.resources),
          settings: copy(run.settings),
          common_dir: run.common_dir,
          tasks: run.tasks.map((task) => ({
            attempts: task.attempts.map((a) => ({ id: a.id, state: a.state, resources: copy(a.resources) })),
          })),
          validation: run.validation
            ? {
                attempt: {
                  id: run.validation.attempt.id,
                  state: run.validation.attempt.state,
                  resources: copy(run.validation.attempt.resources),
                },
              }
            : undefined,
        } as Run),
  );
  if (archivedRun && !runs.some((run) => run.id === archivedRun.id)) runs.push(copy(archivedRun));
  const state = {
    ...source.state,
    runs,
    events: [],
    requests: Object.create(null),
    operations: Object.create(null),
    resource_hashes: copy(source.state.resource_hashes),
    archived_runs: Object.create(null),
    archived_requests: Object.create(null),
    metrics: copy(source.state.metrics),
  } as State;
  const proxies = new WeakMap<object, object>();
  function tracked<T extends object>(target: T, run_id: string, keys: (string | number)[]): T {
    const prior = proxies.get(target);
    if (prior) return prior as T;
    const proxy = new Proxy(target, {
      get(object, key, receiver) {
        const value = Reflect.get(object, key, receiver);
        return value && typeof value === 'object' && typeof key === 'string'
          ? tracked(value, run_id, [...keys, key])
          : value;
      },
      set(object, key, value) {
        invariant(typeof key === 'string', 'STATE_CORRUPT', 'Invalid effect field.');
        const raw = copy(value);
        Reflect.set(object, key, raw);
        changes.push({ run_id, path: [...keys, key], value: copy(raw) });
        return true;
      },
      deleteProperty(object, key) {
        invariant(typeof key === 'string', 'STATE_CORRUPT', 'Invalid effect field.');
        Reflect.deleteProperty(object, key);
        changes.push({ run_id, path: [...keys, key], remove: true });
        return true;
      },
    });
    proxies.set(target, proxy);
    return proxy;
  }
  for (let index = 0; index < runs.length; index++)
    if (runs[index]!.id === runID) runs[index] = tracked(runs[index]!, runID, []);
  const array = new Proxy(runs, {
    set(object, key, value) {
      if (typeof key === 'string' && key !== 'length') {
        const run = copy(value) as Run;
        Reflect.set(object, key, tracked(run, run.id, []));
        changes.push({ run_id: run.id, path: [], value: copy(run) });
        return true;
      }
      return Reflect.set(object, key, value);
    },
  });
  state.runs = array;
  const facade = Object.create(source) as Store;
  Object.defineProperties(facade, {
    state: { value: state, writable: true },
    uncertain: {
      get: () => source.uncertain,
      set: (value: boolean) => {
        if (value) source.uncertain = true;
      },
    },
  });
  facade.save = () => undefined;
  facade.event = (run_id, type, data) => {
    events.push({ run_id, type, data: copy(data) });
  };
  facade.run = (id) => state.runs.find((run) => run.id === id);
  facade.events = (id) => state.events.filter((event) => event.run_id === id);
  facade.isArchived = (id) => source.isArchived(id);
  return {
    store: facade,
    changes,
    events,
    drain() {
      return { changes: changes.splice(0), events: events.splice(0) };
    },
  };
}
export function publishChanges(store: Store, changes: EffectChange[]) {
  for (const change of changes) {
    let run = store.state.runs.find((value) => value.id === change.run_id);
    if (change.path.length === 0) {
      if (run) Object.assign(run, copy(change.value));
      else store.state.runs.push(copy(change.value) as Run);
      continue;
    }
    invariant(run, 'NOT_FOUND', 'Effect run disappeared before publication.');
    let target: any = run;
    for (const key of change.path.slice(0, -1)) {
      target = target[key];
      invariant(target && typeof target === 'object', 'STATE_CORRUPT', 'Effect target disappeared.');
    }
    const key = change.path.at(-1)!;
    if (change.remove) delete target[key];
    else target[key] = copy(change.value);
  }
}

/** A pending response is itself promised work: keep its timer referenced until it fires.
 * Clear it on fast completion so read-only diagnostics never leave a 35-second idle timer. */
export function withProgress<T>(
  operation: Promise<T>,
  milliseconds: number,
  pending: () => unknown,
): Promise<T | unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(pending()), milliseconds);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
