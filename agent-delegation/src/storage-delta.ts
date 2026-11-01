import { invariant, type State, type Run } from './types.js';

export type EntityMap = 'requests' | 'archived_runs' | 'archived_requests' | 'resource_hashes' | 'operations';
export type Delta =
  | { entity: 'run'; id: string; path: string[]; remove?: boolean; value?: unknown }
  | { entity: 'event'; seq: number; remove?: boolean; value?: unknown }
  | { entity: EntityMap; id: string; path: string[]; remove?: boolean; value?: unknown }
  | { entity: 'counter'; id: 'event_seq'; value: number };
export type TransactionRecord = { protocol: 4; previous: number; revision: number; changes: Delta[] };
const maps = new Set(['requests', 'archived_runs', 'archived_requests', 'resource_hashes', 'operations']);
const own = (object: object, key: PropertyKey) => Object.hasOwn(object, key);
const numeric = (key: string) => /^(0|[1-9][0-9]*)$/.test(key);

// Paths are produced by this process, and checked again at the persistence boundary.
// Own-property traversal also makes prototype-like request identifiers ordinary keys.
function patch(object: any, keys: string[], value: unknown, remove?: boolean) {
  invariant(
    keys.length > 0 && keys.every((k) => typeof k === 'string' && !['__proto__', 'prototype'].includes(k)),
    'JOURNAL_CORRUPT',
    'Invalid entity patch path.',
  );
  let parent = object;
  for (const key of keys.slice(0, -1)) {
    invariant(
      parent && typeof parent === 'object' && own(parent, key),
      'JOURNAL_CORRUPT',
      'Entity patch parent is missing.',
    );
    parent = parent[key];
  }
  const key = keys.at(-1)!;
  invariant(parent && typeof parent === 'object', 'JOURNAL_CORRUPT', 'Entity patch target is not an object.');
  if (remove) delete parent[key];
  else Reflect.set(parent, key, value);
}
export function applyDeltas(
  state: State,
  changes: Delta[],
  runs = new Map(state.runs.map((r) => [r.id, r])),
  events = new Map(state.events.map((e) => [e.seq, e])),
) {
  for (const change of changes) {
    invariant(
      change && typeof change === 'object' && typeof change.entity === 'string',
      'JOURNAL_CORRUPT',
      'Invalid journal change.',
    );
    if (change.entity === 'counter')
      invariant(
        change.id === 'event_seq' && Number.isSafeInteger(change.value) && change.value >= state.event_seq,
        'JOURNAL_CORRUPT',
        'Invalid global event counter.',
      );
    else if (change.entity === 'event')
      invariant(
        Number.isSafeInteger(change.seq) &&
          change.seq > 0 &&
          (change.remove === undefined || typeof change.remove === 'boolean'),
        'JOURNAL_CORRUPT',
        'Invalid event change.',
      );
    else
      invariant(
        (change.entity === 'run' || maps.has(change.entity)) &&
          typeof change.id === 'string' &&
          Array.isArray(change.path) &&
          change.path.every((key) => typeof key === 'string') &&
          (change.remove === undefined || typeof change.remove === 'boolean'),
        'JOURNAL_CORRUPT',
        'Invalid entity change.',
      );
    if (change.entity === 'counter') {
      state.event_seq = change.value;
      continue;
    }
    if (change.entity === 'event') {
      if (change.remove) {
        events.delete(change.seq);
      } else {
        invariant(!events.has(change.seq), 'JOURNAL_CORRUPT', 'An event sequence was reused.');
        invariant(
          change.value && (change.value as any).seq === change.seq,
          'JOURNAL_CORRUPT',
          'Event identity mismatch.',
        );
        events.set(change.seq, change.value as any);
      }
      continue;
    }
    if (change.entity === 'run') {
      if (!change.path.length) {
        if (change.remove) runs.delete(change.id);
        else {
          invariant(
            change.value && (change.value as Run).id === change.id,
            'JOURNAL_CORRUPT',
            'Run identity mismatch.',
          );
          runs.set(change.id, change.value as Run);
        }
      } else {
        const run = runs.get(change.id);
        invariant(run && change.path[0] !== 'id', 'JOURNAL_CORRUPT', 'Patched run is missing or its identity changed.');
        patch(run, change.path, change.value, change.remove);
      }
      continue;
    }
    invariant(maps.has(change.entity), 'JOURNAL_CORRUPT', 'Unknown journal entity.');
    const collection = state[change.entity] as Record<string, any>;
    if (!change.path.length) {
      if (change.remove) delete collection[change.id];
      else
        Object.defineProperty(collection, change.id, {
          value: change.value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    } else {
      invariant(own(collection, change.id), 'JOURNAL_CORRUPT', 'Patched entity is missing.');
      patch(collection[change.id], change.path, change.value, change.remove);
    }
  }
  // Replay callers retain maps between records; collection materialization is deferred until EOF.
  return { runs, events };
}

export class StateTracker {
  readonly state: State;
  pending: Delta[] = [];
  readonly runs = new Map<string, Run>();
  private positions = new Map<string, number>();
  readonly runVersions = new Map<string, number>();
  readonly mapVersions = new Map<string, number>();
  readonly events = new Map<number, State['events'][number]>();
  readonly eventsByRun = new Map<string, State['events']>();
  dirtyRuns = new Set<string>();
  newRuns = new Set<string>();
  resources = new Set<string>();
  private proxies = new WeakMap<object, Map<string, any>>();
  private rawValues = new WeakMap<object, object>();
  constructor(readonly raw: State) {
    this.reindex();
    this.state = this.wrap(raw, []);
  }
  private reindex() {
    this.runs.clear();
    this.positions.clear();
    this.raw.runs.forEach((run, index) => {
      this.runs.set(run.id, run);
      this.positions.set(run.id, index);
    });
    this.events.clear();
    this.eventsByRun.clear();
    for (const event of this.raw.events) {
      this.events.set(event.seq, event);
      const list = this.eventsByRun.get(event.run_id) ?? [];
      list.push(event);
      this.eventsByRun.set(event.run_id, list);
    }
  }
  unwrap<T>(value: T): T {
    return value && typeof value === 'object' ? ((this.rawValues.get(value as object) ?? value) as T) : value;
  }
  private wrap(value: any, keys: string[]): any {
    if (!value || typeof value !== 'object') return value;
    if (keys[0] === 'runs' && keys.length === 2 && numeric(keys[1]!)) keys = ['entity_run', String(value.id)];
    const key = JSON.stringify(keys),
      cached = this.proxies.get(value)?.get(key);
    if (cached) return cached;
    const proxy = new Proxy(value, {
      get: (target, name, receiver) =>
        typeof name === 'symbol'
          ? Reflect.get(target, name, receiver)
          : this.wrap(Reflect.get(target, name, receiver), [...keys, name]),
      set: (target, name, input) => {
        if (typeof name !== 'string') return Reflect.set(target, name, input);
        let next = this.unwrap(input);
        if (Array.isArray(next)) next = next.map((item) => this.unwrap(item));
        const previous = target[name];
        if (previous === next) return true;
        Reflect.set(target, name, next);
        this.changed([...keys, name], next, false, previous);
        return true;
      },
      deleteProperty: (target, name) => {
        if (typeof name !== 'string') return Reflect.deleteProperty(target, name);
        const previous = target[name];
        const ok = Reflect.deleteProperty(target, name);
        if (ok) this.changed([...keys, name], undefined, true, previous);
        return ok;
      },
    });
    let byPath = this.proxies.get(value);
    if (!byPath) {
      byPath = new Map();
      this.proxies.set(value, byPath);
    }
    byPath.set(key, proxy);
    this.rawValues.set(proxy, value);
    return proxy;
  }
  private changed(keys: string[], value: unknown, remove: boolean, previous: unknown) {
    const [root, index, ...nested] = keys;
    if (root === 'metrics' || root === 'revision' || root === 'protocol') return;
    if (root === 'event_seq') {
      this.pending.push({ entity: 'counter', id: 'event_seq', value: Number(value) });
      return;
    }
    if (root === 'entity_run') {
      invariant(index && this.runs.has(index), 'STATE_CORRUPT', 'Run mutation has no current owner.');
      invariant(nested[0] !== 'id', 'STATE_CORRUPT', 'Run identity is immutable.');
      this.pending.push({
        entity: 'run',
        id: index,
        path: nested,
        ...(remove || value === undefined ? { remove: true } : { value }),
      });
      this.dirtyRuns.add(index);
      this.runVersions.set(index, (this.runVersions.get(index) ?? 0) + 1);
      if (nested[0] === 'resources') this.resources.add(index);
      return;
    }
    if (root === 'runs') {
      if (index === undefined) {
        const next = new Map(this.raw.runs.map((r) => [r.id, this.unwrap(r)]));
        for (const [id] of this.runs)
          if (!next.has(id)) {
            this.pending.push({ entity: 'run', id, path: [], remove: true });
            this.dirtyRuns.add(id);
          }
        for (const [id, run] of next)
          if (this.runs.get(id) !== run) {
            this.pending.push({ entity: 'run', id, path: [], value: run });
            this.dirtyRuns.add(id);
            this.newRuns.add(id);
            this.resources.add(id);
          }
        this.runs.clear();
        this.positions.clear();
        this.raw.runs.forEach((run, index) => {
          this.runs.set(run.id, run);
          this.positions.set(run.id, index);
        });
        return;
      }
      if (index === 'length') {
        for (const [id, position] of this.positions)
          if (position >= this.raw.runs.length) {
            this.pending.push({ entity: 'run', id, path: [], remove: true });
            this.runs.delete(id);
            this.positions.delete(id);
            this.dirtyRuns.add(id);
          }
        return;
      }
      if (!numeric(index)) return;
      const run = this.raw.runs[Number(index)];
      if (!nested.length) {
        const old = previous as Run | undefined;
        if (old && (!run || old.id !== run.id) && !this.raw.runs.some((value) => value?.id === old.id)) {
          this.pending.push({ entity: 'run', id: old.id, path: [], remove: true });
          this.runs.delete(old.id);
          this.positions.delete(old.id);
        }
        if (run) {
          this.runs.set(run.id, run);
          this.positions.set(run.id, Number(index));
          this.pending.push({ entity: 'run', id: run.id, path: [], value: run });
          this.dirtyRuns.add(run.id);
          this.newRuns.add(run.id);
          this.resources.add(run.id);
        }
        return;
      }
      invariant(run, 'STATE_CORRUPT', 'Run mutation has no owner.');
      this.pending.push({
        entity: 'run',
        id: run.id,
        path: nested,
        ...(remove || value === undefined ? { remove: true } : { value }),
      });
      this.dirtyRuns.add(run.id);
      if (nested[0] === 'resources') this.resources.add(run.id);
      return;
    }
    if (root === 'events') {
      if (index === undefined) {
        const next = new Map(this.raw.events.map((e) => [e.seq, e]));
        for (const [seq] of this.events) if (!next.has(seq)) this.pending.push({ entity: 'event', seq, remove: true });
        for (const [seq, event] of next)
          if (this.events.get(seq) !== event) this.pending.push({ entity: 'event', seq, value: event });
        this.reindex();
        return;
      }
      if (index === 'length') {
        const kept = new Set(this.raw.events.map((event) => event.seq));
        for (const [seq, event] of this.events)
          if (!kept.has(seq)) {
            this.pending.push({ entity: 'event', seq, remove: true });
            this.events.delete(seq);
            this.eventsByRun.set(
              event.run_id,
              (this.eventsByRun.get(event.run_id) ?? []).filter((value) => value.seq !== seq),
            );
          }
        return;
      }
      if (!numeric(index)) return;
      const event = this.raw.events[Number(index)];
      const prior = previous as State['events'][number] | undefined;
      if (prior && (!event || prior.seq !== event.seq)) {
        this.pending.push({ entity: 'event', seq: prior.seq, remove: true });
        this.events.delete(prior.seq);
      }
      if (event) {
        this.pending.push({ entity: 'event', seq: event.seq, value: event });
        const existed = this.events.has(event.seq);
        this.events.set(event.seq, event);
        const list = this.eventsByRun.get(event.run_id) ?? [];
        if (!existed) list.push(event);
        this.eventsByRun.set(event.run_id, list);
      } else if (previous) {
        const old = previous as State['events'][number];
        this.pending.push({ entity: 'event', seq: old.seq, remove: true });
        this.events.delete(old.seq);
        this.eventsByRun.set(
          old.run_id,
          (this.eventsByRun.get(old.run_id) ?? []).filter((e) => e.seq !== old.seq),
        );
      }
      return;
    }
    if (root && maps.has(root)) {
      invariant(
        index !== undefined,
        'STATE_CORRUPT',
        'Replace individual keyed storage records instead of their collection.',
      );
      const versionKey = `${root}:${index}`;
      this.mapVersions.set(versionKey, (this.mapVersions.get(versionKey) ?? 0) + 1);
      this.pending.push({
        entity: root as EntityMap,
        id: index,
        path: nested,
        ...(remove || value === undefined ? { remove: true } : { value }),
      });
    }
  }
  index(id: string) {
    return this.positions.get(id);
  }
  run(id: string): Run | undefined {
    const value = this.runs.get(id);
    if (!value) return;
    return this.wrap(value, ['entity_run', id]);
  }
  clear() {
    this.pending = [];
    this.dirtyRuns.clear();
    this.newRuns.clear();
    this.resources.clear();
  }
  // Clone only the transaction payload; never stringify/diff the whole state to discover changes.
  changes(): Delta[] {
    return JSON.parse(JSON.stringify(this.pending)) as Delta[];
  }
}
