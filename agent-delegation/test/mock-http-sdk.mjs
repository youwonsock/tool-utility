// A test-only public SDK contract over the fake native HTTP server.
export function createOpencodeClient(options){
  const request=async (method,pathname,body,config={})=>{
    const response=await (options.fetch??fetch)(new URL(pathname,options.baseUrl),{method,headers:{...options.headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:config.signal??AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`Native HTTP ${response.status}`);
    return {data:response.status===204?undefined:await response.json()};
  };
  return {
    global:{health:config=>request('GET','/global/health',undefined,config)},
    provider:{list:(_={},config)=>request('GET','/provider',undefined,config)},
    session:{
      create:(params,config)=>request('POST','/session',params,config),
      list:(_={},config)=>request('GET','/session',undefined,config),
      get:(params,config)=>request('GET',`/session/${params.sessionID}`,undefined,config),
      messages:(params,config)=>request('GET',`/session/${params.sessionID}/message`,undefined,config),
      status:(_={},config)=>request('GET','/session/status',undefined,config),
      promptAsync:(params,config)=>request('POST',`/session/${params.sessionID}/prompt_async`,params,config),
      abort:(params,config)=>request('POST',`/session/${params.sessionID}/abort`,{},config),
    },
    permission:{list:(_={},config)=>request('GET','/permission',undefined,config),reply:(params,config)=>request('POST',`/permission/${params.requestID}/reply`,params,config)},
    question:{list:(_={},config)=>request('GET','/question',undefined,config),reply:(params,config)=>request('POST',`/question/${params.requestID}/reply`,params,config),reject:(params,config)=>request('POST',`/question/${params.requestID}/reject`,{},config)},
  };
}
export const createKiloClient=createOpencodeClient;
