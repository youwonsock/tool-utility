import path from 'node:path';
import { z } from 'zod';
import { backendVersions, platforms, workerSchema, modelSchema, invariant, type Platform, type WorkerConfig, type WorkerSelection, type Model } from './types.js';
import { digest, readJson } from './io.js';

const profileSchema=z.object({
  platform:z.enum(platforms), executable:z.string().min(1), args:z.array(z.string()).default([]),
  native_profile:z.string().min(1).optional(), env_refs:z.record(z.string().min(1)).optional(),
  shell:z.object({executable:z.string().min(1),args:z.array(z.string())}).strict().optional(),
}).strict();
const fileSchema=z.object({profiles:z.record(profileSchema)}).strict();
export type LegacyOptions={opencode:string;opencode_args:string[]};
export function resolveWorker(root:string, selection:WorkerSelection|undefined, legacyModel?:Model, legacy?:LegacyOptions):WorkerConfig {
  const choice=workerSchema.parse(selection??{platform:'opencode'});
  if(legacyModel) {
    invariant(choice.platform==='opencode','MODEL','Legacy task.model applies only to OpenCode.');
    invariant(choice.model===undefined || digest(choice.model)===digest(legacyModel),'MODEL','Conflicting legacy and worker models.');
  }
  const profile=choice.profile??'default';
  const saved=readJson<unknown>(path.join(root,'profiles.json'));
  const profiles=saved===undefined?{}:fileSchema.parse(saved).profiles;
  const record=profile==='default'?profiles[`${choice.platform}-default`]??(profiles.default?.platform===choice.platform?profiles.default:undefined):profiles[profile];
  // Defaults are platform-specific; a user profile cannot change its platform.
  const prefix:Record<Platform,string>={opencode:'CODEX_OPENCODE',codex:'DELEGATE_CODEX',kilo:'DELEGATE_KILO','claude-code':'DELEGATE_CLAUDE'};
  const command:Record<Platform,string>={opencode:'opencode',codex:'codex',kilo:'kilo','claude-code':'bundled'};
  invariant(profile==='default'||record,'WORKER_PROFILE',`Unknown execution profile: ${profile}`);
  if(record) invariant(record.platform===choice.platform,'WORKER_PROFILE','Execution profile belongs to another platform.');
  const configuration=record??{
    platform:choice.platform,
    executable:choice.platform==='opencode'&&legacy?legacy.opencode:process.env[`${prefix[choice.platform]}_EXECUTABLE`]??command[choice.platform],
    args:choice.platform==='opencode'&&legacy?legacy.opencode_args:JSON.parse(process.env[`${prefix[choice.platform]}_EXECUTABLE_ARGS`]??'[]') as string[],
  };
  const checked=profileSchema.parse(configuration);
  invariant(!checked.native_profile||choice.platform==='codex','WORKER_PROFILE','Native profile selection is supported only by Codex; use named framework profiles for other runtimes.');
  for(const [name,from]of Object.entries(checked.env_refs??{})) {
    invariant(name.toUpperCase()!=='CODEX_OPENCODE_WORKER'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(from),'WORKER_PROFILE','Invalid or reserved environment reference.');
    invariant(process.env[from]!==undefined,'WORKER_PROFILE',`Required environment reference is unavailable: ${from}`);
  }
  const model=legacyModel??choice.model;
  if(checked.platform==='opencode'||checked.platform==='kilo') { if(model!==undefined)modelSchema.parse(model); }
  else invariant(model===undefined||typeof model==='string','MODEL','Native platform model must be a string.');
  return {
    platform:choice.platform, profile, executable:checked.executable, executable_args:checked.args,
    baseline:backendVersions[choice.platform], config_hash:digest(checked), model,
    ...(checked.native_profile?{native_profile:checked.native_profile}:{}),
    ...(checked.env_refs?{env_refs:checked.env_refs}:{}), ...(checked.shell?{shell:checked.shell}:{}),
  };
}
export function publicWorker(worker?:WorkerConfig) {
  if(!worker)return undefined;
  return {platform:worker.platform,profile:worker.profile,baseline:worker.baseline,model:worker.model,config_hash:worker.config_hash};
}
export function workerEnvironment(worker:WorkerConfig):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={...process.env,CODEX_OPENCODE_WORKER:'1'};
  for(const [name,from]of Object.entries(worker.env_refs??{})) {
    invariant(name.toUpperCase()!=='CODEX_OPENCODE_WORKER','WORKER_PROFILE','Execution profiles cannot disable the worker recursion guard.');
    invariant(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(from),'WORKER_PROFILE','Invalid environment reference.');
    invariant(process.env[from]!==undefined,'WORKER_PROFILE',`Required environment reference is unavailable: ${from}`);
    env[name]=process.env[from];
  }
  return env;
}
