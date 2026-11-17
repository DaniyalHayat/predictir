import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify} from 'jose';
import {issueApprovedShareCookie,PRIVATE_HEADERS,SHARE_COOKIE_SECONDS,shareAccessEnabled,shareCookieValue} from './private-access.mjs';
import {accessIngress} from './workspace/access-ingress.mjs';
import {readProxyBody} from './workspace/proxy.mjs';

const issuer='https://accounts.google.com';
const authorizeURL=issuer+'/o/oauth2/v2/auth';
const tokenURL='https://oauth2.googleapis.com/token';
const keys=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const flowCookie='__Host-predictir-google-flow';
const flowSeconds=600;
const randomToken=()=>randomBytes(32).toString('base64url');
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const sign=(key,value)=>createHmac('sha256',key).update('predictir.google.flow\0'+value).digest('base64url');
const digest=value=>createHash('sha256').update(value);
const equals=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const cookie=(value,age)=>`${flowCookie}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;

function settings(env){
  const {APP_ORIGIN:origin,PREDICTIR_GOOGLE_CLIENT_ID:clientId,PREDICTIR_GOOGLE_CLIENT_SECRET:clientSecret,MARKET_EDGE_SECRET:key}=env;
  if(!shareAccessEnabled(env)||env.PREDICTIR_GOOGLE_ACCESS!=='1'||
    !/^[a-f0-9]{64}$/.test(env.PREDICTIR_SHARE_TOKEN_HASH||'')||typeof key!=='string'||key.length<32||
    !/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId||'')||typeof clientSecret!=='string'||!clientSecret||clientSecret.trim()!==clientSecret)return null;
  try{
    const url=new URL(origin);
    if(url.origin!==origin||url.protocol!=='https:'||env.VERCEL!=='1'&&env.PREDICTIR_MODE!=='live')return null;
    return {origin,clientId,clientSecret,key,redirectURI:origin+'/api/access/google/callback'};
  }catch{return null;}
}

export const googleAccessEnabled=(env=process.env)=>Boolean(settings(env));

function encodeFlow(flow,config){
  const value=Buffer.from(JSON.stringify(flow)).toString('base64url');
  return value+'.'+sign(config.key,value);
}

function decodeFlow(request,config,now,state){
  const cookieValue=shareCookieValue(request.headers.get('cookie'),flowCookie);
  if(!cookieValue||!/^[-_A-Za-z0-9]{1,1024}\.[-_A-Za-z0-9]{43}$/.test(cookieValue)||!tokenPattern.test(state||''))return null;
  const [value,mac]=cookieValue.split('.');
  if(!equals(mac,sign(config.key,value)))return null;
  try{
    const flow=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    if(flow.origin===config.origin&&flow.clientId===config.clientId&&equals(flow.state,state)&&
      typeof flow.verifier==='string'&&tokenPattern.test(flow.verifier)&&typeof flow.nonce==='string'&&tokenPattern.test(flow.nonce)&&
      Number.isSafeInteger(flow.issued)&&flow.issued<=now&&flow.issued+flowSeconds>now)return flow;
  }catch{return null;}
  return null;
}

function redirect(location,cookies=[]){
  const headers=new Headers({...PRIVATE_HEADERS,Location:location,Vary:'Cookie'});
  for(const value of cookies)headers.append('Set-Cookie',value);
  return new Response(null,{status:303,headers});
}

export async function handleGoogleAccess(request,action,{env=process.env,now=Date.now(),fetcher=fetch,verificationKey=keys,countryLookup}={}){
  const config=settings(env);
  if(!config||!['start','callback'].includes(action))return new Response(null,{status:404,headers:PRIVATE_HEADERS});
  if(request.method!=='GET')return new Response(null,{status:405,headers:{...PRIVATE_HEADERS,Allow:'GET'}});
  const url=new URL(request.url),atOrigin=url.origin===config.origin||request.headers.get('host')===new URL(config.origin).host;
  if(!atOrigin)return new Response(null,{status:403,headers:PRIVATE_HEADERS});
  const fail=(reason,cookies=[])=>redirect(config.origin+'/access?sign-in='+reason,cookies);
  const nowSeconds=Math.floor(now/1000);
  const cleared=[cookie('',0)];
  const state=url.searchParams.getAll('state');
  const flow=action==='callback'&&state.length===1?decodeFlow(request,config,nowSeconds,state[0]):null;
  if(action==='callback'&&!flow)return fail('retry');
  const source=request.headers.get('sec-fetch-site');
  if(action==='start'&&(url.search||source&&source!=='same-origin'&&source!=='none'))return fail('retry');
  const regional=await accessIngress(request.headers,env,countryLookup);
  if(regional.status!==200||regional.country!=='US')
    return fail(regional.status===503?'retry':'region',flow?cleared:[]);
  if(action==='start'){
    const attempt={origin:config.origin,clientId:config.clientId,state:randomToken(),nonce:randomToken(),verifier:randomToken(),issued:nowSeconds};
    const authorization=new URL(authorizeURL);
    authorization.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectURI,response_type:'code',scope:'openid',
      state:attempt.state,nonce:attempt.nonce,code_challenge:digest(attempt.verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
    return redirect(authorization.href,[cookie(encodeFlow(attempt,config),flowSeconds)]);
  }

  const codes=url.searchParams.getAll('code'),issuers=url.searchParams.getAll('iss');
  if(url.searchParams.has('error')||codes.length!==1||!codes[0]||codes[0].length>2048||/\s/.test(codes[0])||
    issuers.length>1||issuers.length===1&&issuers[0]!==issuer)return fail('retry',cleared);
  try{
    const response=await fetcher(tokenURL,{method:'POST',redirect:'error',cache:'no-store',
      body:new URLSearchParams({grant_type:'authorization_code',code:codes[0],code_verifier:flow.verifier,
        client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:config.redirectURI}),
      signal:AbortSignal.any([request.signal,AbortSignal.timeout(8000)])});
    if(!response.ok)return fail('retry',cleared);
    const {id_token:token}=JSON.parse(await readProxyBody(response,16000));
    if(typeof token!=='string'||token.length>8000)return fail('retry',cleared);
    const {payload}=await jwtVerify(token,verificationKey,{issuer,audience:config.clientId,algorithms:['RS256'],
      requiredClaims:['sub','exp','iat','nonce'],currentDate:new Date(now),maxTokenAge:flowSeconds,clockTolerance:60});
    if(payload.aud!==config.clientId||payload.azp!==undefined&&payload.azp!==config.clientId||
      !equals(payload.nonce,flow.nonce)||typeof payload.sub!=='string'||!/^[\x21-\x7e]{1,255}$/.test(payload.sub))return fail('retry',cleared);
    const session=issueApprovedShareCookie(env,now,nowSeconds+SHARE_COOKIE_SECONDS,digest('predictir.google.approval\0'+flow.state).digest('hex'));
    return session?redirect(config.origin+'/',[...cleared,session]):fail('retry',cleared);
  }catch{return fail('retry',cleared);}
}
