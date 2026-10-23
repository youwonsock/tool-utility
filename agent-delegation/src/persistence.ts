import fs from 'node:fs';
import path from 'node:path';
import { STORE_FORMAT, Fault, invariant, type State, type Run, type Attempt } from './types.js';
import { digest, mkdir, readJson, writeJson, durableWrite, alive, treeAlive, inside } from './io.js';
import { holdsResources, validateStoredState } from './lifecycle.js';
import { processEvidence } from './backends/process.js';

export const ARCHIVE_AGE = 7 * 24 * 60 * 60 * 1000;
export const emptyState = (): State => ({ protocol: STORE_FORMAT, revision: 0, runs: [], requests: {}, events: [], event_seq: 0,
  archived_runs: {}, archived_requests: {}, resource_hashes: {}, metrics: { responses: 0, response_bytes: 0, mutations: 0 } });
export const journalRecord = (state: State) => `${JSON.stringify({ hash: digest(state), state })}\n`;
export const runAttempts = (run: Run): Attempt[] => [...run.tasks.flatMap(t => t.attempts),
  ...(run.validation ? [run.validation.attempt] : []), ...(run.validation_history ?? []).map(v => v.attempt)];

// Bounded input buffers; only one complete record is parsed at a time. Never repair during inspection/migration backup.
export function loadState(root: string) {
  let state = readJson<State>(path.join(root, 'state.json'));
  const journal = path.join(root, 'journal.jsonl');
  let records = 0, completeBytes = 0, bytes = 0;
  if (fs.existsSync(journal)) {
    const fd = fs.openSync(journal, 'r');
    const buffer = Buffer.alloc(64 * 1024); let pending: Buffer[] = [];
    try {
      for (;;) {
        const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
        bytes += count; let start = 0;
        for (let i = 0; i < count; i++) if (buffer[i] === 10) {
          pending.push(Buffer.from(buffer.subarray(start, i)));
          const line = Buffer.concat(pending); completeBytes += line.length + 1; pending = []; start = i + 1;
          if (!line.length) continue;
          let item: { hash: string; state: State };
          try { item = JSON.parse(line.toString('utf8')); } catch { throw new Fault('JOURNAL_CORRUPT', 'A complete journal record is invalid JSON.'); }
          invariant(item.state && item.hash === digest(item.state), 'JOURNAL_CORRUPT', 'A committed journal record failed its checksum.');
          invariant([2, STORE_FORMAT].includes(item.state.protocol), 'UPDATE_PENDING', 'Journal contains an unsupported storage format.');
          // Migration may have published format 3 before replacing the format-2 snapshot.
          if (!state || item.state.revision > state.revision) state = item.state;
          records++;
        }
        if (start < count) pending.push(Buffer.from(buffer.subarray(start, count)));
      }
    } finally { fs.closeSync(fd); }
  }
  return { state, records, bytes, completeBytes };
}

export async function attemptsStopped(run: Run): Promise<boolean> {
  for (const attempt of runAttempts(run)) {
    if (holdsResources(attempt)) return false;
    const worker = readJson<Attempt['worker']>(path.join(attempt.job_dir, 'worker.json')) ?? attempt.worker;
    const launch = readJson<{ host?: NonNullable<Attempt['worker']>['host'] }>(path.join(attempt.job_dir, 'launch.json'));
    const started = readJson<{ host?: NonNullable<Attempt['worker']>['host'] }>(path.join(attempt.job_dir, 'started.json'));
    const evidence = processEvidence(attempt.job_dir, worker ?? { } as NonNullable<Attempt['worker']>);
    if (evidence.uncertain || worker && (!worker.stopped || worker.phase === 'stop_uncertain')) return false;
    const identities = [...evidence.identities, ...(worker?.processes ?? []), ...(worker?.server ? [worker.server] : [])];
    if (await alive(worker?.host ?? started?.host ?? launch?.host)) return false;
    if ((await Promise.all(identities.map(treeAlive))).some(Boolean)) return false;
    if (!worker && fs.existsSync(path.join(attempt.job_dir, 'server-intent.json')) && !evidence.ledger) return false;
  }
  return true;
}

type Migration = { from: 2; to: 3; backup: string; at: number; target_hash: string };
export async function prepareStorage(root: string, now = Date.now()) {
  mkdir(root);
  const markerPath = path.join(root, 'migration.json');
  let marker = readJson<Migration>(markerPath);
  const loaded = loadState(root);
  if (!marker && loaded.state?.protocol !== 2) return;
  const descriptor = readJson<{ owner?: Parameters<typeof alive>[0] }>(path.join(root, 'service.json'));
  invariant(!await alive(descriptor?.owner), 'UPDATE_PENDING', 'Stop the previous service before storage migration.');
  if (!marker) {
    const legacy = loaded.state!;
    invariant((await Promise.all(legacy.runs.map(attemptsStopped))).every(Boolean), 'UPDATE_PENDING', 'Finish/cancel owned attempts with the previous release before storage migration.');
    const target: State = { ...legacy, protocol: STORE_FORMAT, revision: legacy.revision + 1,
      event_seq: legacy.events.reduce((seq, event) => Math.max(seq, event.seq), 0), archived_runs: {}, archived_requests: {}, resource_hashes: Object.create(null) };
    for (const run of target.runs) {
      if (['completed', 'cancelled'].includes(run.state)) run.ended_at ??= now;
      for (const resource of run.resources) target.resource_hashes[resource.resource_key] = digest(resource);
    }
    for (const request of Object.values(target.requests)) if (request.status === 'done') request.completed_at ??= now;
    validateStoredState(target);
    const backup = `backups/format-2-${now}`; const backupRoot = inside(root, backup); mkdir(backupRoot);
    for (const file of ['state.json', 'journal.jsonl']) if (fs.existsSync(path.join(root, file))) {
      // Stream large journals into a durable backup without loading their history into memory.
      const destination = path.join(backupRoot, file); fs.copyFileSync(path.join(root, file), destination);
      const fd = fs.openSync(destination, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    writeJson(path.join(backupRoot, 'target.json'), target);
    marker = { from: 2, to: 3, backup, at: now, target_hash: digest(target) };
    writeJson(markerPath, marker);
  }
  invariant(marker.from === 2 && marker.to === 3, 'STATE_CORRUPT', 'Unknown migration marker.');
  const target = readJson<State>(inside(root, `${marker.backup}/target.json`));
  invariant(target && digest(target) === marker.target_hash, 'STATE_CORRUPT', 'Migration checkpoint is missing or corrupt.');
  validateStoredState(target);
  if (loaded.state && loaded.state.protocol === STORE_FORMAT) invariant(loaded.state.revision <= target.revision, 'STATE_CORRUPT', 'Migration marker conflicts with a newer state.');
  // Durable intent/backup precede both publications. An interrupted migration repeats only these file writes.
  durableWrite(path.join(root, 'journal.jsonl'), journalRecord(target));
  writeJson(path.join(root, 'state.json'), target);
  fs.unlinkSync(markerPath);
  if (process.platform !== 'win32') {
    const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
