const ownerPath = '/access/manage';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const requestIdFrom = value => typeof value === 'string' && uuid.test(value) ? value : null;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let notice;
  try { notice = event.data?.json()?.notification; } catch {}
  const requestId = requestIdFrom(notice?.data?.requestId);
  const options = {
    body: 'Tap to review. Approve or decline with a tap.',
    tag: requestId ? 'predictir-access-' + requestId : 'predictir-access-request',
    icon: '/access/icon-192.png',
    data: {requestId},
  };
  if (requestId && (self.Notification?.maxActions ?? 0) >= 2) {
    options.actions = [{action: 'approved', title: 'Approve'}, {action: 'declined', title: 'Decline'}];
  }
  event.waitUntil(self.registration.showNotification('New Predictir access request', options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const requestId = requestIdFrom(event.notification.data?.requestId);
  const url = new URL(ownerPath, self.location.origin);
  if (requestId) url.searchParams.set('request', requestId);
  event.waitUntil((async () => {
    let saved = false;
    if (requestId && ['approved', 'declined'].includes(event.action)) {
      try {
        const response = await fetch(new URL('/api/access/manage', self.location.origin), {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          credentials: 'same-origin',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({action: 'decide', id: requestId, decision: event.action}),
        });
        saved = response.ok && (await response.json()).status === event.action;
      } catch {}
    }

    const clients = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    const open = clients.find(client => {
      const active = new URL(client.url);
      return active.origin === url.origin && active.pathname === ownerPath;
    });
    if (open) {
      open.postMessage({type: 'predictir-access-request', requestId: saved ? null : requestId});
      if (!saved) await open.focus();
    } else if (!saved) {
      await self.clients.openWindow(url.href);
    }
  })());
});
