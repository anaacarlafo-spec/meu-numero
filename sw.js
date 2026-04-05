// Service Worker — Meu Número
// Escuta push e mostra notificação de chamada recebida

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Recebe push do servidor (Supabase Edge Function ou Web Push API)
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
      vibrate: [300, 100, 300, 100, 300],
      data:    { url: '/criadora.html' }
    })
  );
});

// Clique na notificação abre/foca o painel da criadora
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

// Mensagem recebida do app (quando Supabase detecta chamada no frontend)
// O app envia { type: 'INCOMING_CALL' } via postMessage ao SW
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'INCOMING_CALL') {
    self.registration.showNotification('📞 Chamada recebida', {
      body:    'Um cliente está ligando para você!',
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     'incoming-call',
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 300],
      data:    { url: '/criadora.html' }
    });
  }
});
