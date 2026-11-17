import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const worker = await readFile(new URL('../public/access/push.js', import.meta.url), 'utf8');
const origin = 'https://predictir.example';
const requestId = '3457289c-071e-4a40-95e4-ab18db1a410d';

function harness({maxActions, clients = [], response = new Response(null, {status: 401})} = {}) {
  const listeners = new Map(), notices = [], opened = [], requests = [];
  runInNewContext(worker, {
    URL, AbortSignal,
    self: {
      location: {origin}, Notification: {maxActions},
      registration: {showNotification(title, options) { notices.push({title, options}); }},
      addEventListener(name, handler) { listeners.set(name, handler); },
      clients: {matchAll: async () => clients, openWindow: async url => opened.push(url)},
    },
    fetch: async (url, options) => { requests.push({url: url.href, ...options}); return response; },
  });
  return {
    notices, opened, requests,
    async fire(name, properties) {
      let completed;
      listeners.get(name)({...properties, waitUntil: result => {completed = result;}});
      await completed;
    },
  };
}

test('push actions respect browser capability and keep prior notifications usable', async () => {
  const mobile = harness(), desktop = harness({maxActions: 2});
  const data = {json: () => ({web_push: 8030, notification: {data: {requestId}}})};
  await mobile.fire('push', {data});
  assert.equal(mobile.notices[0].options.actions, undefined);
  assert.equal(mobile.notices[0].options.data.requestId, requestId);
  await desktop.fire('push', {data});
  assert.equal(JSON.stringify(desktop.notices[0].options.actions),
    JSON.stringify([{action: 'approved', title: 'Approve'}, {action: 'declined', title: 'Decline'}]));
  await desktop.fire('push', {data: {json: () => {throw new SyntaxError();}}});
  assert.equal(desktop.notices[1].options.data.requestId, null);
  assert.equal(desktop.notices[1].options.actions, undefined);
});

test('a banner click only opens or focuses the exact request in the signed-in app', async () => {
  const fresh = harness();
  await fresh.fire('notificationclick', {notification: {close() {}, data: {requestId}}});
  assert.deepEqual(fresh.opened, [origin + '/access/manage?request=' + requestId]);
  assert.deepEqual(fresh.requests, []);
  let focused = false, message;
  const existing = harness({clients: [{url: origin + '/access/manage?request=other',
    async focus() { focused = true; }, postMessage(value) { message = value; }}]});
  await existing.fire('notificationclick', {notification: {close() {}, data: {requestId}}});
  assert.equal(message.type, 'predictir-access-request');
  assert.equal(message.requestId, requestId);
  assert.equal(focused, true);
  assert.deepEqual(existing.opened, []);
});

test('a supported notification action uses the owner session and opens review if it cannot save', async () => {
  const notification = {close() {}, data: {requestId}};
  const blocked = harness();
  await blocked.fire('notificationclick', {action: 'approved', notification});
  const [request] = blocked.requests;
  assert.equal(request.url, origin + '/api/access/manage');
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'same-origin');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body), {action: 'decide', id: requestId, decision: 'approved'});
  assert.deepEqual(blocked.opened, [origin + '/access/manage?request=' + requestId]);

  const saved = harness({response: Response.json({status: 'declined'})});
  await saved.fire('notificationclick', {action: 'declined', notification});
  assert.deepEqual(saved.opened, []);
  assert.equal(saved.requests.length, 1);
  await saved.fire('notificationclick', {action: 'approved',
    notification: {close() {}, data: {requestId: 'https://elsewhere.example/'}}});
  assert.equal(saved.requests.length, 1);
  assert.deepEqual(saved.opened, [origin + '/access/manage']);
});
