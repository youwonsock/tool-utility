import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const argv=process.argv.slice(2);
const version=argv.find(arg=>arg.startsWith('--native-version='))?.split('=')[1]??'0.146.0';
if(argv.includes('--version')){console.log(`codex-cli ${version}`);process.exit(0);}
const send=frame=>process.stdout.write(`${JSON.stringify(frame)}\n`);
const overrides={};
function value(text){let quoted=false,escaped=false,result='';for(const char of text){if(char==='"'&&!escaped)quoted=!quoted;result+=char==='='&&!quoted?':':char;escaped=char==='\\'&&!escaped;}return JSON.parse(result);}
for(let i=0;i<argv.length;i++)if(argv[i]==='-c'){const raw=argv[++i],split=raw.indexOf('=');overrides[raw.slice(0,split)]=value(raw.slice(split+1));}
const config={model:argv.includes('--default-model-null')?null:'fake-model',mcp_servers:{inherited:{enabled:true}},...overrides};
if(argv.includes('--untrusted-unsupported')&&config.approval_policy==='untrusted'){console.error('approval_policy = "untrusted" is no longer supported');process.exit(1);}
if(argv.includes('--incompatible-policy')&&config.hooks)config.web_search='enabled';
const thread={id:'thread_mock',turns:[]};let action={},timer,pending;
const audit=event=>{if(process.env.FAKE_AUDIT)fs.appendFileSync(process.env.FAKE_AUDIT,`${JSON.stringify({...event,cwd:process.cwd(),platform:'codex',pid:process.pid})}\n`);};
const finish=()=>{
  for(const [file,data]of Object.entries(action.files??{})){fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});fs.writeFileSync(file,data);}
  const turn=thread.turns.at(-1);turn.status='completed';turn.items.push({id:'reply_mock',type:'agentMessage',text:action.summary??'Mock implementation finished.'});
  send({method:'turn/completed',params:{threadId:thread.id,turn}});audit({event:'finished'});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
  const frame=JSON.parse(line),p=frame.params??{},reply=result=>send({id:frame.id,result});
  if(!frame.method){if(pending&&String(frame.id)===String(pending.id)){send({method:'serverRequest/resolved',params:{threadId:thread.id,requestId:frame.id}});pending=undefined;timer=setTimeout(finish,10);}return;}
  if(frame.method==='initialize')return reply({userAgent:'mock-codex'});
  if(frame.method==='initialized')return;
  if(frame.method==='config/read')return reply({config,origins:{}});
  if(frame.method==='thread/start'){audit({event:'session'});return reply({thread,model:p.model==='unavailable-model'?'fake-model':p.model??config.model??'fake-model',modelProvider:'fake',cwd:process.cwd(),approvalPolicy:p.approvalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite'}});}
  if(frame.method==='thread/read')return reply({thread});
  if(frame.method==='turn/start'){
    const text=p.input.map(i=>i.text??'').join('\n'),matches=[...text.matchAll(/FAKE_ACTION:(.+)/g)];action=JSON.parse(matches.at(-1)?.[1]??'{}');
    audit({event:'prompt',id:p.clientUserMessageId});
    const turn={id:'turn_mock',status:'inProgress',items:[{id:p.clientUserMessageId,type:'userMessage',content:p.input}]};thread.turns.push(turn);
    send({method:'turn/started',params:{threadId:thread.id,turn}});
    if(action.drop_response)send({id:frame.id,error:{code:-32000,message:'Acknowledgement lost after dispatch'}});else reply({turn});
    if(action.input){pending={id:'input_mock',method:action.input==='question'?'item/tool/requestUserInput':'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:turn.id,itemId:'tool_mock',questions:[{id:'q1',question:'Proceed?',header:'Test',options:[]}],command:'node read-only-probe'}};send(pending);}
    else timer=setTimeout(finish,action.delay??10);return;
  }
  if(frame.method==='turn/interrupt'){clearTimeout(timer);return reply({});}
  send({id:frame.id,error:{code:-32601,message:`Unsupported mock method: ${frame.method}`}});
});
