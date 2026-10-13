import { HttpBackend } from './http.js';
import { CodexBackend } from './codex.js';
import { ClaudeBackend } from './claude.js';
import type { BackendContext, WorkerBackend } from './contract.js';
export function createBackend(context:BackendContext):WorkerBackend {
  switch(context.spec.worker?.platform??'opencode') {
    case 'codex':return new CodexBackend(context);
    case 'claude-code':return new ClaudeBackend(context);
    default:return new HttpBackend(context);
  }
}
export type { WorkerBackend, BackendContext, Answer, Observation } from './contract.js';
