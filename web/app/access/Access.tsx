'use client';

import {useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import AccessChallenge from './AccessChallenge';
import {retryAfterMilliseconds} from '../../lib/transport.mjs';
import {readPreviewSession} from '../../ui/preview-session.mjs';

type AccessStatus='approved'|'pending'|'missing'|'declined';
type AccessScreen='checking'|'request'|'pending'|'declined'|'link';
type EntryResult={status:AccessStatus;notice?:string};

class AccessStatusThrottled extends Error {
  constructor(readonly retryAfterMs:number){super('Access status throttled');}
}


function postAccess(path:string,body?:Record<string,string>){
  return fetch(`/api/access/${path}`,{
    method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',
    signal:AbortSignal.timeout(path==='request'?15000:12000),
    ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),
  });
}

async function readStatus():Promise<AccessStatus>{
  const response=await postAccess('request/status');
  if(response.status===204)return 'approved';
  if(response.status===429)throw new AccessStatusThrottled(retryAfterMilliseconds(response.headers.get('retry-after'),{fallback:60000,maximum:86400000}));
  if(response.status!==200)throw new Error('Access status unavailable');
  const {status}=await response.json();
  if(status==='pending'||status==='missing'||status==='declined')return status;
  throw new Error('Invalid access status');
}

async function enterPreview(requestsEnabled:boolean):Promise<EntryResult>{
  let notice:string|undefined;
  const fragment=window.location.hash.slice(1);
  if(fragment){
    window.history.replaceState(window.history.state,'','/access');
    if(/^[A-Za-z0-9_-]{43,128}$/.test(fragment)){
      try{
        const response=await postAccess('redeem',{token:fragment});
        if(response.ok)return {status:'approved'};
        notice=response.status===429?'Too many link attempts. Try again in a minute.':'This private link could not be opened.';
      }catch{
        notice='The preview could not connect. Try opening your private link again.';
      }
    }else{
      notice='This private link could not be opened.';
    }
  }
  if(await readPreviewSession())return {status:'approved'};
  return {status:requestsEnabled?await readStatus():'missing',notice};
}

