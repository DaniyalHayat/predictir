import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {SHARE_COOKIE,SHARE_COOKIE_SECONDS,CANARY_COOKIE,CANARY_COOKIE_SECONDS,redeemShareAccess,logoutShareAccess,
  shareCookieAuthorized,shareAccessKind,privateAccessResponse,publicAccessPath} from '../lib/private-access.mjs';
import {proxyBackend} from '../lib/workspace/proxy.mjs';
import {assistantResponse} from '../lib/workspace/assistant.mjs';
import {assistantContext} from '../lib/workspace/assistant-context.mjs';
import {createMarketServer} from '../cloud/server.mjs';

const token=randomBytes(32).toString('base64url'),canaryToken=randomBytes(32).toString('base64url'),now=Date.parse('2026-11-07T12:00:00Z');
const hash=value=>createHash('sha256').update(value).digest('hex');
const env={PREDICTIR_SHARE_ACCESS:'1',PREDICTIR_SHARE_TOKEN_HASH:hash(token),PREDICTIR_CANARY_TOKEN_HASH:hash(canaryToken),MARKET_EDGE_SECRET:'fixture-edge-key-'.repeat(4)};
function request(value=token,{origin='https://predictir.dev',ip='192.0.2.10',url='https://predictir.dev/api/access/redeem',headers={}}={}){
  return new Request(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Forwarded-For':ip,...headers},body:JSON.stringify({token:value})});
}
async function cookie(ip='192.0.2.11',value=token){const response=await redeemShareAccess(request(value,{ip}),{env,now});assert.equal(response.status,204);return response.headers.get('set-cookie').split(';',1)[0];}
function environment(t){t.mock.method(Date,'now',()=>now);const keys=[...Object.keys(env),'MARKET_BACKEND_URL','ASSISTANT_SERVICE_SECRET','PREDICTIR_MODE'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));Object.assign(process.env,env);process.env.MARKET_BACKEND_URL='http://127.0.0.1:9876';process.env.ASSISTANT_SERVICE_SECRET='fixture-service-key-'.repeat(4);delete process.env.PREDICTIR_MODE;t.after(()=>{for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];});}

test('a fragment-delivered capability exchanges for a bounded HttpOnly cookie without reflecting the token',async()=>{
  const response=await redeemShareAccess(request(),{env,now}),set=response.headers.get('set-cookie');
  assert.equal(response.status,204);assert.equal(await response.text(),'');assert.ok(!set.includes(token));
  for(const attribute of ['Secure','HttpOnly','SameSite=Lax','Path=/','Max-Age='+SHARE_COOKIE_SECONDS])assert.ok(set.includes(attribute));
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.match(response.headers.get('x-robots-tag'),/noindex/);
  assert.equal(shareCookieAuthorized(set,env,now+1000),true);
});

test('tampering, duplicate cookies, expiry, verifier rotation and signing-key rotation revoke access',async()=>{
  const value=await cookie();
  assert.equal(shareCookieAuthorized(value+'x',env,now),false);
  assert.equal(shareCookieAuthorized(value+'; '+value,env,now),false);
  assert.equal(shareCookieAuthorized(value,env,now-30000),true);
  assert.equal(shareCookieAuthorized(value,env,now-61000),false);
  assert.equal(shareCookieAuthorized(value,env,now+SHARE_COOKIE_SECONDS*1000),false);
  assert.equal(shareCookieAuthorized(value,{...env,PREDICTIR_SHARE_TOKEN_HASH:'a'.repeat(64)},now),false);
  assert.equal(shareCookieAuthorized(value,{...env,MARKET_EDGE_SECRET:'replacement-fixture-key-'.repeat(3)},now),false);
  assert.equal(privateAccessResponse(new Request('https://predictir.dev/api/session'),env,now).status,401);
});

test('missing configuration fails closed and redemption rejects CSRF, query-token delivery and oversized bodies',async()=>{
  assert.equal((await redeemShareAccess(request(),{env:{PREDICTIR_SHARE_ACCESS:'1'},now})).status,503);
  assert.equal(shareCookieAuthorized('',{PREDICTIR_SHARE_ACCESS:'1'},now),false);
  assert.equal((await redeemShareAccess(request(token,{origin:'https://other.invalid'}),{env,now})).status,403);
  assert.equal((await redeemShareAccess(request(token,{url:'https://predictir.dev/api/access/redeem?token=forbidden'}),{env,now})).status,403);
  const bad=await redeemShareAccess(request('wrong',{ip:'192.0.2.12'}),{env,now});assert.equal(bad.status,401);assert.ok(!(await bad.text()).includes('wrong'));
  const large=await redeemShareAccess(request('x'.repeat(300),{ip:'192.0.2.13'}),{env,now});assert.equal(large.status,413);
});

