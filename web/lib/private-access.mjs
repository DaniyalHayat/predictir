import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {accessIngress} from './workspace/access-ingress.mjs';

export const SHARE_COOKIE='__Host-predictir-share';
export const SHARE_COOKIE_SECONDS=86400;
export const CANARY_COOKIE='__Host-predictir-canary';
export const CANARY_COOKIE_SECONDS=900;
export const PRIVATE_HEADERS=Object.freeze({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow, noarchive, nosnippet, noimageindex','X-Content-Type-Options':'nosniff'});
const limits=globalThis[Symbol.for('predictir.share.limits.v1')] ||= new Map();
export const shareAccessEnabled=(env=process.env)=>env.PREDICTIR_SHARE_ACCESS==='1';
function settings(env,kind='share'){
  const hash=env.PREDICTIR_SHARE_TOKEN_HASH,key=env.MARKET_EDGE_SECRET;
  if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||typeof key!=='string'||key.length<32)return null;
  if(kind==='share')return {hash,key,cookie:SHARE_COOKIE,seconds:SHARE_COOKIE_SECONDS};
  const canaryHash=env.PREDICTIR_CANARY_TOKEN_HASH;
  if(typeof canaryHash!=='string'||!/^[a-f0-9]{64}$/.test(canaryHash)||canaryHash===hash||canaryHash===env.PREDICTIR_ACCESS_OWNER_HASH)return null;
  return {hash:canaryHash,key,cookie:CANARY_COOKIE,seconds:CANARY_COOKIE_SECONDS};
}
function sameBytes(left,right){return left.length===right.length&&timingSafeEqual(left,right);}
function signature(value,key,kind){return createHmac('sha256',key).update('predictir.'+kind+'.cookie.v1\0'+value).digest('base64url');}
export function shareCookieValue(header,cookie=SHARE_COOKIE){
  if(typeof header!=='string'||header.length>16000)return null;
  const values=header.split(';').map(part=>part.trim()).filter(part=>part.startsWith(cookie+'='));
  return values.length===1?values[0].slice(cookie.length+1):null;
}
function validCookie(header,env,now,kind){
  const config=settings(env,kind);
  if(!config)return false;
  const value=shareCookieValue(header,config.cookie);
  if(!value||value.length>400||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value))return false;
  const [encoded,mac]=value.split('.');
  if(!sameBytes(Buffer.from(mac),Buffer.from(signature(encoded,config.key,kind))))return false;
  try{
    const payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
    return Object.keys(payload).length===3&&payload.v===1&&typeof payload.h==='string'&&
      sameBytes(Buffer.from(payload.h),Buffer.from(config.hash))&&Number.isSafeInteger(payload.exp)&&payload.exp>Math.floor(now/1000)&&payload.exp<=Math.floor(now/1000)+config.seconds+60;
  }catch{return false;}
}
export function shareCookieAuthorized(header,env=process.env,now=Date.now()){
  return !shareAccessEnabled(env)||validCookie(header,env,now,'share');
}
export function shareAccessKind(header,env=process.env,now=Date.now()){
  if(!shareAccessEnabled(env))return 'open';
  if(validCookie(header,env,now,'share'))return 'share';
  return validCookie(header,env,now,'canary')?'canary':null;
}
const canaryReadPaths=new Set(['/api/health','/api/session','/api/book','/api/stream','/api/workspace/catalog',
  '/api/workspace/markets','/api/workspace/context','/api/workspace/history','/api/workspace/research','/api/workspace/opinions']);
