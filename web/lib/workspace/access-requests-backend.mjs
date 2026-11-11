import {createECDH, createHmac, ECDH, randomUUID} from 'node:crypto';
import {generateRequestDetails} from 'web-push';

export const ACCESS_REQUESTS_INTERNAL_PATH = '/api/internal/access-requests';
const REQUESTS = 'predictir-access-requests-v1';
const PUSH = 'predictir-access-push-v1';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DAY = 86400;
const MAX_SUBSCRIPTIONS = 4;
const message = JSON.stringify({
  title: 'Predictir access request',
  body: 'Someone requested access. Open Predictir to review.',
  url: '/access/manage',
});

function fail(status, message, retryAfter) {
  throw Object.assign(new Error(message), {status, retryAfter});
}

function hashValue(value) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(400, 'Invalid access request.');
  return value;
}

function cleanText(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) return '';
  return value.trim();
}

function contact(input) {
  const name = cleanText(input.name, 100);
  const email = cleanText(input.email, 254).toLowerCase();
  if (!name || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email) || email.split('@')[0].length > 64)
    fail(400, 'Enter a name and a valid email address.');
  return {name, email};
}

function subscriptionEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) fail(400, 'Unsupported push endpoint.');
  let url;
  try { url = new URL(value); }
  catch { fail(400, 'Unsupported push endpoint.'); }
  const host = url.hostname;
  const trusted = host === 'fcm.googleapis.com' && url.pathname.startsWith('/fcm/send/') ||
    host === 'updates.push.services.mozilla.com' ||
    /^[a-z0-9-]+\.push\.apple\.com$/.test(host) ||
    /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  if (!trusted || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.pathname === '/')
    fail(400, 'Unsupported push endpoint.');
  return url.href;
}

function isEncodedKey(value, bytes) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, 'base64url').length === bytes && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function subscriptionValue(value, now) {
  const endpoint = subscriptionEndpoint(value?.endpoint);
  const {p256dh, auth} = value?.keys ?? {};
  const expirationTime = value?.expirationTime ?? null;
  if (!isEncodedKey(p256dh, 65) || !isEncodedKey(auth, 16) ||
      expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime <= now))
    fail(400, 'Invalid push subscription.');
  try { ECDH.convertKey(Buffer.from(p256dh, 'base64url'), 'prime256v1', undefined, undefined, 'uncompressed'); }
  catch { fail(400, 'Invalid push subscription.'); }
  return {endpoint, expirationTime, keys: {p256dh, auth}};
}

function vapidOptions(env) {
  const {PREDICTIR_ACCESS_VAPID_PUBLIC_KEY: publicKey, PREDICTIR_ACCESS_VAPID_PRIVATE_KEY: privateKey,
    PREDICTIR_ACCESS_VAPID_SUBJECT: subject} = env;
  if (!isEncodedKey(publicKey, 65) || !isEncodedKey(privateKey, 32) || typeof subject !== 'string' || subject.length > 254)
    return null;
  let parsed;
  try { parsed = new URL(subject); } catch { return null; }
  const validMail = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject);
  const validSite = parsed.protocol === 'https:' && parsed.hostname.includes('.') &&
    !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  if (!validMail && !validSite) return null;
  try {
    const key = createECDH('prime256v1');
    key.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (!key.getPublicKey().equals(Buffer.from(publicKey, 'base64url'))) return null;
  } catch { return null; }
  return {subject, publicKey, privateKey};
}

const activeSubscriptions = (rows, now) => Array.isArray(rows) ? rows.filter(row => row.expirationTime === null || row.expirationTime > now) : [];
const liveState = state => ['pending', 'approved', 'declined'].includes(state) ? state : 'missing';

export async function scrubExpiredAccessRequests(storage) {
  if (storage?.kind !== 'postgres') return;
  await storage.db.query(`
    UPDATE market_lab.records SET payload=payload-'name'-'email'
    WHERE pk=$1 AND expires_at<=clock_timestamp() AND payload ? 'email'`, [REQUESTS]);
}

