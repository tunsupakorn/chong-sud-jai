// End-to-end test of the Worker against an in-memory Firestore + fake LINE / Google endpoints.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.js';
import { encode, fromFields } from '../src/firestore.js';
import { b64url, resetGoogleToken, resetFirebaseKeys } from '../src/auth.js';
import { validSignature } from '../src/line.js';

const enc = new TextEncoder();
const RS = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const toPem = der => `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----\n`;
const saKeys = await crypto.subtle.generateKey(RS, true, ['sign', 'verify']);
const fbKeys = await crypto.subtle.generateKey(RS, true, ['sign', 'verify']);
const fbJwk = { ...(await crypto.subtle.exportKey('jwk', fbKeys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const SA = { client_email: 'sa@test.iam.gserviceaccount.com', project_id: 'proj', private_key: toPem(await crypto.subtle.exportKey('pkcs8', saKeys.privateKey)) };

async function firebaseToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const full = { aud: 'proj', iss: 'https://securetoken.google.com/proj', iat: now, exp: now + 3600, auth_time: now, sub: 'u1', email_verified: true, ...claims };
  const data = `${b64url(enc.encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })))}.${b64url(enc.encode(JSON.stringify(full)))}`;
  return `${data}.${b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', fbKeys.privateKey, enc.encode(data)))}`;
}

// ---------- fake services ----------
let docs, pushes, replies, clock, pushed = [];
const ROOT = 'projects/proj/databases/(default)/documents/';
const reply = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
const fsErr = (status, code) => reply({ error: { status, code } }, code);
const toDoc = (path, d) => ({ name: ROOT + path, fields: Object.fromEntries(Object.entries(d.data).map(([k, v]) => [k, encode(v)])), updateTime: d.updateTime });

async function fakeFetch(url, opts = {}) {
  url = String(url);
  const body = opts.body;
  if (url === 'https://oauth2.googleapis.com/token') {
    const assertion = new URLSearchParams(body).get('assertion');
    const [h, p, s] = assertion.split('.');
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', saKeys.publicKey, Buffer.from(s, 'base64url'), enc.encode(`${h}.${p}`));
    return ok ? reply({ access_token: 'gtok', expires_in: 3600 }) : reply({}, 400);
  }
  if (url.includes('securetoken@system')) return reply({ keys: [fbJwk] });
  if (url === 'https://api.line.me/oauth2/v3/token') return reply({ access_token: 'ltok', expires_in: 900 });
  if (url === 'https://api.line.me/oauth2/v2.1/verify') {
    const t = new URLSearchParams(body).get('id_token');
    return t?.startsWith('cust-') ? reply({ sub: 'U' + t.slice(5), name: 'ลูกค้า ' + t.slice(5) }) : reply({ error: 'invalid' }, 400);
  }
  if (url === 'https://api.line.me/v2/bot/message/quota') return reply({ type: 'limited', value: 300 });
  if (url === 'https://api.line.me/v2/bot/message/quota/consumption') return reply({ totalUsage: 16 });
  if (url.startsWith('https://api.line.me/v2/bot/message/')) {
    assert.equal(opts.headers.Authorization, 'Bearer ltok');
    (url.endsWith('push') ? pushes : replies).push(JSON.parse(body));
    return reply({});
  }
  if (url.startsWith('https://push.test/')) {
    pushed.push({ url, auth: opts.headers.Authorization });
    return new Response('', { status: url.includes('gone') ? 410 : 201 });
  }
  if (url.startsWith('https://firestore.googleapis.com/v1/')) {
    assert.equal(opts.headers.Authorization, 'Bearer gtok');
    const path = url.slice(('https://firestore.googleapis.com/v1/' + ROOT).length);
    if (url.endsWith(':commit')) return commit(JSON.parse(body).writes);
    if (url.endsWith(':runQuery')) {
      const parent = path.slice(0, -':runQuery'.length);
      const q = JSON.parse(body).structuredQuery;
      const filters = q.where.compositeFilter ? q.where.compositeFilter.filters : [q.where];
      const prefix = `${parent}/${q.from[0].collectionId}/`;
      const rows = Object.entries(docs).filter(([p, d]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')
        && filters.every(f => JSON.stringify(encode(d.data[f.fieldFilter.field.fieldPath])) === JSON.stringify(f.fieldFilter.value)));
      return reply(rows.length ? rows.map(([p, d]) => ({ document: toDoc(p, d) })) : [{ readTime: 'x' }]);
    }
    const d = docs[path];
    return d ? reply(toDoc(path, d)) : fsErr('NOT_FOUND', 404);
  }
  throw new Error('unexpected fetch ' + url);
}

function commit(writes) {
  const next = structuredClone(docs), results = [];
  for (const w of writes) {
    const name = (w.update?.name || w.transform?.document).slice(ROOT.length);
    const cur = next[name];
    const pre = w.currentDocument;
    if (pre?.exists === false && cur) return fsErr('ALREADY_EXISTS', 409);
    if (pre?.exists === true && !cur) return fsErr('NOT_FOUND', 404);
    if (pre?.updateTime && cur?.updateTime !== pre.updateTime) return fsErr('FAILED_PRECONDITION', 400);
    const t = String(++clock);
    let data = cur ? { ...cur.data } : {};
    if (w.update) {
      const fields = fromFields(w.update.fields);
      if (w.updateMask) for (const k of w.updateMask.fieldPaths) data[k] = fields[k]; else data = fields;
    }
    const transformResults = [];
    for (const tr of w.updateTransforms || w.transform?.fieldTransforms || []) {
      data[tr.fieldPath] = (Number(data[tr.fieldPath]) || 0) + Number(tr.increment.integerValue ?? tr.increment.doubleValue);
      transformResults.push(encode(data[tr.fieldPath]));
    }
    next[name] = { data, updateTime: t };
    results.push({ updateTime: t, transformResults });
  }
  docs = next;
  return reply({ writeResults: results });
}

// ---------- fixtures ----------
const SHOP = 'users/shop1';
const menu = [
  { id: 'm_thaitea', name: 'ชาไทย', emoji: '🧋', prices: { blend: 35, iced: 30, hot: 25 }, price: 35, cost: 12, group: 'drink' },
  { id: 't_pearl', name: 'ไข่มุก', price: 10, cost: 3, group: 'topping' }];
const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA), FIREBASE_PROJECT_ID: 'proj', SHOP_UID: 'shop1', OWNER_EMAIL: 'Owner@Shop.com',
  LINE_CHANNEL_ID: '1', LINE_CHANNEL_SECRET: 'sec', LINE_LOGIN_CHANNEL_ID: '2', LIFF_ID: 'liff-1', OWNER_LINE_IDS: 'UBoss, UOther', ALLOWED_ORIGINS: 'https://tunsupakorn.github.io' };
let app;
const call = async (method, path, { token, body, headers = {} } = {}) => {
  const res = await app(new Request('https://w.test' + path, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }));
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
};

