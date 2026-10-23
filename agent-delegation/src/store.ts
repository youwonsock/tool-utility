import fs from 'node:fs';
import path from 'node:path';
import { STORE_FORMAT, Fault, invariant, type State, type Run, type RunArchive, type ArchiveRef, type RequestRecord, type RunSummary } from './types.js';
import { digest, mkdir, readJson, writeJson, durableWrite, uid, inside } from './io.js';
import { validateStoredState } from './lifecycle.js';
import { ARCHIVE_AGE, emptyState, journalRecord, loadState, attemptsStopped } from './persistence.js';

export const responseBytes = (value: unknown) => Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }));

export class Store {
  state: State;
  uncertain = false;
  private records = 0;
  private journalBytes = 0;
  constructor(public root: string, public clock: () => number = Date.now) {
    mkdir(root);
    invariant(!fs.existsSync(path.join(root, 'migration.json')), 'UPDATE_PENDING', 'Resume storage migration before opening the store.');
    const loaded = loadState(root);
    this.state = loaded.state ?? emptyState();
    invariant(this.state.protocol === STORE_FORMAT, 'UPDATE_PENDING', 'Storage migration is required; start the new service after stopping the previous release.');
    validateStoredState(this.state);
    for (const key of ['requests','archived_runs','archived_requests','resource_hashes'] as const) {
      this.state[key] = Object.assign(Object.create(null), this.state[key]);
    }
    if (loaded.bytes !== loaded.completeBytes) {
      const fd = fs.openSync(path.join(root, 'journal.jsonl'), 'r+');
      try { fs.ftruncateSync(fd, loaded.completeBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    this.records = loaded.records; this.journalBytes = loaded.completeBytes;
    this.state.metrics = readJson<State['metrics']>(path.join(root, 'metrics.json')) ?? this.state.metrics;
    this.state.metrics.mutations = Object.keys(this.state.requests).length + Object.keys(this.state.archived_requests).length;
  }
  save() {
    invariant(!this.uncertain, 'REQUEST_UNCERTAIN', 'Storage delivery is uncertain. Restart and reconcile before further mutations.');
    for (const run of this.state.runs) {
      if (['completed','cancelled'].includes(run.state)) run.ended_at ??= this.clock();
      for (const resource of run.resources) {
        const hash = digest(resource), prior = this.state.resource_hashes[resource.resource_key];
        invariant(!prior || prior === hash, 'RESOURCE_PROFILE', 'The same resource_key must refer to the same profile service-wide.');
        this.state.resource_hashes[resource.resource_key] = hash;
      }
    }
    validateStoredState(this.state);
    this.state.revision++;
    try {
      const record = journalRecord(this.state), bytes = Buffer.byteLength(record);
      const fd = fs.openSync(path.join(this.root, 'journal.jsonl'), 'a', 0o600);
      try { fs.writeFileSync(fd, record); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.records++; this.journalBytes += bytes;
      writeJson(path.join(this.root, 'state.json'), this.state);
      if (this.records >= 256 || this.journalBytes >= Math.max(32 * 1024 * 1024, bytes * 4)) {
        durableWrite(path.join(this.root, 'journal.jsonl'), record);
        this.records = 1; this.journalBytes = bytes;
      }
    } catch (e) {
      this.uncertain = true;
      throw new Fault('REQUEST_UNCERTAIN', 'Journal/snapshot/checkpoint delivery is uncertain. Restart and reconcile before dispatch.', { reason: (e as Error).message });
    }
  }
  isArchived(id: string) { return Object.hasOwn(this.state.archived_runs, id); }
  private readArchive<T>(ref: ArchiveRef): T {
    try {
      const value = readJson<T>(inside(this.root, ref.file));
      invariant(value && digest(value) === ref.hash, 'STATE_CORRUPT', 'Archived record is missing or corrupt.');
      return value;
    } catch (e) { throw new Fault('STATE_CORRUPT', 'Archived record could not be verified.', { file: ref.file, reason: (e as Error).message }); }
  }
  private writeArchive(kind: 'runs' | 'requests', id: string, value: unknown, archived_at = this.clock()): ArchiveRef {
    const hash = digest(value), file = `archives/${kind}/${digest(id)}/${hash}.json`;
    writeJson(inside(this.root, file), value);
    return { file, hash, archived_at };
  }
  run(id: string): Run | undefined {
    const current = this.state.runs.find(r => r.id === id); if (current) return current;
    const ref = this.state.archived_runs[id]; if (!ref) return undefined;
    const archive = this.readArchive<RunArchive>(ref);
    invariant(archive.protocol === STORE_FORMAT && archive.run.id === id, 'STATE_CORRUPT', 'Archive identity mismatch.');
    return archive.run;
  }
  events(id: string) {
    const ref = this.state.archived_runs[id];
    return ref ? this.readArchive<RunArchive>(ref).events : this.state.events.filter(e => e.run_id === id);
  }
  summaries() {
    return [...this.state.runs.map(run => ({ ...this.summary(run), archived: false, archived_at: null })),
      ...Object.values(this.state.archived_runs).map(ref => ({ ...ref.summary, archived: true, archived_at: ref.archived_at }))]
      .sort((a,b) => a.created - b.created || a.run_id.localeCompare(b.run_id));
  }
  summary(run: Run): RunSummary {
    return { run_id: run.id, repo: run.repo, branch: run.branch, state: run.state, revision: run.revision,
      tasks: run.tasks.length, created: run.created, ended_at: run.ended_at, event_cursor: this.state.events.filter(e => e.run_id === run.id).at(-1)?.seq ?? 0 };
  }
  request(id: string): RequestRecord | undefined {
    if (Object.hasOwn(this.state.requests, id)) return this.state.requests[id];
    const ref = this.state.archived_requests[id]; if (!ref) return undefined;
    const archive = this.readArchive<{ id: string; request: RequestRecord }>(ref);
    invariant(archive.id === id && archive.request.status === 'done', 'STATE_CORRUPT', 'Archived request identity mismatch.');
    return archive.request;
  }
  event(run_id: string, type: string, data: unknown) {
    const event = { seq: this.state.event_seq + 1, run_id, type, data };
    const ref = this.state.archived_runs[run_id];
    if (ref) {
      const archive = this.readArchive<RunArchive>(ref); archive.events.push(event);
      const next = this.writeArchive('runs', run_id, archive, ref.archived_at);
      this.state.archived_runs[run_id] = { ...next, summary: { ...ref.summary, event_cursor: event.seq } };
    } else this.state.events.push(event);
    this.state.event_seq = event.seq; this.save();
  }
  // Called only on the engine's serialized queue. One durable move per scheduler tick.
  async archiveNext(): Promise<boolean> {
    invariant(!this.uncertain, 'REQUEST_UNCERTAIN', 'Reconcile storage before archiving.');
    const cutoff = this.clock() - ARCHIVE_AGE;
    const preparations = path.join(this.root, 'submissions');
    const blocked = new Set<string>();
    if (fs.existsSync(preparations)) for (const name of fs.readdirSync(preparations)) {
      const manifest = readJson<{ run_id: string }>(inside(preparations, `${name}/manifest.json`));
      // Missing manifests can hide ownership; retain everything until submission recovery resolves them.
      if (!manifest) return false; blocked.add(manifest.run_id);
    }
    for (const run of this.state.runs) {
      if (!['completed','cancelled'].includes(run.state) || run.ended_at === undefined || run.ended_at > cutoff || blocked.has(run.id) || !await attemptsStopped(run)) continue;
      const summary = this.summary(run), events = this.events(run.id);
      const ref = this.writeArchive('runs', run.id, { protocol: STORE_FORMAT, run, events } satisfies RunArchive);
      this.state.archived_runs[run.id] = { ...ref, summary };
      this.state.runs = this.state.runs.filter(r => r !== run);
      this.state.events = this.state.events.filter(e => e.run_id !== run.id);
      this.save(); return true;
    }
    for (const [id, request] of Object.entries(this.state.requests)) {
      if (request.status !== 'done' || request.completed_at === undefined || request.completed_at > cutoff || fs.existsSync(path.join(preparations,id))) continue;
      const ref = this.writeArchive('requests', id, { id, request });
      this.state.archived_requests[id] = ref; delete this.state.requests[id];
      this.save(); return true;
    }
    return false;
  }
  async mutation(id: string, payload: unknown, action: () => Promise<unknown>) {
    invariant(!this.uncertain, 'REQUEST_UNCERTAIN', 'Storage delivery is uncertain. Restart and reconcile before changing state.');
    const key = digest(payload); const prior = this.request(id);
    if (prior) {
      invariant(prior.hash === key, 'IDEMPOTENCY_CONFLICT', 'Request ID was already used with different content.');
      invariant(prior.status === 'done', 'REQUEST_UNCERTAIN', 'Previous request intent exists; reconcile state before issuing a new request.');
      return prior.result;
    }
    this.state.requests[id] = { hash: key, status: 'intent' }; this.state.metrics.mutations++; this.save();
    let result;
    try { result = await action(); } catch (e) {
      if (this.uncertain || e instanceof Fault && e.code === 'REQUEST_UNCERTAIN') throw e;
      result = { error: { code: e instanceof Fault ? e.code : 'INTERNAL', message: (e as Error).message, ...(e instanceof Fault && e.details !== undefined ? { details: e.details } : {}) } };
    }
    this.state.requests[id] = { hash: key, status: 'done', result, completed_at: this.clock() };
    try { this.save(); } catch (e) { this.state.requests[id] = { hash: key, status: 'intent' }; throw e; }
    return result;
  }
  artifact(run: string, name: string, content: string | Buffer) {
    const id = `${run}/${uid('artifact')}-${name}`;
    durableWrite(inside(path.join(this.root, 'artifacts'), id), content); return id;
  }
  artifactPage(id: string, offset: number, limit: number) {
    const data = fs.readFileSync(inside(path.join(this.root, 'artifacts'), id));
    invariant(offset <= data.length, 'CURSOR', 'Offset is past the end.');
    // Byte offsets; back up to a UTF-8 boundary. JSON overhead is included in the page budget.
    invariant(offset === 0 || offset === data.length || (data[offset]! & 0xc0) !== 0x80, 'CURSOR', 'Offset must be a UTF-8 boundary.');
    let end = Math.min(data.length, offset + Math.min(limit, 16384));
    end = Math.max(offset, end);
    const make = () => ({ artifact_id: id, offset, next_offset: end < data.length ? end : null, total_bytes: data.length, text: data.subarray(offset, end).toString('utf8') });
    while (end > offset && end < data.length && (data[end]! & 0xc0) === 0x80) end--;
    while (responseBytes(make()) > 16300 && end > offset) { end--; while (end > offset && (data[end]! & 0xc0) === 0x80) end--; }
    if (end === offset && offset < data.length) { end = offset + 1; while (end < data.length && (data[end]! & 0xc0) === 0x80) end++; }
    return make();
  }
  page(items: unknown[], cursor?: string, extra: Record<string, unknown> = {}, budget = 3900) {
    const start = cursor ? Number(cursor) : 0;
    invariant(Number.isSafeInteger(start) && start >= 0 && start <= items.length, 'CURSOR', 'Invalid cursor.');
    const result: { items: unknown[]; next_cursor: string | null; [key: string]: unknown } = { ...extra, items: [], next_cursor: null };
    for (let i = start; i < items.length; i++) {
      result.items.push(items[i]); result.next_cursor = i + 1 < items.length ? String(i + 1) : null;
      if (responseBytes(result) > budget) {
        result.items.pop(); result.next_cursor = String(i);
        if (!result.items.length) {
          const artifact = this.artifact('responses', 'entry.json', JSON.stringify(items[i])); result.items.push({ artifact_id: artifact }); result.next_cursor = i + 1 < items.length ? String(i + 1) : null;
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
      result = { artifact_id: artifact, total_bytes: bytes, message: 'Read the complete structured response with get_artifact.' };
    }
    if (count) {
      this.state.metrics.responses++; this.state.metrics.response_bytes += responseBytes(result);
      writeJson(path.join(this.root, 'metrics.json'), this.state.metrics);
    }
    return result;
  }
}
