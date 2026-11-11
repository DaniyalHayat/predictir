import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import test from 'node:test';
import {generateVAPIDKeys} from 'web-push';
import {createMarketServer} from '../cloud/server.mjs';
import {createAccessRequestsBackend, scrubExpiredAccessRequests} from '../lib/workspace/access-requests-backend.mjs';
import {makePostgresStore} from '../lib/postgres-store.mjs';
import {applyTestSchema} from './database-fixture.mjs';

const secret = 'access-request-fixture-'.repeat(3);
const testDatabase = process.env.MARKET_TEST_DATABASE_URL;
const path = '/api/internal/access-requests';
const hash = () => randomBytes(32).toString('hex');

test('access requests are available only to the configured edge, with a bounded JSON body', async t => {
  const enabled = createMarketServer({production: true, shareAccess: true, accessRequestsEnabled: true,
    edgeSecret: secret, serviceSecret: 'assistant-fixture-'.repeat(3), storageEnabled: () => false});
  const disabled = createMarketServer({production: true, shareAccess: true, accessRequestsEnabled: false,
    edgeSecret: secret, storageEnabled: () => false});
  for (const server of [enabled, disabled]) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
  }
  const response = (server, {method = 'POST', headers = {}, body = '{}', route = path} = {}) =>
    fetch('http://127.0.0.1:' + server.address().port + route, {
      method, headers: {'Content-Type': 'application/json', ...headers},
      ...(method === 'POST' ? {body} : {}),
    });
  assert.equal((await response(enabled)).status, 401);
  assert.equal((await response(enabled, {headers: {Authorization: 'Bearer ' + 'assistant-fixture-'.repeat(3)}})).status, 401);
  const headers = {'x-market-edge-secret': secret};
  assert.equal((await response(disabled, {headers})).status, 404);
  assert.equal((await response(enabled, {headers, route: path + '?id=anything'})).status, 404);
  assert.equal((await response(enabled, {headers, method: 'GET'})).status, 405);
  assert.equal((await response(enabled, {headers: {...headers, 'Content-Type': 'text/plain'}})).status, 415);
  assert.equal((await response(enabled, {headers, body: ' '.repeat(4097)})).status, 413);
  assert.equal((await response(enabled, {headers})).status, 503);
});

test('access request validation rejects untrusted push destinations and caps submission work', async () => {
  const vapid = generateVAPIDKeys();
  const run = createAccessRequestsBackend({edgeSecret: secret, env: {
    PREDICTIR_ACCESS_VAPID_PUBLIC_KEY: vapid.publicKey,
    PREDICTIR_ACCESS_VAPID_PRIVATE_KEY: vapid.privateKey,
    PREDICTIR_ACCESS_VAPID_SUBJECT: 'mailto:predictir@example.invalid',
  }});
  const quotas = [];
  const storage = {kind: 'postgres', db: {query: async () => ({rows: []})}, consume: async key => {quotas.push(key);return false;}};
  for (const endpoint of [
    'https://fcm.googleapis.com.example.invalid/fcm/send/1',
    'https://127.0.0.1/fcm/send/1',
    'https://fcm.googleapis.com@127.0.0.1/fcm/send/1',
    'http://web.push.apple.com/device',
    'https://web.push.apple.com:9999/device',
  ]) await assert.rejects(() => run(storage, {action: 'subscribe', subscription: {endpoint}}), {status: 400});
  const base = {action: 'request', receiptHash: hash(), ipHash: hash(), name: 'Visitor', email: 'visitor@example.invalid'};
  await assert.rejects(() => run(storage, {...base, name: 'invalid\u0000name'}), {status: 400});
  await assert.rejects(() => run(storage, {...base, email: 'visitor@example.invalid\n'}), {status: 400});
  assert.deepEqual(quotas, []);
  await assert.rejects(() => run(storage, base), {status: 429, retryAfter: 3600});
  assert.match(quotas[0], /^access-request-ip#.{13}#[a-f0-9]{64}$/);
});

test('Postgres persists the queue, atomically decides once, and keeps delivery failure separate', {skip: !testDatabase}, async () => {
  if (!new URL(testDatabase).pathname.endsWith('_test')) throw new Error('Use a dedicated _test database');
  const store = makePostgresStore({connectionString: testDatabase});
  const vapid = generateVAPIDKeys(), device = generateVAPIDKeys(), pushes = [], events = [];
  const receiptHash = hash(), ipHash = hash(), expiredReceipt = hash(), email = hash().slice(0, 32) + '@example.invalid';
  const subscription = {endpoint: 'https://fcm.googleapis.com/fcm/send/' + hash(),
    keys: {p256dh: device.publicKey, auth: randomBytes(16).toString('base64url')}};
  const run = createAccessRequestsBackend({edgeSecret: secret,
    env: {PREDICTIR_ACCESS_VAPID_PUBLIC_KEY: vapid.publicKey, PREDICTIR_ACCESS_VAPID_PRIVATE_KEY: vapid.privateKey,
      PREDICTIR_ACCESS_VAPID_SUBJECT: 'mailto:predictir@example.invalid'},
    fetcher: async (url, options) => {pushes.push({url, options});throw new Error('Simulated provider outage');},
    log: (...args) => events.push(args),
  });
  const call = input => run(store, input);
  try {
    await applyTestSchema(store.db);
    assert.equal((await call({action: 'subscribe', subscription})).value.status, 'subscribed');
    const input = {action: 'request', receiptHash, ipHash, name: 'Test Visitor', email};
    const created = await call(input);
    assert.deepEqual(created, {code: 202, value: {status: 'pending'}});
    assert.deepEqual(await call({...input, name: 'Duplicate'}), created);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].url, subscription.endpoint);
    assert.equal(pushes[0].options.redirect, 'error');
    assert.doesNotMatch(Buffer.from(pushes[0].options.body).toString('utf8'), /Test Visitor|example\.invalid/);
    assert.deepEqual(events, [['access.push_failed', {status: 503}]]);
    assert.deepEqual((await call({action: 'status', receiptHash})).value, {status: 'pending'});
    const row = (await call({action: 'list'})).value.requests.find(item => item.email === email);
    assert.equal(row.name, input.name);
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'email', 'id', 'name']);
    const competing = await Promise.all(['approved', 'declined'].map(decision => call({action: 'decide', id: row.id, decision})));
    const status = competing[0].value.status;
    assert.ok(['approved', 'declined'].includes(status));
    assert.equal(competing[1].value.status, status);
    assert.deepEqual((await call({action: 'status', receiptHash})).value, {status});
    assert.equal((await call({action: 'list'})).value.requests.some(item => item.id === row.id), false);
    const decided = await store.get('predictir-access-requests-v1', receiptHash);
    assert.deepEqual(decided, {id: row.id, state: status});
    await store.db.query(`INSERT INTO market_lab.records(pk,sk,payload,expires_at)
      VALUES('predictir-access-requests-v1',$1,'{"state":"pending","name":"Expired","email":"expired@example.invalid"}',now()-interval '1 hour')`, [expiredReceipt]);
    await scrubExpiredAccessRequests(store);
    assert.equal((await call({action: 'status', receiptHash: expiredReceipt})).value.status, 'missing');
    const {rows} = await store.db.query("SELECT payload FROM market_lab.records WHERE pk='predictir-access-requests-v1' AND sk=$1", [expiredReceipt]);
    assert.deepEqual(rows[0].payload, {state: 'pending'});
  } finally {
    await call({action: 'unsubscribe', endpoint: subscription.endpoint}).catch(() => {});
    await store.close();
  }
});
