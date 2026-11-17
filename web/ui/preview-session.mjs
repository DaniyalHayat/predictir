export async function readPreviewSession(){
  const response=await fetch('/api/access/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(response.status===204)return true;
  if(response.status===401)return false;
  throw new Error('Preview session unavailable');
}