test('redemption is rate limited and logout removes only the share cookie',async()=>{
  const statuses=[];for(let i=0;i<11;i++)statuses.push((await redeemShareAccess(request('wrong',{ip:'192.0.2.14'}),{env,now})).status);
  assert.equal(statuses.filter(value=>value===401).length,10);assert.equal(statuses.at(-1),429);
  const response=await logoutShareAccess(new Request('https://predictir.dev/api/access/logout',{method:'POST',headers:{Origin:'https://predictir.dev'}}),{env});
  assert.equal(response.status,204);assert.match(response.headers.get('set-cookie'),new RegExp('^'+SHARE_COOKIE+'=;'));assert.match(response.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await logoutShareAccess(new Request('https://predictir.dev/api/access/logout'),{env})).status,405);
});

test('preview links require allowed ingress before issuing a session cookie',async()=>{
  const vercel={...env,VERCEL:'1'};
  const allowed={'x-vercel-ip-country':'US','x-vercel-forwarded-for':'192.0.2.71'};
  for(const headers of [{}, {...allowed,'x-vercel-ip-country':'CN'}, {...allowed,'sec-fetch-site':'cross-site'}]){
    const denied=await redeemShareAccess(request(token,{headers}),{env:vercel,now});
    assert.equal(denied.status,403);
    assert.equal(denied.headers.has('set-cookie'),false);
  }
  assert.equal((await redeemShareAccess(request(canaryToken,{headers:allowed}),{env:vercel,now})).status,204);
  const azure={...env,PREDICTIR_MODE:'live'};
  const denied=await redeemShareAccess(request(token,{ip:'192.0.2.72'}),{env:azure,now,countryLookup:async()=> 'RU'});
  assert.equal(denied.status,403);
  assert.equal(denied.headers.has('set-cookie'),false);
  assert.equal((await redeemShareAccess(request(token,{ip:'192.0.2.72'}),{env:azure,now,countryLookup:async()=> 'US'})).status,204);
});

test('frontend API and assistant access checks run before upstream requests or model usage',async t=>{
  environment(t);let calls=0;
  const denied=await proxyBackend(new Request('https://predictir.dev/api/workspace/catalog'),['workspace','catalog'],{fetcher:async()=>{calls++;return Response.json({})}});
  assert.equal(denied.status,401);assert.equal(calls,0);
  const answer=await assistantResponse(new Request('https://predictir.dev/api/assistant',{method:'POST',body:'{}'}),{createClient:async()=>{calls++;throw Error('must not run')}});
  assert.equal(answer.status,401);assert.equal(calls,0);
  const value=await cookie('192.0.2.15');
  const allowed=await proxyBackend(new Request('https://predictir.dev/api/workspace/catalog',{headers:{Cookie:value+'; owner_cookie=private'}}),['workspace','catalog'],{
    fetcher:async(_url,options)=>{calls++;assert.equal(new Headers(options.headers).get('cookie'),value);return Response.json({ok:true});}});
  assert.equal(allowed.status,200);assert.equal(calls,1);
});

