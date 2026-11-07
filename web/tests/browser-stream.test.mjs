import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserStreams} from '../lib/browser-stream.mjs';
import {createBrowserApi} from '../lib/browser-api.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=text=>new Response(text,{headers:{'content-type':'text/event-stream'}});
function failure(open,path='/api/portfolio/stream?tickers=TEST-A'){
  return new Promise(resolve=>{const stream=open(path);stream.onerror=error=>{stream.close();resolve(error);};});
}

test('fragmented SSE preserves named events, UTF-8, comments, multiline data and event identity',async()=>{
  const text='\uFEFF: keepalive\r\nid: quote-1\r\nevent: book\r\ndata: café\r\ndata: second line\r\n\r\n',encoded=new TextEncoder().encode(text),seen=[];
  let request;
  const open=createBrowserStreams({base:'https://predictir.test',fetcher:async(url,options)=>{
    request={url,options};return new Response(new ReadableStream({start(controller){for(let i=0;i<encoded.length;i+=3)controller.enqueue(encoded.slice(i,i+3));controller.close();}}),{headers:{'content-type':'text/event-stream'}});
  }});
  await new Promise(resolve=>{const stream=open('/api/stream?ticker=TEST-A');stream.addEventListener('book',event=>{seen.push(event);stream.close();resolve();});});
  assert.deepEqual(seen,[{type:'book',data:'café\nsecond line',lastEventId:'quote-1'}]);
  assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.cache,'no-store');assert.equal(request.options.redirect,'error');
  assert.equal(request.options.headers.Accept,'text/event-stream');
  await failure(open,'/api/stream?ticker=TEST-A');
  assert.equal(request.options.headers['Last-Event-ID'],'quote-1');
});

test('JSON stream capacity Retry-After blocks both stream consumers while snapshots still work',async()=>{
  let time=1000,calls=0;
  const api=createBrowserApi({now:()=>time,fetcher:async()=>({snapshot:true})});
  const open=createBrowserStreams({api,now:()=>time,fetcher:async()=>{calls++;return Response.json({error:'Streaming capacity is full'},{status:429,headers:{'Retry-After':'15'}});}});
  const first=await failure(open);assert.equal(first.retryAfterMs,15000);assert.equal(first.status,429);
  time+=5000;
  const second=await failure(open,'/api/stream?ticker=TEST-B');assert.equal(second.retryAfterMs,10000);assert.equal(calls,1);
  assert.deepEqual(await api('/api/workspace/portfolio-books'),{snapshot:true});
  time+=10000;await failure(open);assert.equal(calls,2);
});

test('HTTP-date Retry-After is respected and HTML edge limits also pause ordinary API requests',async()=>{
  let time=Date.parse('2026-11-07T21:00:00Z'),apiCalls=0,streamCalls=0;
  const api=createBrowserApi({now:()=>time,fetcher:async()=>{apiCalls++;return {fresh:true};}});
  const open=createBrowserStreams({api,now:()=>time,fetcher:async()=>{streamCalls++;return new Response('<html>limited</html>',{status:429,headers:{'content-type':'text/html','Retry-After':new Date(time+60000).toUTCString()}});}});
  assert.equal((await failure(open)).retryAfterMs,60000);
  await assert.rejects(api('/api/book'),error=>error.status===429&&error.retryAfterMs===60000);assert.equal(apiCalls,0);
  time+=30000;assert.equal((await failure(open)).retryAfterMs,30000);assert.equal(streamCalls,1);
  time+=30000;assert.deepEqual(await api('/api/book'),{fresh:true});
});

test('an existing API edge cooldown prevents opening a stream before its deadline',async()=>{
  let calls=0,time=1000;
  const api=createBrowserApi({now:()=>time});api.pauseFor(12000);
  const open=createBrowserStreams({api,now:()=>time,fetcher:async()=>{calls++;return response('');}});
  assert.equal((await failure(open)).retryAfterMs,12000);assert.equal(calls,0);
  time+=12000;assert.equal((await failure(open)).code,'STREAM_ENDED');assert.equal(calls,1);
});

