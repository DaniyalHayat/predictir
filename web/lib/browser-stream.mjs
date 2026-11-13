import {DataResponseError,retryAfterMilliseconds} from './transport.mjs';

export function createBrowserStreams({base='',fetcher=fetch,api,now=Date.now}={}){
  let resumeAt=0;
  const identities=new Map(),remaining=()=>Math.max(0,resumeAt-now(),api?.cooldownRemaining?.()||0);
  return function open(path){
    const controller=new AbortController(),listeners=new Map();
    let closed=false,reader,retry=3000,eventType='',data=[],eventId=identities.get(path)||'',buffer='',hasData=false,frameSize=0;
    const stream={readyState:0,onmessage:null,onerror:null,
      addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(listener);},
      removeEventListener(type,listener){listeners.get(type)?.delete(listener);},
      close(){if(closed)return;closed=true;stream.readyState=2;controller.abort();reader?.cancel().catch(()=>{});}
    };
    const emit=(type,event)=>{
      if(closed)return;
      for(const listener of [stream['on'+type],...(listeners.get(type)||[])])if(typeof listener==='function'){
        try{listener(event);}catch(error){globalThis.reportError?.(error);}
      }
    };
    const line=value=>{
      if(value.length+frameSize>131072)throw new DataResponseError('Live update exceeded the frame limit.',{code:'STREAM_FRAME_TOO_LARGE'});
      if(value===''){
        if(hasData)emit(eventType||'message',{type:eventType||'message',data:data.join('\n'),lastEventId:eventId});
        data=[];eventType='';hasData=false;frameSize=0;return;
      }
      if(value.startsWith(':'))return;
      const separator=value.indexOf(':'),field=separator<0?value:value.slice(0,separator);
      let content=separator<0?'':value.slice(separator+1);if(content.startsWith(' '))content=content.slice(1);
      if(field==='data'){
        frameSize+=content.length+1;
        if(frameSize>131072)throw new DataResponseError('Live update exceeded the frame limit.',{code:'STREAM_FRAME_TOO_LARGE'});
        data.push(content);hasData=true;
      }
      else if(field==='event')eventType=content;
      else if(field==='id'&&!content.includes('\0')){
        if(content.length>1024)throw new DataResponseError('Live event identity exceeded the limit.',{code:'STREAM_FRAME_TOO_LARGE'});
        eventId=content;identities.delete(path);identities.set(path,content);
        if(identities.size>64)identities.delete(identities.keys().next().value);
      }
      else if(field==='retry'&&/^\d+$/.test(content))retry=Math.max(1000,Math.min(300000,Number(content)));
    };
    queueMicrotask(async()=>{
      try{
        if(closed)return;
        const wait=remaining();
        if(wait)throw new DataResponseError('Live updates are waiting before reconnecting.',{status:429,code:'STREAM_RATE_LIMITED',retryAfterMs:wait});
        const response=await fetcher(base+path,{headers:{Accept:'text/event-stream',...(eventId?{'Last-Event-ID':eventId}:{})},
          credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
        if(closed){await response.body?.cancel();return;}
        if(response.status===429){
          const retryAfterMs=retryAfterMilliseconds(response.headers.get('retry-after'),{now:now(),maximum:86400000});
          resumeAt=Math.max(resumeAt,now()+retryAfterMs);
          if(/text\/html/i.test(response.headers.get('content-type')||''))api?.pauseFor?.(retryAfterMs);
          await response.body?.cancel();
          throw new DataResponseError('Live updates are temporarily limited. Quotes remain available.',{status:429,code:'STREAM_RATE_LIMITED',retryAfterMs});
        }
        if(!response.ok||!/text\/event-stream/i.test(response.headers.get('content-type')||'')||!response.body){
          await response.body?.cancel();throw new DataResponseError('Live updates are unavailable. Quotes remain available.',{status:response.status,code:'STREAM_RESPONSE'});
        }
        stream.readyState=1;emit('open',{type:'open'});reader=response.body.getReader();
        const decoder=new TextDecoder();let first=true;
        while(!closed){
          const {value,done}=await reader.read();if(done)break;
          let text=decoder.decode(value,{stream:true});if(first){text=text.replace(/^\uFEFF/,'');first=false;}buffer+=text;
          let offset=0;
          for(let index=0;index<buffer.length;index++){
            if(buffer[index]!=='\n'&&buffer[index]!=='\r')continue;
            if(buffer[index]==='\r'&&index===buffer.length-1)break;
            line(buffer.slice(offset,index));if(buffer[index]==='\r'&&buffer[index+1]==='\n')index++;offset=index+1;
          }
          buffer=buffer.slice(offset);
          if(buffer.length+frameSize>131072)throw new DataResponseError('Live update exceeded the frame limit.',{code:'STREAM_FRAME_TOO_LARGE'});
        }
        if(!closed)throw new DataResponseError('Live update connection ended.',{code:'STREAM_ENDED'});
      }catch(error){
        if(!closed){stream.readyState=2;error.retryAfterMs=Math.max(error.retryAfterMs||retry,remaining());emit('error',error);}
      }finally{
        try{await reader?.cancel();}catch{}
        reader?.releaseLock();
      }
    });
    return stream;
  };
}
