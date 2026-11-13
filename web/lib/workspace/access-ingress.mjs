import {isIP} from 'node:net';
import {azureAccess} from './azure-access.mjs';
import {azureMode} from './azure-mode.mjs';
import {isCountryAllowed} from './geo.mjs';

export async function accessIngress(headers, env, countryLookup) {
  if (env.VERCEL === '1') {
    const country = headers.get('x-vercel-ip-country');
    const ip = headers.get('x-vercel-forwarded-for')?.split(',')[0].trim();
    return isCountryAllowed(country) && ip && isIP(ip)
      ? {status: 200, country, ip}
      : {status: 403};
  }
  if (azureMode(env.PREDICTIR_MODE) === 'live') return azureAccess(headers, countryLookup);
  return {status: 200, country: 'US'};
}
