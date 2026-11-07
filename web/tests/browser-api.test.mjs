import assert from 'node:assert/strict';
import test from 'node:test';
import {createBrowserApi} from '../lib/browser-api.mjs';
import {DataResponseError,readJSON} from '../lib/transport.mjs';

test('edge HTML rate limits become bounded readable retry windows without interpreting the page',async()=>{
  for(const [header,expected]of [[null,15000],['10',10000],['999999',300000]]){
    const headers={'content-type':'text/html',...(header===null?{}:{'retry-after':header})};
    await assert.rejects(readJSON(new Response('<!doctype html><p>limited</p>',{status:429,headers})),
      error=>error.code==='EDGE_RATE_LIMITED'&&error.status===429&&error.retryAfterMs===expected&&!error.message.includes('<'));
  }
});

test('one edge block pauses new browser requests across panels and permits recovery at the deadline',async()=>{
  let time=1000,calls=0;
  const api=createBrowserApi({now:()=>time,fetcher:async()=>{
    if(++calls===1)throw new DataResponseError('edge',{code:'EDGE_RATE_LIMITED',status:429,retryAfterMs:10000});
    return {fresh:true};
  }});
  await assert.rejects(api('/api/book'),{code:'EDGE_RATE_LIMITED'});
  time+=5000;
  await assert.rejects(api('/api/workspace/position-review'),error=>error.retryAfterMs===5000);
  assert.equal(calls,1);
  time+=5000;
  assert.deepEqual(await api('/api/book'),{fresh:true});
  assert.equal(calls,2);
});

test('a research JSON allowance does not block unrelated paper requests',async()=>{
  const api=createBrowserApi({fetcher:async path=>{
    if(path.endsWith('/research'))throw new DataResponseError('research limit',{code:'HTTP_ERROR',status:429});
    return {paper:true};
  }});
  await assert.rejects(api('/api/research'),{status:429});
  assert.deepEqual(await api('/api/book'),{paper:true});
});
