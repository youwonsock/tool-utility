import fs from 'node:fs';
import path from 'node:path';
import { invariant, VERSION } from './types.js';
import { inside, readJson, samePath } from './io.js';

// Only immutable installer releases opt in. Source checkouts and worker/job
// entry points keep their pinned executable and never follow another deployment.
export function currentMcpExecutable(executableFile:string):string {
  const install=path.resolve(path.dirname(executableFile),'../../../../..');
  const relative=path.relative(install,executableFile).split(path.sep).join('/');
  if(!/^releases\/[^/]+\/plugins\/agent-delegation\/runtime\/cli\.mjs$/.test(relative))return executableFile;
  let current:{cli?:unknown;release?:unknown}|undefined;
  try{current=readJson(path.join(install,'current.json'));}
  catch{invariant(false,'UPDATE_PENDING','The installed deployment pointer is invalid. Repair the installation before using MCP.');}
  invariant(current&&typeof current.cli==='string'&&typeof current.release==='string'&&path.isAbsolute(current.cli)&&path.isAbsolute(current.release),'UPDATE_PENDING','The installed deployment pointer is missing or invalid.');
  const target=path.relative(install,current.cli).split(path.sep).join('/');
  invariant(/^releases\/[^/]+\/plugins\/agent-delegation\/runtime\/cli\.mjs$/.test(target),'UPDATE_PENDING','The installed MCP executable must belong to this installation.');
  const selected=inside(install,target);
  invariant(samePath(current.release,path.resolve(path.dirname(selected),'../../..'))&&fs.existsSync(selected),'UPDATE_PENDING','The selected MCP deployment is incomplete.');
  return selected;
}

export function deploymentVersion(executableFile:string):string {
  const manifest=readJson<{version?:unknown}>(path.resolve(path.dirname(executableFile),'../.codex-plugin/plugin.json'));
  return typeof manifest?.version==='string'?manifest.version:VERSION;
}