export function createAccessRequestsBackend({edgeSecret, env = process.env, now = Date.now,
  fetcher = fetch, log = () => {}} = {}) {
  const vapid = vapidOptions(env);

  async function subscriptions(storage) {
    return activeSubscriptions((await storage.get(PUSH, 'subscriptions'))?.subscriptions, now());
  }

  async function editSubscriptions(storage, change) {
    await storage.transaction(async client => {
      await client.query(`INSERT INTO market_lab.records(pk,sk,payload)
        VALUES($1,'subscriptions','{"subscriptions":[]}'::jsonb) ON CONFLICT DO NOTHING`, [PUSH]);
      const {rows} = await client.query(`SELECT payload FROM market_lab.records
        WHERE pk=$1 AND sk='subscriptions' FOR UPDATE`, [PUSH]);
      const next = change(activeSubscriptions(rows[0]?.payload?.subscriptions, now()));
      await client.query(`UPDATE market_lab.records SET payload=$2::jsonb WHERE pk=$1 AND sk='subscriptions'
        AND payload IS DISTINCT FROM $2::jsonb`, [PUSH, JSON.stringify({subscriptions: next})]);
    });
  }

  async function sendNotice(storage, day) {
    const started = performance.now();
    const report = (event, status, result) =>
      log('access.' + event, {status, result, duration_ms: Math.round(performance.now() - started)}, {sample: false});
    if (!vapid) return report('push_skipped', 200, 'disabled');
    try {
      const targets = await subscriptions(storage);
      if (!targets.length) return report('push_skipped', 200, 'no_device');
      if (!await storage.consume('access-push#' + day, 24, 1, 2 * DAY))
        return report('push_skipped', 200, 'daily_limit');
      const results = await Promise.allSettled(targets.map(async target => {
        subscriptionEndpoint(target.endpoint);
        const outbound = generateRequestDetails(target, message, {
          vapidDetails: vapid, TTL: 600, urgency: 'high', topic: 'predictir-access',
        });
        const response = await fetcher(outbound.endpoint, {
          method: 'POST', headers: outbound.headers, body: outbound.body, redirect: 'error',
          signal: AbortSignal.timeout(4000),
        });
        await response.body?.cancel();
        return {target, status: response.status};
      }));
      const stale = results.filter(result => result.status === 'fulfilled' && [404, 410].includes(result.value.status))
        .map(result => result.value.target);
      if (results.some(result => result.status === 'fulfilled' && result.value.status >= 200 && result.value.status < 300))
        report('push_accepted', 200, 'provider_accepted');
      if (results.some(result => result.status === 'rejected' || result.value.status >= 400 && ![404, 410].includes(result.value.status)))
        report('push_failed', 503, 'provider_failed');
      if (stale.length) {
        await editSubscriptions(storage, rows => rows.filter(row =>
          !stale.some(item => item.endpoint === row.endpoint && item.keys.p256dh === row.keys.p256dh && item.keys.auth === row.keys.auth)));
        report('push_stale', 200, 'subscription_removed');
      }
    } catch { report('push_failed', 503, 'delivery_failed'); }
  }

  async function status(storage, receiptHash) {
    const {rows} = await storage.db.query(`SELECT payload->>'state' AS state FROM market_lab.records
      WHERE pk=$1 AND sk=$2 AND expires_at>clock_timestamp()`, [REQUESTS, receiptHash]);
    return liveState(rows[0]?.state);
  }

  async function createRequest(storage, input) {
    const receiptHash = hashValue(input.receiptHash), ipHash = hashValue(input.ipHash);
    const details = contact(input);
    const existing = await status(storage, receiptHash);
    if (existing !== 'missing') return {status: existing};
    const stamp = new Date(now()).toISOString(), day = stamp.slice(0, 10), hour = stamp.slice(0, 13);
    const emailHash = createHmac('sha256', edgeSecret).update('predictir-access-email\0' + details.email).digest('hex');
    for (const [key, limit, ttl, retry] of [
      ['access-request-ip#' + hour + '#' + ipHash, 6, 7200, 3600],
      ['access-request-email#' + day + '#' + emailHash, 3, 2 * DAY, DAY],
      ['access-request-day#' + day, 48, 2 * DAY, DAY],
    ]) {
      if (!await storage.consume(key, limit, 1, ttl)) fail(429, 'Too many access requests. Try again later.', retry);
    }
    const inserted = await storage.db.query(`INSERT INTO market_lab.records(pk,sk,payload,expires_at)
      VALUES($1,$2,$3::jsonb,clock_timestamp()+interval '7 days') ON CONFLICT DO NOTHING RETURNING sk`,
      [REQUESTS, receiptHash, JSON.stringify({id: randomUUID(), state: 'pending', ...details})]);
    if (inserted.rowCount) await sendNotice(storage, day);
    return {status: inserted.rowCount ? 'pending' : await status(storage, receiptHash)};
  }

  return async (storage, input) => {
    if (storage?.kind !== 'postgres') fail(503, 'Access requests are temporarily unavailable.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Invalid access request.');
    switch (input.action) {
      case 'request':
        return {code: 202, value: await createRequest(storage, input)};
      case 'status':
        return {code: 200, value: {status: await status(storage, hashValue(input.receiptHash))}};
      case 'list': {
        const {rows} = await storage.db.query(`
          SELECT payload->>'id' AS id, payload->>'name' AS name, payload->>'email' AS email, created_at AS "createdAt"
          FROM market_lab.records WHERE pk=$1 AND payload->>'state'='pending' AND expires_at>clock_timestamp()
          ORDER BY created_at DESC,sk LIMIT 336`, [REQUESTS]);
        return {code: 200, value: {requests: rows}};
      }
      case 'decide': {
        const {id, decision} = input;
        if (typeof id !== 'string' || !UUID.test(id) || !['approved', 'declined'].includes(decision))
          fail(400, 'Invalid access decision.');
        const state = await storage.transaction(async client => {
          const updated = await client.query(`
            UPDATE market_lab.records SET payload=jsonb_build_object('id',$2::text,'state',$3::text)
            WHERE pk=$1 AND payload->>'id'=$2 AND payload->>'state'='pending' AND expires_at>clock_timestamp()
            RETURNING payload->>'state' AS state`, [REQUESTS, id, decision]);
          if (updated.rowCount) return updated.rows[0].state;
          const {rows} = await client.query(`SELECT payload->>'state' AS state FROM market_lab.records
            WHERE pk=$1 AND payload->>'id'=$2 AND expires_at>clock_timestamp()`, [REQUESTS, id]);
          return liveState(rows[0]?.state);
        });
        return {code: 200, value: {status: state}};
      }
      case 'subscribe': {
        if (!vapid) fail(503, 'Phone notifications are not configured.');
        const subscription = subscriptionValue(input.subscription, now());
        await editSubscriptions(storage, rows => {
          const remaining = rows.filter(row => row.endpoint !== subscription.endpoint);
          if (remaining.length >= MAX_SUBSCRIPTIONS) fail(409, 'Remove an existing device before adding another.');
          return [...remaining, subscription];
        });
        return {code: 200, value: {status: 'subscribed'}};
      }
      case 'unsubscribe': {
        const endpoint = subscriptionEndpoint(input.endpoint);
        await editSubscriptions(storage, rows => rows.filter(row => row.endpoint !== endpoint));
        return {code: 200, value: {status: 'unsubscribed'}};
      }
      default:
        fail(400, 'Unknown access request action.');
    }
  };
}
