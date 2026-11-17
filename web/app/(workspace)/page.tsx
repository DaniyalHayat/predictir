import Workspace from '../../ui/App';
import ReplayWorkspace from '../../ui/ReplayWorkspace';
import {azureMode} from '../../lib/workspace/azure-mode.mjs';
import {shareAccessEnabled,shareAccessKind} from '../../lib/private-access.mjs';
import {headers} from 'next/headers';
import PrivateWorkspaceControls from '../components/PrivateWorkspaceControls';

export default async function Home() {
  const mode=azureMode();
  const controls=shareAccessEnabled()&&shareAccessKind((await headers()).get('cookie'))?<PrivateWorkspaceControls/>:<></>;
  return mode==='replay'?<ReplayWorkspace privateControls={controls}/>:<Workspace paperWorkspace={mode==='live'} privateControls={controls}/>;
}
