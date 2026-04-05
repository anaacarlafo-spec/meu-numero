// Service Worker — Meu Número
// Web Push real para iPhone (iOS 16.4+)

const CACHE = 'meu-numero-v2';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

// ── Push recebido do servidor (via VAPID) ──────────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || '📞 Chamada recebida';
  const body  = data.body  || 'Um cliente está ligando para você!';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     'incoming-call',
      renotify: true,
      requireInteraction: true,
      silent:  false,
      vibrate: [400, 100, 400, 100, 400, 100, 400],
      data:    { url: '/criadora.html' }
    })
  );
});

// ── Clique na notificação: abre/foca o painel ──────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('criadora') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/criadora.html');
    })
  );
});

// ── Mensagem do app (fecha notificação quando chamada cancelar) ──────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'CLOSE_NOTIFICATION') {
    self.registration.getNotifications({ tag: 'incoming-call' })
      .then(notifs => notifs.forEach(n => n.close()));
  }
  // Fallback legado: app em foreground pediu notificação
  if (e.data && e.data.type === 'INCOMING_CALL') {
    self.registration.showNotification('📞 Chamada recebida', {
      body: 'Um cliente está ligando para você!',
      icon: '/icon-192.png',
      tag:  'incoming-call',
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [400, 100, 400, 100, 400]
    });
  }
});
