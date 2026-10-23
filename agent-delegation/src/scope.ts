import fs from 'node:fs';
import path from 'node:path';
import { invariant, type WorkerSpec, type WorkerState } from './types.js';
import { digest } from './io.js';

const fold=(value:string)=>value.normalize('NFC').toLowerCase();
const comparable=(value:string)=>process.platform==='win32'||process.platform==='darwin'?fold(value):value;
export function scopeAllows(scope:string[],file:string):boolean {
  if(!file||file.includes('\\')||file.includes('\0')||path.posix.isAbsolute(file)||file.split('/').some(p=>!p||p==='.'||p==='..'||fold(p)==='.git'))return false;
  return scope.some(entry=>entry==='**'||(entry.endsWith('/**')?comparable(file).startsWith(comparable(entry.slice(0,-2))):entry.endsWith('/')?comparable(file).startsWith(comparable(entry)):comparable(file)===comparable(entry)));
}

// Resolve every existing parent, including an existing leaf, before evaluating a
// new path. Native realpath expands Windows short names. No link traversal is
// accepted: an edit cannot use a link to escape its declared spelling or root.
export function checkedMutationPath(directory:string,file:string,scope:string[],contextPaths:string[]):string {
  invariant(typeof file==='string'&&file.length>0&&!file.includes('\0'),'SCOPE_VIOLATION','Mutation has no verifiable path.');
  const root=fs.realpathSync.native(directory),absolute=path.resolve(root,file),relative=path.relative(root,absolute);
  invariant(relative&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative),'SCOPE_VIOLATION','Mutation leaves the worker checkout.',{path:file});
  const supplied=(process.platform==='win32'?file.replaceAll('\\','/'):file).split('/');
  invariant(!supplied.some(p=>p==='..'||fold(p)==='.git')&&!supplied.some(p=>/[. ]$/.test(p)),'SCOPE_VIOLATION','Unsafe mutation path.',{path:file});
  let resolved=root;
  for(const component of relative.split(path.sep)) {
    invariant(!component.includes(':')&&fold(component)!=='.git','SCOPE_VIOLATION','Git metadata and alternate streams are protected.',{path:file});
    const next=path.join(resolved,component);
    let stat:fs.Stats|undefined;try{stat=fs.lstatSync(next);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(stat){invariant(!stat.isSymbolicLink(),'SCOPE_VIOLATION','Mutation through a symbolic link or junction is forbidden.',{path:file});resolved=fs.realpathSync.native(next);}
    else resolved=next;
    const child=path.relative(root,resolved);invariant(child!=='..'&&!child.startsWith(`..${path.sep}`)&&!path.isAbsolute(child),'SCOPE_VIOLATION','Mutation resolves outside the worker checkout.',{path:file});
  }
  const canonical=path.relative(root,resolved).split(path.sep).join('/');
  invariant(!contextPaths.some(p=>fold(p)===fold(canonical)||fold(p).startsWith(`${fold(canonical)}/`)),'CONTEXT_CHANGED','Protected context cannot be mutated.',{path:file});
  invariant(scopeAllows(scope,canonical),'SCOPE_VIOLATION','Mutation exceeds the declared scope.',{path:file,canonical});
  return canonical;
}
export const workerPolicyHash=(spec:Pick<WorkerSpec,'id'|'directory'|'scope'|'context'>)=>digest({version:2,attempt:spec.id,cwd:fs.realpathSync.native(spec.directory),scope:spec.scope,context:spec.context.map(c=>({path:c.path,hash:c.hash}))});
export function scopeMonitorHealthy(spec:WorkerSpec,state:WorkerState):boolean {
  try{return state.id===spec.id&&state.scope_guard?.status==='healthy'&&Date.now()-state.scope_guard.checked_at<10000&&state.scope_guard.policy_hash===workerPolicyHash(spec);}catch{return false;}
}
export function assertScopeMonitor(spec:WorkerSpec,state:WorkerState){invariant(scopeMonitorHealthy(spec,state),'SCOPE_GUARD_UNKNOWN','Worker scope monitor is missing, unhealthy, stale, or bound to a different policy.');}
