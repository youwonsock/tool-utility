import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import spawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Options, Query, PermissionResult } from './claude-contract.js';
import { invariant, type InputRequest } from '../types.js';
import { writeJson, digest } from '../io.js';
import { workerEnvironment } from '../profiles.js';
import { connection, toolPolicy, permissionKey } from './policy.js';
import { beginProcess, registerProcess, stopOwned } from './process.js';
import type { Answer, BackendContext, Observation, WorkerBackend } from './contract.js';
import { reportedVersion } from './version.js';
import { loadSdk, requireSdkMethods, runtimeFault, findExecutable } from '../runtime.js';

class PromptQueue<T> implements AsyncIterable<T> {
  private waiting?: (value:IteratorResult<T>)=>void;
  private values:T[]=[];
  private ended=false;
  push(value:T){invariant(!this.ended,'BACKEND_DISCONNECTED','Prompt queue is closed.');if(this.waiting){const fn=this.waiting;this.waiting=undefined;fn({value,done:false});}else this.values.push(value);}
  close(){this.ended=true;this.waiting?.({value:undefined,done:true});this.waiting=undefined;}
  [Symbol.asyncIterator](){return {next:():Promise<IteratorResult<T>>=>this.values.length?Promise.resolve({value:this.values.shift()!,done:false}):this.ended?Promise.resolve({value:undefined,done:true}):new Promise(resolve=>{this.waiting=resolve;})};}
}
export class ClaudeBackend implements WorkerBackend {
  private query?:Query;
  private queue=new PromptQueue<any>();
  private messages:any[]=[];
  private pending=new Map<string,{input:InputRequest;resolve:(value:PermissionResult)=>void;native:Record<string,unknown>;native_id:string}>();
  private registrations:Promise<unknown>[]=[];
  private complete=false;
  private accepted=false;
  private error?:string;
  private answered=new Map<string,string>();
  private confirmed=new Set<string>();
  private initialization?:any;
  constructor(private context:BackendContext){}
  async start() {
    const {spec,state,save}=this.context;
    const sdk=await loadSdk(spec.worker,state.runtime!);
    const sessionID=crypto.randomUUID();
    writeJson(path.join(spec.job_dir,'session-intent.json'),{session_id:sessionID,at:Date.now()});
    state.session_id=sessionID;state.native_request_id=crypto.randomUUID();save();
    const env={...workerEnvironment(spec.worker!),CLAUDE_CODE_RESUME_INTERRUPTED_TURN:'0',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1'};
    const resources=new Set(spec.resources.map(r=>r.connection.name));
    const mcpServers=Object.fromEntries(spec.resources.map(r=>[r.connection.name,connection(r,spec.directory)]));
    const policy=(name:string,input:Record<string,unknown>)=>{
      if(name.startsWith('mcp__')&&!resources.has(name.split('__')[1]!))return 'deny';
      return toolPolicy(name,input,spec.directory,spec.context.map(c=>c.path));
    };
    const options:Options={
      cwd:spec.directory,sessionId:sessionID,model:typeof spec.model==='string'?spec.model:undefined,
      env,settingSources:[],plugins:[],strictMcpConfig:true,mcpServers,
      tools:['Read','Write','Edit','Glob','Grep','Bash','TodoWrite','AskUserQuestion','WebFetch','WebSearch'],
      disallowedTools:['Agent','Task','Skill','CronCreate','CronDelete','CronList','EnterWorktree','ExitWorktree','TeamCreate','SendMessage'],
      permissionMode:'default',maxTurns:100,
      pathToClaudeCodeExecutable:spec.executable,
      hooks:{PreToolUse:[{hooks:[async (input:any)=>{
        if(input.hook_event_name!=='PreToolUse')return {};
        const decision=policy(input.tool_name,input.tool_input as Record<string,unknown>);
        return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:decision,permissionDecisionReason:'Delegation worker policy.'}};
      }]}]},
      canUseTool:async (name:string,input:Record<string,unknown>,details:any)=>{
        const decision=policy(name,input);
        if(decision==='deny')return {behavior:'deny',message:'Operation is forbidden by the delegation worker policy.'};
        if(decision==='allow'&&name!=='AskUserQuestion')return {behavior:'allow',updatedInput:input};
        const nativeID=details.toolUseID??digest({name,input});
        const id=`input_${digest({sessionID,nativeID}).slice(0,32)}`;
        const question=name==='AskUserQuestion';
        const request:InputRequest={id,kind:question?'question':'permission',details:question?{questions:input.questions}:{tool:name,input},
          supported_decisions:question?['answer','reject']:['once','always','reject'],...(question?{}:{grant_key:permissionKey(name,input)})};
        return new Promise<PermissionResult>(resolve=>{
          this.pending.set(id,{input:request,resolve,native:input,native_id:nativeID});
          details.signal.addEventListener('abort',()=>{this.pending.delete(id);resolve({behavior:'deny',message:'Execution was cancelled.',interrupt:true});},{once:true});
        });
      },
      spawnClaudeCodeProcess:(options:any)=>{
        const intent=options.delegationIntent??beginProcess(this.context);
        const same=(a:string|undefined,b:string)=>{try{return !!a&&fs.realpathSync.native(a)===fs.realpathSync.native(b);}catch{return false;}};
        const command=findExecutable(options.command,options.env,options.cwd);
        const direct=same(command,spec.executable),javascript=same(command,process.execPath)&&same(options.args[0],spec.executable);
        if(!direct&&!javascript){writeJson(path.join(spec.job_dir,'process-records',`${intent}.json`),{failed:true,stopped:true});throw runtimeFault('CLI_INCOMPATIBLE',spec.worker,'Claude SDK tried to launch a different CLI.');}
        const args=javascript?[options.args[0],...spec.executable_args,...options.args.slice(1)]:[...spec.executable_args,...options.args];
        const child=spawn(options.command,args,{cwd:options.cwd,env:options.env,detached:process.platform!=='win32',windowsHide:true,stdio:['pipe','pipe','pipe']});
        const log=fs.createWriteStream(path.join(spec.job_dir,'server.log'),{flags:'a',mode:0o600});
        child.stderr!.on('data',data=>log.write(data));child.once('close',()=>log.end());
        this.registrations.push(registerProcess(this.context,child,intent).catch(error=>{this.error=(error as Error).message;}));
        return child as ChildProcessWithoutNullStreams;
      },
    };
    const launchIntent=beginProcess(this.context);
    let claimed=false;
    const spawnConfigured=options.spawnClaudeCodeProcess as (options:any)=>ChildProcessWithoutNullStreams;
    options.spawnClaudeCodeProcess=(options:any)=>{const first=!claimed;claimed=true;return spawnConfigured({...options,...(first?{delegationIntent:launchIntent}:{})});};
    this.query=sdk.query({prompt:this.queue,options});
    requireSdkMethods(this.query,['initializationResult','getContextUsage','setModel','interrupt','close'],spec.worker);
    if(typeof this.query?.[Symbol.asyncIterator]!=='function')throw runtimeFault('SDK_INCOMPATIBLE',spec.worker,'Claude SDK query does not provide an async message stream.');
    void (async()=>{
      try{
        for await(const message of this.query!){
          this.messages.push(message);
          const m=message as any;
          if(m.type==='system'&&m.subtype==='init') {
            invariant(!m.tools?.some((name:string)=>/^(Agent|Task|Skill|CronCreate|TeamCreate|SendMessage)$/.test(name)),'MCP_POLICY','Forbidden tools remain available.');
            invariant(!m.mcp_servers?.some((s:any)=>!resources.has(s.name)),'MCP_POLICY','An undeclared MCP server remains available.');
            if(m.model){invariant(state.model===undefined||state.model===m.model,'MODEL_UNAVAILABLE','Claude changed the resolved worker model.');state.model=m.model;save();}
          }
          if(m.type==='user'&&m.uuid===state.native_request_id)this.accepted=true;
          if(m.type==='assistant')this.accepted=true;
          if(m.type==='user')for(const block of Array.isArray(m.message?.content)?m.message.content:[])if(block.type==='tool_result')for(const [id,nativeID]of this.answered)if(nativeID===block.tool_use_id)this.confirmed.add(id);
          if(m.type==='result') {this.accepted=true;this.complete=true;if(m.is_error||m.subtype!=='success')this.error=m.errors?.join('\n')??m.subtype;else for(const id of this.answered.keys())this.confirmed.add(id);}
        }
      }catch(e){this.error=(e as Error).message;}
    })();
    this.initialization=await this.query.initializationResult();
    await Promise.all(this.registrations);
    invariant(claimed&&state.processes?.length,'SDK_INCOMPATIBLE','Claude SDK did not use the required owned CLI spawn hook.');
    reportedVersion(this.initialization.claude_code_version,'Claude Code');
    invariant(this.initialization.hooks_applied===true,'MCP_POLICY','Claude did not confirm worker hook registration.');
    const usage=await this.query.getContextUsage({detail:'summary'});
    invariant(typeof usage.model==='string'&&usage.model.length>0,'MODEL_UNAVAILABLE','Claude did not identify its current native model.');
    const family=typeof spec.model==='string'&&/^(sonnet|opus|haiku)(?:\[1m\])?$/.exec(spec.model)?.[1];
    const resolvedAlias=family&&usage.model.includes(family)&&this.initialization.models?.some((m:any)=>m.value===spec.model);
    invariant(spec.model===undefined||spec.model===usage.model||resolvedAlias,'MODEL_UNAVAILABLE','Requested Claude model was not resolved. Use a resolved model ID when its alias cannot be verified. No fallback was used.');
    await this.query.setModel(usage.model);
    state.backend='claude-code';state.backend_version=this.initialization.claude_code_version;
    state.model=usage.model;
    save();
  }
  async createSession(){invariant(this.context.state.session_id,'SESSION_UNCERTAIN','Claude session intent is missing.');}
  async dispatch(prompt:string,_requestID:string) {
    this.queue.push({type:'user',session_id:this.context.state.session_id,uuid:this.context.state.native_request_id,message:{role:'user',content:prompt},parent_tool_use_id:null});
  }
  async observe():Promise<Observation> {
    const result=this.messages.filter(m=>m.type==='result').at(-1);
    const texts=this.messages.filter(m=>m.type==='assistant').flatMap(m=>m.message?.content??[]).filter(p=>p.type==='text').map(p=>p.text);
    const inputs=[...this.pending.values()].map(p=>p.input);
    return {accepted:this.accepted,complete:this.complete&&!inputs.length,inputs,transcript:this.messages,
      summary:result?.result??texts.join('\n'),usage:result?.usage,error:this.error,reply_confirmations:[...this.confirmed]};
  }
  async reply(input:InputRequest,answer:Answer):Promise<'uncertain'> {
    const pending=this.pending.get(input.id);invariant(pending,'INPUT','Native input is no longer pending.');
    this.answered.set(input.id,pending.native_id);
    if(answer.decision==='reject') {this.pending.delete(input.id);pending.resolve({behavior:'deny',message:'The supervisor rejected this operation.'});return 'uncertain';}
    if(input.kind==='question') {
      const questions=pending.native.questions as {question:string}[];
      invariant(answer.answers&&answer.answers.length===questions.length,'INPUT','Answer count does not match question count.');
      pending.resolve({behavior:'allow',updatedInput:{...pending.native,answers:Object.fromEntries(questions.map((q,i)=>[q.question,answer.answers![i]!.join(', ')]))}});
    }else pending.resolve({behavior:'allow',updatedInput:pending.native});
    this.pending.delete(input.id);return 'uncertain';
  }
  async reconcile(){return {session_present:!!this.context.state.session_id,prompt_present:this.accepted,complete:this.complete,inputs:this.pending.size};}
  async cancel(){if(typeof this.query?.interrupt==='function')await this.query.interrupt().catch(()=>undefined);for(const pending of this.pending.values())pending.resolve({behavior:'deny',message:'Execution cancelled.',interrupt:true});this.pending.clear();}
  async confirmStopped(){await Promise.allSettled(this.registrations);const stopped=await stopOwned(this.context);this.queue.close();if(typeof this.query?.close==='function')this.query.close();return stopped;}
}
