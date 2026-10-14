import { invariant, type WorkerSpec } from '../types.js';
import { exec } from '../io.js';
import { workerEnvironment } from '../profiles.js';

// Native versions identify the runtime; API and policy checks decide compatibility.
export function reportedVersion(value:unknown,platform:string):string {
  invariant(typeof value==='string'&&value.length>0&&!/\s/.test(value),'BACKEND_VERSION',`${platform} did not report a runtime version.`);
  return value;
}
export async function executableVersion(spec:WorkerSpec):Promise<string> {
  const platform=spec.worker.platform;
  const result=await exec(spec.executable,[...spec.executable_args,'--version'],{cwd:spec.directory,env:workerEnvironment(spec.worker)});
  invariant(result.code===0,'BACKEND_VERSION',`${platform} --version failed: ${result.stderr.trim()}`);
  const output=result.stdout.trim();
  return reportedVersion(platform==='codex'?/^codex-cli (\S+)$/.exec(output)?.[1]:output,platform);
}
