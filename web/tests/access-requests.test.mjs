import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {handleAccessRequest} from '../lib/access-requests.mjs';
import {publicAccessPath,SHARE_COOKIE,shareCookieAuthorized} from '../lib/private-access.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const ownerCode=randomBytes(32).toString('base64url');
const origin='https://predictir.dev';
const env={
  PREDICTIR_SHARE_ACCESS:'1',
  PREDICTIR_ACCESS_REQUESTS:'1',
  PREDICTIR_SHARE_TOKEN_HASH:hash('existing-share-fixture'),
  PREDICTIR_ACCESS_OWNER_HASH:hash(ownerCode),
  MARKET_EDGE_SECRET:'edge-fixture-key-for-tests-only-1234567',
  MARKET_BACKEND_URL:'https://backend.example.test',
};
const cookiePair=(headers,name)=>headers.getSetCookie().find(value=>value.startsWith(name+'='))?.split(';',1)[0];

function call(operation,body,{cookie='',from=origin,options={},query=''}={}){
  return handleAccessRequest(new Request(origin+'/api/access/'+operation+query,{method:'POST',
    headers:{Origin:from,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),
    operation,{env, ...options});
}

test('only the originating browser can enter after an authenticated owner approves',async()=>{
  const pending=new Map();
  let forwarded=0;
  const options={fetcher:async(url,init)=>{
    forwarded++;
    assert.equal(url.href,'https://backend.example.test/api/internal/access-requests');
    assert.equal(init.redirect,'error');
    assert.equal(init.headers['x-market-edge-secret'],env.MARKET_EDGE_SECRET);
    assert.ok(!('cookie' in init.headers));
    const data=JSON.parse(init.body);
    if(data.action==='request'){
      assert.match(data.receiptHash,/^[a-f0-9]{64}$/);
      assert.match(data.ipHash,/^[a-f0-9]{64}$/);
      pending.set(data.receiptHash,{id:'00000000-0000-4000-8000-000000000001',name:data.name,email:data.email,status:'pending'});
      return Response.json({status:'pending'},{status:202});
    }
    if(data.action==='status')return Response.json({status:pending.get(data.receiptHash)?.status||'missing'});
    if(data.action==='list')return Response.json({requests:[...pending.values()]});
    if(data.action==='decide'){
      const match=[...pending.values()].find(row=>row.id===data.id);
      match.status=data.decision;
      return Response.json({status:match.status});
    }
    assert.fail('unexpected access action');
  }};
  const visitor=await call('request',{name:' Example Visitor ',email:'Visitor@Example.test'},{options});
  const receipt=cookiePair(visitor.headers,'__Host-predictir-access-receipt');
  assert.equal(visitor.status,202);
  assert.match(visitor.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);
  assert.deepEqual(await visitor.json(),{status:'pending'});
  const before=await call('request/status',undefined,{cookie:receipt,options});
  assert.deepEqual(await before.json(),{status:'pending'});
  assert.equal(await cookiePair(before.headers,SHARE_COOKIE),undefined);
  const unauthenticated=await call('manage',{action:'list'},{cookie:receipt,options});
  assert.equal(unauthenticated.status,401);
  assert.equal(forwarded,2);

  const signedIn=await call('manage/sign-in',{code:ownerCode},{options});
  const owner=cookiePair(signedIn.headers,'__Host-predictir-access-owner');
  assert.equal(signedIn.status,204);
  assert.ok(!owner.includes(ownerCode));
  const list=await call('manage',{action:'list'},{cookie:owner,options});
  assert.equal(list.headers.get('cache-control'),'private, no-store');
  const {requests}=await list.json();
  assert.equal(requests[0].name,'Example Visitor');
  assert.equal(requests[0].email,'visitor@example.test');
  assert.equal((await call('manage',{action:'decide',id:requests[0].id,decision:'approved'},{cookie:owner,options})).status,200);
  const differentBrowser=await call('request/status',undefined,{options});
  assert.deepEqual(await differentBrowser.json(),{status:'missing'});
  const forgedReceipt=await call('request/status',undefined,{cookie:receipt+'x',options});
  assert.deepEqual(await forgedReceipt.json(),{status:'missing'});
  const entry=await call('request/status',undefined,{cookie:receipt,options});
  assert.equal(entry.status,204);
  assert.equal(shareCookieAuthorized(cookiePair(entry.headers,SHARE_COOKIE),env),true);
  assert.match(entry.headers.getSetCookie()[1],/Max-Age=0/);
  assert.equal(forwarded,5);
});

test('requests are closed when disabled and reject cross-site or oversized input without reaching storage',async()=>{
  const fetcher=async()=>assert.fail('must not reach storage');
  const options={fetcher};
  assert.equal((await call('request',{name:'A',email:'a@example.test'},{from:'https://other.test',options})).status,403);
  assert.equal((await call('request',{name:'A',email:'a@example.test'},{query:'?token=bad',options})).status,403);
  assert.equal((await call('request',{name:'x'.repeat(1200),email:'a@example.test'},{options})).status,413);
  assert.equal((await call('request',{name:'A',email:'invalid'},{options})).status,400);
  assert.equal((await call('manage/sign-in',{code:'wrong'},{options})).status,401);
  assert.equal((await call('request',{},{options:{fetcher,env:{...env,PREDICTIR_ACCESS_REQUESTS:'0'}}})).status,404);
  assert.equal(publicAccessPath('/api/access/request'),true);
  assert.equal(publicAccessPath('/api/internal/access-requests'),false);
  assert.equal(publicAccessPath('/api/access/manage/other'),false);
});
