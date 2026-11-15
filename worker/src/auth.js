// Google service-account access token (for Firestore REST) and Firebase ID token verification (shop owner), with WebCrypto.

const enc = new TextEncoder();
export const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = o => b64url(enc.encode(JSON.stringify(o)));
export const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export async function signJwt(claims, privateKeyPem) {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKeyPem), RS256, false, ['sign']);
  const data = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson(claims)}`;
  return `${data}.${b64url(await crypto.subtle.sign(RS256.name, key, enc.encode(data)))}`;
}

// cached per isolate; refreshed a minute before it expires
let cached = { token: '', until: 0 };
export async function googleToken(sa, fetchFn = fetch, now = Date.now()) {
  if (cached.token && now < cached.until) return cached.token;
  const iat = Math.floor(now / 1000);
  const assertion = await signJwt({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }, sa.private_key);
  const res = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${await res.text()}`);
  const d = await res.json();
  cached = { token: d.access_token, until: now + ((Number(d.expires_in) || 3600) - 60) * 1000 };
  return cached.token;
}
export function resetGoogleToken() { cached = { token: '', until: 0 }; }

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks = { keys: [], until: 0 };
async function firebaseKeys(fetchFn) {
  if (jwks.keys.length && Date.now() < jwks.until) return jwks.keys;
  const res = await fetchFn(JWKS_URL);
  if (!res.ok) throw new Error(`Firebase keys ${res.status}`);
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]) || 3600;
  jwks = { keys: (await res.json()).keys || [], until: Date.now() + maxAge * 1000 };
  return jwks.keys;
}

// Returns the token's claims, or throws. Checks signature, audience, issuer and times (Firebase's documented rules).
export async function verifyFirebaseToken(token, projectId, fetchFn = fetch, nowSec = Math.floor(Date.now() / 1000)) {
  const [h, p, s] = String(token || '').split('.');
  if (!h || !p || !s) throw new Error('bad token');
  const header = JSON.parse(new TextDecoder().decode(fromB64url(h)));
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(p)));
  if (header.alg !== 'RS256') throw new Error('bad alg');
  const jwk = (await firebaseKeys(fetchFn)).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, RS256, false, ['verify']);
  if (!await crypto.subtle.verify(RS256.name, key, fromB64url(s), enc.encode(`${h}.${p}`))) throw new Error('bad signature');
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('wrong project');
  if (!(claims.exp > nowSec) || !(claims.iat <= nowSec + 300) || !(claims.auth_time <= nowSec + 300) || !claims.sub) throw new Error('expired');
  return claims;
}
export function resetFirebaseKeys() { jwks = { keys: [], until: 0 }; }