beforeEach(() => {
  clock = 0; pushes = []; replies = []; pushed = [];
  // always open: hours cover the whole day so the test does not depend on the clock
  docs = { [SHOP]: { data: { settings: { menu, promptpay: '0812345678', line: { open: true, from: '00:00', to: '23:59', prep: 0 } } }, updateTime: '0' } };
  resetGoogleToken(); resetFirebaseKeys();
  app = createApp(env, fakeFetch);
});

test('menu is public, hides cost, sends CORS for the shop site', async () => {
  const r = await call('GET', '/menu', { headers: { Origin: 'https://tunsupakorn.github.io' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.menu.length, 2);
  assert.ok(!JSON.stringify(r.data).includes('cost'));
  assert.equal(r.data.shop.promptpay, true);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://tunsupakorn.github.io');
  const other = await call('GET', '/menu', { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('customer orders need a valid LINE token', async () => {
  assert.equal((await call('POST', '/orders', { body: {} })).status, 401);
  assert.equal((await call('POST', '/orders', { token: 'forged', body: {} })).status, 401);
});

test('full flow: order → accept → ready (push) → cash → sale + stamps', async () => {
  const placed = await call('POST', '/orders', { token: 'cust-A', body: { items: [{ id: 'm_thaitea', style: 'iced', qty: 2, price: 1 }, { id: 't_pearl', qty: 1 }], pickup: { mode: 'asap' }, payMethod: 'cash' } });
  assert.equal(placed.status, 201);
  assert.equal(placed.data.no, 'L001');
  assert.equal(placed.data.total, 70);
  assert.equal(placed.data.items[0].cost, undefined);
  const id = placed.data.id;
  const stored = docs[`${SHOP}/orders/${id}`].data;
  assert.equal(stored.lineUserId, 'UA');
  assert.equal(stored.items[0].cost, 12);

  const second = await call('POST', '/orders', { token: 'cust-B', body: { items: [{ id: 'm_thaitea', style: 'hot', qty: 1 }], payMethod: 'cash' } });
  assert.equal(second.data.no, 'L002');

  const owner = await firebaseToken({ email: 'owner@shop.com' });
  assert.equal((await call('POST', `/shop/orders/${id}`, { token: await firebaseToken({ email: 'other@x.com' }), body: { action: 'accept' } })).status, 403);
  assert.equal((await call('POST', `/shop/orders/${id}`, { token: await firebaseToken({ email: 'owner@shop.com', email_verified: false }), body: { action: 'accept' } })).status, 403);
  assert.equal((await call('POST', `/shop/orders/${id}`, { token: await firebaseToken({ email: 'owner@shop.com', aud: 'other' }), body: { action: 'accept' } })).status, 403);

  assert.equal(pushes.length, 0); // placing the order tells the customer nothing yet
  assert.equal((await call('POST', `/shop/orders/${id}`, { token: owner, body: { action: 'accept' } })).data.status, 'accepted');
  assert.equal(pushes.length, 1); // the shop accepted: now the customer gets a card
  assert.equal(pushes[0].to, 'UA');
  assert.equal(pushes[0].messages[0].type, 'flex');
  assert.match(pushes[0].messages[0].altText, /ร้านรับออเดอร์แล้ว ✅ L001/);
  assert.equal((await call('POST', `/shop/orders/${id}`, { token: owner, body: { action: 'done' } })).status, 409); // not paid yet
  await call('POST', `/shop/orders/${id}`, { token: owner, body: { action: 'ready' } });
  assert.equal(pushes.length, 2);
  assert.match(pushes[1].messages[0].text, /L001 พร้อมรับแล้ว/);

  const done = await call('POST', `/shop/orders/${id}`, { token: owner, body: { action: 'cash' } });
  assert.deepEqual(done.data, { ok: true, status: 'done', paid: true });
  const tx = docs[`${SHOP}/tx/line-${id}`].data;
  assert.equal(tx.source, 'pos'); assert.equal(tx.channel, 'line'); assert.equal(tx.amount, 70); assert.equal(tx.method, 'cash');
  assert.equal(docs[`${SHOP}/orders/${id}`].data.txId, `line-${id}`);
  assert.deepEqual([docs[`${SHOP}/customers/UA`].data.stamps, docs[`${SHOP}/customers/UA`].data.orders], [2, 1]);
  // a closed order cannot be finished twice (no second sale)
  assert.equal((await call('POST', `/shop/orders/${id}`, { token: owner, body: { action: 'done' } })).status, 409);
  assert.equal(Object.keys(docs).filter(k => k.includes('/tx/')).length, 1);
});

test('promptpay: customer claims, shop confirms, hand over', async () => {
  const placed = await call('POST', '/orders', { token: 'cust-A', body: { items: [{ id: 'm_thaitea', qty: 1 }], pickup: { mode: 'later', at: '23:50' }, payMethod: 'promptpay' } });
  assert.equal(placed.data.promptpay, '0812345678');
  assert.deepEqual(placed.data.pickup, { mode: 'later', at: '23:50' });
  const id = placed.data.id;
  assert.equal((await call('GET', `/orders/${id}`, { token: 'cust-B' })).status, 404); // someone else's order
  assert.equal((await call('POST', `/orders/${id}/claim`, { token: 'cust-A' })).status, 200);
  assert.equal((await call('POST', `/orders/${id}/cancel`, { token: 'cust-A' })).status, 409); // already claimed a transfer
  const owner = await firebaseToken({ email: 'owner@shop.com' });
  await call('POST', `/shop/orders/${id}`, { token: owner, body: { action: 'paid' } });
  const mine = await call('GET', `/orders/${id}`, { token: 'cust-A' });
  assert.equal(mine.data.paid, true);
  assert.equal(mine.data.promptpay, undefined);
  await call('POST', `/shop/orders/${id}`, { token: owner, body: { action: 'done' } });
  assert.equal(docs[`${SHOP}/tx/line-${id}`].data.method, 'promptpay');
});

test('limits: two open orders per customer; customer cancel; shop cancel pushes', async () => {
  const body = { items: [{ id: 'm_thaitea', qty: 1 }], payMethod: 'cash' };
  const a = await call('POST', '/orders', { token: 'cust-A', body });
  await call('POST', '/orders', { token: 'cust-A', body });
  assert.equal((await call('POST', '/orders', { token: 'cust-A', body })).status, 429);
  assert.equal((await call('POST', `/orders/${a.data.id}/cancel`, { token: 'cust-A' })).status, 200);
  const c = await call('POST', '/orders', { token: 'cust-A', body });
  assert.equal(c.status, 201);
  const owner = await firebaseToken({ email: 'owner@shop.com' });
  await call('POST', `/shop/orders/${c.data.id}`, { token: owner, body: { action: 'cancel', reason: 'นมหมด' } });
  assert.match(pushes[0].messages[0].text, /เหตุผล: นมหมด/);
  const list = await call('GET', '/orders', { token: 'cust-A' });
  assert.equal(list.data.length, 3);
});

test('closed shop refuses orders', async () => {
  docs[SHOP].data.settings.line.open = false;
  const r = await call('POST', '/orders', { token: 'cust-A', body: { items: [{ id: 'm_thaitea', qty: 1 }], payMethod: 'cash' } });
  assert.equal(r.status, 409);
});

test('webhook: signature required; keyword replies are free replies', async () => {
  const placed = await call('POST', '/orders', { token: 'cust-A', body: { items: [{ id: 'm_thaitea', qty: 1 }], payMethod: 'cash' } });
  const raw = JSON.stringify({ events: [
    { type: 'message', replyToken: 'r1', source: { userId: 'UA' }, message: { type: 'text', text: `🧾 ออเดอร์ ${placed.data.no}` } },
    { type: 'message', replyToken: 'r2', source: { userId: 'UA' }, message: { type: 'text', text: 'แต้ม' } },
    { type: 'follow', replyToken: 'r3', source: { userId: 'UB' } }] });
  const bad = await app(new Request('https://w.test/webhook', { method: 'POST', body: raw, headers: { 'x-line-signature': 'nope' } }));
  assert.equal(bad.status, 401);
  const key = await crypto.subtle.importKey('raw', enc.encode('sec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, enc.encode(raw))).toString('base64');
  assert.equal(await validSignature(raw, sig, 'sec'), true);
  const ok = await app(new Request('https://w.test/webhook', { method: 'POST', body: raw, headers: { 'x-line-signature': sig } }));
  assert.equal(ok.status, 200);
  assert.equal(replies.length, 3);
  const byToken = Object.fromEntries(replies.map(r => [r.replyToken, r.messages[0]]));
  assert.equal(byToken.r1.type, 'flex');
  assert.match(byToken.r2.text, /0\/10/);
  assert.match(byToken.r3.template.actions[0].uri, /liff\.line\.me\/liff-1/);
  assert.equal(pushes.length, 0);
});

test('POS sign-in with LINE: only listed LINE accounts get a Firebase custom token', async () => {
  const denied = await call('POST', '/auth/line', { body: { idToken: 'cust-A' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.lineUserId, 'UA');
  assert.equal((await call('POST', '/auth/line', { body: { idToken: 'forged' } })).status, 401);
  const ok = await call('POST', '/auth/line', { body: { idToken: 'cust-Boss' } });
  assert.equal(ok.status, 200);
  const [h, p, s] = ok.data.token.split('.');
  assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', saKeys.publicKey, Buffer.from(s, 'base64url'), enc.encode(`${h}.${p}`)));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.uid, 'line:UBoss');
  assert.equal(claims.iss, SA.client_email);
  assert.equal(claims.claims.lineOwner, true);
  assert.match(claims.aud, /identitytoolkit/);
  // a Firebase ID token carrying the lineOwner claim may run the shop actions
  const placed = await call('POST', '/orders', { token: 'cust-A', body: { items: [{ id: 'm_thaitea', qty: 1 }], payMethod: 'cash' } });
  const lineOwner = await firebaseToken({ lineOwner: true, sub: 'line:UBoss' });
  assert.equal((await call('POST', `/shop/orders/${placed.data.id}`, { token: lineOwner, body: { action: 'accept' } })).status, 200);
  assert.equal((await call('POST', `/shop/orders/${placed.data.id}`, { token: await firebaseToken({ lineOwner: false }), body: { action: 'ready' } })).status, 403);
});

test('slip: attach, shown on the sale, same slip refused on another order', async () => {
  const body = { items: [{ id: 'm_thaitea', qty: 1 }], payMethod: 'promptpay' };
  const a = await call('POST', '/orders', { token: 'cust-A', body });
  const img = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  assert.equal((await call('POST', `/orders/${a.data.id}/slip`, { token: 'cust-A', body: { image: 'data:text/html;base64,AAAA' } })).status, 400);
  assert.equal((await call('POST', `/orders/${a.data.id}/slip`, { token: 'cust-A', body: { image: 'data:image/jpeg;base64,' + 'A'.repeat(950000) } })).status, 400);
  assert.equal((await call('POST', `/orders/${a.data.id}/slip`, { token: 'cust-B', body: { image: img } })).status, 404);
  assert.equal((await call('POST', `/orders/${a.data.id}/slip`, { token: 'cust-A', body: { image: img, ref: '004:015299123456ABC' } })).status, 200);
  assert.equal(docs[`${SHOP}/slips/line-${a.data.id}`].data.data, img);
  const mine = await call('GET', `/orders/${a.data.id}`, { token: 'cust-A' });
  assert.equal(mine.data.hasSlip, true); assert.equal(mine.data.payClaimed, true);
  const b = await call('POST', '/orders', { token: 'cust-B', body });
  assert.equal((await call('POST', `/orders/${b.data.id}/slip`, { token: 'cust-B', body: { image: img, ref: '004:015299123456ABC' } })).status, 409);
  const owner = await firebaseToken({ email: 'owner@shop.com' });
  await call('POST', `/shop/orders/${a.data.id}`, { token: owner, body: { action: 'paid' } });
  await call('POST', `/shop/orders/${a.data.id}`, { token: owner, body: { action: 'done' } });
  const tx = docs[`${SHOP}/tx/line-${a.data.id}`].data;
  assert.equal(tx.hasSlip, true); assert.equal(tx.qrRef, '004:015299123456ABC');
  assert.equal((await call('POST', `/orders/${a.data.id}/slip`, { token: 'cust-A', body: { image: img } })).status, 409); // already paid
});

test('QR image link: PNG for an unpaid PromptPay order only', async () => {
  const a = await call('POST', '/orders', { token: 'cust-A', body: { items: [{ id: 'm_thaitea', qty: 1 }], payMethod: 'promptpay' } });
  const res = await app(new Request(`https://w.test/qr/${a.data.id}.png?dl=1`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-disposition'), /QR-L001-35THB\.png/);
  const png = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...png.slice(1, 4)], [80, 78, 71]);
  const c = await call('POST', '/orders', { token: 'cust-B', body: { items: [{ id: 'm_thaitea', qty: 1 }], payMethod: 'cash' } });
  assert.equal((await app(new Request(`https://w.test/qr/${c.data.id}.png`))).status, 404);
  assert.equal((await app(new Request('https://w.test/qr/nope.png'))).status, 404);
});

test('shop push: subscribe (owner only), notified on new order and slip, peek shows the text, gone subs switched off', async () => {
  const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', vk.privateKey);
  app = createApp({ ...env, VAPID_PRIVATE_JWK: JSON.stringify(jwk) }, fakeFetch);
  const owner = await firebaseToken({ email: 'owner@shop.com' });
  assert.equal((await call('POST', '/shop/push', { token: await firebaseToken({ email: 'x@y.z' }), body: { endpoint: 'https://push.test/a' } })).status, 403);
  assert.equal((await call('POST', '/shop/push', { token: owner, body: { endpoint: 'javascript:1' } })).status, 400);
  const sub = await call('POST', '/shop/push', { token: owner, body: { endpoint: 'https://push.test/tablet', device: 'Android' } });
  await call('POST', '/shop/push', { token: owner, body: { endpoint: 'https://push.test/gone-phone' } });
  pushed = [];
  const o = await call('POST', '/orders', { token: 'cust-A', body: { items: [{ id: 'm_thaitea', qty: 2 }], payMethod: 'promptpay' } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(pushed.length, 2);
  // VAPID header: ES256 JWT for the push service origin, signed by our key
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(pushed[0].auth);
  const [h, p, sg] = t.split('.');
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).aud, 'https://push.test');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk.publicKey, Buffer.from(sg, 'base64url'), enc.encode(`${h}.${p}`)));
  assert.equal(Buffer.from(k, 'base64url').length, 65);
  const peek = await call('GET', `/push/peek/${sub.data.id}`);
  assert.equal(peek.data.title, '💚 ออเดอร์ใหม่');
  assert.match(peek.data.body, /L001 · ชาไทย ปั่น×2 · ฿70\n.*มารับเองที่ร้าน.*พร้อมเพย์/);
  // the expired device is switched off, the next push only reaches the tablet
  pushed = [];
  await call('POST', `/orders/${o.data.id}/slip`, { token: 'cust-A', body: { image: 'data:image/jpeg;base64,AAAA' } });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(pushed.map(x => x.url), ['https://push.test/tablet']);
  assert.match((await call('GET', `/push/peek/${sub.data.id}`)).data.title, /แนบสลิป/);
});

test('menu photo is served from Firestore as an image', async () => {
  docs[`${SHOP}/menuPhotos/m_thaitea`] = { data: { data: 'data:image/webp;base64,' + Buffer.from('RIFFxxxxWEBP').toString('base64'), v: 5 }, updateTime: '1' };
  const res = await app(new Request('https://w.test/photo/m_thaitea?v=5'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'RIFFxxxxWEBP');
  assert.equal((await app(new Request('https://w.test/photo/m_mango'))).status, 404);
});

test('"เมนู" in chat: a carousel with photo cards first, sold out left out; banner on the menu', async () => {
  docs[SHOP].data.settings.menu = [
    { id: 'm_thaitea', name: 'ชาไทย', emoji: '🧋', prices: { blend: 35, iced: 30, hot: 25 }, price: 35, group: 'drink', photo: 9, photoType: 'jpeg' },
    { id: 'm_mango', name: 'มะม่วงปั่น', emoji: '🥭', prices: { blend: 45 }, price: 45, group: 'fruit', photo: 3, photoType: 'webp' },
    { id: 'm_off', name: 'หมดแล้ว', emoji: '🍓', prices: { blend: 40 }, price: 40, group: 'fruit', soldOut: true },
    { id: 't_pearl', name: 'ไข่มุก', price: 10, group: 'topping' }];
  docs[SHOP].data.settings.line.banner = { on: true, text: 'ซื้อ 2 ลด 10%', photo: 77 };
  const m = await call('GET', '/menu');
  assert.deepEqual(m.data.shop.banner, { text: 'ซื้อ 2 ลด 10%', photo: 77 });
  const raw = JSON.stringify({ events: [{ type: 'message', replyToken: 'r9', source: { userId: 'UA' }, message: { type: 'text', text: 'เมนู' } }] });
  const key = await crypto.subtle.importKey('raw', enc.encode('sec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, enc.encode(raw))).toString('base64');
  await app(new Request('https://w.test/webhook', { method: 'POST', body: raw, headers: { 'x-line-signature': sig } }));
  const cards = replies[0].messages[0].contents.contents;
  assert.equal(replies[0].messages[0].contents.type, 'carousel');
  assert.deepEqual(cards.slice(0, 2).map(c => c.body.contents.find(x => x.weight === 'bold').text), ['ชาไทย', 'มะม่วงปั่น']);
  assert.equal(cards[0].hero.url, 'https://w.test/photo/m_thaitea?v=9');
  assert.equal(cards[1].hero, undefined); // WebP: LINE cannot show it
  assert.equal(cards.length, 3);           // 2 menu cards + "ดูเมนูทั้งหมด" (sold out and toppings left out)
  assert.equal(cards[0].footer.contents[0].action.uri, 'https://liff.line.me/liff-1?item=m_thaitea');
  docs[SHOP].data.settings.line.banner.on = false;
  assert.equal((await call('GET', '/menu')).data.shop.banner, undefined);
});

test('chat button message: no bot reply, the shop\'s devices are notified; quota; accept notice can be switched off', async () => {
  const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  app = createApp({ ...env, VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', vk.privateKey)), BOT_BASIC_ID: '@157zqolw' }, fakeFetch);
  const owner = await firebaseToken({ email: 'owner@shop.com' });
  const sub = await call('POST', '/shop/push', { token: owner, body: { endpoint: 'https://push.test/tablet' } });
  const o = await call('POST', '/orders', { token: 'cust-A', body: { items: [{ id: 'm_thaitea', qty: 1 }], payMethod: 'cash' } });
  assert.equal((await call('GET', '/menu')).data.shop.oaId, '@157zqolw');
  await new Promise(r => setTimeout(r, 50)); // let the "new order" notification finish first
  pushed = []; replies = [];
  const raw = JSON.stringify({ events: [{ type: 'message', replyToken: 'r1', source: { userId: 'UA' }, message: { type: 'text', text: `💬 ${o.data.no}: ขอหวานน้อยได้ไหมคะ` } }] });
  const key = await crypto.subtle.importKey('raw', enc.encode('sec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, enc.encode(raw))).toString('base64');
  await app(new Request('https://w.test/webhook', { method: 'POST', body: raw, headers: { 'x-line-signature': sig } }));
  assert.equal(replies.length, 0);
  assert.equal(pushed.length, 1);
  const peek = (await call('GET', `/push/peek/${sub.data.id}`)).data;
  assert.equal(peek.title, '💬 ลูกค้าทักแชท · L001 · ลูกค้า A');
  assert.equal(peek.body, 'ขอหวานน้อยได้ไหมคะ');
  // quota for the settings page (owner only)
  assert.equal((await call('GET', '/shop/quota', { token: await firebaseToken({ email: 'x@y.z' }) })).status, 403);
  assert.deepEqual((await call('GET', '/shop/quota', { token: owner })).data, { type: 'limited', limit: 300, used: 16, notifyAccept: true });
  // switched off: accepting sends nothing to the customer
  docs[SHOP].data.settings.line.notifyAccept = false;
  pushes = [];
  await call('POST', `/shop/orders/${o.data.id}`, { token: owner, body: { action: 'accept' } });
  assert.equal(pushes.length, 0);
  await call('POST', `/shop/orders/${o.data.id}`, { token: owner, body: { action: 'ready' } });
  assert.equal(pushes.length, 1);
});

test('order history: all of the customer\'s days, newest first, nobody else\'s', async () => {
  const body = { items: [{ id: 'm_thaitea', qty: 1 }], payMethod: 'cash' };
  const a = await call('POST', '/orders', { token: 'cust-A', body });
  docs[`${SHOP}/orders/${a.data.id}`].data.day = '2026-11-01'; // an older day
  docs[`${SHOP}/orders/${a.data.id}`].data.createdAt = 1;
  const b = await call('POST', '/orders', { token: 'cust-A', body });
  await call('POST', '/orders', { token: 'cust-B', body });
  const h = await call('GET', '/orders', { token: 'cust-A' });
  assert.deepEqual(h.data.map(o => o.id), [b.data.id, a.data.id]);
  assert.equal(h.data[1].day, '2026-11-01');
  assert.equal(h.data[0].items[0].cost, undefined);
});
