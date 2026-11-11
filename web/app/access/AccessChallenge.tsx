'use client';

import {useEffect,useRef,useState} from 'react';
import Script from 'next/script';

type Turnstile = {
  render: (element: HTMLElement, options: {
    sitekey: string;
    action: string;
    theme: 'dark';
    size: 'compact';
    appearance: 'interaction-only';
    callback: (token: string) => void;
    'expired-callback': () => void;
    'error-callback': () => void;
  }) => string;
  remove: (id: string) => void;
};

export default function AccessChallenge({siteKey,onToken}:{siteKey:string;onToken:(token:string)=>void}){
  const element=useRef<HTMLDivElement>(null);
  const [ready,setReady]=useState(false);
  const [error,setError]=useState(false);
  useEffect(()=>{
    const widget=(window as Window & {turnstile?:Turnstile}).turnstile;
    if(!ready||!widget||!element.current)return;
    const reset=()=>onToken('');
    const id=widget.render(element.current,{
      sitekey:siteKey,action:'preview_request',theme:'dark',size:'compact',appearance:'interaction-only',
      callback:token=>{setError(false);onToken(token);},
      'expired-callback':reset,'error-callback':()=>{reset();setError(true);},
    });
    return ()=>widget.remove(id);
  },[ready,siteKey,onToken]);
  return <>
    <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
      strategy="afterInteractive" onReady={()=>setReady(true)} onError={()=>setError(true)}/>
    <div ref={element}/>
    {error&&<p role="status">The security check could not load. Reload this page to try again.</p>}
  </>;
}
