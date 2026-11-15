// LINE Messaging API helpers (WebCrypto, fetch).
import { b64url } from './auth.js';

export async function validSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody);
  const expected = b64url(mac);
  const got = String(signature).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Stateless channel access token (15 min) from the channel ID + secret: no long-lived token to store.
let token = { value: '', until: 0 };
export async function accessToken(env, fetchFn = fetch) {
  if (token.value && Date.now() < token.until) return token.value;
  const res = await fetchFn('https://api.line.me/oauth2/v3/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET }) });
  if (!res.ok) throw new Error(`LINE token ${res.status}: ${await res.text()}`);
  const d = await res.json();
  token = { value: d.access_token, until: Date.now() + ((Number(d.expires_in) || 900) - 60) * 1000 };
  return token.value;
}

export async function lineApi(env, path, body, fetchFn = fetch) {
  const res = await fetchFn(`https://api.line.me/v2/bot/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken(env, fetchFn)}` }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`LINE ${path} ${res.status}: ${await res.text()}`);
}

// LIFF: liff.getIDToken() → who the customer is
export async function verifyLiffToken(env, idToken, fetchFn = fetch) {
  const res = await fetchFn('https://api.line.me/oauth2/v2.1/verify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: env.LINE_LOGIN_CHANNEL_ID }) });
  if (!res.ok) return null;
  const p = await res.json();
  return p.sub ? { id: p.sub, name: String(p.name || 'ลูกค้า LINE').slice(0, 60) } : null;
}
