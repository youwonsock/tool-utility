import path from 'node:path';
import { z } from 'zod';
import {
  backendVersions,
  platforms,
  workerSchema,
  modelSchema,
  invariant,
  type Platform,
  type WorkerConfig,
  type WorkerSelection,
} from './types.js';
import { digest, readJson } from './io.js';

const profileSchema = z
  .object({
    platform: z.enum(platforms),
    executable: z.string().min(1),
    args: z.array(z.string()).default([]),
    native_profile: z.string().min(1).optional(),
    env_refs: z.record(z.string().min(1)).optional(),
    sdk_root: z
      .string()
      .refine((value) => path.isAbsolute(value), 'sdk_root must be an absolute package directory.')
      .optional(),
    shell: z
      .object({ executable: z.string().min(1), args: z.array(z.string()) })
      .strict()
      .optional(),
  })
  .strict();
const fileSchema = z.object({ profiles: z.record(profileSchema) }).strict();
export function resolveWorker(root: string, selection?: WorkerSelection): WorkerConfig {
  const choice = workerSchema.parse(selection ?? { platform: 'opencode' });
  const profile = choice.profile ?? 'default';
  const saved = readJson<unknown>(path.join(root, 'profiles.json'));
  const profiles = saved === undefined ? {} : fileSchema.parse(saved).profiles;
  const record =
    profile === 'default'
      ? (profiles[`${choice.platform}-default`] ??
        (profiles.default?.platform === choice.platform ? profiles.default : undefined))
      : profiles[profile];
  // Defaults are platform-specific; a user profile cannot change its platform.
  const prefix: Record<Platform, string> = {
    opencode: 'AGENT_DELEGATION_OPENCODE',
    codex: 'AGENT_DELEGATION_CODEX',
    kilo: 'AGENT_DELEGATION_KILO',
    'claude-code': 'AGENT_DELEGATION_CLAUDE',
  };
  const command: Record<Platform, string> = {
    opencode: 'opencode',
    codex: 'codex',
    kilo: 'kilo',
    'claude-code': 'claude',
  };
  invariant(profile === 'default' || record, 'WORKER_PROFILE', `Unknown execution profile: ${profile}`);
  if (record)
    invariant(record.platform === choice.platform, 'WORKER_PROFILE', 'Execution profile belongs to another platform.');
  const configuration = record ?? {
    platform: choice.platform,
    executable: process.env[`${prefix[choice.platform]}_EXECUTABLE`] ?? command[choice.platform],
    args: JSON.parse(process.env[`${prefix[choice.platform]}_EXECUTABLE_ARGS`] ?? '[]') as string[],
  };
  const parsed = profileSchema.safeParse(configuration);
  invariant(
    parsed.success,
    'WORKER_PROFILE',
    'Invalid execution profile.',
    parsed.success ? undefined : parsed.error.issues,
  );
  const checked = parsed.data;
  const sdk_root = checked.sdk_root ?? process.env[`${prefix[choice.platform]}_SDK_ROOT`];
  invariant(
    !sdk_root || path.isAbsolute(sdk_root),
    'WORKER_PROFILE',
    'SDK_ROOT must be an absolute package directory.',
  );
  invariant(
    !checked.native_profile || choice.platform === 'codex',
    'WORKER_PROFILE',
    'Native profile selection is supported only by Codex; use named framework profiles for other runtimes.',
  );
  for (const [name, from] of Object.entries(checked.env_refs ?? {})) {
    invariant(
      name.toUpperCase() !== 'AGENT_DELEGATION_WORKER' &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(from),
      'WORKER_PROFILE',
      'Invalid or reserved environment reference.',
    );
    invariant(
      process.env[from] !== undefined,
      'WORKER_PROFILE',
      `Required environment reference is unavailable: ${from}`,
    );
  }
  const model = choice.model;
  if (checked.platform === 'opencode' || checked.platform === 'kilo') {
    if (model !== undefined) modelSchema.parse(model);
  } else
    invariant(model === undefined || typeof model === 'string', 'MODEL', 'Native platform model must be a string.');
  return {
    platform: choice.platform,
    profile,
    executable: checked.executable,
    executable_args: checked.args,
    baseline: backendVersions[choice.platform],
    config_hash: digest({ ...checked, ...(sdk_root ? { sdk_root } : {}) }),
    model,
    ...(checked.native_profile ? { native_profile: checked.native_profile } : {}),
    ...(sdk_root ? { sdk_root, sdk_source: checked.sdk_root ? ('profile' as const) : ('environment' as const) } : {}),
    ...(checked.env_refs ? { env_refs: checked.env_refs } : {}),
    ...(checked.shell ? { shell: checked.shell } : {}),
  };
}
export function publicWorker(worker?: WorkerConfig) {
  if (!worker) return undefined;
  return {
    platform: worker.platform,
    profile: worker.profile,
    baseline: worker.baseline,
    model: worker.model,
    config_hash: worker.config_hash,
  };
}
export function workerEnvironment(worker: WorkerConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_DELEGATION_WORKER: '1' };
  for (const [name, from] of Object.entries(worker.env_refs ?? {})) {
    invariant(
      name.toUpperCase() !== 'AGENT_DELEGATION_WORKER',
      'WORKER_PROFILE',
      'Execution profiles cannot disable the worker recursion guard.',
    );
    invariant(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(from),
      'WORKER_PROFILE',
      'Invalid environment reference.',
    );
    invariant(
      process.env[from] !== undefined,
      'WORKER_PROFILE',
      `Required environment reference is unavailable: ${from}`,
    );
    env[name] = process.env[from];
  }
  return env;
}
