import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {accessIngress} from './workspace/access-ingress.mjs';
import {createAdmission} from './runtime/admission.mjs';
import {browserSessionExpiry,BROWSER_IDLE_SECONDS,BROWSER_MAX_SECONDS,BROWSER_REFRESH_SECONDS,validBrowserSession} from './browser-session.mjs';

export const SHARE_COOKIE='__Host-predictir-share';
const APPROVED_LOGOUT_COOKIE='__Host-predictir-share-logout';
export const SHARE_COOKIE_SECONDS=86400;
export const CANARY_COOKIE='__Host-predictir-canary';
export const CANARY_COOKIE_SECONDS=900;
export const PRIVATE_HEADERS=Object.freeze({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow, noarchive, nosnippet, noimageindex','X-Content-Type-Options':'nosniff'});
const admitFailedRedemption=globalThis[Symbol.for('predictir.share.failed-admission.v2')] ||= createAdmission(300,10);
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
function verifiedCookie(header,env,now,kind){
  const config=settings(env,kind);
  if(!config)return null;
  const value=shareCookieValue(header,config.cookie);
  if(!value||value.length>400||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value))return null;
  const [encoded,mac]=value.split('.');
  if(!sameBytes(Buffer.from(mac),Buffer.from(signature(encoded,config.key,kind))))return null;
  try{
    const payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
    if(typeof payload.h!=='string'||!sameBytes(Buffer.from(payload.h),Buffer.from(config.hash)))return null;
    const current=Math.floor(now/1000);
    if(payload.v===1&&Object.keys(payload).length===3&&Number.isSafeInteger(payload.exp)&&
      payload.exp>current&&payload.exp<=current+config.seconds+60)return payload;
    if(kind==='share'&&payload.v===2&&Object.keys(payload).length===5&&typeof payload.id==='string'&&
      /^[A-Za-z0-9_-]{22}$/.test(payload.id)&&payload.id!==shareCookieValue(header,APPROVED_LOGOUT_COOKIE)&&
      validBrowserSession(payload.iat,payload.exp,current))return payload;
  }catch{return null;}
  return null;
}
export function shareCookieAuthorized(header,env=process.env,now=Date.now()){
  return !shareAccessEnabled(env)||Boolean(verifiedCookie(header,env,now,'share'));
}
export function shareAccessKind(header,env=process.env,now=Date.now()){
  if(!shareAccessEnabled(env))return 'open';
  if(verifiedCookie(header,env,now,'share'))return 'share';
  return verifiedCookie(header,env,now,'canary')?'canary':null;
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
export function issueShareCookie(env=process.env,now=Date.now(),kind='share',expiresAt){
  const config=settings(env,kind);
  if(!shareAccessEnabled(env)||!config)return null;
  const current=Math.floor(now/1000),exp=expiresAt??current+config.seconds;
  if(!Number.isSafeInteger(exp)||exp<=current||exp>current+config.seconds+60)return null;
  return signedCookie(config,kind,{v:1,h:config.hash,exp},Math.min(config.seconds,exp-current));
}
function signedCookie(config,kind,payload,maxAge){
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return browserCookie(config.cookie,encoded+'.'+signature(encoded,config.key,kind),maxAge);
}
function browserCookie(name,value,maxAge){
  return name+'='+value+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+maxAge;
}
export function issueApprovedShareCookie(env,now,redemptionExpiresAt,receiptHash){
  const config=settings(env);
  if(!shareAccessEnabled(env)||!config||typeof receiptHash!=='string'||!/^[a-f0-9]{64}$/.test(receiptHash))return null;
  const current=Math.floor(now/1000);
  if(!Number.isSafeInteger(redemptionExpiresAt)||redemptionExpiresAt<=current||redemptionExpiresAt>current+config.seconds+60)return null;
  const iat=redemptionExpiresAt-config.seconds;
  const exp=browserSessionExpiry(iat,iat);
  const id=signature(receiptHash,config.key,'approval-id').slice(0,22);
  return signedCookie(config,'share',{v:2,h:config.hash,exp,iat,id},Math.min(BROWSER_IDLE_SECONDS,exp-current));
}
export function renewApprovedShareCookie(header,env=process.env,now=Date.now()){
  if(!shareAccessEnabled(env))return null;
  const session=verifiedCookie(header,env,now,'share');
  if(session?.v!==2)return null;
  const current=Math.floor(now/1000),exp=browserSessionExpiry(session.iat,current);
  if(exp-session.exp<BROWSER_REFRESH_SECONDS)return null;
  return signedCookie(settings(env),'share',{...session,exp},exp-current);
}
export function shareHeaderForBackend(header,env=process.env,now=Date.now()){
  if(!shareAccessEnabled(env))return header;
  const session=verifiedCookie(header,env,now,'share');
  if(session?.v!==2)return header;
  const expiry=Math.min(session.exp,Math.floor(now/1000)+SHARE_COOKIE_SECONDS);
  const replacement=issueShareCookie(env,now,'share',expiry).split(';',1)[0];
  return header.split(';').map(part=>part.trim().startsWith(SHARE_COOKIE+'=')?replacement:part.trim()).join('; ');
}
function rejectRedemption(ip,key,now){
  const fingerprint=createHmac('sha256',key).update('share-limit\0'+ip).digest('hex');
  if(!admitFailedRedemption(fingerprint,Math.floor(now/60000)))
    return Response.json({error:'Too many attempts. Try again in one minute.'},{status:429,headers:{...PRIVATE_HEADERS,'Retry-After':'60'}});
  return Response.json({error:'This private link is invalid or expired.'},{status:401,headers:PRIVATE_HEADERS});
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
  const share=settings(env);
  if(!shareAccessEnabled(env)||!share)return Response.json({error:'Private access is not configured.'},{status:503,headers:PRIVATE_HEADERS});
  if(!accessOriginAllowed(request,env)||request.headers.get('sec-fetch-site')==='cross-site'||new URL(request.url).search)return Response.json({error:'Open the private link directly.'},{status:403,headers:PRIVATE_HEADERS});
  const regional=await accessIngress(request.headers,env,countryLookup);
  if(regional.status!==200)return Response.json({error:'The access check could not be completed.'},{status:regional.status,headers:PRIVATE_HEADERS});
  const ip=regional.ip||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
  try{
    const value=await accessBody(request);
    if(!value||Object.keys(value).length!==1||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(value.token))return rejectRedemption(ip,share.key,now);
    const hash=createHash('sha256').update(value.token).digest('hex');
    const kind=['share','canary'].find(scope=>{
      const config=settings(env,scope);
      return config&&sameBytes(Buffer.from(hash),Buffer.from(config.hash));
    });
    if(!kind)return rejectRedemption(ip,share.key,now);
    if(kind==='share'&&verifiedCookie(request.headers.get('cookie'),env,now,'share')?.v===2)
      return new Response(null,{status:204,headers:PRIVATE_HEADERS});
    return new Response(null,{status:204,headers:{...PRIVATE_HEADERS,'Set-Cookie':issueShareCookie(env,now,kind)}});
  }catch(error){return Response.json({error:'The private link could not be opened.'},{status:[413,415].includes(error.status)?error.status:400,headers:PRIVATE_HEADERS});}
}
export async function logoutShareAccess(request,{env=process.env,now=Date.now()}={}){
  if(request.method!=='POST')return Response.json({error:'Use POST.'},{status:405,headers:PRIVATE_HEADERS});
  if(!accessOriginAllowed(request,env))return Response.json({error:'Open this action from Predictir.'},{status:403,headers:PRIVATE_HEADERS});
  const headers=new Headers(PRIVATE_HEADERS);
  const cookieHeader=request.headers.get('cookie');
  const session=verifiedCookie(cookieHeader,env,now,'share');
  headers.append('Set-Cookie',browserCookie(SHARE_COOKIE,'',0));
  if(session?.v===2)headers.append('Set-Cookie',browserCookie(APPROVED_LOGOUT_COOKIE,session.id,session.iat+BROWSER_MAX_SECONDS-Math.floor(now/1000)));
  if(shareCookieValue(cookieHeader,CANARY_COOKIE))headers.append('Set-Cookie',browserCookie(CANARY_COOKIE,'',0));
  return new Response(null,{status:204,headers});
}