test('backend direct entry, API and forged edge claims are blocked while readiness and authenticated forwarding work',async t=>{
  const value=await cookie('192.0.2.16'),server=createMarketServer({production:true,edgeSecret:env.MARKET_EDGE_SECRET,serviceSecret:'fixture-service-key-'.repeat(4),shareAccess:true,shareTokenHash:env.PREDICTIR_SHARE_TOKEN_HASH,now:()=>now,storageEnabled:()=>false,logger:()=>{},getRoute:async()=>Response.json({ok:true})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  for(const path of ['/','/lab.html','/api/health','/api/workspace/catalog'])assert.equal((await fetch(base+path)).status,401);
  assert.equal((await fetch(base+'/api/workspace/catalog',{headers:{'x-market-edge-secret':env.MARKET_EDGE_SECRET}})).status,401);
  assert.equal((await fetch(base+'/api/workspace/catalog',{headers:{Cookie:value}})).status,401);
  const health=await fetch(base+'/healthz');assert.equal(health.status,200);assert.deepEqual(await health.json(),{status:'ok'});
  const allowed=await fetch(base+'/api/workspace/catalog',{headers:{Cookie:value,'x-market-edge-secret':env.MARKET_EDGE_SECRET,'x-market-country':'US'}});assert.equal(allowed.status,200);
  assert.match(allowed.headers.get('x-robots-tag'),/noindex/);
});

test('public paths are limited to bootstrap, static framework assets, readiness and exact ownership files',()=>{
  for(const path of ['/access','/api/access/redeem','/healthz','/google7653305cfae6f81b.html','/hibp-verification.txt','/_next/static/a.js'])assert.equal(publicAccessPath(path),true,path);
  for(const path of ['/','/api/session','/lab.html','/research/research-audit.pdf','/_next/image','/access/other','/hibp-verification.txt/other'])assert.equal(publicAccessPath(path),false,path);
});

test('dedicated canary cookie expires and rotates independently of recruiter access',async()=>{
  const response=await redeemShareAccess(request(canaryToken,{ip:'192.0.2.30'}),{env,now});
  const issued=response.headers.get('set-cookie');
  assert.equal(response.status,204);
  assert.ok(!issued.includes(canaryToken));
  for(const attribute of ['Secure','HttpOnly','SameSite=Lax','Path=/','Max-Age='+CANARY_COOKIE_SECONDS])assert.ok(issued.includes(attribute));
  const canary=issued.split(';',1)[0],share=await cookie('192.0.2.31');
  assert.ok(canary.startsWith(CANARY_COOKIE+'='));
  assert.equal(shareAccessKind(canary,env,now),'canary');
  assert.equal(shareAccessKind(canary+'; '+share,env,now),'share');
  assert.equal(shareCookieAuthorized(canary,env,now),false);
  assert.equal(shareAccessKind(canary.replace(CANARY_COOKIE,SHARE_COOKIE),env,now),null);
  assert.equal(shareAccessKind(canary+'; '+canary,env,now),null);
  assert.equal(shareAccessKind(canary,env,now+CANARY_COOKIE_SECONDS*1000),null);
  assert.equal(shareAccessKind(canary,{...env,PREDICTIR_CANARY_TOKEN_HASH:undefined},now),null);
  assert.equal(shareAccessKind(canary+'; '+share,{...env,PREDICTIR_CANARY_TOKEN_HASH:'a'.repeat(64)},now),'share');
  assert.equal(shareAccessKind(canary+'; '+share,{...env,PREDICTIR_SHARE_TOKEN_HASH:'b'.repeat(64)},now),'canary');
  assert.equal((await redeemShareAccess(request(canaryToken),{env:{...env,PREDICTIR_SHARE_ACCESS:'0'},now})).status,503);
  assert.equal((await redeemShareAccess(request(canaryToken),{env:{...env,PREDICTIR_ACCESS_OWNER_HASH:hash(canaryToken)},now})).status,401);
  const signOut=await logoutShareAccess(new Request('https://predictir.dev/api/access/logout',{
    method:'POST',headers:{Origin:'https://predictir.dev',Cookie:canary+'; '+share}
  }),{env});
  assert.equal(signOut.headers.getSetCookie().length,2);
  assert.ok(signOut.headers.getSetCookie().every(value=>value.includes('Max-Age=0')));
});

test('a canary can forward market reads and guest session but cannot pass credentials to account actions',async t=>{
  environment(t);
  const canary=await cookie('192.0.2.32',canaryToken);
  const staleShare=await cookie('192.0.2.33');
  process.env.PREDICTIR_SHARE_TOKEN_HASH='c'.repeat(64);
  const headers={Cookie:canary+'; '+staleShare+'; __Host-market_guest=guest; __Host-market_owner=owner',
    Authorization:'Bearer other-token','X-MS-Token-AAD-ID-Token':'owner-token'};
  let calls=0;
  const fetcher=async(url,options)=>{
    calls++;
    const forwarded=new Headers(options.headers);
    assert.equal(forwarded.get('cookie'),canary+(url.pathname==='/api/session'?'; __Host-market_guest=guest':''));
    assert.equal(forwarded.get('authorization'),null);
    assert.equal(forwarded.get('x-ms-token-aad-id-token'),null);
    if(url.pathname==='/api/portfolio/stream')return new Response('data: {}\n\n',{headers:{'Content-Type':'text/event-stream'}});
    return Response.json({ok:true});
  };
  for(const route of ['session','workspace/catalog','workspace/evidence?preview=1','workspace/portfolio-books?tickers=TEST','portfolio/stream?tickers=TEST']){
    const path=route.split('?',1)[0].split('/');
    const response=await proxyBackend(new Request('https://predictir.dev/api/'+route,{headers}),path,{fetcher});
    assert.equal(response.status,200,route);
    await response.body?.cancel();
  }
  for(const route of ['account/profile','account/portfolio','journal','export.xlsx','workspace/evidence?preview=0',
    'workspace/evidence?preview=1&preview=0','workspace/portfolio-books?tickers=TEST,OTHER','portfolio/stream?tickers=TEST&tickers=OTHER']){
    const response=await proxyBackend(new Request('https://predictir.dev/api/'+route,{headers}),route.split('?',1)[0].split('/'),{fetcher});
    assert.equal(response.status,401,route);
  }
  assert.equal(calls,5);
});

test('canary Ask Why only runs the single built-in selected contract question without invoking the paid model',async t=>{
  environment(t);
  const canary=await cookie('192.0.2.34',canaryToken),ticker='TEST-TICKER';
  const launch=assistantContext('analysis',ticker,{detail:'full'});
  const input={ticker,model:'validated',panel:launch.panel,detail:launch.detail,messages:[{role:'user',content:launch.question}]};
  const ask=(payload,origin='https://predictir.dev')=>new Request('https://predictir.dev/api/assistant',{
    method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:canary},body:JSON.stringify(payload)
  });
  const calls=[];
  const unexpected=()=>assert.fail('general model or spend reservation was invoked');
  const dependencies={generate:unexpected,fetcher:unexpected,createClient:async()=>({
    callTool:async({name,arguments:args})=>{calls.push(name);assert.equal(args.ticker,ticker);return {content:[{type:'text',text:JSON.stringify({ticker})}]};},
    close:async()=>{},
  })};
  assert.equal((await assistantResponse(ask(input,'https://other.invalid'),dependencies)).status,403);
  assert.equal((await assistantResponse(ask({...input,messages:[{role:'user',content:'Give me a different question'}]}),dependencies)).status,401);
  assert.deepEqual(calls,[]);
  const response=await assistantResponse(ask(input),dependencies);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('x-research-model'),'deterministic-contract-brief');
  assert.deepEqual(calls,['get_research','get_contract']);
  assert.match(await response.text(),/TEST-TICKER/);
});

