import path from 'node:path';
import fs from 'node:fs';
import { invariant, type Resource } from '../types.js';
import { digest } from '../io.js';
import { checkedMutationPath, workerPolicyHash } from '../scope.js';
import type { WorkerSpec } from '../types.js';

export function forbiddenCommand(command:string):boolean {
  return /(?:^|[\s;&|/\\])(?:codex|opencode|claude|kilo|agent-delegation)(?:[.\s;&|]|$)/i.test(command)
    || /\bgit\s+(?:(?:-[cC]\s+\S+|--\S+)\s+)*(?:push|reset|checkout|switch|commit|worktree|update-ref|symbolic-ref|branch|clean|restore|merge|rebase|cherry-pick|am|add|rm|mv|update-index|config|remote|tag|fetch|pull|gc|prune|repack|init|clone|submodule|sparse-checkout)\b/i.test(command)
    || /(?:^|[;&|\s])(?:nohup|disown|start-process|start-job)\b|(?<![&>])&(?![&0-9])/i.test(command);
}
export type McpConnection={type:'stdio';command:string;args:string[];env?:Record<string,string>}|{type:'http'|'sse';url:string;headers?:Record<string,string>};
export function connection(resource:Resource,directory:string):McpConnection {
  invariant(!/agent-delegation|delegat/i.test(resource.connection.name+JSON.stringify(resource.connection.config)),'RECURSION','Delegation MCP cannot be exposed to a worker.');
  const expand=(v:unknown):any=>typeof v==='string'?v.replaceAll('{{worktree}}',directory):Array.isArray(v)?v.map(expand):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,expand(x)])):v;
  const c=expand(resource.connection.config);
  const allowed=new Set(['type','command','args','environment','env','url','headers','enabled','timeout','oauth']);
  invariant(Object.keys(c).every(key=>allowed.has(key)),'MCP_POLICY','Resource connection has unsupported configuration fields.');
  invariant(c.enabled===undefined||c.enabled===true,'MCP_POLICY','A declared worker resource must be enabled.');
  invariant(c.environment===undefined||c.env===undefined,'MCP_POLICY','Use one resource environment field.');
  invariant(c.timeout===undefined||Number.isInteger(c.timeout)&&c.timeout>0,'MCP_POLICY','Resource timeout must be a positive integer.');
  if(c.type==='local'||c.type==='stdio'||(c.command&&!c.url)) {
    invariant(c.url===undefined&&c.headers===undefined&&c.oauth===undefined,'MCP_POLICY','Stdio resources cannot contain remote connection fields.');
    invariant(!Array.isArray(c.command)||c.args===undefined,'MCP_POLICY','Use a command array or a separate args field, not both.');
    const command=Array.isArray(c.command)?c.command[0]:c.command;
    const args=Array.isArray(c.command)?c.command.slice(1):c.args??[];
    invariant(typeof command==='string'&&Array.isArray(args)&&args.every((v:unknown)=>typeof v==='string'),'MCP_POLICY','Invalid stdio resource connection.');
    const env=c.environment??c.env;
    invariant(!env||Object.values(env).every(v=>typeof v==='string'),'MCP_POLICY','Resource environment must contain strings.');
    return {type:'stdio',command,args,...(env?{env}:{})};
  }
  invariant(['remote','http','sse'].includes(c.type)&&typeof c.url==='string','MCP_POLICY','Unsupported MCP resource transport.');
  invariant(c.command===undefined&&c.args===undefined&&c.env===undefined&&c.environment===undefined,'MCP_POLICY','Remote resources cannot contain stdio connection fields.');
  invariant(c.oauth===undefined||c.oauth===false||c.oauth&&typeof c.oauth==='object'&&!Array.isArray(c.oauth)&&Object.entries(c.oauth).every(([key,value])=>['clientId','clientSecret','scope'].includes(key)&&typeof value==='string'),'MCP_POLICY','Unsupported OAuth resource configuration.');
  const url=new URL(c.url);invariant(['http:','https:'].includes(url.protocol),'MCP_POLICY','Unsupported MCP resource URL.');
  invariant(!c.headers||Object.values(c.headers).every(v=>typeof v==='string'),'MCP_POLICY','Resource headers must contain strings.');
  return {type:c.type==='sse'?'sse':'http',url:c.url,...(c.headers?{headers:c.headers}:{})};
}
export function mutationPaths(tool:string,input:Record<string,unknown>):string[]|undefined {
  if(!/write|edit|notebook|patch|delete|remove|rename|move|filechange/i.test(tool))return undefined;
  const paths:string[]=[];
  const collect=(value:unknown)=>{
    if(!value||typeof value!=='object')return;
    for(const [key,item]of Object.entries(value)) {
      if(/^(?:file_path|filePath|path|notebook_path|old_path|new_path|oldPath|newPath|source|destination|from|to|move_path|movePath)$/.test(key)&&typeof item==='string')paths.push(item);
      else if(Array.isArray(item))for(const child of item) {
        if(/^(?:native_paths|paths|files|file_paths|filePaths|affected_paths|affectedPaths|source_paths|destination_paths)$/.test(key)&&typeof child==='string')paths.push(child);
        else collect(child);
      }
      else if(item&&typeof item==='object') {
        if(/^(?:changes|files|paths)$/.test(key))paths.push(...Object.keys(item));
        collect(item);
      }
    }
  };
  collect(input);
  if(input.changes&&typeof input.changes==='object'&&!Array.isArray(input.changes))paths.push(...Object.keys(input.changes));
  const patch=input.patch??input.patch_text??input.input;
  if(typeof patch==='string') {
    // The native apply_patch grammar exposes every add/update/delete and move.
    const matches=[...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)];
    if(!patch.startsWith('*** Begin Patch')||!matches.length||!patch.trimEnd().endsWith('*** End Patch'))return [];
    paths.push(...matches.map(m=>m[1]!));
  }
  return [...new Set(paths)];
}
export function toolPolicy(tool:string,input:Record<string,unknown>,directory:string,contextPaths:string[],scope:string[]=[]):'allow'|'ask'|'deny' {
  if(typeof tool!=='string'||!input||typeof input!=='object')return 'deny';
  let cwd=directory;
  try {
    const aliases=[input.cwd,input.workdir,input.working_directory].filter(value=>value!==undefined);
    if(aliases.some(value=>typeof value!=='string'))return 'deny';
    const directories=aliases.map(value=>fs.realpathSync.native(path.resolve(directory,value as string)));
    if(new Set(directories).size>1)return 'deny';
    const supplied=aliases[0];
    if(supplied!==undefined) {
      if(typeof supplied!=='string')return 'deny';
      cwd=path.resolve(directory,supplied);
      const root=fs.realpathSync.native(directory),relative=path.relative(root,cwd);
      if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))return 'deny';
      let current=root;for(const part of relative.split(path.sep).filter(Boolean)){current=path.join(current,part);if(part.toLowerCase()==='.git'||fs.lstatSync(current).isSymbolicLink())return 'deny';}
      cwd=fs.realpathSync.native(cwd);
    }
  }catch{return 'deny';}
  if(/^(Agent|Task|Skill|CronCreate|CronDelete|CronList|EnterWorktree|ExitWorktree|TeamCreate|SendMessage)$/i.test(tool))return 'deny';
  if(/bash|shell|commandexecution|exec_command|write_stdin/i.test(tool)) {
    if(input.run_in_background===true||input.background===true)return 'deny';
    const raw=input.command??input.cmd??input.chars;
    const command=Array.isArray(raw)?raw.join(' '):String(raw??'');
    if(!command||forbiddenCommand(command)||/(?:^|[\\/\s'"=])\.git(?:[\\/\s'";]|$)/i.test(command))return 'deny';
    // Direct references to protected rules cannot be elevated by a shell grant.
    // Arbitrary approved programs remain programs, not an OS sandbox.
    if(contextPaths.some(file=>command.toLowerCase().includes(file.toLowerCase())||command.toLowerCase().includes(path.resolve(directory,file).toLowerCase())))return 'deny';
    return 'ask';
  }
  if(/^(Read|Glob|Grep|LS|List|TodoWrite)$/i.test(tool))return 'allow';
  const paths=mutationPaths(tool,input);
  if(paths) {
    if(!paths.length)return 'deny';
    if(paths.some(file=>(process.platform==='win32'?file.replaceAll('\\','/'):file).split('/').includes('..')))return 'deny';
    try{for(const file of paths)checkedMutationPath(directory,path.resolve(cwd,file),scope,contextPaths);return /^mcp__/i.test(tool)?'ask':'allow';}catch{return 'deny';}
  }
  if(/^mcp__/i.test(tool)||/webfetch|websearch/i.test(tool))return 'ask';
  return 'ask';
}
export const permissionKey=(tool:string,input:unknown)=>digest({tool,input});
export const workerPermissionKey=(spec:WorkerSpec,tool:string,input:unknown)=>digest({tool,input,cwd:path.resolve(spec.directory),attempt:spec.id,policy:workerPolicyHash(spec)});
