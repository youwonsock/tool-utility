import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { invariant, type Evidence, type ShellSpec, type Command } from './types.js';
import { readJson, writeJson, mkdir, uid, digest, sleep, alive } from './io.js';
import { workerEnvironment } from './profiles.js';
import { spawnRuntime, stopOwned, stopRuntimeIntent } from './backends/process.js';
import type { BackendContext } from './backends/contract.js';
import { verificationInvocation, verificationShell } from './shell.js';
export { verificationShell } from './shell.js';

type CommandIntent={command:Command;shell:ShellSpec;argv:string[];directory:string;receipt:string;log:string;environment_hash:string};
type Receipt={exit_code:number|null;error?:string;output_bytes:number;truncated:boolean};

// Stay alive after reporting exit so the owner terminates a known live root
// and its process tree before recording confirmed termination on Windows too.
export async function commandHost(intentFile:string) {
  const intent=readJson<CommandIntent>(intentFile)!;
  invariant(intent&&path.isAbsolute(intent.directory)&&path.isAbsolute(intent.receipt),'COMMAND_SPEC','Invalid command intent.');
  const fd=fs.openSync(intent.log,'wx',0o600);let written=0,total=0,error:string|undefined;
  const cmd=process.platform==='win32'&&/(?:^|[\\/])cmd(?:\.exe)?$/i.test(intent.shell.executable);
  const args=cmd?[...intent.argv.slice(0,-1),`"${intent.argv.at(-1)}"`]:intent.argv;
  const child=spawn(intent.shell.executable,args,{cwd:intent.directory,env:process.env,windowsHide:true,windowsVerbatimArguments:cmd,stdio:['ignore','pipe','pipe']});
  const collect=(data:Buffer)=>{total+=data.length;const part=data.subarray(0,Math.max(0,16*1024*1024-written));if(part.length){fs.writeSync(fd,part);written+=part.length;}};
  child.stdout?.on('data',collect);child.stderr?.on('data',collect);child.on('error',e=>{error=e.message;});
  await new Promise<void>(resolve=>child.once('close',()=>resolve()));
  fs.fsyncSync(fd);fs.closeSync(fd);
  writeJson(intent.receipt,{exit_code:child.exitCode,error,output_bytes:total,truncated:total>written} satisfies Receipt);
  await new Promise<void>(()=>{setInterval(()=>{},1000);});
}
// Dynamic shell calls share the owned ledger with Codex, but finishing a command
// must never stop the still-running model server or replace its root identity.
export async function runSupervisedCommand(context:BackendContext,requestID:string,command:Command,directory:string,cancelled:()=>boolean) {
  const {spec,state}=context,shell=state.verification_shell??verificationShell(spec.worker?.shell);
  const prefix=path.join(spec.job_dir,`supervised-${digest(requestID).slice(0,32)}`),intentFile=`${prefix}-intent.json`,receiptFile=`${prefix}-receipt.json`,log=`${prefix}.log`;
  invariant(!fs.existsSync(intentFile),'COMMAND_UNCERTAIN','This tool call already has an execution intent. It will not be replayed.');
  const env:NodeJS.ProcessEnv={...workerEnvironment(spec.worker!),TERM:'dumb'};
  const intent:CommandIntent={command,shell,argv:verificationInvocation(shell,command.command,directory),directory,receipt:receiptFile,log,environment_hash:digest(Object.keys(env).sort().map(key=>[key,/KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(key)?'<credential>':env[key]]))};
  writeJson(intentFile,intent);
  invariant(!cancelled(),'CANCELLED','Cancelled before command dispatch.');
  const runtime=await spawnRuntime(context,process.execPath,[spec.host_executable,'command-host',intentFile],env,{primary:false});
  const deadline=Date.now()+command.timeout_ms;let receipt:Receipt|undefined,wasCancelled=false,stopped=false;
  try {
    while(!(receipt=readJson<Receipt>(receiptFile))) {
      if(cancelled()||Date.now()>=deadline){wasCancelled=true;break;}
      if(!await alive(runtime.identity))break;
      await sleep(100);
    }
  } finally {stopped=await stopRuntimeIntent(context,runtime.intent);}
  const exit=receipt?.exit_code??null,status=wasCancelled||cancelled()?'cancelled':Number.isInteger(exit)?exit===0?'passed':'failed':'unknown';
  const output=Buffer.alloc(Math.min(fs.existsSync(log)?fs.statSync(log).size:0,64*1024));
  if(output.length){const fd=fs.openSync(log,'r');try{fs.readSync(fd,output,0,output.length,0);}finally{fs.closeSync(fd);}}
  const result={status,exit_code:exit,output:output.toString('utf8'),output_bytes:receipt?.output_bytes??output.length,truncated:(receipt?.output_bytes??output.length)>output.length,termination_confirmed:stopped};
  writeJson(`${prefix}-result.json`,{...result,log:path.basename(log)});
  invariant(stopped,'STOP_UNCERTAIN','Command process tree termination could not be confirmed.');
  return result;
}
export async function runVerification(context:BackendContext,index:number,command:Command,cancelled:()=>boolean):Promise<Evidence> {
  const {spec,state,save}=context;
  const shell=state.verification_shell??verificationShell(spec.worker?.shell),id=uid('command'),prefix=path.join(spec.job_dir,`verification-${index}`);
  const intentFile=`${prefix}-intent.json`,receiptFile=`${prefix}-receipt.json`,log=`${prefix}.log`;
  invariant(!fs.existsSync(intentFile),'COMMAND_UNCERTAIN','Command already has an execution intent. It will not be replayed.');
  mkdir(spec.job_dir);
  const env:NodeJS.ProcessEnv={...workerEnvironment(spec.worker!),TERM:'dumb'};
  const intent:CommandIntent={command,shell,argv:verificationInvocation(shell,command.command,spec.directory),directory:spec.directory,receipt:receiptFile,log,environment_hash:digest(Object.keys(env).sort().map(key=>[key,/KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(key)?'<credential>':env[key]]))};
  writeJson(intentFile,intent);
  state.shell_intent={index,message_id:id,command:command.command};save();
  invariant(!cancelled(),'CANCELLED','Cancelled before verification dispatch.');
  await spawnRuntime(context,process.execPath,[spec.host_executable,'command-host',intentFile],env);
  state.shell_intent.process=state.server;save();
  const deadline=Date.now()+command.timeout_ms;
  let receipt:Receipt|undefined,wasCancelled=false;
  while(!(receipt=readJson<Receipt>(receiptFile))) {
    if(cancelled()||Date.now()>=deadline){wasCancelled=true;break;}
    if(state.server&&!(await alive(state.server)))break;
    await sleep(100);
  }
  const stopped=await stopOwned(context),exit=receipt?.exit_code??null;
  const status=wasCancelled||cancelled()?'cancelled':Number.isInteger(exit)?exit===0?'passed':'failed':'unknown';
  const artifact=`verification-${index}.json`;
  writeJson(path.join(spec.job_dir,artifact),{...intent,...receipt,exit_code:exit,status,termination_confirmed:stopped,log:path.basename(log)});
  state.shell_intent=undefined;save();
  invariant(stopped,'STOP_UNCERTAIN','Verification process tree termination could not be confirmed.');
  return {command:command.command,status,exit_code:exit,artifact};
}
