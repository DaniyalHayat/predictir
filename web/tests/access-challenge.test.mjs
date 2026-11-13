import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {handleAccessRequest} from '../lib/access-requests.mjs';
import {contentSecurityPolicy} from '../lib/security-policy.mjs';
import {accessChallengeConfig} from '../lib/workspace/access-challenge.mjs';

const origin = 'https://predictir.dev';
const env = {
  PREDICTIR_SHARE_ACCESS: '1',
  PREDICTIR_ACCESS_REQUESTS: '1',
  PREDICTIR_SHARE_TOKEN_HASH: createHash('sha256').update('fixture-share').digest('hex'),
  PREDICTIR_ACCESS_OWNER_HASH: createHash('sha256').update('fixture-owner').digest('hex'),
  MARKET_EDGE_SECRET: 'fixture-edge-key-'.repeat(4),
  MARKET_BACKEND_URL: 'https://backend.example.test',
  PREDICTIR_ACCESS_TURNSTILE_SITE_KEY: 'fixture_site_key',
  PREDICTIR_ACCESS_TURNSTILE_SECRET: 'fixture_server_secret',
};

test('request challenge validates its action and hostname before creating a row', async () => {
  let checks = 0;
  let writes = 0;
  const submit = (token, verification, options = env) => handleAccessRequest(new Request(origin + '/api/access/request', {
    method: 'POST', headers: {origin, 'content-type': 'application/json'},
    body: JSON.stringify({name: 'Preview visitor', email: 'visitor@example.test', challengeToken: token}),
  }), 'request', {
    env: options,
    challengeFetcher: async (url, request) => {
      checks++;
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(request.body.get('response'), token);
      assert.equal(request.redirect, 'error');
      if (!verification) throw new Error('provider unavailable');
      return Response.json(verification);
    },
    fetcher: async (url, request) => {
      writes++;
      assert.equal(url.hostname, 'backend.example.test');
      assert.equal(JSON.parse(request.body).challengeToken, undefined);
      return Response.json({status: 'pending'}, {status: 202});
    },
  });
  assert.equal((await submit()).status, 403);
  assert.equal((await submit('a', {success: false})).status, 403);
  assert.equal((await submit('b', {success: true, action: 'preview_request', hostname: 'other.example.test'})).status, 403);
  assert.equal((await submit('c', {success: true, action: 'other', hostname: 'predictir.dev'})).status, 403);
  assert.equal((await submit('d', null)).status, 503);
  assert.equal((await submit('e', null, {...env, PREDICTIR_ACCESS_TURNSTILE_SECRET: ''})).status, 503);
  assert.equal(writes, 0);
  assert.equal((await submit('f', {success: true, action: 'preview_request', hostname: 'predictir.dev'})).status, 202);
  assert.equal(checks, 5);
  assert.equal(writes, 1);
  assert.equal(accessChallengeConfig({...env, NODE_ENV: 'production', PREDICTIR_ACCESS_TURNSTILE_SITE_KEY: '1x00000000000000000000AA'}).siteKey, null);
});

test('challenge only adds its dedicated script, connection and iframe origin when requested', () => {
  const origin = 'https://challenges.cloudflare.com';
  const standard = contentSecurityPolicy({nonce: 'fixture'});
  const enabled = contentSecurityPolicy({nonce: 'fixture', accessChallenge: true});
  assert.ok(!standard.includes(origin));
  for (const directive of ['script-src ', 'connect-src ', 'frame-src ']) {
    assert.ok(enabled.split('; ').find(item => item.startsWith(directive))?.includes(origin));
  }
  assert.match(enabled, /frame-ancestors 'none'/);
});
