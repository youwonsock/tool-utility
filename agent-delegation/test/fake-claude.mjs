import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const argv=process.argv.slice(2);
const version=argv.find(arg=>arg.startsWith('--native-version='))?.split('=')[1]??'2.1.296';
if(argv.includes('--version')){console.log(`${version} (Claude Code)`);process.exit(0);}
const session=argv[argv.indexOf('--session-id')+1]??'mock-session';
const send=frame=>process.stdout.write(`${JSON.stringify(frame)}\n`);
const audit=event=>{if(process.env.FAKE_AUDIT)fs.appendFileSync(process.env.FAKE_AUDIT,`${JSON.stringify({...event,cwd:process.cwd(),platform:'claude-code',pid:process.pid})}\n`);};
let action={},timer,pending;
// Saves like the real CLI: a sibling temporary file is visible to watchers before the rename.
const save=async(file,data)=>{
  fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
  const temporary=`${file}.tmp.${process.pid}.78d4486ba9cb`;
  fs.writeFileSync(temporary,data);await new Promise(resolve=>setTimeout(resolve,50));fs.renameSync(temporary,file);
};
const finish=async()=>{
  for(const [file,data]of Object.entries(action.files??{}))await save(file,data);
  send({type:'assistant',session_id:session,parent_tool_use_id:null,uuid:'reply_mock',message:{role:'assistant',model:'fake-model',content:[{type:'text',text:action.summary??'Mock implementation finished.'}],usage:{input_tokens:1,output_tokens:1}}});
  send({type:'result',subtype:'success',session_id:session,is_error:false,result:action.summary??'Mock implementation finished.',num_turns:1,duration_ms:1,duration_api_ms:0,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});audit({event:'finished'});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
  const frame=JSON.parse(line);
  if(frame.type==='control_request'){
    const kind=frame.request.subtype;
    const response=kind==='initialize'?{commands:[],agents:[],models:[{value:'fake-model',displayName:'Fake',description:'Mock'},{value:'sonnet',displayName:'Alias',description:'Mock supported alias with a mismatched resolved model'}],account:{},hooks_applied:!argv.includes('--incompatible-policy'),claude_code_version:version}:kind==='mcp_status'?{mcpServers:[]}:kind==='get_context_usage'?{model:'fake-model',categories:[],totalTokens:0,maxTokens:200000,rawMaxTokens:200000,percentage:0,gridRows:[],memoryFiles:[],mcpTools:[],agents:[]}:{};
    send({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response}});
    if(kind==='initialize')audit({event:'session'});if(kind==='interrupt')clearTimeout(timer);return;
  }
  if(frame.type==='control_response'&&pending&&frame.response.request_id===pending){if(frame.response.response?.behavior==='deny')action.files={};pending=undefined;timer=setTimeout(finish,10);return;}
  if(frame.type==='user'){
    const text=typeof frame.message.content==='string'?frame.message.content:frame.message.content.map(p=>p.text??'').join('\n');
    const matches=[...text.matchAll(/FAKE_ACTION:(.+)/g)];action=JSON.parse(matches.at(-1)?.[1]??'{}');audit({event:'prompt',id:frame.uuid});
    send({type:'system',subtype:'init',session_id:session,cwd:process.cwd(),tools:['Read','Write','Edit','Bash','AskUserQuestion'],mcp_servers:[],model:'fake-model',permissionMode:'default'});
    send(frame);
    if(action.input||action.permission){pending='permission_mock';send({type:'control_request',request_id:pending,request:{subtype:'can_use_tool',tool_name:action.permission?.tool??(action.input==='question'?'AskUserQuestion':'WebFetch'),tool_use_id:'tool_mock',input:action.permission?.input??(action.input==='question'?{questions:[{question:'Proceed?',header:'Test',options:[]}]}:{url:'https://example.invalid'})}});}
    else timer=setTimeout(finish,action.delay??10);
  }
});
