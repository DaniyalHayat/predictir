import Access from './Access';
import OwnerAccess from './manage/OwnerAccess';
import {accessRequestsEnabled,hasAccessOwnerSession} from '../../lib/access-requests.mjs';
import {accessChallengeConfig} from '../../lib/workspace/access-challenge.mjs';
import {headers} from 'next/headers';
export const dynamic='force-dynamic';
export const metadata={title:'Predictir | Private preview',robots:{index:false,follow:false}};
export default async function AccessPage(){
  const challenge=accessChallengeConfig();
  return <>
    <Access requestsEnabled={accessRequestsEnabled()&&(!challenge.enabled||Boolean(challenge.siteKey))}
      challengeSiteKey={challenge.siteKey}/>
    {hasAccessOwnerSession(await headers())&&<OwnerAccess notificationOnly/>}
  </>;
}
