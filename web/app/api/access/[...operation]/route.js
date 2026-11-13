import {handleAccessRequest} from '../../../../lib/access-requests.mjs';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function POST(request,{params}){
  const {operation}=await params;
  return handleAccessRequest(request,operation.join('/'));
}
