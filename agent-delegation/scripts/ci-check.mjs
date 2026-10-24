// CI diagnostics contain sanitized command output only. Never collect jobs,
// native runtime logs/configuration, specs, credentials, or user installations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

export function sanitize(text,environment=process.env) {
  let safe=text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'<private-key-redacted>')
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi,'$1<userinfo-redacted>@')
    .replace(/\b(?:Basic|Bearer)\s+[A-Za-z\d+/_=.~-]+/gi,'<authorization-redacted>')
    .replace(/\b(?:secret_[a-f\d]{16,}|gh[pousr]_[A-Za-z\d_]+|github_pat_[A-Za-z\d_]+|sk-[A-Za-z\d_-]{12,})\b/g,'<credential-redacted>')
    .replace(/^.*["']?(?:authorization|cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=].*$/gim,'<credential-assignment-redacted>');
  const secrets=Object.entries(environment).filter(([key,value])=>/TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE/i.test(key)&&typeof value==='string'&&value.length>=8).map(([,value])=>value).sort((a,b)=>b.length-a.length);
  for(const value of secrets)safe=safe.split(value).join('<environment-credential-redacted>');
  return safe;
}

export async function runCheck(phase,diagnostics,nativePrefix) {
  if(!['regression','prepare','native','windows-focus'].includes(phase)||!path.isAbsolute(diagnostics)||['prepare','native'].includes(phase)&&(!nativePrefix||!path.isAbsolute(nativePrefix)))throw new Error('Use regression|prepare|native|windows-focus and absolute owned diagnostics/native test directories.');
  fs.mkdirSync(diagnostics,{recursive:true});
  if(phase==='regression'&&process.platform==='win32') {
    const built=await captureCheck('windows-focus-build',diagnostics,['npm',['run','build']]);if(built!==0)return built;
    const focused=await runCheck('windows-focus',diagnostics);if(focused!==0)return focused;
  }
  const command=phase==='regression'?['npm',['run','check']]:phase==='windows-focus'?[process.execPath,['--test','--test-concurrency=1','--test-timeout=120000','--test-name-pattern=Codex TOML|Windows .*cmd|stdin|native write failure','test/codex-toml.test.mjs','test/json-rpc.test.mjs','test/local-runtime.test.mjs']]
    :[process.execPath,[phase==='prepare'?'scripts/prepare-connections.mjs':'scripts/connection-check.mjs',nativePrefix]];
  return captureCheck(phase,diagnostics,command);
}
async function captureCheck(phase,diagnostics,command) {
  const started=Date.now(),child=spawn(command[0],command[1],{cwd:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),env:process.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const capture={prefix:'',tail:'',bytes:0};
  const collect=data=>{
    const text=data.toString();capture.bytes+=data.length;
    if(capture.prefix.length<2*1024*1024)capture.prefix+=text.slice(0,2*1024*1024-capture.prefix.length);
    else capture.tail=(capture.tail+text).slice(-6*1024*1024);
  };
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  let launchError;child.on('error',error=>{launchError=error.message;});
  const result=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code:code??1,signal})));
  const output=sanitize(capture.prefix+(capture.tail?'\n<bounded capture: tail>\n'+capture.tail:'')+(launchError?`\n${launchError}`:''));
  fs.writeFileSync(path.join(diagnostics,`${phase}.log`),output,{mode:0o600});
  fs.writeFileSync(path.join(diagnostics,`${phase}.json`),JSON.stringify({phase,command:[command[0],...command[1]],exit_code:result.code,signal:result.signal,elapsed_ms:Date.now()-started,output_bytes:capture.bytes,truncated:capture.bytes>8*1024*1024,model_requests:0},null,2),{mode:0o600});
  process.stdout.write(output);return result.code;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runCheck(...process.argv.slice(2));
