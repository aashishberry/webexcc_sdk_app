self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action || 'open';
  const callKey = event.notification.data?.callKey || '';
  event.waitUntil(
    self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(async (clients) => {
      const client = clients[0];
      if (!client) return self.clients.openWindow('/');
      client.postMessage({type: 'webex-call-notification-action', action, callKey});
      if (action === 'open') return client.focus();
      return undefined;
    }),
  );
});
