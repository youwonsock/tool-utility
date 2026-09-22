import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL, Fault, invariant, type State } from './types.js';
import { digest, mkdir, readJson, writeJson, durableWrite, uid, inside } from './io.js';

export const responseBytes = (value: unknown) => Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }));

export class Store {
  state: State;
  constructor(public root: string) {
    mkdir(root);
    this.state = readJson<State>(path.join(root, 'state.json')) ?? { protocol: PROTOCOL, revision: 0, runs: [], requests: {}, events: [], metrics: { responses: 0, response_bytes: 0, mutations: 0 } };
    invariant(this.state.protocol === PROTOCOL, 'UPDATE_PENDING', 'Storage format differs. Keep the previous release until its jobs finish.');
    // The durable journal is authoritative if a crash occurred between journal and snapshot.
    const journal = path.join(root, 'journal.jsonl');
    if (fs.existsSync(journal)) {
      const content = fs.readFileSync(journal, 'utf8');
      const complete = content.slice(0, content.lastIndexOf('\n') + 1);
      if (complete.length !== content.length) durableWrite(journal, complete);
      for (const line of complete.split('\n')) {
        if (!line) continue;
        const item = JSON.parse(line) as { hash: string; state: State };
        invariant(item.hash === digest(item.state), 'JOURNAL_CORRUPT', 'A committed journal record failed its checksum.');
        if (item.state.revision > this.state.revision) this.state = item.state;
      }
    }
    invariant(this.state.protocol === PROTOCOL, 'UPDATE_PENDING', 'Journal format differs.');
    this.state.metrics = readJson<State['metrics']>(path.join(root, 'metrics.json')) ?? this.state.metrics;
    this.state.metrics.mutations = Object.keys(this.state.requests).length;
  }
  save() {
    this.state.revision++;
    const fd = fs.openSync(path.join(this.root, 'journal.jsonl'), 'a', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify({ hash: digest(this.state), state: this.state })}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    writeJson(path.join(this.root, 'state.json'), this.state);
  }
  event(run_id: string, type: string, data: unknown) {
    this.state.events.push({ seq: (this.state.events.at(-1)?.seq ?? 0) + 1, run_id, type, data }); this.save();
  }
  async mutation(id: string, payload: unknown, action: () => Promise<unknown>) {
    const key = digest(payload); const prior = this.state.requests[id];
    if (prior) {
      invariant(prior.hash === key, 'IDEMPOTENCY_CONFLICT', 'Request ID was already used with different content.');
      invariant(prior.status === 'done', 'REQUEST_UNCERTAIN', 'Previous request intent exists; reconcile state before issuing a new request.');
      return prior.result;
    }
    this.state.requests[id] = { hash: key, status: 'intent' }; this.state.metrics.mutations++; this.save();
    let result;
    try { result = await action(); } catch (e) {
      result = { error: { code: e instanceof Fault ? e.code : 'INTERNAL', message: (e as Error).message, ...(e instanceof Fault && e.details !== undefined ? { details: e.details } : {}) } };
    }
    this.state.requests[id] = { hash: key, status: 'done', result }; this.save(); return result;
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
