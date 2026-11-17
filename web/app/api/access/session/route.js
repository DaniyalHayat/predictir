import {previewSessionResponse} from '../../../../lib/private-access.mjs';

export const runtime='nodejs';

export function GET(request){
  return previewSessionResponse(request);
}
