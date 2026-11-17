'use client';

import {useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import ApprovalBanner from './ApprovalBanner';
import styles from './owner.module.css';

type AccessRequest={id:string;name:string;email:string;createdAt:string};
type Decision='approved'|'declined';
type Notice={request:AccessRequest;autoOpen?:boolean};
const requestIdPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const requestTime=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const refreshInterval=12000;
const dismissedKey='predictir:approval-banner-dismissals';

function post(path:string,body:unknown){
  return fetch('/api/access/manage'+path,{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
}

function pushSupported(){
  return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
}

export default function OwnerAccess({notificationOnly=false}:{notificationOnly?:boolean}){
  const [state,setState]=useState<'loading'|'locked'|'ready'|'unavailable'>('loading');
  const [requests,setRequests]=useState<AccessRequest[]>([]);
  const [publicKey,setPublicKey]=useState('');
  const [pushState,setPushState]=useState<'on'|'off'|'unavailable'>('unavailable');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [deciding,setDeciding]=useState('');
  const [selectedRequest,setSelectedRequest]=useState('');
  const [notice,setNotice]=useState<Notice|null>(null);
  const selectedCard=useRef<HTMLElement|null>(null);
  const submission=useRef(false);
  const decisionInFlight=useRef(false);
  const dismissals=useRef(new Set<string>());
  const pendingFocus=useRef('');
  const confirmingNotice=useRef('');
  const refreshVersion=useRef(0);
  const ownerChannel=useRef<BroadcastChannel|null>(null);
  const registration=useRef<ServiceWorkerRegistration|null>(null);
  const currentSubscription=useRef<PushSubscription|null>(null);

  function showNotice(list:AccessRequest[],target?:string){
    setNotice(current=>{
      if(current?.request.id===confirmingNotice.current)return current;
      const selected=list.find(item=>item.id===target);
      if(selected)return {request:selected,autoOpen:true};
      if(current&&list.some(item=>item.id===current.request.id))return current;
      const next=list.find(item=>!dismissals.current.has(item.id));
      return next?{request:next}:null;
    });
  }

  function lock(){
    refreshVersion.current++;
    setRequests([]);
    setNotice(null);
    setState('locked');
  }

  async function refresh(background=false){
    const version=++refreshVersion.current;
    try{
      const result=await post('',{action:'list',background});
      if(version!==refreshVersion.current)return;
      if(result.status===401||result.status===403||result.status===404){lock();return;}
      if(!result.ok)throw new Error();
      const data=await result.json();
      if(version!==refreshVersion.current)return;
      showNotice(data.requests,pendingFocus.current);
      pendingFocus.current='';
      setRequests(data.requests);
      setPublicKey(data.vapidPublicKey||'');
      setState('ready');
    }catch{
      if(version!==refreshVersion.current||background)return;
      setState(previous=>previous==='ready'?'ready':'unavailable');
      setMessage('The request queue is unavailable. Try again.');
    }
  }

  useEffect(()=>{
    try{
      const saved=JSON.parse(sessionStorage.getItem(dismissedKey)||'[]');
      if(Array.isArray(saved))dismissals.current=new Set(saved.slice(-336).filter(
        id=>typeof id==='string'&&requestIdPattern.test(id)));
    }catch{}
    const reopen=()=>{if(document.visibilityState==='visible')void refresh();};
    const notification=(event:MessageEvent)=>{
      if(event.data==='predictir-access-request'||event.data?.type==='predictir-access-pending'){
        if(document.visibilityState==='visible')void refresh(true);
        return;
      }
      if(event.data?.type!=='predictir-access-request')return;
      const id=event.data.requestId;
      if(typeof id==='string'&&requestIdPattern.test(id)){
        setSelectedRequest(id);
        pendingFocus.current=id;
      }
      void refresh();
    };
    if(!notificationOnly){
      const ids=new URLSearchParams(window.location.search).getAll('request');
      if(ids.length===1&&requestIdPattern.test(ids[0])){
        setSelectedRequest(ids[0]);
        pendingFocus.current=ids[0];
      }
    }
    if(typeof BroadcastChannel==='function'){
      try{
        const channel=new BroadcastChannel('predictir-owner-access');
        channel.onmessage=event=>{if(event.data==='signed-out')lock();};
        ownerChannel.current=channel;
      }catch{}
    }
    void refresh();
    document.addEventListener('visibilitychange',reopen);
    navigator.serviceWorker?.addEventListener('message',notification);
    return ()=>{
      refreshVersion.current++;
      ownerChannel.current?.close();
      ownerChannel.current=null;
      document.removeEventListener('visibilitychange',reopen);
      navigator.serviceWorker?.removeEventListener('message',notification);
    };
  },[notificationOnly]);
  useEffect(()=>{
    if(state!=='ready'&&state!=='unavailable')return;
    const timer=window.setInterval(()=>{
      if(document.visibilityState==='visible'&&!decisionInFlight.current)void refresh(true);
    },refreshInterval);
    return ()=>window.clearInterval(timer);
  },[state]);
  const selectedPending=state==='ready'&&requests.some(item=>item.id===selectedRequest);
  useEffect(()=>{
    if(!selectedPending||notice?.autoOpen)return;
    selectedCard.current?.scrollIntoView({block:'center'});
    selectedCard.current?.focus({preventScroll:true});
  },[selectedPending,selectedRequest,notice?.autoOpen]);

  useEffect(()=>{
    if(notificationOnly||state!=='ready'||!publicKey||!pushSupported())return;
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
  },[state,publicKey,notificationOnly]);

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

  async function decide(id:string,decision:Decision,fromNotice=false):Promise<Decision|'expired'>{
    if(decisionInFlight.current)throw new Error('Another decision is being saved.');
    decisionInFlight.current=true;
    if(fromNotice)confirmingNotice.current=id;
    setDeciding(id);
    setMessage('');
    try{
      const result=await post('',{action:'decide',id,decision});
      if(result.status===401){lock();throw new Error('Sign in to review this request.');}
      if(!result.ok&&result.status!==404&&result.status!==409)throw new Error();
      const data=result.ok?await result.json():{status:'missing'};
      const status=data.status==='missing'?'expired':data.status;
      if(status!=='approved'&&status!=='declined'&&status!=='expired')throw new Error();
      refreshVersion.current++;
      setRequests(items=>items.filter(item=>item.id!==id));
      if(!fromNotice)setNotice(current=>current?.request.id===id?null:current);
      setSelectedRequest(previous=>previous===id?'':previous);
      setMessage(status==='approved'?'Approved. The visitor can now open Predictir.':
        status==='declined'?'Request declined.':'This request has expired.');
      return status;
    }catch(error){
      if(fromNotice)confirmingNotice.current='';
      setMessage('The decision could not be saved. Refresh the queue and try again.');
      throw error;
    }finally{decisionInFlight.current=false;setDeciding('');}
  }

  function dismissNotice(id:string){
    dismissals.current.add(id);
    try{sessionStorage.setItem(dismissedKey,JSON.stringify([...dismissals.current].slice(-336)));}catch{}
    const url=new URL(window.location.href);
    if(!notificationOnly&&url.searchParams.get('request')===id){
      url.searchParams.delete('request');
      window.history.replaceState(window.history.state,'',url);
    }
    confirmingNotice.current='';
    setNotice(current=>current?.request.id===id?null:current);
    showNotice(requests);
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
      lock();
      ownerChannel.current?.postMessage('signed-out');
    }catch{setMessage('Could not sign out. Try again.');}
  }

  async function copyEmail(email:string){
    try{
      await navigator.clipboard.writeText(email);
      setMessage('Email copied.');
    }catch{setMessage('Could not copy. Select the email and copy it manually.');}
  }

  const alert=state==='ready'&&notice?<ApprovalBanner key={notice.request.id} request={notice.request}
    autoOpen={notice.autoOpen} onDismiss={()=>dismissNotice(notice.request.id)}
    onDecision={(id,decision)=>decide(id,decision,true)}/>:null;
  if(notificationOnly)return alert;
  return <><main className={styles.shell}>
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
        {publicKey&&pushState==='unavailable'&&<p>On iPhone or iPad, open this page in Safari, choose Share → Add to Home Screen, then open the Predictir icon to enable alerts.</p>}
        {!publicKey&&<p>Push alerts are currently unavailable. Use this page to review requests.</p>}
        {selectedRequest&&!selectedPending&&<p role="status">That request is no longer pending.</p>}
        {requests.length===0?<p>No pending requests.</p>:<ul className={styles.list}>
          {requests.map(item=>{
            const selected=item.id===selectedRequest;
            const date=new Date(item.createdAt);
            return <li key={item.id}>
              <article className={styles.request} data-selected={selected||undefined} aria-labelledby={'request-'+item.id}
                ref={selected?selectedCard:undefined} tabIndex={selected?-1:undefined} aria-busy={deciding===item.id}>
                <header className={styles.requestHeader}>
                  {selected&&<span className={styles.selectedLabel}>Selected request</span>}
                  <h2 className={styles.name} id={'request-'+item.id}>{item.name}</h2>
                  {Number.isFinite(+date)&&<time dateTime={item.createdAt}>{requestTime.format(date)}</time>}
                </header>
                <div className={styles.contact}>
                  <span className={styles.email} onClick={event=>{
                    if(event.target instanceof Element&&event.target.closest('a'))event.preventDefault();
                  }}>{item.email}</span>
                  <button type="button" className={styles.copy} aria-label={'Copy email for '+item.name}
                    onClick={()=>void copyEmail(item.email)}>Copy email</button>
                </div>
                <footer className={styles.decisions}>
                  <button type="button" className={styles.approve} disabled={Boolean(deciding)}
                    aria-label={'Approve '+item.name} onClick={()=>void decide(item.id,'approved').catch(()=>{})}>Approve</button>
                  <button type="button" className={styles.decline} disabled={Boolean(deciding)}
                    aria-label={'Decline '+item.name} onClick={()=>void decide(item.id,'declined').catch(()=>{})}>Decline</button>
                </footer>
              </article>
            </li>;
          })}
        </ul>}
      </>}
      <p role="status" aria-live="polite">{message}</p>
    </section>
  </main>{alert}</>;
}
