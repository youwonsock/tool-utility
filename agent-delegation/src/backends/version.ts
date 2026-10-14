import { invariant, type WorkerSpec } from '../types.js';
import { exec } from '../io.js';
import { workerEnvironment } from '../profiles.js';
import { runtimeFault } from '../runtime.js';

// Native versions identify the runtime; API and policy checks decide compatibility.
export function reportedVersion(value:unknown,platform:string):string {
  invariant(typeof value==='string'&&value.length>0&&!/\s/.test(value),'BACKEND_VERSION',`${platform} did not report a runtime version.`);
  return value;
}
export async function executableVersion(spec:WorkerSpec):Promise<string> {
  const platform=spec.worker.platform;
  if(spec.worker.runtime?.cli.version)return spec.worker.runtime.cli.version;
  let result;
  try {result=await exec(spec.executable,[...spec.executable_args,'--version'],{cwd:spec.directory,env:workerEnvironment(spec.worker)});}
  catch(error){throw runtimeFault('CLI_INCOMPATIBLE',spec.worker,`${platform} --version failed: ${(error as Error).message}`,{path:spec.executable});}
  if(result.code!==0)throw runtimeFault('CLI_INCOMPATIBLE',spec.worker,`${platform} --version failed: ${result.stderr.trim()}`,{path:spec.executable});
  const output=result.stdout.trim();
  try {return reportedVersion(platform==='codex'?/^codex-cli (\S+)$/.exec(output)?.[1]:platform==='claude-code'?/^(\S+)(?:\s+\(Claude Code\))?$/.exec(output)?.[1]:output,platform);}
  catch(error){throw runtimeFault('CLI_INCOMPATIBLE',spec.worker,(error as Error).message,{path:spec.executable});}
}
