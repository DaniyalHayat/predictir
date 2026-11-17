'use client';
import {useEffect,useState} from 'react';
import {readPreviewSession} from '../../ui/preview-session.mjs';
import './private-session.css';

export default function PrivateWorkspaceControls() {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    const page=document.documentElement;
    const show=()=>page.removeAttribute('data-preview-revalidating');
    const hide=()=>page.setAttribute('data-preview-revalidating','');
    let active=true;
    const leave=(event:PageTransitionEvent)=>{if(event.persisted)hide();};
    const restore=(event:PageTransitionEvent)=>{
      if(!event.persisted)return;
      hide();
      void readPreviewSession().then(valid=>{
        if(!active)return;
        if(valid)show();
        else window.location.replace('/access');
      }).catch(()=>{if(active)window.location.reload();});
    };
    window.addEventListener('pagehide',leave);
    window.addEventListener('pageshow',restore);
    return ()=>{
      active=false;show();
      window.removeEventListener('pagehide',leave);
      window.removeEventListener('pageshow',restore);
    };
  },[]);
  async function lock() {
    if(busy)return;
    setBusy(true);setError('');
    try {
      const response=await fetch('/api/access/logout',{method:'POST',credentials:'same-origin',cache:'no-store'});
      if(!response.ok)throw new Error();
      window.location.replace('/access');
    }catch{setError('Could not lock the workspace. Try again.');setBusy(false);}
  }
  return <div className="private-session-controls workspace-lock-wrap"><button className="workspace-lock" type="button" onClick={lock} disabled={busy} title="Reopen the preview to return">{busy?'Locking…':'Lock workspace'}</button>{error&&<span role="alert">{error}</span>}</div>;
}
