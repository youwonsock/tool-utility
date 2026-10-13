import path from 'node:path';
import { invariant, type Resource } from '../types.js';
import { digest, samePath } from '../io.js';

export function forbiddenCommand(command:string):boolean {
  return /(?:^|[\s;&|/\\])(?:codex|opencode|claude|kilo|codex-opencode)(?:[.\s;&|]|$)/i.test(command)
    || /\bgit\s+(?:push|reset|checkout|switch|commit|branch\s+-[dD])\b/i.test(command);
}
export type McpConnection={type:'stdio';command:string;args:string[];env?:Record<string,string>}|{type:'http'|'sse';url:string;headers?:Record<string,string>};
export function connection(resource:Resource,directory:string):McpConnection {
  invariant(!/codex-opencode|delegat/i.test(resource.connection.name+JSON.stringify(resource.connection.config)),'RECURSION','Delegation MCP cannot be exposed to a worker.');
  const expand=(v:unknown):any=>typeof v==='string'?v.replaceAll('{{worktree}}',directory):Array.isArray(v)?v.map(expand):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,expand(x)])):v;
  const c=expand(resource.connection.config);
  const allowed=new Set(['type','command','args','environment','env','url','headers','enabled','timeout','oauth']);
  invariant(Object.keys(c).every(key=>allowed.has(key)),'MCP_POLICY','Resource connection has unsupported configuration fields.');
  if(c.type==='local'||c.type==='stdio'||(c.command&&!c.url)) {
    const command=Array.isArray(c.command)?c.command[0]:c.command;
    const args=Array.isArray(c.command)?c.command.slice(1):c.args??[];
    invariant(typeof command==='string'&&Array.isArray(args)&&args.every((v:unknown)=>typeof v==='string'),'MCP_POLICY','Invalid stdio resource connection.');
    const env=c.environment??c.env;
    invariant(!env||Object.values(env).every(v=>typeof v==='string'),'MCP_POLICY','Resource environment must contain strings.');
    return {type:'stdio',command,args,...(env?{env}:{})};
  }
  invariant(['remote','http','sse'].includes(c.type)&&typeof c.url==='string','MCP_POLICY','Unsupported MCP resource transport.');
  const url=new URL(c.url);invariant(['http:','https:'].includes(url.protocol),'MCP_POLICY','Unsupported MCP resource URL.');
  invariant(!c.headers||Object.values(c.headers).every(v=>typeof v==='string'),'MCP_POLICY','Resource headers must contain strings.');
  return {type:c.type==='sse'?'sse':'http',url:c.url,...(c.headers?{headers:c.headers}:{})};
}
export function toolPolicy(tool:string,input:Record<string,unknown>,directory:string,contextPaths:string[]):'allow'|'ask'|'deny' {
  if(/^(Agent|Task|Skill|CronCreate|CronDelete|CronList|EnterWorktree|ExitWorktree|TeamCreate|SendMessage)$/i.test(tool))return 'deny';
  if(/bash|shell|commandexecution|exec_command|write_stdin/i.test(tool)) {
    if(input.run_in_background===true||input.background===true)return 'deny';
    const raw=input.command??input.cmd??input.chars;
    const command=Array.isArray(raw)?raw.join(' '):String(raw??'');
    return forbiddenCommand(command)?'deny':'allow';
  }
  if(/^mcp__/i.test(tool)||/webfetch|websearch/i.test(tool))return 'ask';
  if(/write|edit|notebook/i.test(tool)) {
    const file=input.file_path??input.path??input.notebook_path;
    if(typeof file!=='string')return 'ask';
    const resolved=path.resolve(directory,file),relative=path.relative(directory,resolved).replaceAll('\\','/');
    if(relative.startsWith('../')||path.isAbsolute(relative)||contextPaths.some(p=>samePath(resolved,path.resolve(directory,p))))return 'deny';
    return 'allow';
  }
  if(/^(Read|Glob|Grep|LS|List|TodoWrite)$/i.test(tool))return 'allow';
  return 'ask';
}
export const permissionKey=(tool:string,input:unknown)=>digest({tool,input});
