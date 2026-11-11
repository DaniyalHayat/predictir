export const ACCESS_CHALLENGE_ORIGIN = 'https://challenges.cloudflare.com';
export const ACCESS_CHALLENGE_ACTION = 'preview_request';

export function accessChallengeConfig(env = process.env) {
  const siteKey = env.PREDICTIR_ACCESS_TURNSTILE_SITE_KEY || '';
  const secret = env.PREDICTIR_ACCESS_TURNSTILE_SECRET || '';
  if (!siteKey && !secret) return {enabled: false, siteKey: null};
  const key = /^[A-Za-z0-9_-]{8,200}$/;
  const productionTestKey = env.NODE_ENV === 'production' && (/x0{16}/.test(siteKey) || /x0{16}/.test(secret));
  return {enabled: true, siteKey: key.test(siteKey) && key.test(secret) && !productionTestKey ? siteKey : null};
}

export async function validateAccessChallenge(token, request, env, fetcher = fetch) {
  const config = accessChallengeConfig(env);
  if (!config.enabled) return 200;
  if (!config.siteKey) return 503;
  if (typeof token !== 'string' || !token || token.length > 2048) return 403;
  try {
    const result = await fetcher(ACCESS_CHALLENGE_ORIGIN + '/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({secret: env.PREDICTIR_ACCESS_TURNSTILE_SECRET, response: token}),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(3500)]),
    });
    if (!result.ok) return 503;
    const verified = await result.json();
    const hostname = new URL(env.APP_ORIGIN || request.url).hostname;
    return verified.success === true && verified.hostname === hostname && verified.action === ACCESS_CHALLENGE_ACTION ? 200 : 403;
  } catch {
    return 503;
  }
}
