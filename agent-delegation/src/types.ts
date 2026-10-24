import { z } from 'zod';

export const PROTOCOL = 1;
export const STORE_FORMAT = 4;
export const WORKER_FORMAT = 2;
export const VERSION = '1.0.0';
export const BASELINE = '1.18.30';
export const platforms = ['opencode','codex','claude-code','kilo'] as const;
export type Platform = typeof platforms[number];
export const backendVersions: Record<Platform,string> = { opencode: BASELINE, codex: '0.162.1', 'claude-code': '0.3.296', kilo: '7.4.23' };
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const commandSchema = z.object({ command: z.string().min(1).max(8192), timeout_ms: z.number().int().min(100).max(3_600_000).default(600_000) }).strict();
export const modelSchema = z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }).strict();
const workerFields = { profile: idSchema.optional() };
export const workerSchema = z.discriminatedUnion('platform', [
  z.object({platform:z.literal('opencode'),model:modelSchema.optional(),...workerFields}).strict(),
  z.object({platform:z.literal('kilo'),model:modelSchema.optional(),...workerFields}).strict(),
  z.object({platform:z.literal('codex'),model:z.string().min(1).optional(),...workerFields}).strict(),
  z.object({platform:z.literal('claude-code'),model:z.string().min(1).optional(),...workerFields}).strict(),
]);
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
  resources: z.array(idSchema).default([]), worker: workerSchema.optional(),
}).strict();
const request = { request_id: idSchema };
const run = { run_id: idSchema };
const paging = { cursor: z.string().optional() };
export const schemas = {
  doctor: z.object({ repo: z.string().optional(), worker:workerSchema.optional() }).strict(),
  submit_tasks: z.object({ ...request, run_id: idSchema.optional(), repo: z.string().optional(), tasks: z.array(taskSchema).min(1).max(100),
    resources: z.array(resourceSchema).default([]), final_verification: z.array(commandSchema).optional(),
    context_files: z.array(z.string()).default([]), worker:workerSchema.optional(),
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
export type WorkerModel = Model | string;
export type WorkerSelection = z.infer<typeof workerSchema>;
export type ShellSpec = { executable:string; args:string[]; baseline?:boolean };
export type RuntimeIdentity = {
  cli:{path:string;real_path:string;args:string[];hash:string;argument_files:{path:string;hash:string}[];version?:string};
  sdk?:{name:string;root:string;entry:string;version:string;source:'profile'|'environment'|'cli'|'global';hash:string};
};
export type WorkerConfig = {
  platform:Platform; profile:string; executable:string; executable_args:string[];
  baseline:string; config_hash:string; model?:WorkerModel; native_profile?:string;
  env_refs?:Record<string,string>; shell?:ShellSpec; sdk_root?:string; sdk_source?:'profile'|'environment'; runtime?:RuntimeIdentity;
};
export type Command = z.infer<typeof commandSchema>;
export type TaskSpec = z.infer<typeof taskSchema>;
export type SubmitArgs = z.infer<typeof schemas.submit_tasks>;
export type Resource = z.infer<typeof resourceSchema>;
export type Settings = { concurrency: number; timeout_ms: number; max_retries: number };
export type ContextFile = { path: string; hash: string; artifact: string; tracked: boolean; mode: number };
export type ProcessIdentity = { pid: number; birth: string };
export type InputDecision = 'once'|'always'|'reject'|'answer';
export type InputRequest = { id: string; kind: 'permission' | 'question'; details: unknown; supported_decisions?:InputDecision[]; grant_key?:string };
export type Evidence = { command: string; status: 'passed' | 'failed' | 'unknown' | 'cancelled'; exit_code: number | null; artifact: string };
export const runStates = ['active','validating','waiting_final_review','finalizing','finalize_uncertain','completed','cancelling','cancelled'] as const;
export const taskStates = ['queued','running','needs_input','needs_review','integrated','cancelled'] as const;
export const attemptStates = ['launching','running','needs_input','resource_wait','delivery_uncertain','cancelling','orphaned','stop_uncertain','failed','cancelled','needs_review','scope_or_context_error','integrating','integrated','integration_conflict','interrupted','verified'] as const;
export const validationStates = ['running','awaiting_resource','passed','failed','cancelled','invalidated'] as const;
export const workerPhases = ['starting','creating_session','implementing','verifying','needs_input','reconciling_delivery','delivery_uncertain','cancelling','cancelled','completed','failed','stop_uncertain'] as const;
export type RunState = typeof runStates[number];
export type TaskState = typeof taskStates[number];
export type AttemptState = typeof attemptStates[number];
export type ValidationState = typeof validationStates[number];
export type WorkerPhase = typeof workerPhases[number];
export type WorkerState = {
  protocol: number; id: string; phase: WorkerPhase; updated: number; host?: ProcessIdentity;
  server?: ProcessIdentity; url?: string; session_id?: string; model?: WorkerModel;
  backend?:Platform; backend_version?:string; processes?:ProcessIdentity[];
  runtime?:RuntimeIdentity; error_code?:string; error_details?:unknown; diagnostic_stage?:string;
  prompt_id: string; prompt_intent?: number; prompt_accepted?: boolean;
  native_request_id?:string; turn_id?:string; permission_grants?:string[];
  scope_guard?:{status:'starting'|'healthy'|'violated'|'unknown';checked_at:number;policy_hash:string;evidence?:string};
  verification_shell?:ShellSpec;
  verification: Evidence[]; shell_intent?: { index: number; message_id: string; command: string; process?:ProcessIdentity };
  inputs: InputRequest[]; replies: Record<string, 'intent' | 'sent' | 'uncertain'>;
  summary?: string; transcript?: string; usage?: unknown; error?: string; stopped?: boolean;
};
export type WorkerSpec = {
  id: string; directory: string; job_dir: string; goal: string; acceptance: string[];
  verification: Command[]; resources: Resource[]; context: ContextFile[];
  scope: string[]; model?: WorkerModel; timeout_ms: number; validation: boolean;
  executable: string; executable_args: string[]; password: string;
  protocol:number; worker:WorkerConfig; host_executable:string; diagnostic?:boolean;
};
export type Attempt = {
  id: string; number: number; base: string; directory: string; job_dir: string;
  state: AttemptState; feedback?: string; commit?: string; artifacts: string[];
  verification: Evidence[]; model?: WorkerModel; inputs: InputRequest[]; error?: string; execution?:WorkerConfig;
  integrated_commit?: string; approval?: { commit: string; at: number };
  worker?: WorkerState; context: ContextFile[]; resources: string[];
  launch_boot?: string;
  runtime_error?:{code:string;message:string};
  commit_intent?: boolean;
};
export type Task = { spec: TaskSpec; state: TaskState; attempts: Attempt[]; revision: number; worker:WorkerConfig };
export type Validation = { id: string; revision: number; commit: string; context_hash: string; commands_hash: string; attempt: Attempt; state: ValidationState };
export type Run = {
  id: string; repo: string; common_dir: string; branch: string; base: string;
  integration_branch: string; integration_dir: string; integration_commit: string;
  state: RunState; revision: number; created: number; tasks: Task[]; context: ContextFile[];
  worker:WorkerConfig;
  final_verification: Command[]; resources: Resource[]; settings: Settings;
  validation?: Validation; error?: string;
  validation_history?: Validation[];
  ended_at?: number;
  control_generation?: number;
  finalize_intent?: { validation_id: string; commit: string; revision: number; started: number };
};
export type RequestRecord = { hash: string; status: 'intent' | 'done'; result?: unknown; completed_at?: number; operation_id?:string };
export type DurableOperation = {
  id:string; kind:string; request_id?:string; request_hash?:string; run_id?:string; repository_key?:string;
  status:'running'|'completed'|'uncertain'; created:number; updated:number; expected_revision?:number; generation?:number;
  inputs:unknown; reservations:{slot?:boolean;attempt_id?:string;resources?:string[];repository?:string};
  result?:unknown; error?:{code:string;message:string};
};
export type RunEvent = { seq: number; run_id: string; type: string; data: unknown };
export type ArchiveRef = { file: string; hash: string; archived_at: number };
export type RunSummary = { run_id: string; repo: string; branch: string; state: RunState; revision: number; tasks: number; created: number; ended_at?: number; event_cursor: number };
export type State = {
  operations: Record<string, DurableOperation>;
  protocol: number; revision: number; runs: Run[]; requests: Record<string, RequestRecord>; events: RunEvent[];
  event_seq: number; archived_runs: Record<string, ArchiveRef & { summary: RunSummary }>;
  archived_requests: Record<string, ArchiveRef>; resource_hashes: Record<string, string>;
  metrics: { responses: number; response_bytes: number; mutations: number };
};
export class Fault extends Error { constructor(public code: string, message: string, public details?: unknown) { super(message); } }
export function invariant(value: unknown, code: string, message: string, details?: unknown): asserts value { if (!value) throw new Fault(code, message, details); }
