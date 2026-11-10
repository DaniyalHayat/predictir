import type {ReactNode} from 'react';
import Analytics from '../components/Analytics.jsx';
import PrivateWorkspaceControls from '../components/PrivateWorkspaceControls';
import {azureMode} from '../../lib/workspace/azure-mode.mjs';
import {shareAccessEnabled,shareCookieAuthorized} from '../../lib/private-access.mjs';
import {headers} from 'next/headers';

export default async function WorkspaceLayout({children}:{children:ReactNode}) {
  const requestHeaders=await headers(),nonce=requestHeaders.get('x-nonce')||undefined;
  const privateAccess=shareAccessEnabled(),edition=azureMode();
  return <>
    {children}
    {edition==='live'&&<footer style={{background:'#0b0c0e',color:'#cbd0d8',fontSize:12,padding:'8px 20px'}}><a style={{color:'inherit'}} href="https://db-ip.com/">IP geolocation by DB-IP</a></footer>}
    {privateAccess&&shareCookieAuthorized(requestHeaders.get('cookie'))&&<PrivateWorkspaceControls/>}
    {!edition&&!privateAccess&&<Analytics nonce={nonce}/>}
  </>;
}