test('the private backend requires both edge and canary credentials and keeps sessions guest-only',async t=>{
  const canary=await cookie('192.0.2.35',canaryToken);
  const share=await cookie('192.0.2.36'),uuid='00000000-0000-0000-0000-000000000001';
  const storage={consume:async()=>true,readOwnerPortfolio:async()=>({}),saveOwnerPortfolio:async()=>({})};
  let ownerChecks=0;
  const server=createMarketServer({production:true,edgeSecret:env.MARKET_EDGE_SECRET,serviceSecret:'fixture-service-key-'.repeat(4),
    shareAccess:true,shareTokenHash:env.PREDICTIR_SHARE_TOKEN_HASH,canaryTokenHash:env.PREDICTIR_CANARY_TOKEN_HASH,
    now:()=>now,storageEnabled:()=>true,storage:()=>storage,logger:()=>{},getRoute:async()=>Response.json({ok:true}),
    accountOptions:{env:{PREDICTIR_MODE:'live',APP_ORIGIN:'https://predictir.dev',AZURE_OWNER_AUTH_ENABLED:'1',
      AZURE_OWNER_TENANT_ID:uuid,AZURE_OWNER_OBJECT_ID:uuid,AZURE_OWNER_CLIENT_ID:uuid},
    verifyEntraOwner:async()=>{ownerChecks++;return {key:'owner-key',display_name:'Owner'};}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const headers={Cookie:canary+'; __Host-market_owner=fixture','X-Market-Edge-Secret':env.MARKET_EDGE_SECRET,'X-Market-Country':'US',
    'X-MS-Token-AAD-ID-Token':'fixture'};
  assert.equal((await fetch(base+'/api/workspace/catalog',{headers:{Cookie:canary}})).status,401);
  assert.equal((await fetch(base+'/api/workspace/catalog',{headers})).status,200);
  for(const path of ['/','/api/account/portfolio','/api/journal','/api/workspace/evidence?preview=0','/mcp'])
    assert.equal((await fetch(base+path,{headers})).status,401,path);
  const session=await fetch(base+'/api/session',{headers}),guest=await session.json();
  assert.equal(session.status,200);
  assert.equal(guest.kind,'guest');
  assert.equal(guest.login_configured,false);
  assert.equal(guest.owner,undefined);
  assert.equal(guest.login_provider,undefined);
  assert.equal(ownerChecks,0);
  assert.match(session.headers.get('set-cookie'),/^__Host-market_guest=/);
  const owner=await fetch(base+'/api/session',{headers:{...headers,Cookie:share}});
  assert.equal((await owner.json()).kind,'owner');
  assert.equal(ownerChecks,1);
});
