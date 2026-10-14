import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Fault, invariant, type Platform, type RuntimeIdentity, type WorkerConfig } from './types.js';
import { digest, exec } from './io.js';
import { workerEnvironment } from './profiles.js';

export const sdkPackages: Partial<Record<Platform,{name:string;subpath:string;factory:string}>> = {
  opencode:{name:'@opencode-ai/sdk',subpath:'./v2/client',factory:'createOpencodeClient'},
  kilo:{name:'@kilocode/sdk',subpath:'./v2/client',factory:'createKiloClient'},
  'claude-code':{name:'@anthropic-ai/claude-agent-sdk',subpath:'.',factory:'query'},
};
const cliPackages: Record<Platform,string> = {opencode:'opencode-ai',kilo:'@kilocode/cli','claude-code':'@anthropic-ai/claude-code',codex:'@openai/codex'};
const envNames: Record<Platform,string> = {opencode:'OPENCODE',kilo:'KILO','claude-code':'CLAUDE',codex:'CODEX'};
type Discovery = {env?:NodeJS.ProcessEnv;global_root?:string|null;cwd?:string};
export function runtimeFault(code:string,worker:WorkerConfig,message:string,extra:Record<string,unknown>={}) {
  const sdk=sdkPackages[worker.platform];
  const guidance=`Install/configure ${worker.platform} yourself. Set AGENT_DELEGATION_${envNames[worker.platform]}_EXECUTABLE or a profile executable${sdk?`, and sdk_root (absolute ${sdk.name} package directory) or AGENT_DELEGATION_${envNames[worker.platform]}_SDK_ROOT`:''}. Run doctor again. No runtime was installed or substituted.`;
  return new Fault(code,message,{platform:worker.platform,package:sdk?.name,...extra,guidance});
}
const fingerprints=new Map<string,{stamp:string;hash:string}>();
function fingerprint(file:string) {
  const stat=fs.statSync(file,{bigint:true}),stamp=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const cached=fingerprints.get(file);if(cached?.stamp===stamp)return cached.hash;
  const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024);
  try {let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,count));}
  finally {fs.closeSync(fd);}
  const value=hash.digest('hex');fingerprints.set(file,{stamp,hash:value});return value;
}
function packageFingerprint(root:string) {
  const files:{path:string;hash:string}[]=[];
  const visit=(dir:string)=>{for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    if(['node_modules','.git','.cache'].includes(item.name)||item.name.endsWith('.log'))continue;
    const file=path.join(dir,item.name),relative=path.relative(root,file);
    if(item.isDirectory())visit(file);
    else if(item.isSymbolicLink())files.push({path:relative,hash:digest(fs.readlinkSync(file))});
    else if(item.isFile())files.push({path:relative,hash:fingerprint(file)});
  }};
  visit(root);return digest(files);
}
function regular(file:string,executable=false) {
  try {if(!fs.statSync(file).isFile())return false;fs.accessSync(file,executable&&process.platform!=='win32'?fs.constants.X_OK:fs.constants.R_OK);return true;}catch{return false;}
}
export function findExecutable(command:string,env:NodeJS.ProcessEnv=process.env,cwd=process.cwd()):string|undefined {
  const explicit=path.isAbsolute(command)||/[\\/]/.test(command);
  const search=explicit?[path.resolve(cwd,command)]:(env.PATH??env.Path??'').split(path.delimiter).filter(Boolean).map(dir=>path.resolve(dir,command));
  const extensions=process.platform==='win32'&&!path.extname(command)?['',...(env.PATHEXT??env.PathExt??'.COM;.EXE;.BAT;.CMD').split(';')]:[''];
  for(const file of search)for(const extension of extensions)if(regular(file+extension,true))return file+extension;
}
function cliPackageRoot(worker:WorkerConfig,cli:string) {
  const entries=[cli,...worker.executable_args.filter(arg=>path.isAbsolute(arg)&&regular(arg))];
  for(const entry of entries)for(let dir=path.dirname(fs.realpathSync.native(entry));;dir=path.dirname(dir)) {
    const manifest=path.join(dir,'package.json');
    if(regular(manifest)) {
      let name;try {name=JSON.parse(fs.readFileSync(manifest,'utf8')).name;}catch{break;}
      if(name===cliPackages[worker.platform])return dir;
      const native=typeof name==='string'&&[`${cliPackages[worker.platform]}-`,...(worker.platform==='opencode'?['opencode-']:[])].some(prefix=>name.startsWith(prefix));
      if(!native)break; // Native CLI assets may live below their owning CLI package.
    }
    if(path.dirname(dir)===dir)break;
  }
}
const globalRoots=new Map<string,Promise<string|undefined>>();
async function globalRoot(env:NodeJS.ProcessEnv) {
  const npm=findExecutable('npm',env);if(!npm)return undefined;
  const key=digest({npm,path:env.PATH??env.Path,prefix:env.npm_config_prefix??env.NPM_CONFIG_PREFIX});
  if(!globalRoots.has(key))globalRoots.set(key,(async()=>{
    try {const result=await exec(npm,['root','--global'],{env,timeout:10000,limit:65536});return result.code===0&&path.isAbsolute(result.stdout.trim())?result.stdout.trim():undefined;}catch{return undefined;}
  })());
  return globalRoots.get(key)!;
}
function exportTarget(value:unknown):string|undefined {
  if(typeof value==='string')return value;
  if(Array.isArray(value)){for(const item of value){const target=exportTarget(item);if(target)return target;}return undefined;}
  if(value&&typeof value==='object')for(const [condition,item]of Object.entries(value))if(['node','import','default','node-addons'].includes(condition)) {
    const target=exportTarget(item);if(target)return target;
  }
}
function entryTarget(info:any,subpath:string) {
  if(info.exports===undefined)return subpath==='.'&&typeof info.main==='string'?info.main:undefined;
  const exports=info.exports;
  if(typeof exports==='string'||Array.isArray(exports)||exports&&typeof exports==='object'&&!Object.keys(exports).some(key=>key.startsWith('.')))return subpath==='.'?exportTarget(exports):undefined;
  if(!exports||typeof exports!=='object')return undefined;
  if(Object.hasOwn(exports,subpath))return exportTarget(exports[subpath]);
  const patterns=Object.keys(exports).filter(key=>key.includes('*')).sort((a,b)=>b.indexOf('*')-a.indexOf('*')||b.length-a.length);
  for(const pattern of patterns){const [before,after]=pattern.split('*');if(subpath.startsWith(before!)&&subpath.endsWith(after!)){const target=exportTarget(exports[pattern]);return target?.replaceAll('*',subpath.slice(before!.length,after? -after.length:undefined));}}
}
export async function resolveRuntime(worker:WorkerConfig,options:Discovery={}):Promise<RuntimeIdentity> {
  const env=options.env??workerEnvironment(worker),command=findExecutable(worker.executable,env,options.cwd);
  if(!command)throw runtimeFault('CLI_NOT_FOUND',worker,`Selected ${worker.platform} executable was not found.`,{executable:worker.executable});
  const real=fs.realpathSync.native(command);
  const cli={path:command,real_path:real,args:[...worker.executable_args],hash:fingerprint(real),argument_files:worker.executable_args.filter(arg=>path.isAbsolute(arg)&&regular(arg)).map(file=>({path:fs.realpathSync.native(file),hash:fingerprint(file)}))};
  const required=sdkPackages[worker.platform];
  if(!required)return {cli};
  const explicit=worker.sdk_root??env[`AGENT_DELEGATION_${envNames[worker.platform]}_SDK_ROOT`];
  let candidate=explicit,source: 'profile'|'environment'|'cli'|'global'=worker.sdk_root?(worker.sdk_source??'profile'):'environment';
  if(!candidate) {
    const owned=cliPackageRoot(worker,real),near=owned&&path.join(owned,'node_modules',required.name);
    if(near&&fs.existsSync(near)){candidate=near;source='cli';}
    else {
      const global=options.global_root===undefined?await globalRoot(env):options.global_root;
      const direct=global&&path.join(global,required.name);
      if(direct&&fs.existsSync(direct)){candidate=direct;source='global';}
    }
  }
  if(!candidate||!path.isAbsolute(candidate)||!regular(path.join(candidate,'package.json')))throw runtimeFault('SDK_NOT_FOUND',worker,`Required local SDK ${required.name} was not found.`,{path:candidate??null,source});
  try {
    const root=fs.realpathSync.native(candidate),manifest=path.join(root,'package.json'),info=JSON.parse(fs.readFileSync(manifest,'utf8'));
    if(info.name!==required.name||typeof info.version!=='string')throw new Error(`Expected package ${required.name} with a version.`);
    const target=entryTarget(info,required.subpath);
    if(!target||info.exports!==undefined&&!target.startsWith('./'))throw new Error(`Required public ESM export ${required.subpath} is unavailable.`);
    const entry=path.resolve(root,target),relative=path.relative(root,entry);
    if(relative.startsWith('..')||path.isAbsolute(relative)||!regular(entry))throw new Error(`Required ESM entry ${required.subpath} is missing or invalid.`);
    return {cli,sdk:{name:required.name,root,entry:fs.realpathSync.native(entry),version:info.version,source,hash:digest({package:packageFingerprint(root),entry:fingerprint(entry)})}};
  }catch(error){throw runtimeFault('SDK_INCOMPATIBLE',worker,(error as Error).message,{path:candidate,source,required_export:required.subpath});}
}
function identity(runtime:RuntimeIdentity) {
  const {version:_,...cli}=runtime.cli;
  const sdk=runtime.sdk&&(({source:__,...rest})=>rest)(runtime.sdk);
  return digest({cli,sdk});
}
export function publicRuntime(runtime?:RuntimeIdentity) {
  if(!runtime)return undefined;
  const {path,real_path,hash,version}=runtime.cli;
  return {cli:{path,real_path,hash,version},sdk:runtime.sdk};
}
export async function assertRuntimeUnchanged(worker:WorkerConfig,expected:RuntimeIdentity) {
  try {
    const current=await resolveRuntime({...worker,...(expected.sdk?{sdk_root:expected.sdk.root}:{})});
    if(identity(current)===identity(expected)){if(current.sdk&&expected.sdk)current.sdk.source=expected.sdk.source;return current;}
    throw new Error('Selected executable or SDK identity changed.');
  }catch(error){throw runtimeFault('RUNTIME_CHANGED',worker,'The recorded execution environment is unavailable or changed. No model request was replayed.',{reason:(error as Error).message,expected:publicRuntime(expected)});}
}
// Called only in an owned worker/diagnostic process. Core services never import platform SDKs.
export async function loadSdk(worker:WorkerConfig,runtime:RuntimeIdentity):Promise<Record<string,any>> {
  const required=sdkPackages[worker.platform];
  invariant(required&&runtime.sdk,'SDK_NOT_FOUND','This adapter requires a local SDK.');
  try {
    const sdk=await import(pathToFileURL(runtime.sdk.entry).href);
    if(typeof sdk[required.factory]!=='function')throw new Error(`Required SDK function ${required.factory} is missing.`);
    return sdk;
  }catch(error){throw runtimeFault('SDK_INCOMPATIBLE',worker,`Cannot load ${required.name}: ${(error as Error).message}`,{path:runtime.sdk.root,required_api:required.factory});}
}
export function callSdkFactory(sdk:Record<string,any>,worker:WorkerConfig,options:unknown):any {
  const required=sdkPackages[worker.platform]!;
  try {return sdk[required.factory](options);}
  catch(error){if(error instanceof Fault)throw error;throw runtimeFault('SDK_INCOMPATIBLE',worker,`SDK ${required.factory} initialization failed: ${(error as Error).message}`,{required_api:required.factory,path:worker.runtime?.sdk?.root});}
}
export function requireSdkMethods(value:any,methods:string[],worker:WorkerConfig) {
  for(const method of methods){let owner=value;const parts=method.split('.');for(const key of parts.slice(0,-1))owner=owner?.[key];if(typeof owner?.[parts.at(-1)!]!=='function')throw runtimeFault('SDK_INCOMPATIBLE',worker,`Required SDK API ${method} is missing.`,{required_api:method});}
}
