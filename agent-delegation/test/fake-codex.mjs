import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const argv=process.argv.slice(2);
const version=argv.find(arg=>arg.startsWith('--native-version='))?.split('=')[1]??'0.162.1';
if(argv.includes('--version')){console.log(`codex-cli ${version}`);process.exit(0);}
const send=frame=>process.stdout.write(`${JSON.stringify(frame)}\n`);
const overrides={};
function value(text){let quoted=false,escaped=false,result='';for(const char of text){if(char==='"'&&!escaped)quoted=!quoted;result+=char==='='&&!quoted?':':char;escaped=char==='\\'&&!escaped;}return JSON.parse(result);}
for(let i=0;i<argv.length;i++)if(argv[i]==='-c'){const raw=argv[++i],split=raw.indexOf('='),key=raw.slice(0,split),parsed=value(raw.slice(split+1));if(key==='windows.sandbox')overrides.windows={...overrides.windows,sandbox:parsed};else overrides[key]=parsed;}
const configuredWindowsMode=argv.find(arg=>arg.startsWith('--windows-sandbox='))?.slice('--windows-sandbox='.length);
const config={model:argv.includes('--default-model-null')?null:'fake-model',mcp_servers:{inherited:{enabled:true}},...(configuredWindowsMode?{windows:{sandbox:configuredWindowsMode}}:{}),...overrides};
if(argv.includes('--ignore-windows-sandbox'))delete config.windows;
if(argv.includes('--untrusted-unsupported')&&config.approval_policy==='untrusted'){console.error('approval_policy = "untrusted" is no longer supported');process.exit(1);}
if(argv.includes('--incompatible-policy')&&config.hooks)config.web_search='enabled';
const hookKey=argv.includes('--windows-hook-key')?'C:\\<session-flags>\\config.toml:pre_tool_use:0:0':'/<session-flags>/config.toml:pre_tool_use:0:0';
const hookEntry=()=>{
  const hook=config.hooks?.PreToolUse?.[0]?.hooks?.[0],hash=`sha256:${crypto.createHash('sha256').update(JSON.stringify(hook)).digest('hex')}`;
  return {key:hookKey,eventName:'preToolUse',handlerType:'command',command:hook?.command,async:hook?.async===true,matcher:config.hooks?.PreToolUse?.[0]?.matcher,timeoutSec:hook?.timeout,
    source:'sessionFlags',sourcePath:'/<session-flags>/config.toml',enabled:true,currentHash:hash,trustStatus:!argv.includes('--untrusted-hook')&&config.hooks?.state?.[hookKey]?.trusted_hash===hash?'trusted':'untrusted'};
};
const guarded=(tool,input)=>{
  const hook=hookEntry();if(hook.trustStatus!=='trusted')return false;
  const result=spawnSync(hook.command,{cwd:process.cwd(),shell:true,input:JSON.stringify({hook_event_name:'PreToolUse',cwd:process.cwd(),tool_name:tool,tool_input:input}),encoding:'utf8',timeout:15000});
  const decision=(()=>{try{return JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision;}catch{return undefined;}})();
  audit({event:'hook',tool,decision});return result.status===0&&decision==='allow';
};
const thread={id:'thread_mock',turns:[]};let action={},timer,pending,ephemeral=false,dynamicTools=[],readErrors=0;
const audit=event=>{if(process.env.FAKE_AUDIT)fs.appendFileSync(process.env.FAKE_AUDIT,`${JSON.stringify({...event,cwd:process.cwd(),platform:'codex',pid:process.pid})}\n`);};
const finish=()=>{
  const files=Object.entries(action.files??{}),patch=['*** Begin Patch',...files.flatMap(([file,data])=>[`*** Add File: ${file}`,...String(data).split('\n').map(line=>`+${line}`)]),'*** End Patch'].join('\n');
  if(files.length&&(action.bypass_hook===true||guarded('apply_patch',{command:patch})))for(const [file,data]of files){fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});fs.writeFileSync(file,data);}
  const turn=thread.turns.at(-1);turn.status='completed';turn.items.push({id:'reply_mock',type:'agentMessage',text:action.summary??'Mock implementation finished.'});
  send({method:'turn/completed',params:{threadId:thread.id,turn}});audit({event:'finished'});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
  const frame=JSON.parse(line),p=frame.params??{},reply=result=>send({id:frame.id,result});
  if(!frame.method){if(pending&&String(frame.id)===String(pending.id)){if(frame.result?.decision==='decline'||frame.result?.success===false)action.files={};
    if(pending.method==='item/tool/call') {const item={id:pending.params.callId,type:'dynamicToolCall',tool:pending.params.tool,arguments:pending.params.arguments,status:'completed',...frame.result};thread.turns.at(-1).items.push(item);send({method:'item/completed',params:{threadId:thread.id,item}});audit({event:'dynamic_result',result:frame.result});}
    send({method:'serverRequest/resolved',params:{threadId:thread.id,requestId:frame.id}});pending=undefined;timer=setTimeout(finish,10);}return;}
  if(frame.method==='initialize')return reply({userAgent:'mock-codex'});
  if(frame.method==='initialized')return;
  if(frame.method==='config/read')return reply({config,origins:{}});
  if(frame.method==='hooks/list')return reply({data:[{cwd:process.cwd(),hooks:[hookEntry(),...(argv.includes('--extra-hook')?[{...hookEntry(),key:'inherited'}]:[])],warnings:[],errors:[]}]});
  if(frame.method==='thread/start'){
    ephemeral=p.ephemeral===true;dynamicTools=p.dynamicTools??[];audit({event:'session',ephemeral,dynamic_tools:dynamicTools.map(tool=>tool.name)});
    const windows=process.platform==='win32'||argv.includes('--windows-no-sandbox-fallback');
    const sandbox=argv.includes('--unsafe-sandbox')?{type:'dangerFullAccess'}:argv.includes('--opaque-sandbox')?{type:'unknown',opaque:'not a verified boundary'}
      :argv.includes('--external-sandbox')?{type:'externalSandbox',networkAccess:'restricted'}
      :argv.includes('--read-only-sandbox')||windows&&!config.windows?.sandbox?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite'};
    return reply({thread,model:p.model==='unavailable-model'?'fake-model':p.model??config.model??'fake-model',modelProvider:'fake',cwd:process.cwd(),approvalPolicy:p.approvalPolicy,approvalsReviewer:'user',sandbox});
  }
  if(frame.method==='thread/read'){
    if(ephemeral&&p.includeTurns)return send({id:frame.id,error:{code:-32600,message:'ephemeral threads do not support includeTurns'}});
    if(thread.turns.length&&(argv.includes('--empty-rollout-always')||argv.includes('--empty-rollout-once')&&readErrors++===0)) {
      const rollout=path.join(process.cwd(),`rollout-${thread.id}.jsonl`);return send({id:frame.id,error:{code:-32603,message:`failed to read thread: thread-store internal error: failed to read session metadata ${rollout}: rollout at ${rollout} is empty`}});
    }
    if(thread.turns.length&&(argv.includes('--list-turns-always')||argv.includes('--list-turns-once')&&readErrors++===0))return send({id:frame.id,error:{code:-32601,message:'list_turns is not supported yet'}});
    if(argv.includes('--unrelated-read-error'))return send({id:frame.id,error:{code:-32603,message:'failed to read thread: unrelated permanent metadata error'}});
    if(action.block_observe)return;return reply({thread});
  }
  if(frame.method==='turn/start'){
    const text=p.input.map(i=>i.text??'').join('\n'),matches=[...text.matchAll(/FAKE_ACTION:(.+)/g)];action=JSON.parse(matches.at(-1)?.[1]??'{}');
    audit({event:'prompt',id:p.clientUserMessageId});
    const turn={id:'turn_mock',status:'inProgress',items:[{id:p.clientUserMessageId,type:'userMessage',content:p.input}]};thread.turns.push(turn);
    send({method:'turn/started',params:{threadId:thread.id,turn}});
    if(action.drop_response)send({id:frame.id,error:{code:-32000,message:'Acknowledgement lost after dispatch'}});else reply({turn});
    if(action.dynamic_tool) {
      const {tool,arguments:args}=action.dynamic_tool;
      if(!dynamicTools.some(candidate=>candidate.name===tool)||!guarded(tool,args)){action.files={};timer=setTimeout(finish,10);return;}
      pending={id:'dynamic_mock',method:'item/tool/call',params:{threadId:thread.id,turnId:turn.id,callId:'call_mock',namespace:null,tool,arguments:args}};send(pending);
    } else if(action.input||action.permission){
      if(action.input==='question'&&!guarded('request_user_input',{questions:[{id:'q1',question:'Proceed?',header:'Test',options:[]}]})){action.files={};timer=setTimeout(finish,10);return;}
      pending={id:'input_mock',method:action.input==='question'?'item/tool/requestUserInput':action.permission?.method??'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:turn.id,itemId:'tool_mock',questions:[{id:'q1',question:'Proceed?',header:'Test',options:[]}],command:'node read-only-probe',...action.permission?.params}};send(pending);
    }
    else timer=setTimeout(finish,action.delay??10);return;
  }
  if(frame.method==='turn/interrupt'){clearTimeout(timer);return reply({});}
  send({id:frame.id,error:{code:-32601,message:`Unsupported mock method: ${frame.method}`}});
});
