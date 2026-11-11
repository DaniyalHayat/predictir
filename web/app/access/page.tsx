import Access from './Access';
import {accessRequestsEnabled} from '../../lib/access-requests.mjs';
export const dynamic='force-dynamic';
export const metadata={title:'Predictir | Private preview',robots:{index:false,follow:false}};
export default function AccessPage(){return <Access requestsEnabled={accessRequestsEnabled()}/>;}
