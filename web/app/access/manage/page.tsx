import {notFound} from 'next/navigation';
import {accessRequestsEnabled} from '../../../lib/access-requests.mjs';
import OwnerAccess from './OwnerAccess';

export const dynamic='force-dynamic';
export const metadata={
  title:'Predictir | Access requests',
  robots:{index:false,follow:false},
  formatDetection:{email:false,telephone:false,address:false},
  manifest:'/access/manifest.webmanifest',
  icons:{apple:'/access/icon-192.png'},
};

export default function ManageAccessPage(){
  if(!accessRequestsEnabled())notFound();
  return <OwnerAccess/>;
}
