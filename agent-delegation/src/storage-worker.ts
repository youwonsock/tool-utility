import { parentPort, workerData } from 'node:worker_threads';
import { loadState } from './persistence.js';
import { digest, inside, writeJson } from './io.js';
import { invariant } from './types.js';
import {
  readRunArchive,
  readArchiveEvents,
  readVerified,
  writeChunkedArchive,
  readArchiveTaskPage,
  appendArchiveEvent,
} from './storage-archives.js';

// This owned worker reads a stable durable cut; the control thread never clones a full state for it.
try {
  const { kind, root } = workerData;
  let result: unknown;
  if (kind === 'checkpoint') {
    const state = loadState(root, workerData.manifest).state;
    invariant(state, 'STATE_CORRUPT', 'Checkpoint input is missing.');
    writeJson(inside(root, workerData.output), state);
    result = { hash: digest(state), revision: state.revision };
  } else if (kind === 'archive') {
    const state = loadState(root, workerData.manifest, workerData.limits).state;
    const run = state?.runs.find((r) => r.id === workerData.id);
    invariant(run, 'STATE_CORRUPT', 'Archive candidate is missing.');
    result = writeChunkedArchive(
      root,
      run.id,
      run,
      state!.events.filter((e) => e.run_id === run.id),
      workerData.at,
    );
  } else if (kind === 'archive_request') {
    const state = loadState(root, workerData.manifest, workerData.limits).state;
    const request = state?.requests[workerData.id];
    invariant(request?.status === 'done', 'STATE_CORRUPT', 'Archive request is missing.');
    const value = { id: workerData.id, request },
      hash = digest(value),
      file = `archives/requests/${digest(workerData.id)}/${hash}.json`;
    writeJson(inside(root, file), value);
    result = { file, hash, archived_at: workerData.at };
  } else if (kind === 'run') result = readRunArchive(root, workerData.id, workerData.ref);
  else if (kind === 'events')
    result = readArchiveEvents(root, workerData.id, workerData.ref, workerData.after, workerData.limit);
  else if (kind === 'request') result = readVerified(root, workerData.ref);
  else if (kind === 'append_event') result = appendArchiveEvent(root, workerData.id, workerData.ref, workerData.event);
  else if (kind === 'run_page')
    result = readArchiveTaskPage(root, workerData.id, workerData.ref, workerData.start, workerData.count);
  else throw new Error('Unknown storage helper operation.');
  parentPort!.postMessage({ result });
} catch (error) {
  parentPort!.postMessage({
    error: {
      message: (error as Error).message,
      code: (error as any).code ?? 'STORAGE_WORKER',
      details: (error as any).details,
    },
  });
}
