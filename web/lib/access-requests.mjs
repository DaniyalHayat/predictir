import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {accessOriginAllowed,issueShareCookie,PRIVATE_HEADERS,shareAccessEnabled} from './private-access.mjs';
import {readProxyBody} from './workspace/proxy.mjs';
import {azureMode} from './workspace/azure-mode.mjs';
import {azureAccess} from './workspace/azure-access.mjs';
import {isCountryAllowed} from './workspace/geo.mjs';

const receiptCookie='__Host-predictir-access-receipt';
const ownerCookie='__Host-predictir-access-owner';
const receiptSeconds=7*86400;
const ownerSeconds=30*86400;
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const hashPattern=/^[a-f0-9]{64}$/;
const idPattern=/^[a-z0-9-]{16,128}$/i;
const statusPattern=/^(pending|declined|missing|approved)$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
const sign=(key,scope,value)=>createHmac('sha256',key).update(scope+'\0'+value).digest('base64url');
const equal=(a,b)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const cookie=(name,value,seconds)=>name+'='+value+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age='+seconds;

export function accessRequestsEnabled(env=process.env){
  return shareAccessEnabled(env)&&env.PREDICTIR_ACCESS_REQUESTS==='1'&&
    hashPattern.test(env.PREDICTIR_SHARE_TOKEN_HASH||'')&&hashPattern.test(env.PREDICTIR_ACCESS_OWNER_HASH||'')&&
    (env.MARKET_EDGE_SECRET?.length||0)>=32&&Boolean(backendURL(env));
}

function backendURL(env){
  try{
    const origin=new URL(env.MARKET_BACKEND_URL);
    if(origin.username||origin.password||origin.protocol!=='https:'&&
      !(env.NODE_ENV!=='production'&&origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))return null;
    return new URL('/api/internal/access-requests',origin);
  }catch{return null;}
}

function readCookie(request,name){
  const header=request.headers.get('cookie')||'';
  if(header.length>16000)return '';
  const matches=header.split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'='));
  return matches.length===1?matches[0].slice(name.length+1):'';
}

function ownerAuthorized(request,env,now){
  const value=readCookie(request,ownerCookie);
  if(!/^\d{10}\.[A-Za-z0-9_-]{43}$/.test(value))return false;
  const [expiry,signature]=value.split('.');
  const current=Math.floor(now/1000);
  return Number(expiry)>current&&Number(expiry)<=current+ownerSeconds&&
    equal(signature,sign(env.MARKET_EDGE_SECRET,'predictir.access.owner',expiry+'.'+env.PREDICTIR_ACCESS_OWNER_HASH));
}

function response(data,status=200,setCookies=[],retryAfter=60){
  const headers=new Headers(PRIVATE_HEADERS);
  headers.set('Vary','Cookie');
  if(status===429)headers.set('Retry-After',String(retryAfter));
  for(const value of setCookies)headers.append('Set-Cookie',value);
  return status===204?new Response(null,{status,headers}):Response.json(data,{status,headers});
}

async function jsonBody(request,maxBytes){
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')
    throw Object.assign(new Error(),{status:415});
  const result=JSON.parse(await readProxyBody(request,maxBytes));
  if(!result||typeof result!=='object'||Array.isArray(result))throw new SyntaxError();
  return result;
}

async function backend(request,env,fetcher,data,regional){
  const vercelIP=env.VERCEL==='1'?request.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim():null;
  const ip=regional?.ip||vercelIP;
  const country=regional?.country||(env.VERCEL==='1'?request.headers.get('x-vercel-ip-country'):'US');
  const headers={'content-type':'application/json','x-market-edge-secret':env.MARKET_EDGE_SECRET};
  if(ip&&isIP(ip))headers['x-market-client-ip']=ip;
  if(country&&/^[A-Z]{2}$/.test(country))headers['x-market-country']=country;
  const result=await fetcher(backendURL(env),{method:'POST',cache:'no-store',redirect:'error',
    headers,
    body:JSON.stringify(data),signal:AbortSignal.any([request.signal,AbortSignal.timeout(8500)])});
  if(result.status===204)return {status:204,data:null};
  if(!result.headers.get('content-type')?.startsWith('application/json'))throw new Error();
  const body=await readProxyBody(result,256000);
  try{return {status:result.status,data:JSON.parse(body),retryAfter:Number(result.headers.get('retry-after'))};}
  catch{throw new Error('Invalid access service response');}
}

function providerFailure(result){
  if(result.status===429)return response({error:'Too many requests. Try again later.'},429,[],Math.min(86400,Math.max(1,result.retryAfter||60)));
  if(result.status===409)return response({error:'This action conflicts with the current settings.'},409);
  if(result.status===400)return response({error:'The request could not be accepted. Check the details and try again.'},400);
  if(result.status===404)return response({error:'This request is no longer available.'},404);
  return response({error:'Access requests are temporarily unavailable. Try again shortly.'},503);
}

