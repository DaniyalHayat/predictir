'use client';

import {useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import styles from './owner.module.css';

type AccessRequest={id:string;name:string;email:string;createdAt:string};

function post(path:string,body:unknown){
  return fetch('/api/access/manage'+path,{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
}

function pushSupported(){
  return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
}

export default function OwnerAccess(){
  const [state,setState]=useState<'loading'|'locked'|'ready'|'unavailable'>('loading');
  const [requests,setRequests]=useState<AccessRequest[]>([]);
  const [publicKey,setPublicKey]=useState('');
  const [pushState,setPushState]=useState<'on'|'off'|'unavailable'>('unavailable');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [deciding,setDeciding]=useState('');
  const submission=useRef(false);
  const registration=useRef<ServiceWorkerRegistration|null>(null);
  const currentSubscription=useRef<PushSubscription|null>(null);

  async function refresh(){
    try{
      const result=await post('',{action:'list'});
      if(result.status===401){setRequests([]);setState('locked');return;}
      if(!result.ok)throw new Error();
      const data=await result.json();
      setRequests(data.requests);
      setPublicKey(data.vapidPublicKey||'');
      setState('ready');
    }catch{
      setState(previous=>previous==='ready'?'ready':'unavailable');
      setMessage('The request queue is unavailable. Try again.');
    }
  }

  useEffect(()=>{
    const reopen=()=>{if(document.visibilityState==='visible')void refresh();};
    const notification=(event:MessageEvent)=>{if(event.data==='predictir-access-request')void refresh();};
    void refresh();
    document.addEventListener('visibilitychange',reopen);
    navigator.serviceWorker?.addEventListener('message',notification);
    return ()=>{
      document.removeEventListener('visibilitychange',reopen);
      navigator.serviceWorker?.removeEventListener('message',notification);
    };
  },[]);
  useEffect(()=>{
    if(state!=='ready'||!publicKey||!pushSupported())return;
    let active=true;
    void navigator.serviceWorker.register('/access/push.js',{scope:'/access/'})
      .then(()=>navigator.serviceWorker.ready).then(async worker=>{
        const subscription=await worker.pushManager.getSubscription();
        if(!active)return;
        registration.current=worker;
        currentSubscription.current=subscription;
        setPushState(subscription?'on':'off');
      }).catch(()=>{});
    return ()=>{active=false;};
  },[state,publicKey]);

  async function signIn(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(submission.current)return;
    const form=event.currentTarget;
    const code=String(new FormData(form).get('code')||'').trim();
    submission.current=true;
    setBusy(true);
    setMessage('');
    try{
      const result=await post('/sign-in',{code});
      if(result.status===401){setMessage('That owner code didn’t match.');return;}
      if(!result.ok)throw new Error();
      form.reset();
      await refresh();
    }catch{setMessage('Owner sign-in is unavailable. Try again.');}
    finally{submission.current=false;setBusy(false);}
  }

  async function decide(id:string,decision:'approved'|'declined'){
    if(deciding)return;
    setDeciding(id);
    setMessage('');
    try{
      const result=await post('',{action:'decide',id,decision});
      if(result.status===401||result.status===409||result.status===404){await refresh();return;}
      if(!result.ok)throw new Error();
      const {status}=await result.json();
      setRequests(items=>items.filter(item=>item.id!==id));
      setMessage(status==='approved'?'Approved. The visitor can now open Predictir.':
        status==='declined'?'Request declined.':'This request has expired.');
    }catch{setMessage('The decision could not be saved. Refresh the queue and try again.');}
    finally{setDeciding('');}
  }

  async function changeNotifications(){
    const worker=registration.current;
    if(!worker||!publicKey||busy)return;
    setBusy(true);
    setMessage('');
    try{
      const existing=currentSubscription.current;
      if(pushState==='on'){
        if(existing){
          const result=await post('',{action:'unsubscribe',endpoint:existing.endpoint});
          if(!result.ok)throw new Error();
          await existing.unsubscribe();
        }
        currentSubscription.current=null;
        setPushState('off');
        setMessage('Request alerts are off on this device.');
      }else{
        const key=Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-publicKey.length%4)%4)),character=>character.charCodeAt(0));
        const subscription=existing??await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
        const result=await post('',{action:'subscribe',subscription:subscription.toJSON()});
        if(!result.ok){if(!existing)await subscription.unsubscribe();throw new Error();}
        currentSubscription.current=subscription;
        setPushState('on');
        setMessage('Request alerts are on for this device.');
      }
    }catch{setMessage(Notification.permission==='denied'?'Allow notifications in this device’s settings to receive alerts.':
      'Notification settings could not be saved. Try again.');}
    finally{setBusy(false);}
  }

  async function signOut(){
    setMessage('');
    try{
      const result=await post('',{action:'sign-out'});
      if(!result.ok&&result.status!==401)throw new Error();
      setRequests([]);
      setState('locked');
    }catch{setMessage('Could not sign out. Try again.');}
  }

  return <main className={styles.shell}>
    <section className={styles.card} aria-labelledby="owner-title">
      <a href="/access" className={styles.brand}>Predictir</a>
      <h1 id="owner-title">Access requests</h1>
      {state==='loading'&&<p role="status">Opening the request queue…</p>}
      {state==='unavailable'&&<button onClick={()=>void refresh()}>Try again</button>}
      {state==='locked'&&<form className={styles.form} method="post" action="/api/access/manage/sign-in" onSubmit={signIn}>
        <label htmlFor="owner-code">Owner code</label>
        <input id="owner-code" name="code" type="password" autoComplete="current-password" maxLength={80} required/>
        <button disabled={busy}>{busy?'Signing in…':'Sign in'}</button>
      </form>}
      {state==='ready'&&<>
        <div className={styles.tools}>
          <button onClick={()=>void refresh()}>Refresh</button>
          {pushState!=='unavailable'&&<button disabled={busy} onClick={()=>void changeNotifications()}>
            {pushState==='on'?'Turn off alerts':'Enable alerts on this device'}
          </button>}
          <button onClick={()=>void signOut()}>Sign out</button>
        </div>
        {publicKey&&pushState==='unavailable'&&<p>On iPhone or iPad, open this page from your Home Screen to enable alerts.</p>}
        {requests.length===0?<p>No pending requests.</p>:<ul className={styles.list}>
          {requests.map(item=><li key={item.id}>
            <strong>{item.name}</strong><span>{item.email}</span>
            <div className={styles.tools}>
              <button className={styles.approve} disabled={Boolean(deciding)} onClick={()=>void decide(item.id,'approved')}>Approve</button>
              <button disabled={Boolean(deciding)} onClick={()=>void decide(item.id,'declined')}>Decline</button>
            </div>
          </li>)}
        </ul>}
      </>}
      <p role="status" aria-live="polite">{message}</p>
    </section>
  </main>;
}
