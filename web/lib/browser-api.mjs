import {DataResponseError,fetchJSON} from './transport.mjs';

export function createBrowserApi({base='',fetcher=fetchJSON,now=Date.now}={}){
  let resumeAt=0;
  return async function api(path,options={}){
    if(options.signal?.aborted)throw options.signal.reason;
    const remaining=resumeAt-now();
    if(remaining>0)throw new DataResponseError(`Site protection paused requests. Try again in ${Math.ceil(remaining/1000)} seconds.`,
      {status:429,code:'EDGE_RATE_LIMITED',retryAfterMs:remaining});
    try{return await fetcher(base+path,{cache:'no-store',source:'Predictir',...options});}
    catch(error){
      if(error.code==='EDGE_RATE_LIMITED')resumeAt=Math.max(resumeAt,now()+Math.max(1000,Math.min(300000,error.retryAfterMs||15000)));
      throw error;
    }
  };
}