export function privateAccessAllowed(kind,url,method,frontend=true){
  if(kind==='open'||kind==='share')return true;
  if(kind!=='canary')return false;
  if(frontend&&url.pathname==='/api/assistant'&&method==='POST'&&!url.search)return true;
  if(method!=='GET')return false;
  if(frontend&&url.pathname==='/')return true;
  if(url.pathname==='/api/workspace/portfolio-books'||url.pathname==='/api/portfolio/stream'){
    const tickers=url.searchParams.getAll('tickers');
    return tickers.length===1&&/^[A-Za-z0-9_.-]{1,140}$/.test(tickers[0]);
  }
  if(url.pathname==='/api/workspace/evidence'){
    const flags=url.searchParams.getAll('preview');
    return flags.length===1&&flags[0]==='1';
  }
  return canaryReadPaths.has(url.pathname);
}
export function shareCookieForward(header,{canary=false,guest=false}={}){
  const cookies=canary?[CANARY_COOKIE]:[SHARE_COOKIE];
  if(guest)cookies.push('__Host-market_guest','market_guest');
  return cookies.flatMap(cookie=>{
    const value=shareCookieValue(header,cookie);
    return value?[cookie+'='+value]:[];
  }).join('; ')||null;
}
export function privateAccessResponse(request,env=process.env,now=Date.now()){
  if(privateAccessAllowed(shareAccessKind(request.headers.get('cookie'),env,now),new URL(request.url),request.method))return null;
  return Response.json({error:'A private Predictir link is required.'},{status:401,headers:PRIVATE_HEADERS});
}
export function publicAccessPath(pathname){
  return ['/access','/access/manage','/access/manifest.webmanifest','/access/push.js','/access/icon-192.png','/access/icon-512.png',
    '/api/access/request','/api/access/request/status','/api/access/manage','/api/access/manage/sign-in',
    '/api/access/redeem','/api/access/logout','/healthz','/favicon.ico','/favicon.svg','/robots.txt','/hibp-verification.txt','/google7653305cfae6f81b.html'].includes(pathname)||pathname.startsWith('/_next/static/');
}
export function accessOriginAllowed(request,env){
  const origin=request.headers.get('origin');if(!origin)return false;
  try{
    const parsed=new URL(origin),own=new URL(request.url);
    if(parsed.origin!==origin||!['https:','http:'].includes(parsed.protocol))return false;
    return origin===(env.APP_ORIGIN||own.origin);
  }catch{return false;}
}
export function issueShareCookie(env=process.env,now=Date.now(),kind='share'){
  const config=settings(env,kind);
  if(!shareAccessEnabled(env)||!config)return null;
  const encoded=Buffer.from(JSON.stringify({v:1,h:config.hash,exp:Math.floor(now/1000)+config.seconds})).toString('base64url');
  return config.cookie+'='+encoded+'.'+signature(encoded,config.key,kind)+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+config.seconds;
}
function allowance(ip,env,now){
  const slot=Math.floor(now/60000);
  const fingerprint=createHmac('sha256',settings(env)?.key||'unconfigured').update('share-limit\0'+ip).digest('hex');
  for(const [key,value]of limits)if(value.slot!==slot)limits.delete(key);
  if(limits.size>4096&&!limits.has(fingerprint))return false;
  for(const [key,maximum]of [['global',300],[fingerprint,10]]){
    const value=limits.get(key)||{slot,used:0};value.used++;limits.set(key,value);
    if(value.used>maximum)return false;
  }
  return true;
}
async function accessBody(request){
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw Object.assign(new Error(),{status:415});
  if(Number(request.headers.get('content-length')||0)>256)throw Object.assign(new Error(),{status:413});
  const reader=request.body?.getReader(),parts=[];let size=0;
  if(reader)try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>256){await reader.cancel();throw Object.assign(new Error(),{status:413});}parts.push(value);}}finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export async function redeemShareAccess(request,{env=process.env,now=Date.now(),countryLookup}={}){
  if(request.method!=='POST')return Response.json({error:'Use POST.'},{status:405,headers:PRIVATE_HEADERS});
  if(!shareAccessEnabled(env)||!settings(env))return Response.json({error:'Private access is not configured.'},{status:503,headers:PRIVATE_HEADERS});
  if(!accessOriginAllowed(request,env)||request.headers.get('sec-fetch-site')==='cross-site'||new URL(request.url).search)return Response.json({error:'Open the private link directly.'},{status:403,headers:PRIVATE_HEADERS});
  const regional=await accessIngress(request.headers,env,countryLookup);
  if(regional.status!==200)return Response.json({error:'The access check could not be completed.'},{status:regional.status,headers:PRIVATE_HEADERS});
  const ip=regional.ip||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
  if(!allowance(ip,env,now))return Response.json({error:'Too many attempts. Try again in one minute.'},{status:429,headers:{...PRIVATE_HEADERS,'Retry-After':'60'}});
  try{
    const value=await accessBody(request);
    if(!value||Object.keys(value).length!==1||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(value.token))return Response.json({error:'This private link is invalid or expired.'},{status:401,headers:PRIVATE_HEADERS});
    const hash=createHash('sha256').update(value.token).digest('hex');
    const kind=['share','canary'].find(scope=>{
      const config=settings(env,scope);
      return config&&sameBytes(Buffer.from(hash),Buffer.from(config.hash));
    });
    if(!kind)return Response.json({error:'This private link is invalid or expired.'},{status:401,headers:PRIVATE_HEADERS});
    return new Response(null,{status:204,headers:{...PRIVATE_HEADERS,'Set-Cookie':issueShareCookie(env,now,kind)}});
  }catch(error){return Response.json({error:'The private link could not be opened.'},{status:[413,415].includes(error.status)?error.status:400,headers:PRIVATE_HEADERS});}
}
export async function logoutShareAccess(request,{env=process.env}={}){
  if(request.method!=='POST')return Response.json({error:'Use POST.'},{status:405,headers:PRIVATE_HEADERS});
  if(!accessOriginAllowed(request,env))return Response.json({error:'Open this action from Predictir.'},{status:403,headers:PRIVATE_HEADERS});
  const headers=new Headers(PRIVATE_HEADERS);
  headers.append('Set-Cookie',SHARE_COOKIE+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  if(shareCookieValue(request.headers.get('cookie'),CANARY_COOKIE))headers.append('Set-Cookie',CANARY_COOKIE+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  return new Response(null,{status:204,headers});
}
