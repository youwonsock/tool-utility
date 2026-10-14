import { HttpBackend } from './http.js';
import { CodexBackend } from './codex.js';
import { ClaudeBackend } from './claude.js';
import type { BackendContext, WorkerBackend } from './contract.js';
import { resolveRuntime, assertRuntimeUnchanged, runtimeFault } from '../runtime.js';
import { executableVersion } from './version.js';
import { Fault } from '../types.js';
export function createBackend(context:BackendContext):WorkerBackend {
  let backend:WorkerBackend;
  switch(context.spec.worker.platform) {
    case 'codex':backend=new CodexBackend(context);break;
    case 'claude-code':backend=new ClaudeBackend(context);break;
    default:backend=new HttpBackend(context);
  }
  const start=backend.start.bind(backend);
  backend.start=async()=>{
    const {spec,state,save}=context;
    state.diagnostic_stage='installation';save();
    const runtime=spec.worker.runtime?await assertRuntimeUnchanged(spec.worker,spec.worker.runtime):await resolveRuntime(spec.worker);
    state.runtime=runtime;spec.worker.runtime=runtime;spec.executable=runtime.cli.path;save();
    state.diagnostic_stage='cli';save();
    runtime.cli.version=await executableVersion(spec);save();
    state.diagnostic_stage='initialization';save();
    try {await start();}
    catch(error){if(error instanceof Fault&&['BACKEND_API','BACKEND_VERSION','OPENCODE_CONFIG','OPENCODE_HEALTH'].includes(error.code))throw runtimeFault('CLI_INCOMPATIBLE',spec.worker,error.message,{cause_code:error.code,path:runtime.cli.path});throw error;}
    if(state.backend_version!==runtime.cli.version)throw runtimeFault('CLI_INCOMPATIBLE',spec.worker,'The native session did not identify the selected CLI version.',{expected:runtime.cli.version,observed:state.backend_version});
    state.diagnostic_stage='session';save();
  };
  return backend;
}
export type { WorkerBackend, BackendContext, Answer, Observation } from './contract.js';
