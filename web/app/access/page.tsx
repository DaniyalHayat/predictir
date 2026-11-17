import Access from './Access';
import OwnerAccess from './manage/OwnerAccess';
import {accessRequestsEnabled,hasAccessOwnerSession} from '../../lib/access-requests.mjs';
import {googleAccessEnabled} from '../../lib/google-access.mjs';
import {accessChallengeConfig} from '../../lib/workspace/access-challenge.mjs';
import {headers} from 'next/headers';
import './preview.css';
export const dynamic='force-dynamic';
export const metadata={title:'Predictir | Private preview',robots:{index:false,follow:false}};
export default async function AccessPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const challenge=accessChallengeConfig();
  const googleEnabled=googleAccessEnabled(),signIn=(await searchParams)['sign-in'];
  const signInNotice=!googleEnabled?'':signIn==='region'?'Google sign-in is available in the United States.':
    signIn==='retry'?'Google sign-in didn’t finish. You can try again.':'';
  return <>
    <Access requestsEnabled={accessRequestsEnabled()&&(!challenge.enabled||Boolean(challenge.siteKey))}
      challengeSiteKey={challenge.siteKey} googleEnabled={googleEnabled} signInNotice={signInNotice}/>
    {hasAccessOwnerSession(await headers())&&<OwnerAccess notificationOnly/>}
  </>;
}
