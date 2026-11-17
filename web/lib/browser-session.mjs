export const BROWSER_IDLE_SECONDS=30*86400;
export const BROWSER_MAX_SECONDS=180*86400;
export const BROWSER_REFRESH_SECONDS=86400;

export function validBrowserSession(issued,expiry,current){
  return Number.isSafeInteger(issued)&&Number.isSafeInteger(expiry)&&issued<=current+60&&
    expiry>current&&expiry>issued&&expiry<=current+BROWSER_IDLE_SECONDS+60&&expiry<=issued+BROWSER_MAX_SECONDS;
}

export function browserSessionExpiry(issued,current){
  return Math.min(current+BROWSER_IDLE_SECONDS,issued+BROWSER_MAX_SECONDS);
}
