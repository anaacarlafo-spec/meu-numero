// Edge Function: send-push
// Chamada via Database Webhook quando um row é inserido em `sinalizacao`
// Envia Web Push para o dispositivo da criadora

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')!;   // mailto:voce@email.com
const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── VAPID JWT helper ──────────────────────────────────────────────
async function importPrivateKey(b64url: string): Promise<CryptoKey> {
  const raw = base64urlToUint8Array(b64url);
  return crypto.subtle.importKey(
    'raw', raw,
    { name: 'ECDH', namedCurve: 'P-256' },
    true, []
  ).catch(async () => {
    // Tenta como PKCS8 se raw falhar
    const pkcs8 = buildPKCS8(raw);
    return crypto.subtle.importKey(
      'pkcs8', pkcs8,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, ['sign']
    );
  });
}

function base64urlToUint8Array(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function uint8ArrayToBase64url(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function buildPKCS8(rawPrivate: Uint8Array): ArrayBuffer {
  // PKCS#8 wrapper para chave EC P-256
  const prefix = new Uint8Array([0x30,0x41,0x02,0x01,0x00,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20]);
  const result = new Uint8Array(prefix.length + rawPrivate.length);
  result.set(prefix); result.set(rawPrivate, prefix.length);
  return result.buffer;
}

async function makeVapidJwt(audience: string): Promise<string> {
  const header  = { alg: 'ES256', typ: 'JWT' };
  const payload = { aud: audience, exp: Math.floor(Date.now()/1000) + 43200, sub: VAPID_SUBJECT };
  const enc = (obj: unknown) => uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(obj)));
  const sigInput = `${enc(header)}.${enc(payload)}`;

  const pkcs8 = buildPKCS8(base64urlToUint8Array(VAPID_PRIVATE));
  const key = await crypto.subtle.importKey(
    'pkcs8', pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(sigInput)
  );
  return `${sigInput}.${uint8ArrayToBase64url(new Uint8Array(sig))}`;
}

// ── Enviar Web Push ───────────────────────────────────────────────
async function sendWebPush(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await makeVapidJwt(audience);

  const authRaw   = base64urlToUint8Array(subscription.keys.auth);
  const p256dhRaw = base64urlToUint8Array(subscription.keys.p256dh);

  // Gera chave efêmera
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  // Importa chave pública do cliente
  const clientPublic = await crypto.subtle.importKey('raw', p256dhRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // Deriva segredo compartilhado
  const sharedBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublic }, ephemeral.privateKey, 256));

  // HKDF para chave de conteúdo (RFC 8291)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(sharedBits, authRaw, 'Content-Encoding: auth\0', 32);
  const key = await hkdf(ikm, salt, buildInfo('aesgcm', p256dhRaw, ephPublicRaw), 16);
  const nonce = await hkdf(ikm, salt, buildInfo('nonce', p256dhRaw, ephPublicRaw), 12);

  const aesKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const paddedPayload = new Uint8Array([0, 0, ...new TextEncoder().encode(payload)]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, paddedPayload));

  // Monta body
  const body = new Uint8Array(salt.length + 4 + 1 + ephPublicRaw.length + encrypted.length);
  let offset = 0;
  body.set(salt, offset); offset += salt.length;
  body.set([0, 0, 16, 0], offset); offset += 4;
  body.set([ephPublicRaw.length], offset++); 
  body.set(ephPublicRaw, offset); offset += ephPublicRaw.length;
  body.set(encrypted, offset);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC}`,
      'Content-Type':  'application/octet-stream',
      'Content-Encoding': 'aesgcm',
      'Encryption': `salt=${uint8ArrayToBase64url(salt)}`,
      'Crypto-Key': `dh=${uint8ArrayToBase64url(ephPublicRaw)};p256ecdsa=${VAPID_PUBLIC}`,
      'TTL': '60'
    },
    body
  });

  return res.status;
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string | Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const infoBytes = typeof info === 'string' ? new TextEncoder().encode(info) : info;
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: infoBytes }, key, length * 8);
  return new Uint8Array(bits);
}

function buildInfo(type: string, clientKey: Uint8Array, serverKey: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const prefix = enc.encode(`Content-Encoding: ${type}\0P-256\0`);
  const result = new Uint8Array(prefix.length + 2 + clientKey.length + 2 + serverKey.length);
  let offset = 0;
  result.set(prefix, offset); offset += prefix.length;
  new DataView(result.buffer).setUint16(offset, clientKey.length, false); offset += 2;
  result.set(clientKey, offset); offset += clientKey.length;
  new DataView(result.buffer).setUint16(offset, serverKey.length, false); offset += 2;
  result.set(serverKey, offset);
  return result;
}

// ── Handler principal ─────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const body = await req.json();
    const record = body.record ?? body;

    // Só dispara para novas chamadas
    if (record.status !== 'calling') return new Response('ok', { status: 200 });

    // Busca subscription salva da criadora
    const { data: pushRows } = await sb.from('perfil_push').select('subscription').eq('perfil_id', 1);
    if (!pushRows || pushRows.length === 0) return new Response('no subscription', { status: 200 });

    const payload = JSON.stringify({
      title: '📞 Chamada recebida',
      body:  'Um cliente está ligando para você!'
    });

    // Envia para todos os dispositivos cadastrados da criadora
    await Promise.all(
      pushRows.map(row => sendWebPush(row.subscription, payload).catch(e => console.error('push error:', e)))
    );

    return new Response('pushed', { status: 200 });
  } catch (err) {
    console.error('send-push error:', err);
    return new Response('error', { status: 500 });
  }
});
