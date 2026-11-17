import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {generateKeyPair,SignJWT} from 'jose';
import {googleAccessEnabled,handleGoogleAccess} from '../lib/google-access.mjs';
import {hasAccessOwnerSession} from '../lib/access-requests.mjs';
import {SHARE_COOKIE,shareAccessKind,shareCookieValue} from '../lib/private-access.mjs';

const origin='https://preview.example.test',now=Date.parse('2026-11-17T12:00:00Z');
const issuer='https://accounts.google.com',clientId='123456-example.apps.googleusercontent.com';
const env={APP_ORIGIN:origin,VERCEL:'1',PREDICTIR_SHARE_ACCESS:'1',PREDICTIR_ACCESS_REQUESTS:'1',PREDICTIR_GOOGLE_ACCESS:'1',
  PREDICTIR_SHARE_TOKEN_HASH:'a'.repeat(64),PREDICTIR_ACCESS_OWNER_HASH:'b'.repeat(64),MARKET_BACKEND_URL:'https://backend.example.test',
  MARKET_EDGE_SECRET:'edge-test-secret-'.repeat(4),PREDICTIR_GOOGLE_CLIENT_ID:clientId,PREDICTIR_GOOGLE_CLIENT_SECRET:'example-google-secret'};
const keyPair=generateKeyPair('RS256');
const hash=value=>createHash('sha256').update(value).digest('base64url');
const cookieHeader=response=>response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');
const unexpected=()=>Promise.reject(new Error('An invalid callback tried exchanging its code'));

function request(action,{cookie='',country='US',search='',base=origin,headers={}}={}){
  return new Request(base+'/api/access/google/'+action+search,{headers:{Cookie:cookie,
    'X-Vercel-IP-Country':country,'X-Vercel-Forwarded-For':'192.0.2.71',...headers}});
}

async function start(options={}){
  const response=await handleGoogleAccess(request('start',options.request),'start',{env,now,...options.dependencies});
  return {response,authorization:new URL(response.headers.get('location')),cookie:cookieHeader(response)};
}

async function callback(attempt,{request:requestOptions={},dependencies={},claims={},claimsOmitted=[],privateKey,codeUsed=false}={}){
  const parameters=attempt.authorization.searchParams;
  const {publicKey,privateKey:fixtureKey}=await keyPair;
  const payload={iss:issuer,aud:clientId,sub:'fixture-account-id',iat:now/1000,exp:now/1000+300,
    nonce:parameters.get('nonce'),...claims};
  for(const name of claimsOmitted)delete payload[name];
  const idToken=await new SignJWT(payload).setProtectedHeader({alg:'RS256'}).sign(privateKey||fixtureKey);
  let exchanges=0;
  const response=await handleGoogleAccess(request('callback',{cookie:attempt.cookie,
    search:'?'+new URLSearchParams({state:parameters.get('state'),code:'fixture-code',iss:issuer}),...requestOptions}),
    'callback',{env,now,verificationKey:publicKey,fetcher:async(url,init)=>{
      exchanges++;
      assert.equal(url,'https://oauth2.googleapis.com/token');
      assert.equal(init.method,'POST');
      assert.equal(init.redirect,'error');
      assert.equal(init.body.get('code'),'fixture-code');
      assert.equal(init.body.get('grant_type'),'authorization_code');
      assert.equal(init.body.get('client_id'),clientId);
      assert.equal(init.body.get('client_secret'),env.PREDICTIR_GOOGLE_CLIENT_SECRET);
      assert.equal(init.body.get('redirect_uri'),origin+'/api/access/google/callback');
      assert.equal(hash(init.body.get('code_verifier')),parameters.get('code_challenge'));
      return codeUsed?Response.json({error:'invalid_grant'},{status:400}):
        Response.json({id_token:idToken,access_token:'unused-google-access-token'});
    },...dependencies});
  return {response,exchanges};
}

test('Google access requires HTTPS and a configured private preview on supported production ingress',async()=>{
  assert.equal(googleAccessEnabled(env),true);
  for(const change of [{PREDICTIR_GOOGLE_ACCESS:'0'}, {PREDICTIR_SHARE_ACCESS:'0'}, {PREDICTIR_GOOGLE_CLIENT_SECRET:undefined},
    {PREDICTIR_GOOGLE_CLIENT_ID:'bad-id'}, {APP_ORIGIN:undefined}, {APP_ORIGIN:'http://localhost:3000'}, {VERCEL:undefined}]){
    const options={env:{...env,...change},now,fetcher:unexpected};
    assert.equal(googleAccessEnabled(options.env),false);
    assert.equal((await handleGoogleAccess(request('start'),'start',options)).status,404);
    assert.equal((await handleGoogleAccess(request('callback'),'callback',options)).status,404);
  }
});

