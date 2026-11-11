'use client';

import {useEffect,useRef,useState} from 'react';
import type {CSSProperties,FormEvent} from 'react';
import AccessChallenge from './AccessChallenge';

type AccessStatus='approved'|'pending'|'missing'|'declined';
type AccessScreen='checking'|'request'|'pending'|'declined'|'link';
type EntryResult={status:AccessStatus;notice?:string};

const inputStyle:CSSProperties={width:'100%',boxSizing:'border-box',background:'#080808',color:'#f5f5f5',border:'1px solid #505050',borderRadius:8,padding:'12px',font:'inherit',minHeight:44};
const buttonStyle:CSSProperties={width:'100%',minHeight:44,border:'1px solid #f5f5f5',borderRadius:8,padding:'10px 14px',background:'#f5f5f5',color:'#101010',font:'inherit',fontWeight:600};

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
  return {status:requestsEnabled?await readStatus():'missing',notice};
}

export default function Access({requestsEnabled=false,challengeSiteKey=null}:{requestsEnabled?:boolean;challengeSiteKey?:string|null}){
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
        setNotice(notice??'');
        setScreen(status==='missing'?(requestsEnabled?'request':'link'):status);
      }).catch(()=>{
        if(!active||entry.current!==result)return;
        setNotice('Access status is temporarily unavailable. You can try again.');
        setScreen(requestsEnabled?'request':'link');
      });
    }
    function openNewLink(){
      if(!window.location.hash)return;
      setScreen('checking');
      setNotice('');
      entry.current=enterPreview(requestsEnabled);
      showResult(entry.current);
    }
    entry.current??=enterPreview(requestsEnabled);
    showResult(entry.current);
    window.addEventListener('hashchange',openNewLink);
    return ()=>{active=false;window.removeEventListener('hashchange',openNewLink);};
  },[requestsEnabled]);

  useEffect(()=>{
    if(screen!=='pending')return;
    const fastPollUntil=Date.now()+60000;
    let active=true;
    let inFlight=false;
    let timer:ReturnType<typeof setTimeout>|undefined;

    function schedule(){
      if(active&&document.visibilityState==='visible')timer=setTimeout(()=>void check(),Date.now()<fastPollUntil?5000:15000);
    }

    async function check(){
      if(!active||inFlight||document.visibilityState!=='visible')return;
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
      }catch{
        if(active)setNotice('Could not check your request. We’ll try again shortly.');
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
    request:'Enter your name and email to request access from the owner.',
    pending:'Request sent. This page will open the preview once the owner approves.',
    declined:'The owner did not approve this request. You can still open a private link if you receive one.',
    link:'Open the private link you were given.',
  };

  return <main style={{minHeight:'100dvh',boxSizing:'border-box',display:'grid',placeItems:'center',background:'#080808',color:'#f5f5f5',padding:'clamp(16px, 5vw, 32px)',fontFamily:'Arial, sans-serif',colorScheme:'dark'}}>
    <section aria-labelledby="access-heading" style={{maxWidth:420,width:'100%',boxSizing:'border-box',border:'1px solid #303030',borderRadius:18,padding:'clamp(20px, 6vw, 32px)',background:'#111'}}>
      <p style={{fontSize:12,color:'#aaa',letterSpacing:2,textTransform:'uppercase',margin:0}}>Private preview</p>
      <h1 id="access-heading" style={{fontSize:34,letterSpacing:-1,margin:'16px 0'}}>Predictir</h1>
      <p role="status" style={{fontSize:16,lineHeight:1.6,color:'#d0d0d0',margin:'0 0 12px'}}>{messages[screen]}</p>
      <p aria-live="polite" style={{color:'#ffc0a6',fontSize:14,lineHeight:1.5,margin:notice?'12px 0':0}}>{notice}</p>
      {screen==='request'&&<form method="post" action="/api/access/request" onSubmit={submitRequest} aria-busy={submitting} style={{display:'grid',gap:14,marginTop:20}}>
        <label style={{display:'grid',gap:6,fontSize:14}}>Name
          <input name="name" autoComplete="name" required maxLength={100} style={inputStyle}/>
        </label>
        <label style={{display:'grid',gap:6,fontSize:14}}>Email address
          <input name="email" type="email" autoComplete="email" required maxLength={254} style={inputStyle}/>
        </label>
        {challengeSiteKey&&<AccessChallenge key={challengeAttempt} siteKey={challengeSiteKey} onToken={setChallengeToken}/>}
        <button type="submit" disabled={submitting||Boolean(challengeSiteKey&&!challengeToken)} style={{...buttonStyle,opacity:submitting||challengeSiteKey&&!challengeToken?0.7:1,cursor:submitting?'wait':'pointer'}}>
          {submitting?'Sending request…':'Request access'}
        </button>
      </form>}
      {screen==='pending'&&<p style={{fontSize:13,lineHeight:1.6,color:'#aaa',margin:'18px 0 0'}}>You can close this page and return here in the same browser.</p>}
    </section>
  </main>;
}
