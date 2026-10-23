import path from 'node:path';
import { invariant, type InputRequest } from '../types.js';
import { writeJson, digest } from '../io.js';
import { workerEnvironment } from '../profiles.js';
import { connection, workerPermissionKey, toolPolicy } from './policy.js';
import { spawnRuntime, stopOwned } from './process.js';
import { JsonRpcPeer, type RpcFrame } from './json-rpc.js';
import type { Answer, BackendContext, Observation, WorkerBackend } from './contract.js';
import { executableVersion } from './version.js';
import { assertScopeMonitor, scopeMonitorHealthy } from '../scope.js';

function toml(value:unknown):string {
  if(typeof value==='string')return JSON.stringify(value);
  if(typeof value==='boolean'||typeof value==='number')return String(value);
  if(Array.isArray(value))return `[${value.map(toml).join(',')}]`;
  invariant(value&&typeof value==='object','CONFIG','Unsupported native configuration value.');
  return `{${Object.entries(value).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>`${JSON.stringify(k)}=${toml(v)}`).join(',')}}`;
}
function quote(value:string) {
  if(process.platform==='win32'){invariant(!/["%\r\n]/.test(value),'PATH','Native hook path cannot be quoted safely.');return `"${value}"`;}
  return `'${value.replaceAll("'","'\\''")}'`;
}
export class CodexBackend implements WorkerBackend {
  private peer?:JsonRpcPeer;
  private frames:RpcFrame[]=[];
  private pending=new Map<string,{frame:RpcFrame;input:InputRequest}>();
  private answered=new Map<string,string>();
  private confirmed=new Set<string>();
  private accepted=false;
  private complete=false;
  private error?:string;
  private thread?:any;
  private model?:string;
  constructor(private context:BackendContext){}
  private receive(frame:RpcFrame) {
    const {state,save,spec}=this.context;
    this.frames.push(frame);
    const p=frame.params??{};
    if(p.threadId&&p.threadId!==state.session_id)return;
    if(frame.method==='serverRequest/resolved') {
      for(const [key,pending]of this.pending)if(String(pending.frame.id)===String(p.requestId))this.pending.delete(key);
      if(!this.complete){const key=this.answered.get(String(p.requestId));if(key)this.confirmed.add(key);}
    }
    if(frame.method==='turn/started'){state.turn_id=p.turn?.id;save();}
    if(frame.method==='turn/completed'){this.complete=true;this.error=p.turn?.error?.message??(p.turn?.status!=='completed'?`Native turn ${p.turn?.status}.`:undefined);}
    if(frame.method==='item/started'&&p.item?.type==='userMessage'&&p.item.id===state.prompt_id)this.accepted=true;
    if(frame.id===undefined||!frame.method)return;
    const id=`input_${digest({method:frame.method,id:frame.id,session:state.session_id}).slice(0,32)}`;
    const question=frame.method==='item/tool/requestUserInput'||frame.method==='mcpServer/elicitation/request';
    const supported=['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request'];
    if(!supported.includes(frame.method)) {
      this.error=`Unsupported native server request: ${frame.method}`;
      this.peer?.write({id:frame.id,error:{code:-32601,message:'Worker backend does not support this request.'}});return;
    }
    const decision=question?'ask':this.permissionDecision(frame.method,p);
    if(!question&&decision!=='ask') {
      this.peer!.write({id:frame.id,result:frame.method==='item/permissions/requestApproval'?{permissions:{},scope:'turn'}:{decision:decision==='deny'?'decline':'accept'}});return;
    }
    if(frame.method==='mcpServer/elicitation/request') {
      const server=p.serverName??p.server_name;
      if(server&&!spec.resources.some(r=>r.connection.name===server)){this.peer!.write({id:frame.id,result:{action:'decline'}});this.error='Undeclared MCP server requested input.';return;}
    }
    const logical={...p};delete logical.threadId;delete logical.turnId;delete logical.itemId;
    const input:InputRequest={id,kind:question?'question':'permission',details:p,supported_decisions:question?['answer','reject']:['once','always','reject'],
      ...(question?{}:{grant_key:workerPermissionKey(spec,frame.method,logical)})};
    this.pending.set(id,{frame,input});
  }
  private permissionDecision(method:string,params:Record<string,any>) {
    const {spec,state}=this.context;
    if(!scopeMonitorHealthy(spec,state))return 'deny';
    if(method==='item/permissions/requestApproval')return 'deny'; // Native broad grants cannot override the path policy.
    if(method==='item/commandExecution/requestApproval') {
      if(typeof params.command!=='string'&&!Array.isArray(params.command))return 'deny';
      return toolPolicy('exec_command',params,spec.directory,spec.context.map(c=>c.path),spec.scope);
    }
    if(method==='item/fileChange/requestApproval')return toolPolicy('fileChange',params,spec.directory,spec.context.map(c=>c.path),spec.scope);
    return 'ask';
  }
  private async launch(overrides:Record<string,unknown>) {
    const {spec}=this.context;
    const args=[...spec.executable_args,...(spec.worker?.native_profile?['--profile',spec.worker.native_profile]:[]),
      ...Object.entries(overrides).flatMap(([key,value])=>['-c',`${key}=${toml(value)}`]),'app-server','--listen','stdio://'];
    const runtime=await spawnRuntime(this.context,spec.executable,args,workerEnvironment(spec.worker!));
    this.peer=new JsonRpcPeer(runtime.child,frame=>this.receive(frame));
    const initialization=await this.peer.request('initialize',{clientInfo:{name:'delegate-worker',version:'1.0.0'},capabilities:{experimentalApi:true}});
    invariant(typeof initialization?.userAgent==='string','BACKEND_API','Codex initialize API returned an incompatible response.');
    this.peer.write({method:'initialized'});
  }
  async start() {
    const {spec,state,save}=this.context;
    const version=await executableVersion(spec);
    const features={multi_agent:false,multi_agent_v2:false,apps:false,plugins:false,remote_plugin:false,goals:false,memories:false,browser_use:false,computer_use:false,image_generation:false,code_mode_host:false,hooks:false};
    // Probe configuration without starting a thread or model; stop it before the owned execution server.
    await this.launch({features});
    const initial=(await this.peer!.request('config/read',{cwd:spec.directory,includeLayers:false})).config;
    invariant(initial&&typeof initial==='object','BACKEND_API','Codex config/read API returned an incompatible response.');
    invariant(await stopOwned(this.context),'STOP_UNCERTAIN','Codex configuration probe did not stop.');
    const mcp:Record<string,unknown>=Object.fromEntries(Object.keys(initial.mcp_servers??{}).map(name=>[name,{enabled:false}]));
    for(const resource of spec.resources) {
      const c=connection(resource,spec.directory);
      invariant(c.type!=='sse','MCP_POLICY','Codex requires stdio or streamable HTTP resources.');
      mcp[resource.connection.name]=c.type==='stdio'?{command:c.command,args:c.args,env:c.env,enabled:true}:{url:c.url,http_headers:c.headers,enabled:true};
    }
    const cli=spec.host_executable??path.resolve(process.argv[1]!);
    const hookCommand=[process.execPath,cli,'policy-hook',spec.job_dir].map(quote).join(' ');
    const hooks:Record<string,unknown>=Object.fromEntries(Object.keys(initial.hooks??{}).map(event=>[event,[]]));
    hooks.PreToolUse=[{matcher:'.*',hooks:[{type:'command',command:hookCommand,timeout:15}]}];
    const overrides={features:{...features,hooks:true,default_mode_request_user_input:true},mcp_servers:mcp,hooks,web_search:'disabled',approval_policy:'on-request',approvals_reviewer:'user'};
    await this.launch(overrides);
    const effective=(await this.peer!.request('config/read',{cwd:spec.directory,includeLayers:false})).config;
    invariant(effective&&typeof effective==='object','BACKEND_API','Codex config/read API returned an incompatible response.');
    invariant(Object.entries(overrides.features).every(([key,value])=>effective.features?.[key]===value)&&effective.web_search==='disabled','MCP_POLICY','Effective Codex feature policy differs.');
    invariant(effective.approval_policy==='on-request'&&effective.approvals_reviewer==='user','MCP_POLICY','Effective Codex approval policy differs.');
    const actualHooks=effective.hooks?.PreToolUse;
    const hookCheck=Array.isArray(actualHooks)&&actualHooks.length===1&&actualHooks[0].matcher==='.*'&&actualHooks[0].hooks?.length===1
      &&actualHooks[0].hooks[0].type==='command'&&actualHooks[0].hooks[0].command===hookCommand&&actualHooks[0].hooks[0].async!==true;
    writeJson(path.join(spec.job_dir,'hook-policy.json'),{confirmed:hookCheck,groups:Array.isArray(actualHooks)?actualHooks.map((g:any)=>({keys:Object.keys(g),matcher:g.matcher,handlers:g.hooks?.map((h:any)=>({keys:Object.keys(h),type:h.type,command_matches:h.command===hookCommand,async:h.async}))})):null});
    invariant(hookCheck,'MCP_POLICY','Effective Codex tool hook differs.');
    const allowed=new Set(spec.resources.map(r=>r.connection.name));
    invariant(Object.entries(effective.mcp_servers??{}).every(([name,cfg])=>(cfg as any).enabled===false||allowed.has(name)),'MCP_POLICY','Undeclared Codex MCP server remains enabled.');
    for(const name of allowed) {
      const expected=mcp[name] as Record<string,unknown>,observed=effective.mcp_servers?.[name];
      for(const [key,value]of Object.entries(expected))if(value!==undefined)invariant(digest(observed?.[key])===digest(value),'MCP_POLICY','Effective Codex resource differs from its verified profile.');
    }
    this.model=typeof spec.model==='string'?spec.model:typeof initial.model==='string'&&initial.model.length?initial.model:undefined;
    state.backend='codex';state.backend_version=version;save();
  }
  async createSession() {
    const {spec,state,save}=this.context;
    writeJson(path.join(spec.job_dir,'session-intent.json'),{at:Date.now(),id:spec.id,ephemeral:false});
    // Durable owned threads support thread/read(includeTurns); ephemeral threads
    // reject that API after an accepted prompt. Never retry a turn to recover it.
    const response=await this.peer!.request('thread/start',{cwd:spec.directory,model:this.model??null,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write',ephemeral:false,
      developerInstructions:'Implement only the assigned task. Do not delegate, commit, change branches, or modify protected context files.'});
    invariant(response.thread?.id&&response.approvalPolicy==='on-request'&&response.approvalsReviewer==='user','MCP_POLICY','Native thread did not retain worker approval policy.');
    invariant(typeof response.model==='string'&&response.model.length>0&&(this.model===undefined||response.model===this.model),'MODEL_UNAVAILABLE','Codex did not resolve the requested model. No substitute model will be dispatched.');
    state.session_id=response.thread.id;state.model=response.model;this.thread=response.thread;save();
  }
  async dispatch(prompt:string,requestID:string) {
    const {state,save,spec}=this.context;assertScopeMonitor(spec,state);
    const response=await this.peer!.request('turn/start',{threadId:state.session_id,clientUserMessageId:requestID,input:[{type:'text',text:prompt,text_elements:[]}]});
    state.turn_id=response.turn?.id;this.accepted=true;save();
  }
  async observe():Promise<Observation> {
    if(this.context.state.session_id) {
      const response=await this.peer!.request('thread/read',{threadId:this.context.state.session_id,includeTurns:true});
      this.thread=response.thread;
      const turn=this.thread.turns?.find((t:any)=>t.id===this.context.state.turn_id)??this.thread.turns?.at(-1);
      if(turn){this.accepted ||= turn.items?.some((i:any)=>i.type==='userMessage'&&i.id===this.context.state.prompt_id)??false;
        if(['completed','failed','interrupted'].includes(turn.status)){this.complete=true;this.error??=turn.error?.message??(turn.status==='completed'?undefined:`Native turn ${turn.status}.`);}}
    }
    const summary=this.thread?.turns?.flatMap((t:any)=>t.items??[]).filter((i:any)=>i.type==='agentMessage').map((i:any)=>i.text).join('\n');
    return {accepted:this.accepted,complete:this.complete&&!this.pending.size,inputs:[...this.pending.values()].map(p=>p.input),transcript:{thread:this.thread,events:this.frames},summary,error:this.error,reply_confirmations:[...this.confirmed]};
  }
  async reply(input:InputRequest,answer:Answer):Promise<'uncertain'> {
    const pending=this.pending.get(input.id);invariant(pending,'INPUT','Native request is no longer pending.');
    const {frame}=pending,p=frame.params??{};let result:unknown;
    invariant(input.kind==='question'||answer.decision==='reject'||this.permissionDecision(frame.method!,p)!=='deny','MCP_POLICY','Permission no longer satisfies the hard worker policy.');
    if(frame.method==='item/tool/requestUserInput') {
      const questions=p.questions??[];
      invariant(answer.decision==='reject'||answer.answers?.length===questions.length,'INPUT','Answer count differs from question count.');
      result={answers:Object.fromEntries(questions.map((q:any,i:number)=>[q.id,{answers:answer.decision==='reject'?[]:answer.answers![i]}]))};
    } else if(frame.method==='mcpServer/elicitation/request') {
      if(answer.decision==='reject')result={action:'decline'};
      else {
        const schema=p.requestedSchema??p.requested_schema;
        invariant(schema?.type==='object'&&schema.properties,'BACKEND_UNSUPPORTED','Only object-form MCP elicitation is supported.');
        const entries=Object.entries(schema.properties) as [string,any][];
        invariant(answer.answers?.length===entries.length,'INPUT','MCP answer count differs from the form.');
        const content=Object.fromEntries(entries.map(([key,field],i)=>{
          const raw=answer.answers![i]![0]??'';
          const value=field.type==='boolean'?raw==='true':field.type==='number'||field.type==='integer'?Number(raw):field.type==='array'?answer.answers![i]:raw;
          invariant(!['number','integer'].includes(field.type)||Number.isFinite(value),'INPUT','Invalid numeric form answer.');return [key,value];
        }));result={action:'accept',content};
      }
    }else if(frame.method==='item/permissions/requestApproval')result={permissions:answer.decision==='reject'?{}:p.permissions,scope:'turn'};
    else result={decision:answer.decision==='reject'?'decline':'accept'};
    this.answered.set(String(frame.id),input.id);this.peer!.write({id:frame.id,result});this.pending.delete(input.id);return 'uncertain';
  }
  async reconcile(){return {session_present:!!this.context.state.session_id,prompt_present:this.accepted,turn_id:this.context.state.turn_id,complete:this.complete};}
  async cancel(){if(this.context.state.session_id&&this.context.state.turn_id)await this.peer?.request('turn/interrupt',{threadId:this.context.state.session_id,turnId:this.context.state.turn_id},5000).catch(()=>undefined);}
  async confirmStopped(){return stopOwned(this.context);}
}
