// Web Push to the shop's phones/tablets (new order, slip attached) — no payload, so no message encryption is needed:
// the push only wakes the service worker, which then fetches the text from /push/peek/{id} (id = SHA-256 of the
// subscription endpoint, which only that device knows).
import { b64url } from './auth.js';

const enc = new TextEncoder();
export async function subId(endpoint) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(String(endpoint)))).slice(0, 32);
}

// VAPID (RFC 8292): an ES256 JWT for the push service's origin, signed with the app server key
let keyCache = null;
async function vapidKey(jwkJson) {
  if (!keyCache || keyCache.src !== jwkJson) {
    const jwk = JSON.parse(jwkJson);
    keyCache = { src: jwkJson, jwk, key: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  }
  return keyCache;
}
export function publicKeyFromJwk(jwk) { // uncompressed point 0x04 || X || Y, base64url
  const b = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  return b64url(new Uint8Array([4, ...b(jwk.x), ...b(jwk.y)]));
}
export async function vapidAuth(endpoint, jwkJson, subject, now = Date.now()) {
  const { jwk, key } = await vapidKey(jwkJson);
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const sig = b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${sig}, k=${publicKeyFromJwk(jwk)}`;
}

// → 'ok' | 'gone' (subscription expired: delete it) | 'error'
export async function sendPush(endpoint, env, fetchFn = fetch) {
  try {
    const res = await fetchFn(endpoint, { method: 'POST', headers: {
      Authorization: await vapidAuth(endpoint, env.VAPID_PRIVATE_JWK, env.VAPID_SUBJECT || 'https://tunsupakorn.github.io/jukjik-kaa/'),
      TTL: '3600', Urgency: 'high', 'Content-Length': '0' } });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'error';
  } catch { return 'error'; }
}