export default function Access({requestsEnabled=false,challengeSiteKey=null,googleEnabled=false,signInNotice=''}:{
  requestsEnabled?:boolean;challengeSiteKey?:string|null;googleEnabled?:boolean;signInNotice?:string;
}){
  const [screen,setScreen]=useState<AccessScreen>('checking');
  const [notice,setNotice]=useState('');
  const [submitting,setSubmitting]=useState(false);
  const [challengeToken,setChallengeToken]=useState('');
  const [challengeAttempt,setChallengeAttempt]=useState(0);
  const entry=useRef<Promise<EntryResult>|null>(null);
  const submitInFlight=useRef(false);

  useEffect(()=>{
    let active=true;
    function showResult(result:Promise<EntryResult>){
      void result.then(({status,notice})=>{
        if(!active||entry.current!==result)return;
        if(status==='approved'){window.location.replace('/');return;}
        setNotice(notice??signInNotice);
        setScreen(status==='missing'?(requestsEnabled?'request':'link'):status);
      }).catch(()=>{
        if(!active||entry.current!==result)return;
        setNotice('Access status is temporarily unavailable. You can try again.');
        setScreen(requestsEnabled?'request':'link');
      });
    }
    function recheck(){
      setScreen('checking');
      setNotice('');
      entry.current=enterPreview(requestsEnabled);
      showResult(entry.current);
    }
    function openNewLink(){if(window.location.hash)recheck();}
    function restore(event:PageTransitionEvent){if(event.persisted)recheck();}
    entry.current??=enterPreview(requestsEnabled);
    showResult(entry.current);
    window.addEventListener('hashchange',openNewLink);
    window.addEventListener('pageshow',restore);
    return ()=>{active=false;window.removeEventListener('hashchange',openNewLink);window.removeEventListener('pageshow',restore);};
  },[requestsEnabled,signInNotice]);

  useEffect(()=>{
    if(screen!=='pending')return;
    const fastPollUntil=Date.now()+60000;
    let active=true;
    let inFlight=false;
    let retryAt=0;
    let timer:ReturnType<typeof setTimeout>|undefined;

    function schedule(){
      const now=Date.now();
      if(active&&document.visibilityState==='visible')timer=setTimeout(()=>void check(),Math.max(now<fastPollUntil?5000:15000,retryAt-now));
    }

    async function check(){
      if(!active||inFlight||document.visibilityState!=='visible')return;
      if(Date.now()<retryAt){schedule();return;}
      inFlight=true;
      try{
        const status=await readStatus();
        if(!active)return;
        if(status==='approved'){active=false;window.location.replace('/');return;}
        if(status==='declined'){active=false;setNotice('');setScreen('declined');return;}
        if(status==='missing'){
          active=false;
          setNotice('This request has expired. You can submit a new one.');
          setScreen('request');
          return;
        }
        setNotice('');
      }catch(error){
        if(error instanceof AccessStatusThrottled)retryAt=Date.now()+error.retryAfterMs;
        if(active)setNotice(error instanceof AccessStatusThrottled?'Access checks are paused briefly. We’ll retry automatically.':'Could not check your request. We’ll try again shortly.');
      }finally{
        inFlight=false;
        schedule();
      }
    }

    function onVisibility(){
      clearTimeout(timer);
      if(document.visibilityState==='visible')void check();
    }

    schedule();
    document.addEventListener('visibilitychange',onVisibility);
    return ()=>{active=false;clearTimeout(timer);document.removeEventListener('visibilitychange',onVisibility);};
  },[screen]);

  async function submitRequest(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(submitInFlight.current)return;
    const fields=new FormData(event.currentTarget);
    const name=String(fields.get('name')??'').trim(),email=String(fields.get('email')??'').trim();
    if(!name||!email){setNotice('Enter your name and email address.');return;}
    if(challengeSiteKey&&!challengeToken){setNotice('Complete the security check first.');return;}
    submitInFlight.current=true;
    setSubmitting(true);
    setNotice('');
    try{
      const response=await postAccess('request',{name,email,...(challengeSiteKey?{challengeToken}:{})});
      if(response.status===202){setScreen('pending');return;}
      if(response.status===400||response.status===422){setNotice('Check your name and email address, then try again.');return;}
      if(response.status===403&&challengeSiteKey){setNotice('The security check expired or was unsuccessful. Try again.');return;}
      if(response.status===429){setNotice('Too many requests. Try again later.');return;}
      setNotice('We couldn’t submit your request. Try again shortly.');
    }catch{
      setNotice('We couldn’t submit your request. Try again shortly.');
    }finally{
      submitInFlight.current=false;
      setSubmitting(false);
      if(challengeSiteKey){setChallengeToken('');setChallengeAttempt(attempt=>attempt+1);}
    }
  }

  const messages={
    checking:'Checking preview access…',
    request:'Request access to the paper-trading and market research preview.',
    pending:'Request sent. This page will open the preview once the owner approves.',
    declined:'The owner did not approve this request. You can still open a private link if you receive one.',
    link:googleEnabled?'Sign in with Google from the United States or open your private link.':'Open the private link you were given.',
  };

  return <main className="preview-entry">
    <section className="preview-card" aria-labelledby="access-heading">
      <p className="preview-eyebrow">Private preview</p>
      <h1 id="access-heading">Predictir</h1>
      <p className="preview-description" role="status">{messages[screen]}</p>
      <p className="preview-notice" aria-live="polite">{notice}</p>
      {googleEnabled&&screen==='request'&&<GoogleAccessLink/>}
      {screen==='request'&&<form className="preview-form" method="post" action="/api/access/request" onSubmit={submitRequest} aria-busy={submitting}>
        <label>Name
          <input className="preview-input" name="name" autoComplete="name" required maxLength={100}/>
        </label>
        <label>Email address
          <input className="preview-input" name="email" type="email" autoComplete="email" required maxLength={254}/>
        </label>
        {challengeSiteKey&&<AccessChallenge key={challengeAttempt} siteKey={challengeSiteKey} onToken={setChallengeToken}/>}
        <button className="preview-submit" type="submit" disabled={submitting||Boolean(challengeSiteKey&&!challengeToken)}>
          {submitting?'Sending request…':'Request access'}
        </button>
      </form>}
      {googleEnabled&&screen==='link'&&<GoogleAccessLink/>}
      {screen==='pending'&&<p className="preview-help">You can close this page and return here in the same browser.</p>}
      {screen!=='checking'&&<a className="preview-privacy" href="/privacy">Privacy</a>}
    </section>
  </main>;
}

function GoogleAccessLink(){
  return <a className="google-access-button" href="/api/access/google/start" rel="nofollow" style={{display:'flex',justifyContent:'center',
    alignItems:'center',gap:12,minHeight:44,border:'1px solid #747775',borderRadius:4,padding:'0 12px',background:'#fff',color:'#1f1f1f',
    font:"500 14px Roboto, Arial, sans-serif",textDecoration:'none',marginTop:18}}>
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48" focusable="false">
      <path fill="#4285F4" d="M43.61 24.46c0-1.36-.12-2.66-.35-3.92H24v7.42h11a9.41 9.41 0 0 1-4.08 6.17v5.13h6.6c3.85-3.55 6.09-8.79 6.09-14.8Z"/>
      <path fill="#34A853" d="M24 44c5.51 0 10.13-1.83 13.52-4.97l-6.6-5.12c-1.83 1.23-4.17 1.96-6.92 1.96-5.32 0-9.83-3.59-11.44-8.42H5.74v5.28C9.1 39.42 16.01 44 24 44Z"/>
      <path fill="#FBBC05" d="M12.56 27.45c-.41-1.23-.64-2.54-.64-3.89s.23-2.66.64-3.89v-5.28H5.74A20.28 20.28 0 0 0 3.6 23.56c0 3.27.78 6.36 2.14 9.17l6.82-5.28Z"/>
      <path fill="#EA4335" d="M24 11.25c2.99 0 5.67 1.03 7.78 3.05l5.83-5.83C34.1 5.2 29.48 3.2 24 3.2c-7.99 0-14.9 4.58-18.26 11.27l6.82 5.28c1.61-4.83 6.12-8.5 11.44-8.5Z"/>
    </svg>
    Sign in with Google
  </a>;
}
