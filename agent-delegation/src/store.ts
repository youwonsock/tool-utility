import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  Fault,
  invariant,
  type State,
  type Run,
  type ArchiveRef,
  type RequestRecord,
  type RunSummary,
  type RunEvent,
} from './types.js';
import { digest, mkdir, readJson, writeJson, durableWrite, uid, inside } from './io.js';
import { validateStoredState, validateStoredRun } from './lifecycle.js';
import {
  ARCHIVE_AGE,
  emptyState,
  deltaRecord,
  loadState,
  attemptsStopped,
  type StorageManifest,
} from './persistence.js';
import { StateTracker, type Delta } from './storage-delta.js';
import { readVerified, readRunArchive, readArchiveEvents, appendArchiveEvent } from './storage-archives.js';
import { publicWorker } from './profiles.js';
import { publicRuntime } from './runtime.js';

export const responseBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }));
export type PreparedArchive = {
  kind: 'run' | 'request';
  id: string;
  ref: ArchiveRef;
  source: object;
  version?: number;
  cursor?: number;
  summary?: RunSummary;
};
const COMPACT_BYTES = 32 * 1024 * 1024;

export class Store {
  state: State;
  uncertain = false;
  private tracker: StateTracker;
  private manifest: StorageManifest;
  private records = 0;
  private journalBytes = 0;
  private lastRecordBytes = 0;
  private checkpointTask?: Promise<void>;
  private checkpointError?: Error;
  private batching = 0;
  private metricsTimer?: NodeJS.Timeout;
  private helpers = new Set<Promise<unknown>>();
  private retired = new Set<string>();
  private coldActive = 0;
  private durableActive = 0;
  private coldQueue: (() => void)[] = [];
  private durableQueue: (() => void)[] = [];
  private summaryCache?: ReturnType<Store['buildSummaries']>;
  // Operational counters: measure bytes actually issued, independent of synthetic wall-clock speed.
  readonly io = { journal_bytes: 0, artifact_read_bytes: 0, checkpoints: 0, helper_peak: 0 };
  constructor(
    public root: string,
    public clock: () => number = Date.now,
  ) {
    const loaded = loadState(root);
    const raw = loaded.state ?? emptyState();
    validateStoredState(raw);
    mkdir(root);
    for (const key of ['requests', 'archived_runs', 'archived_requests', 'resource_hashes', 'operations'] as const)
      raw[key] = Object.assign(Object.create(null), raw[key]);
    if (loaded.bytes !== loaded.completeBytes) {
      const tail = loaded.files.at(-1)!;
      const fd = fs.openSync(inside(root, tail.file), 'r+');
      try {
        fs.ftruncateSync(fd, tail.completeBytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    this.tracker = new StateTracker(raw);
    this.state = this.tracker.state;
    if (loaded.manifest) this.manifest = loaded.manifest;
    else {
      // Before its initial manifest is durable a store cannot acknowledge any mutation.
      // A missing manifest with existing records is corruption, not permission to guess
      // a newer snapshot and overwrite the only journal on the control thread.
      invariant(loaded.records === 0, 'STATE_CORRUPT', 'A storage generation manifest is missing.');
      if (!loaded.state) writeJson(path.join(root, 'state.json'), raw);
      if (!fs.existsSync(path.join(root, 'journal.jsonl'))) durableWrite(path.join(root, 'journal.jsonl'), '');
      this.manifest = {
        protocol: 4,
        generation: 'initial',
        snapshot: { file: 'state.json', hash: digest(raw), revision: raw.revision },
        journals: ['journal.jsonl'],
      };
      writeJson(path.join(root, 'checkpoint.json'), this.manifest);
    }
    this.records = loaded.manifest ? loaded.records : 0;
    this.journalBytes = loaded.manifest ? loaded.completeBytes : 0;
    this.state.metrics = readJson<State['metrics']>(path.join(root, 'metrics.json')) ?? this.state.metrics;
    this.state.metrics.mutations =
      Object.keys(this.state.requests).length + Object.keys(this.state.archived_requests).length;
  }
  private journal() {
    return inside(this.root, this.manifest.journals.at(-1)!);
  }
  private fail(error: unknown): never {
    this.uncertain = true;
    throw new Fault(
      'REQUEST_UNCERTAIN',
      'Journal/checkpoint delivery is uncertain. Restart and reconcile before dispatch.',
      { reason: (error as Error).message },
    );
  }
  save() {
    invariant(
      !this.uncertain,
      'REQUEST_UNCERTAIN',
      'Storage delivery is uncertain. Restart and reconcile before further mutations.',
    );
    if (this.batching) return;
    for (const id of this.tracker.dirtyRuns) {
      const run = this.tracker.run(id);
      if (run && ['completed', 'cancelled'].includes(run.state)) run.ended_at ??= this.clock();
    }
    for (const id of this.tracker.resources) {
      const run = this.tracker.run(id);
      if (run)
        for (const resource of run.resources) {
          const hash = digest(resource),
            prior = this.state.resource_hashes[resource.resource_key];
          invariant(
            !prior || prior === hash,
            'RESOURCE_PROFILE',
            'The same resource_key must refer to the same profile service-wide.',
          );
          if (!prior) this.state.resource_hashes[resource.resource_key] = hash;
        }
    }
    // Validate newly created/replaced entities. State transition helpers validate individual
    // subsequent fields; a small save never walks all runs, attempts, requests, or event history.
    for (const id of this.tracker.newRuns) {
      const run = this.tracker.run(id);
      if (run) validateStoredRun(run);
    }
    if (!this.tracker.pending.length) return;
    const changes = this.tracker.changes(),
      previous = this.state.revision;
    const record = deltaRecord({ protocol: 4, previous, revision: previous + 1, changes }),
      bytes = Buffer.byteLength(record);
    try {
      const fd = fs.openSync(this.journal(), 'a', 0o600);
      try {
        fs.writeFileSync(fd, record);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.state.revision = previous + 1;
      this.tracker.clear();
      this.records++;
      this.journalBytes += bytes;
      this.lastRecordBytes = bytes;
      this.io.journal_bytes += bytes;
      this.summaryCache = undefined;
      if (!this.checkpointTask && (this.records >= 256 || this.journalBytes >= Math.max(COMPACT_BYTES, bytes * 4)))
        this.startCheckpoint();
    } catch (error) {
      this.fail(error);
    }
  }
  transaction<T>(action: () => T): T {
    this.batching++;
    let succeeded = false;
    try {
      const result = action();
      invariant(!(result instanceof Promise), 'TRANSACTION', 'Storage transactions must be synchronous.');
      succeeded = true;
      return result;
    } catch (error) {
      this.uncertain = true;
      throw error;
    } finally {
      this.batching--;
      if (succeeded && !this.batching) this.save();
    }
  }
  applyChanges(changes: Delta[]) {
    for (const change of changes) {
      if (change.entity === 'counter') {
        this.state.event_seq = change.value;
        continue;
      }
      if (change.entity === 'event') {
        if (change.remove) this.state.events = this.state.events.filter((event) => event.seq !== change.seq);
        else this.state.events.push(change.value as RunEvent);
        continue;
      }
      let target: any;
      if (change.entity === 'run') {
        const run = this.run(change.id);
        if (!change.path.length) {
          if (change.remove) this.state.runs = this.state.runs.filter((run) => run.id !== change.id);
          else this.replaceRun(change.value as Run);
          continue;
        }
        target = run;
      } else {
        const map = this.state[change.entity] as Record<string, unknown>;
        if (!change.path.length) {
          if (change.remove) delete map[change.id];
          else map[change.id] = change.value;
          continue;
        }
        target = map[change.id];
      }
      for (const key of change.path.slice(0, -1)) {
        invariant(
          target && typeof target === 'object' && Object.hasOwn(target, key),
          'STATE_CORRUPT',
          'Patch target is missing.',
        );
        target = target[key];
      }
      const key = change.path.at(-1)!;
      invariant(target && typeof target === 'object', 'STATE_CORRUPT', 'Patch target is missing.');
      if (change.remove) delete target[key];
      else target[key] = change.value;
    }
  }
  replaceRun(run: Run) {
    const current = this.tracker.runs.get(run.id);
    if (!current) this.state.runs.push(run);
    else {
      const index = this.tracker.index(run.id)!;
      this.state.runs[index] = run;
    }
  }
  cloneRun(id: string) {
    const run = this.run(id);
    return run ? (JSON.parse(JSON.stringify(run)) as Run) : undefined;
  }
  private work<T>(data: Record<string, unknown>): Promise<T> {
    const durable = ['checkpoint', 'archive', 'archive_request', 'append_event'].includes(String(data.kind));
    const queue = durable ? this.durableQueue : this.coldQueue;
    invariant(queue.length < 128, 'STORAGE_BUSY', 'Storage helper queue is full; retry this read shortly.');
    const promise = new Promise<T>((resolve, reject) => {
      const start = () => {
        if (durable) this.durableActive++;
        else this.coldActive++;
        this.io.helper_peak = Math.max(this.io.helper_peak, this.durableActive + this.coldActive);
        let answered = false,
          worker: Worker | undefined;
        const release = () => {
          if (durable) this.durableActive--;
          else this.coldActive--;
          queue.shift()?.();
        };
        try {
          worker = new Worker(new URL('./storage-worker.mjs', import.meta.url), {
            workerData: { root: this.root, ...data },
          });
        } catch (error) {
          release();
          reject(error);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Fault('STORAGE_TIMEOUT', 'Owned storage helper exceeded its deadline.'));
          void worker!.terminate();
        }, 120000);
        timer.unref();
        worker.on(
          'message',
          (message: { result?: T; error?: { code: string; message: string; details?: unknown } }) => {
            answered = true;
            if (message.error) reject(new Fault(message.error.code, message.error.message, message.error.details));
            else resolve(message.result as T);
          },
        );
        worker.once('error', reject);
        worker.once('exit', (code) => {
          clearTimeout(timer);
          release();
          if (!answered) reject(new Fault('STORAGE_WORKER', `Storage helper exited before replying (${code}).`));
        });
      };
      if ((durable ? this.durableActive : this.coldActive) < (durable ? 1 : 2)) start();
      else queue.push(start);
    });
    this.helpers.add(promise);
    void promise
      .finally(() => {
        this.helpers.delete(promise);
        this.cleanupRetired();
      })
      .catch(() => {});
    return promise;
  }
  private cleanupRetired() {
    if (this.helpers.size) return;
    for (const relative of this.retired) {
      try {
        fs.unlinkSync(inside(this.root, relative));
        this.retired.delete(relative);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.retired.delete(relative);
      }
    }
  }
  private startCheckpoint() {
    const previous = this.manifest,
      targetRevision = this.state.revision,
      generation = uid('checkpoint'),
      journal = `journals/${generation}.jsonl`,
      output = `checkpoints/${generation}/state.json`;
    // Rotate before the helper starts: its source segments are now immutable. New commits
    // append to the durable tail and are included in both the old and new generation view.
    durableWrite(inside(this.root, journal), '');
    const rotating = { ...previous, generation, journals: [...previous.journals, journal] };
    writeJson(path.join(this.root, 'checkpoint.json'), rotating);
    this.manifest = rotating;
    this.records = 0;
    this.journalBytes = 0;
    this.checkpointTask = this.work<{ hash: string; revision: number }>({
      kind: 'checkpoint',
      manifest: previous,
      output,
    })
      .then((result) => {
        invariant(
          result.revision === targetRevision,
          'STATE_CORRUPT',
          'Checkpoint helper reconstructed a different durable revision.',
        );
        const next: StorageManifest = {
          protocol: 4,
          generation,
          snapshot: { file: output, ...result },
          journals: this.manifest.journals.filter((file) => !previous.journals.includes(file)),
        };
        writeJson(path.join(this.root, 'checkpoint.json'), next);
        this.manifest = next;
        this.io.checkpoints++;
        for (const file of previous.journals) this.retired.add(file);
        if (previous.snapshot.file !== 'state.json') this.retired.add(previous.snapshot.file);
        this.cleanupRetired();
      })
      .catch((error) => {
        this.uncertain = true;
        this.checkpointError = error as Error;
      })
      .finally(() => {
        this.checkpointTask = undefined;
      });
  }
  async flushCheckpoint(force = false) {
    invariant(
      !this.uncertain || !!this.checkpointTask || !!this.checkpointError,
      'REQUEST_UNCERTAIN',
      'Restart and reconcile uncertain storage before checkpointing.',
    );
    if (this.checkpointTask) await this.checkpointTask;
    if (this.checkpointError) this.fail(this.checkpointError);
    if (force || this.records >= 256 || this.journalBytes >= Math.max(COMPACT_BYTES, this.lastRecordBytes * 4)) {
      try {
        this.startCheckpoint();
      } catch (error) {
        this.fail(error);
      }
      await this.checkpointTask;
    }
    if (this.checkpointError) this.fail(this.checkpointError);
  }
  async close() {
    if (this.metricsTimer) {
      clearTimeout(this.metricsTimer);
      this.metricsTimer = undefined;
      this.flushMetrics();
    }
    await this.flushCheckpoint();
    await Promise.allSettled([...this.helpers]);
  }
  isArchived(id: string) {
    return Object.hasOwn(this.state.archived_runs, id);
  }
  run(id: string): Run | undefined {
    const current = this.tracker.run(id);
    if (current) return current;
    const ref = this.state.archived_runs[id];
    return ref ? readRunArchive(this.root, id, ref) : undefined;
  }
  async runAsync(id: string): Promise<Run | undefined> {
    const current = this.tracker.run(id);
    if (current) return current;
    const ref = this.state.archived_runs[id];
    return ref ? this.work<Run>({ kind: 'run', id, ref: JSON.parse(JSON.stringify(ref)) }) : undefined;
  }
  events(id: string, after = 0, limit = Number.MAX_SAFE_INTEGER) {
    const ref = this.state.archived_runs[id];
    return ref ? readArchiveEvents(this.root, id, ref, after, limit) : this.hotEvents(id, after, limit);
  }
  private hotEvents(id: string, after: number, limit: number) {
    const events = this.tracker.eventsByRun.get(id) ?? [];
    let low = 0,
      high = events.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (events[middle]!.seq <= after) low = middle + 1;
      else high = middle;
    }
    return events.slice(low, low + limit);
  }
  async eventsAsync(id: string, after = 0, limit = 128): Promise<RunEvent[]> {
    const ref = this.state.archived_runs[id];
    return ref
      ? this.work<RunEvent[]>({ kind: 'events', id, ref: JSON.parse(JSON.stringify(ref)), after, limit })
      : this.events(id, after, limit);
  }
  eventCursor(id: string) {
    return this.state.archived_runs[id]?.summary.event_cursor ?? this.tracker.eventsByRun.get(id)?.at(-1)?.seq ?? 0;
  }
  private buildSummaries() {
    return [
      ...this.state.runs.map((run) => ({ ...this.summary(run), archived: false, archived_at: null })),
      ...Object.values(this.state.archived_runs).map((ref) => ({
        ...ref.summary,
        archived: true,
        archived_at: ref.archived_at,
      })),
    ].sort((a, b) => a.created - b.created || a.run_id.localeCompare(b.run_id));
  }
  summaries() {
    return (this.summaryCache ??= this.buildSummaries());
  }
  summary(run: Run): RunSummary {
    return {
      run_id: run.id,
      repo: run.repo,
      branch: run.branch,
      state: run.state,
      revision: run.revision,
      tasks: run.tasks.length,
      created: run.created,
      ended_at: run.ended_at,
      event_cursor: this.eventCursor(run.id),
    };
  }
  request(id: string): RequestRecord | undefined {
    if (Object.hasOwn(this.state.requests, id)) return this.state.requests[id];
    const ref = this.state.archived_requests[id];
    if (!ref) return;
    const value = readVerified<{ id: string; request: RequestRecord }>(this.root, ref);
    invariant(
      value.id === id && value.request.status === 'done',
      'STATE_CORRUPT',
      'Archived request identity mismatch.',
    );
    return value.request;
  }
  async requestAsync(id: string): Promise<RequestRecord | undefined> {
    if (Object.hasOwn(this.state.requests, id)) return this.state.requests[id];
    const ref = this.state.archived_requests[id];
    if (!ref) return;
    const value = await this.work<{ id: string; request: RequestRecord }>({
      kind: 'request',
      ref: JSON.parse(JSON.stringify(ref)),
    });
    invariant(
      value.id === id && value.request.status === 'done',
      'STATE_CORRUPT',
      'Archived request identity mismatch.',
    );
    return value.request;
  }
  event(run_id: string, type: string, data: unknown) {
    const event = { seq: this.state.event_seq + 1, run_id, type, data };
    const ref = this.state.archived_runs[run_id];
    if (ref) {
      const next = appendArchiveEvent(this.root, run_id, ref, event);
      this.state.archived_runs[run_id] = { ...next, summary: { ...ref.summary, event_cursor: event.seq } };
    } else this.state.events.push(event);
    this.state.event_seq = event.seq;
    this.save();
  }
  async prepareArchivedEvent(id: string, type: string, data: unknown, seq: number) {
    const ref = this.state.archived_runs[id];
    invariant(ref, 'NOT_FOUND', 'Archived run is missing.');
    invariant(
      Number.isSafeInteger(seq) && seq > ref.summary.event_cursor && seq <= this.state.event_seq,
      'STATE_CORRUPT',
      'Archived event sequence was not durably reserved.',
    );
    const captured = JSON.parse(JSON.stringify(ref)) as typeof ref,
      event = { seq, run_id: id, type, data };
    const next = await this.work<ArchiveRef>({ kind: 'append_event', id, ref: captured, event });
    return { id, previous: captured, ref: next, seq };
  }
  commitArchivedEvent(prepared: {
    id: string;
    previous: ArchiveRef & { summary: RunSummary };
    ref: ArchiveRef;
    seq: number;
  }) {
    const current = this.state.archived_runs[prepared.id];
    invariant(
      current && current.hash === prepared.previous.hash && current.file === prepared.previous.file,
      'REQUEST_UNCERTAIN',
      'Archive changed before event publication; retry after reconciliation.',
    );
    this.state.archived_runs[prepared.id] = {
      ...prepared.ref,
      summary: { ...current.summary, event_cursor: prepared.seq },
    };
    this.save();
  }
  private blockedArchives() {
    const preparations = path.join(this.root, 'submissions'),
      blocked = new Set<string>();
    if (fs.existsSync(preparations))
      for (const name of fs.readdirSync(preparations)) {
        const manifest = readJson<{ run_id: string }>(inside(preparations, `${name}/manifest.json`));
        if (!manifest) return;
        blocked.add(manifest.run_id);
      }
    for (const op of Object.values(this.state.operations)) if (op.run_id) blocked.add(op.run_id);
    return blocked;
  }
  async prepareArchive(): Promise<PreparedArchive | undefined> {
    invariant(!this.uncertain, 'REQUEST_UNCERTAIN', 'Reconcile storage before archiving.');
    const cutoff = this.clock() - ARCHIVE_AGE,
      blocked = this.blockedArchives();
    if (!blocked) return;
    for (const run of this.state.runs) {
      if (
        !['completed', 'cancelled'].includes(run.state) ||
        run.ended_at === undefined ||
        run.ended_at > cutoff ||
        blocked.has(run.id) ||
        !(await attemptsStopped(run))
      )
        continue;
      const id = run.id,
        source = this.tracker.unwrap(run),
        version = this.tracker.runVersions.get(id) ?? 0,
        cursor = this.eventCursor(id),
        summary = this.summary(run);
      const limits = Object.fromEntries(
        this.manifest.journals.map((file) => [file, fs.statSync(inside(this.root, file)).size]),
      );
      const ref = await this.work<ArchiveRef>({
        kind: 'archive',
        id,
        manifest: this.manifest,
        limits,
        at: this.clock(),
      });
      return { kind: 'run', id, source, version, cursor, summary, ref };
    }
    for (const [id, request] of Object.entries(this.state.requests)) {
      if (
        request.status !== 'done' ||
        request.completed_at === undefined ||
        request.completed_at > cutoff ||
        fs.existsSync(path.join(this.root, 'submissions', id))
      )
        continue;
      const version = this.tracker.mapVersions.get(`requests:${id}`) ?? 0;
      const limits = Object.fromEntries(
        this.manifest.journals.map((file) => [file, fs.statSync(inside(this.root, file)).size]),
      );
      const ref = await this.work<ArchiveRef>({
        kind: 'archive_request',
        id,
        manifest: this.manifest,
        limits,
        at: this.clock(),
      });
      return { kind: 'request', id, source: this.tracker.unwrap(request), version, ref };
    }
  }
  commitArchive(prepared: PreparedArchive): boolean {
    invariant(!this.uncertain, 'REQUEST_UNCERTAIN', 'Reconcile storage before archiving.');
    if (prepared.kind === 'run') {
      const blocked = this.blockedArchives();
      if (!blocked) return false;
      const run = this.tracker.runs.get(prepared.id);
      if (
        run !== prepared.source ||
        (this.tracker.runVersions.get(prepared.id) ?? 0) !== prepared.version ||
        this.eventCursor(prepared.id) !== prepared.cursor ||
        blocked.has(prepared.id)
      )
        return false;
      this.state.archived_runs[prepared.id] = { ...prepared.ref, summary: prepared.summary! };
      this.state.runs = this.state.runs.filter((r) => r.id !== prepared.id);
      this.state.events = this.state.events.filter((event) => event.run_id !== prepared.id);
    } else {
      if (
        this.tracker.unwrap(this.state.requests[prepared.id]) !== prepared.source ||
        (this.tracker.mapVersions.get(`requests:${prepared.id}`) ?? 0) !== prepared.version ||
        fs.existsSync(path.join(this.root, 'submissions', prepared.id))
      )
        return false;
      this.state.archived_requests[prepared.id] = prepared.ref;
      delete this.state.requests[prepared.id];
    }
    this.save();
    return true;
  }
  async archiveNext() {
    const prepared = await this.prepareArchive();
    return prepared ? this.commitArchive(prepared) : false;
  }
  async mutation(id: string, payload: unknown, action: () => Promise<unknown>) {
    invariant(
      !this.uncertain,
      'REQUEST_UNCERTAIN',
      'Storage delivery is uncertain. Restart and reconcile before changing state.',
    );
    const key = digest(payload),
      prior = await this.requestAsync(id);
    if (prior) {
      invariant(prior.hash === key, 'IDEMPOTENCY_CONFLICT', 'Request ID was already used with different content.');
      invariant(
        prior.status === 'done',
        'REQUEST_UNCERTAIN',
        'Previous request intent exists; reconcile state before issuing a new request.',
      );
      return prior.result;
    }
    this.state.requests[id] = { hash: key, status: 'intent' };
    this.state.metrics.mutations++;
    this.save();
    let result;
    try {
      result = await action();
    } catch (error) {
      if (this.uncertain || (error instanceof Fault && error.code === 'REQUEST_UNCERTAIN')) throw error;
      result = {
        error: {
          code: error instanceof Fault ? error.code : 'INTERNAL',
          message: (error as Error).message,
          ...(error instanceof Fault && error.details !== undefined ? { details: error.details } : {}),
        },
      };
    }
    this.state.requests[id] = { hash: key, status: 'done', result, completed_at: this.clock() };
    try {
      this.save();
    } catch (error) {
      this.state.requests[id] = { hash: key, status: 'intent' };
      throw error;
    }
    return result;
  }
  artifact(run: string, name: string, content: string | Buffer) {
    const id = `${run}/${uid('artifact')}-${name}`;
    durableWrite(inside(path.join(this.root, 'artifacts'), id), content);
    return id;
  }
  artifactPage(id: string, offset: number, limit: number) {
    invariant(
      Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0,
      'CURSOR',
      'Invalid artifact byte range.',
    );
    const fd = fs.openSync(inside(path.join(this.root, 'artifacts'), id), 'r');
    try {
      const before = fs.fstatSync(fd),
        total = before.size;
      invariant(offset <= total, 'CURSOR', 'Offset is past the end.');
      const count = Math.min(total - offset, Math.min(limit, 16384) + 4),
        data = Buffer.alloc(count);
      let read = 0;
      while (read < count) {
        const bytes = fs.readSync(fd, data, read, count - read, offset + read);
        if (!bytes) break;
        read += bytes;
        this.io.artifact_read_bytes += bytes;
      }
      const after = fs.fstatSync(fd);
      invariant(
        read === count &&
          before.size === after.size &&
          before.mtimeMs === after.mtimeMs &&
          before.ctimeMs === after.ctimeMs,
        'ARTIFACT_CHANGED',
        'Artifact changed during the byte-range read; retry after the writer finishes.',
      );
      invariant(
        offset === 0 || offset === total || (data[0]! & 0xc0) !== 0x80,
        'CURSOR',
        'Offset must be a UTF-8 boundary.',
      );
      let end = Math.min(read, Math.min(limit, 16384));
      const make = () => ({
        artifact_id: id,
        offset,
        next_offset: offset + end < total ? offset + end : null,
        total_bytes: total,
        text: data.subarray(0, end).toString('utf8'),
      });
      while (end > 0 && offset + end < total && (data[end]! & 0xc0) === 0x80) end--;
      while (responseBytes(make()) > 16300 && end > 0) {
        end--;
        while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
      }
      if (!end && offset < total) {
        end = 1;
        while (end < read && (data[end]! & 0xc0) === 0x80) end++;
      }
      return make();
    } finally {
      fs.closeSync(fd);
    }
  }
  async getRunPageAsync(id: string, cursor?: string) {
    const ref = this.state.archived_runs[id];
    if (!ref) return;
    const start = cursor ? Number(cursor) : 0;
    invariant(Number.isSafeInteger(start) && start >= 0 && start <= ref.summary.tasks, 'CURSOR', 'Invalid cursor.');
    // One page-sized set of task metadata/latest attempts, never the complete run history.
    const { run, total } = await this.work<{ run: Run; total: number }>({
      kind: 'run_page',
      id,
      ref: JSON.parse(JSON.stringify(ref)),
      start,
      count: 16,
    });
    const items = run.tasks.map((task) => {
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
          backend: a.worker?.backend,
          backend_version: a.worker?.backend_version,
          runtime: publicRuntime(a.worker?.runtime ?? a.execution?.runtime),
          runtime_error: a.runtime_error,
          verification: a.verification,
          artifacts: a.artifacts,
          inputs: a.inputs,
          error: a.error,
          integrated_commit: a.integrated_commit,
        },
      };
    });
    const page = this.page(items, undefined, {
      run_id: id,
      state: run.state,
      revision: run.revision,
      base: run.base,
      integration_commit: run.integration_commit,
      worker: publicWorker(run.worker),
      ended_at: run.ended_at,
      archived: true,
      archived_at: ref.archived_at,
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
      event_cursor: ref.summary.event_cursor,
    });
    const consumed = page.next_cursor ? Number(page.next_cursor) : items.length;
    page.next_cursor = start + consumed < total ? String(start + consumed) : null;
    return page;
  }
  private flushMetrics() {
    try {
      writeJson(path.join(this.root, 'metrics.json'), this.state.metrics);
    } catch (error) {
      process.stderr.write(`metrics: ${(error as Error).message}\n`);
    }
  }
  page(items: unknown[], cursor?: string, extra: Record<string, unknown> = {}, budget = 3900) {
    const start = cursor ? Number(cursor) : 0;
    invariant(Number.isSafeInteger(start) && start >= 0 && start <= items.length, 'CURSOR', 'Invalid cursor.');
    const result: { items: unknown[]; next_cursor: string | null; [key: string]: unknown } = {
      ...extra,
      items: [],
      next_cursor: null,
    };
    for (let i = start; i < items.length; i++) {
      result.items.push(items[i]);
      result.next_cursor = i + 1 < items.length ? String(i + 1) : null;
      if (responseBytes(result) > budget) {
        result.items.pop();
        result.next_cursor = String(i);
        if (!result.items.length) {
          const artifact = this.artifact('responses', 'entry.json', JSON.stringify(items[i]));
          result.items.push({ artifact_id: artifact });
          result.next_cursor = i + 1 < items.length ? String(i + 1) : null;
        }
        break;
      }
    }
    return result;
  }
  bounded(value: unknown, budget = 4000, count = true) {
    let result = value;
    if (responseBytes(value) > budget) {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      const artifact = this.artifact('responses', 'response.json', JSON.stringify(value));
      result = {
        artifact_id: artifact,
        total_bytes: bytes,
        message: 'Read the complete structured response with get_artifact.',
      };
    }
    if (count) {
      this.state.metrics.responses++;
      this.state.metrics.response_bytes += responseBytes(result);
      if (!this.metricsTimer) {
        this.metricsTimer = setTimeout(() => {
          this.metricsTimer = undefined;
          this.flushMetrics();
        }, 1000);
        this.metricsTimer.unref();
      }
    }
    return result;
  }
}
