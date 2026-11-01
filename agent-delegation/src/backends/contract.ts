import type { InputDecision, InputRequest, WorkerSpec, WorkerState } from '../types.js';

export type Observation = {
  accepted: boolean;
  complete: boolean;
  inputs: InputRequest[];
  transcript: unknown;
  summary?: string;
  usage?: unknown;
  error?: string;
  reply_confirmations?: string[];
};
export type Answer = { decision: InputDecision; answers?: string[][] };
export type BackendContext = {
  spec: WorkerSpec;
  state: WorkerState;
  save: () => void;
  // For periodic refreshes: writes a real change at once and otherwise at a bounded rate.
  refresh?: () => void;
};
export interface WorkerBackend {
  start(): Promise<void>;
  createSession(): Promise<void>;
  dispatch(prompt: string, requestID: string): Promise<void>;
  observe(): Promise<Observation>;
  reply(input: InputRequest, answer: Answer): Promise<'sent' | 'uncertain'>;
  cancel(): Promise<void>;
  confirmStopped(): Promise<boolean>;
}