test('Google start uses a browser-bound PKCE flow, exact redirect URL and no profile scopes',async()=>{
  const attempt=await start();
  assert.equal(attempt.response.status,303);
  assert.equal(attempt.response.headers.get('cache-control'),'private, no-store');
  assert.equal(attempt.response.headers.get('referrer-policy'),'no-referrer');
  assert.equal(attempt.authorization.origin,issuer);
  assert.equal(attempt.authorization.pathname,'/o/oauth2/v2/auth');
  const query=Object.fromEntries(attempt.authorization.searchParams);
  assert.equal(query.client_id,clientId);
  assert.equal(query.redirect_uri,origin+'/api/access/google/callback');
  assert.equal(query.response_type,'code');
  assert.equal(query.scope,'openid');
  assert.equal(query.code_challenge_method,'S256');
  assert.equal(new Set([query.state,query.nonce,query.code_challenge]).size,3);
  for(const field of [query.state,query.nonce,query.code_challenge])assert.match(field,/^[a-zA-Z0-9_-]{43}$/);
  assert.match(attempt.response.headers.get('set-cookie'),/^__Host-predictir-google-flow=.*; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
  assert.equal(attempt.authorization.href.includes(env.PREDICTIR_GOOGLE_CLIENT_SECRET),false);
});

test('Google access issues a durable preview session with zero provider identity or owner permissions',async()=>{
  const attempt=await start();
  const {response,exchanges}=await callback(attempt);
  const cookie=cookieHeader(response);
  assert.equal(exchanges,1);
  assert.equal(response.headers.get('location'),origin+'/');
  assert.match(response.headers.getSetCookie()[0],/^__Host-predictir-google-flow=;.*Max-Age=0$/);
  const share=shareCookieValue(cookie,SHARE_COOKIE);
  const payload=JSON.parse(Buffer.from(share.split('.')[0],'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(),['exp','h','iat','id','v']);
  assert.equal(payload.v,2);
  assert.equal(shareAccessKind(cookie,env,now+86400000),'share');
  assert.equal(hasAccessOwnerSession(new Headers({Cookie:cookie}),env,now),false);
  const second=await callback(attempt,{codeUsed:true});
  assert.equal(second.response.headers.get('location'),origin+'/access?sign-in=retry');
  assert.equal(shareCookieValue(cookieHeader(second.response),SHARE_COOKIE),null);
});

test('Google access fails for missing or altered state, wrong host, expired flow and non-US ingress',async()=>{
  const attempt=await start();
  const state=attempt.authorization.searchParams.get('state');
  const cases=[{request:{country:'CA'},location:origin+'/access?sign-in=region'},
    {request:{country:'GB'},location:origin+'/access?sign-in=region'},
    {request:{headers:{'X-Vercel-Forwarded-For':'invalid'}},location:origin+'/access?sign-in=region'},
    {request:{cookie:''}}, {request:{cookie:attempt.cookie+'x'}},
    {request:{search:`?state=${state}&state=${state}&code=fixture-code`}},
    {request:{search:`?state=${state}&code=fixture-code&iss=https://other.example.test`}},
    {request:{search:'?state='+state+'&error=access_denied'}},
    {dependencies:{now:now+600000}}, {request:{base:'https://another.example.test'},location:null}];
  for(const {location=origin+'/access?sign-in=retry',...input} of cases){
    const {response,exchanges}=await callback(attempt,input);
    assert.equal(response.headers.get('location'),location,JSON.stringify(input));
    assert.equal(exchanges,0);
    assert.equal(shareCookieValue(cookieHeader(response),SHARE_COOKIE),null);
  }
  for(const visitor of [{country:'CA'}, {headers:{'Sec-Fetch-Site':'cross-site'}}, {search:'?next=https://other.example.test'}]){
    const response=await handleGoogleAccess(request('start',visitor),'start',{env,now});
    assert.equal(new URL(response.headers.get('location')).origin,origin);
    assert.equal(cookieHeader(response),'');
  }
});

test('Azure Google access uses ingress geolocation rather than forwarded country claims',async()=>{
  const azure={...env,VERCEL:undefined,PREDICTIR_MODE:'live'};
  const requestOptions={headers:{'X-Forwarded-For':'192.0.2.73'}};
  const attempt=await start({request:requestOptions,dependencies:{env:azure,countryLookup:async()=> 'US'}});
  assert.equal(attempt.authorization.origin,issuer);
  const denied=await callback(attempt,{request:requestOptions,dependencies:{env:azure,countryLookup:async()=> 'CA'}});
  assert.equal(denied.response.headers.get('location'),origin+'/access?sign-in=region');
  assert.equal(denied.exchanges,0);
  const accepted=await callback(attempt,{request:requestOptions,dependencies:{env:azure,countryLookup:async()=> 'US'}});
  assert.equal(accepted.response.headers.get('location'),origin+'/');
  assert.equal(shareAccessKind(cookieHeader(accepted.response),azure,now),'share');
});

test('Google callback verifies the signed issuer, audience, nonce and required fresh claims',async()=>{
  const attempt=await start(),{privateKey}=await generateKeyPair('RS256');
  const cases=[{claims:{iss:'https://other.example.test'}}, {claims:{aud:'another-client'}}, {claims:{aud:[clientId,'another-client']}},
    {claims:{azp:'another-client'}}, {claims:{nonce:'wrong-nonce'}}, {claims:{sub:''}}, {claimsOmitted:['sub']}, {claimsOmitted:['exp']},
    {claims:{exp:now/1000-120}}, {claims:{iat:now/1000+120}}, {claims:{iat:now/1000-1800}}, {privateKey}];
  for(const input of cases){
    const {response,exchanges}=await callback(attempt,input);
    assert.equal(exchanges,1);
    assert.equal(response.headers.get('location'),origin+'/access?sign-in=retry');
    assert.equal(shareCookieValue(cookieHeader(response),SHARE_COOKIE),null);
  }
});