export async function handleAccessRequest(request,operation,{env=process.env,now=Date.now(),fetcher=fetch,countryLookup}={}){
  if(!accessRequestsEnabled(env))return response({error:'This action is unavailable.'},404);
  if(request.method!=='POST')return response({error:'Use POST.'},405);
  if(!accessOriginAllowed(request,env)||request.headers.get('sec-fetch-site')==='cross-site'||new URL(request.url).search)
    return response({error:'Open this action from Predictir.'},403);
  if(env.VERCEL==='1'&&!isCountryAllowed(request.headers.get('x-vercel-ip-country')))
    return response({error:'Access is unavailable in your region.'},403);
  const regional=azureMode(env.PREDICTIR_MODE)==='live'?await azureAccess(request.headers,countryLookup):null;
  if(regional&&regional.status!==200)return response({error:'The access check could not be completed.'},regional.status);

  try{
    if(operation==='manage/sign-in'){
      const {code}=await jsonBody(request,160);
      if(typeof code!=='string'||!tokenPattern.test(code)||!equal(digest(code),env.PREDICTIR_ACCESS_OWNER_HASH))
        return response({error:'The owner code is invalid.'},401);
      const expiry=Math.floor(now/1000)+ownerSeconds;
      const signature=sign(env.MARKET_EDGE_SECRET,'predictir.access.owner',expiry+'.'+env.PREDICTIR_ACCESS_OWNER_HASH);
      return response(null,204,[cookie(ownerCookie,expiry+'.'+signature,ownerSeconds)]);
    }
    if(operation==='request'||operation==='request/status'){
      const [candidate,mac,extra]=readCookie(request,receiptCookie).split('.');
      const existing=extra===undefined&&tokenPattern.test(candidate)&&typeof mac==='string'&&tokenPattern.test(mac)&&
        equal(mac,sign(env.MARKET_EDGE_SECRET,'predictir.access.receipt',candidate))?candidate:null;
      const receipt=existing||randomBytes(32).toString('base64url');
      const receiptHash=digest(receipt);
      const receiptHeader=value=>cookie(receiptCookie,value+'.'+sign(env.MARKET_EDGE_SECRET,'predictir.access.receipt',value),receiptSeconds);
      if(operation==='request/status'){
        if(!existing)return response({status:'missing'},200,[receiptHeader(receipt)]);
        const result=await backend(request,env,fetcher,{action:'status',receiptHash},regional);
        if(result.status!==200||!statusPattern.test(result.data?.status||''))return providerFailure(result);
        if(result.data.status==='approved'){
          const share=issueShareCookie(env,now);
          return response(null,204,[share,cookie(receiptCookie,'',0)]);
        }
        const replacement=result.data.status==='missing'?[receiptHeader(randomBytes(32).toString('base64url'))]:
          result.data.status==='declined'?[cookie(receiptCookie,'',0)]:[];
        return response({status:result.data.status},200,replacement);
      }
      const {name,email}=await jsonBody(request,1024);
      if(typeof name!=='string'||typeof email!=='string'||!name.trim()||name.trim().length>100||
        /[\u0000-\u001f\u007f]/u.test(name)||email.trim().length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim()))
        return response({error:'Enter your name and a valid email address.'},400);
      const platformIP=env.VERCEL==='1'?request.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim():null;
      const ip=regional?.ip||(platformIP&&isIP(platformIP)?platformIP:'unknown');
      const ipHash=createHmac('sha256',env.MARKET_EDGE_SECRET).update('predictir.access.ip\0'+ip).digest('hex');
      const result=await backend(request,env,fetcher,{action:'request',receiptHash,name:name.trim(),email:email.trim().toLowerCase(),ipHash},regional);
      if(result.status!==202)return providerFailure(result);
      return response({status:'pending'},202,[receiptHeader(receipt)]);
    }
    if(operation!=='manage')return response({error:'Unknown access action.'},404);
    if(!ownerAuthorized(request,env,now))return response({error:'Owner sign-in required.'},401);
    const data=await jsonBody(request,4096);
    if(data.action==='sign-out')return response(null,204,[cookie(ownerCookie,'',0)]);
    if(data.action==='list'){
      const result=await backend(request,env,fetcher,{action:'list'},regional);
      if(result.status!==200||!Array.isArray(result.data?.requests))return providerFailure(result);
      return response({requests:result.data.requests,vapidPublicKey:env.PREDICTIR_ACCESS_VAPID_PUBLIC_KEY||null});
    }
    if(data.action==='decide'&&typeof data.id==='string'&&idPattern.test(data.id)&&['approved','declined'].includes(data.decision)||
      data.action==='subscribe'&&data.subscription&&typeof data.subscription==='object'||
      data.action==='unsubscribe'&&typeof data.endpoint==='string'){
      const result=await backend(request,env,fetcher,data,regional);
      if(result.status===204)return response(null,204);
      return result.status===200?response(result.data):providerFailure(result);
    }
    return response({error:'Unknown access action.'},400);
  }catch(error){
    if(error instanceof SyntaxError||[413,415].includes(error.status))return response({error:'The request could not be read.'},error.status||400);
    return response({error:'Access requests are temporarily unavailable. Try again shortly.'},503);
  }
}
