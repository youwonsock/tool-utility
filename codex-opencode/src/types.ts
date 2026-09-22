import { z } from 'zod';

export const PROTOCOL = 1;
export const VERSION = '1.0.0';
export const BASELINE = '1.18.30';
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const commandSchema = z.object({ command: z.string().min(1).max(8192), timeout_ms: z.number().int().min(100).max(3_600_000).default(600_000) }).strict();
export const modelSchema = z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }).strict();
export const resourceSchema = z.object({
  resource_key: idSchema,
  connection: z.object({ name: idSchema, config: z.record(z.unknown()) }).strict(),
  probe: z.object({ executable: z.string().min(1), args: z.array(z.string()), read_only: z.literal(true) }).strict(),
  expected_instance: z.string().min(1),
  project_bound: z.boolean().default(false),
}).strict();
export const taskSchema = z.object({
  id: idSchema, goal: z.string().min(1).max(32000),
  dependencies: z.array(idSchema).default([]),
  scope: z.array(z.string().min(1)).min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  verification: z.array(commandSchema).default([]),
  context_files: z.array(z.string()).default([]),
  resources: z.array(idSchema).default([]), model: modelSchema.optional(),
}).strict();
const request = { request_id: idSchema };
const run = { run_id: idSchema };
const paging = { cursor: z.string().optional() };
export const schemas = {
  doctor: z.object({ repo: z.string().optional(), model: modelSchema.optional() }).strict(),
  submit_tasks: z.object({ ...request, run_id: idSchema.optional(), repo: z.string().optional(), tasks: z.array(taskSchema).min(1).max(100),
    resources: z.array(resourceSchema).default([]), final_verification: z.array(commandSchema).optional(),
    context_files: z.array(z.string()).default([]),
    settings: z.object({ concurrency: z.number().int().min(1).max(16).optional(), timeout_ms: z.number().int().min(1000).max(86_400_000).optional(), max_retries: z.number().int().min(0).max(20).optional() }).strict().optional(),
  }).strict(),
  list_runs: z.object(paging).strict(),
  get_run: z.object({ ...run, ...paging }).strict(),
  wait_run: z.object({ ...run, after: z.number().int().min(0).default(0), timeout_ms: z.number().int().min(0).max(30000).default(30000) }).strict(),
  get_artifact: z.object({ artifact_id: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(16384).default(16384) }).strict(),
  review_task: z.object({ ...request, ...run, task_id: idSchema, attempt_id: idSchema, commit: z.string().optional(), decision: z.enum(['approve', 'request_changes']), feedback: z.string().max(32000).optional() }).strict(),
  respond_to_request: z.object({ ...request, ...run, attempt_id: idSchema, input_id: z.string(), decision: z.enum(['once','always','reject','answer']), answers: z.array(z.array(z.string())).optional() }).strict(),
  reconcile_run: z.object({ ...request, ...run }).strict(),
  cancel_run: z.object({ ...request, ...run }).strict(),
  validate_run: z.object({ ...request, ...run }).strict(),
  finalize_run: z.object({ ...request, ...run, validation_id: idSchema, commit: z.string(), revision: z.number().int().min(1) }).strict(),
};
export type ToolName = keyof typeof schemas;
export type Model = z.infer<typeof modelSchema>;
export type Command = z.infer<typeof commandSchema>;
export type TaskSpec = z.infer<typeof taskSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type Settings = { concurrency: number; timeout_ms: number; max_retries: number };
export type ContextFile = { path: string; hash: string; artifact: string; tracked: boolean; mode: number };
export type ProcessIdentity = { pid: number; birth: string };
export type InputRequest = { id: string; kind: 'permission' | 'question'; details: unknown };
export type Evidence = { command: string; status: 'passed' | 'failed' | 'unknown' | 'cancelled'; exit_code: number | null; artifact: string };
export type WorkerState = {
  protocol: number; id: string; phase: string; updated: number; host?: ProcessIdentity;
  server?: ProcessIdentity; url?: string; session_id?: string; model?: Model;
  prompt_id: string; prompt_intent?: number; prompt_accepted?: boolean;
  verification: Evidence[]; shell_intent?: { index: number; message_id: string; command: string };
  inputs: InputRequest[]; replies: Record<string, 'intent' | 'sent' | 'uncertain'>;
  summary?: string; transcript?: string; usage?: unknown; error?: string; stopped?: boolean;
};
export type WorkerSpec = {
  id: string; directory: string; job_dir: string; goal: string; acceptance: string[];
  verification: Command[]; resources: Resource[]; context: ContextFile[];
  scope: string[]; model?: Model; timeout_ms: number; validation: boolean;
  executable: string; executable_args: string[]; password: string;
};
export type Attempt = {
  id: string; number: number; base: string; directory: string; job_dir: string;
  state: string; feedback?: string; commit?: string; artifacts: string[];
  verification: Evidence[]; model?: Model; inputs: InputRequest[]; error?: string;
  integrated_commit?: string; approval?: { commit: string; at: number };
  worker?: WorkerState; context: ContextFile[]; resources: string[];
  launch_boot?: string;
  commit_intent?: boolean;
};
export type Task = { spec: TaskSpec; state: string; attempts: Attempt[]; revision: number };
export type Validation = { id: string; revision: number; commit: string; context_hash: string; commands_hash: string; attempt: Attempt; state: string };
export type Run = {
  id: string; repo: string; common_dir: string; branch: string; base: string;
  integration_branch: string; integration_dir: string; integration_commit: string;
  state: string; revision: number; created: number; tasks: Task[]; context: ContextFile[];
  final_verification: Command[]; resources: Resource[]; settings: Settings;
  validation?: Validation; error?: string;
  validation_history?: Validation[];
  finalize_intent?: { validation_id: string; commit: string; revision: number; started: number };
};
export type State = { protocol: number; revision: number; runs: Run[]; requests: Record<string, { hash: string; status: 'intent' | 'done'; result?: unknown }>; events: { seq: number; run_id: string; type: string; data: unknown }[]; metrics: { responses: number; response_bytes: number; mutations: number } };
export class Fault extends Error { constructor(public code: string, message: string, public details?: unknown) { super(message); } }
export function invariant(value: unknown, code: string, message: string, details?: unknown): asserts value { if (!value) throw new Fault(code, message, details); }
