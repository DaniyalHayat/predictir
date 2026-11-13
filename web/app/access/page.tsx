import Access from './Access';
import {accessRequestsEnabled} from '../../lib/access-requests.mjs';
import {accessChallengeConfig} from '../../lib/workspace/access-challenge.mjs';
export const dynamic='force-dynamic';
export const metadata={title:'Predictir | Private preview',robots:{index:false,follow:false}};
export default function AccessPage(){
  const challenge=accessChallengeConfig();
  return <Access requestsEnabled={accessRequestsEnabled()&&(!challenge.enabled||Boolean(challenge.siteKey))}
    challengeSiteKey={challenge.siteKey}/>;
}
