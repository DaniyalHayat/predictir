import {handleGoogleAccess} from '../../../../../lib/google-access.mjs';

export const runtime='nodejs';

export async function GET(request,{params}){
  const {action}=await params;
  return handleGoogleAccess(request,action);
}