test('server retry directive is retained after a normal EOF and unknown fields are ignored',async()=>{
  const open=createBrowserStreams({fetcher:async()=>response(': heartbeat\nunknown: ignored\nretry: 17000\ndata: ready\n\n')});
  let data;
  const error=await new Promise(resolve=>{const stream=open('/api/stream');stream.onmessage=event=>{data=event.data;};stream.onerror=error=>{stream.close();resolve(error);};});
  assert.equal(data,'ready');assert.equal(error.retryAfterMs,17000);assert.equal(error.code,'STREAM_ENDED');
});

test('closing an idle stream aborts the request, cancels its reader and suppresses late errors',async()=>{
  let options,cancelled=0,errors=0;
  const open=createBrowserStreams({fetcher:async(url,value)=>{options=value;return new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}});}});
  const stream=open('/api/stream');stream.onerror=()=>errors++;await tick();stream.close();await tick();
  assert.equal(options.signal.aborted,true);assert.equal(cancelled,1);assert.equal(errors,0);assert.equal(stream.readyState,2);
});

test('closing during connection cancels a late response without dispatching errors',async()=>{
  let resolveResponse,cancelled=0,options,errors=0;
  const open=createBrowserStreams({fetcher:(url,value)=>{options=value;return new Promise(resolve=>{resolveResponse=resolve;});}});
  const stream=open('/api/stream');stream.onerror=()=>errors++;await tick();stream.close();
  resolveResponse(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}}));await tick();
  assert.equal(options.signal.aborted,true);assert.equal(cancelled,1);assert.equal(errors,0);
});

test('empty data lines still count against the frame bound',async()=>{
  let cancelled=0,remaining=131073;
  const open=createBrowserStreams({fetcher:async()=>new Response(new ReadableStream({pull(controller){if(remaining--<=0)return controller.close();controller.enqueue(new TextEncoder().encode('data:\n'));},cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}})});
  assert.equal((await failure(open)).code,'STREAM_FRAME_TOO_LARGE');assert.equal(cancelled,1);
});

test('a large network chunk containing many individually valid frames is processed completely',async()=>{
  const frames=12000,text=Array.from({length:frames},(_,index)=>'data: quote-'+index+'\n\n').join('');
  assert.ok(text.length>131072);let messages=0;
  const open=createBrowserStreams({fetcher:async()=>response(text)});
  const error=await new Promise(resolve=>{const stream=open('/api/stream');stream.onmessage=()=>messages++;stream.onerror=error=>{stream.close();resolve(error);};});
  assert.equal(messages,frames);assert.equal(error.code,'STREAM_ENDED');
});

test('listener exceptions are reported without rejecting the transport cleanup',async()=>{
  const previous=globalThis.reportError,reported=[];globalThis.reportError=error=>reported.push(error.message);
  try{
    const open=createBrowserStreams({fetcher:async()=>response('data: quote\n\n')});
    const stream=open('/api/stream');stream.onmessage=()=>{throw new Error('Listener fixture');};stream.onerror=()=>{stream.close();throw new Error('Error listener fixture');};
    await tick();await tick();assert.deepEqual(reported,['Listener fixture','Error listener fixture']);assert.equal(stream.readyState,2);
  }finally{globalThis.reportError=previous;}
});

test('oversized frames and non-SSE responses are cancelled instead of retained or parsed as events',async()=>{
  let cancelled=0;
  const open=createBrowserStreams({fetcher:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+'x'.repeat(131073)));},cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}})});
  assert.equal((await failure(open)).code,'STREAM_FRAME_TOO_LARGE');assert.equal(cancelled,1);
  const invalid=createBrowserStreams({fetcher:async()=>Response.json({error:'Private link required'},{status:401})});
  const error=await failure(invalid);assert.equal(error.code,'STREAM_RESPONSE');assert.equal(error.status,401);
});
