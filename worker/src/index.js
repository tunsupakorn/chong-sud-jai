// จุกจิกการค้า × LINE OA — Cloudflare Worker (free plan)
//   GET  /menu                      public menu for the LIFF page (no cost)
//   *    /orders...                 customer, signed in with the LIFF ID token
//   POST /shop/orders/:id           shop owner (POS), signed in with the Firebase ID token
//   POST /webhook                   LINE Messaging API webhook (signature checked)
// Data stays in Firestore (users/{SHOP_UID}/...), reached with the Firestore REST API and a service account.
import * as Shop from './shop.js';
import { Firestore, withRetry } from './firestore.js';
import { googleToken, verifyFirebaseToken } from './auth.js';
import { validSignature, lineApi, verifyLiffToken } from './line.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const baht = n => '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });

export function createApp(env, fetchFn = (...a) => fetch(...a)) {
  const sa = typeof env.FIREBASE_SERVICE_ACCOUNT === 'string' ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}') : env.FIREBASE_SERVICE_ACCOUNT;
  const projectId = env.FIREBASE_PROJECT_ID || sa?.project_id;
  const db = new Firestore(projectId, () => googleToken(sa, fetchFn), fetchFn);
  const shop = `users/${env.SHOP_UID}`;
  const liffUrl = (q = '') => `https://liff.line.me/${env.LIFF_ID}${q}`;
  const line = (path, body) => lineApi(env, path, body, fetchFn);

  async function loadShop() {
    const doc = await db.get(shop);
    const settings = doc?.data?.settings || {};
    const cfg = Shop.lineSettings(settings);
    return { settings, cfg, menu: Array.isArray(settings.menu) ? settings.menu : [], name: cfg.name || env.SHOP_NAME || 'จุกจิกการค้า' };
  }
  // today's orders (one equality filter: no composite index needed)
  const ordersOn = day => db.where(shop, 'orders', [['day', day]]);

  // ---------- messages ----------
  const itemsText = o => o.items.map(i => `${i.name}${i.qty > 1 ? ' ×' + i.qty : ''}`).join(', ');
  const pickupText = o => o.pickup?.mode === 'later' ? `นัดรับ ${o.pickup.at} น.` : `รับได้ประมาณ ${o.pickup?.at || ''} น.`;
  const payText = o => o.paid ? 'ชำระแล้ว ✅' : o.payMethod === 'promptpay' ? (o.payClaimed ? 'แจ้งโอนแล้ว รอร้านตรวจ' : 'พร้อมเพย์ (ยังไม่ได้โอน)') : 'จ่ายเงินสดตอนรับ';
  function orderBubble(id, o, title) {
    const row = (k, v, bold) => ({ type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: k, size: 'sm', color: '#888888', flex: 2 },
      { type: 'text', text: v, size: 'sm', wrap: true, flex: 5, ...(bold ? { weight: 'bold' } : {}) }] });
    return { type: 'flex', altText: `${title} ${o.no} · ${baht(o.total)}`, contents: { type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: title, size: 'sm', color: '#2F7FD6', weight: 'bold' },
        { type: 'text', text: `คิว ${o.no}`, size: 'xxl', weight: 'bold' },
        row('รายการ', itemsText(o)), row('ยอด', baht(o.total), true), row('ชำระ', payText(o)),
        row('สถานะ', Shop.STATUS_TEXT[o.status] || o.status), row('รับ', pickupText(o))] },
      footer: { type: 'box', layout: 'vertical', contents: [
        { type: 'button', style: 'primary', color: '#2F7FD6', action: { type: 'uri', label: 'ดูออเดอร์', uri: liffUrl(`?order=${id}`) } }] } } };
  }
  const orderButton = (text, label = '🥤 สั่งเครื่องดื่ม') => ({ type: 'template', altText: text,
    template: { type: 'buttons', text: text.slice(0, 160), actions: [{ type: 'uri', label, uri: liffUrl() }] } });

  // ---------- customer API ----------
  async function menu() {
    const { settings, cfg, menu, name } = await loadShop();
    const now = Shop.bkk();
    return { shop: { name, open: cfg.open, from: cfg.from, to: cfg.to, prep: Number(cfg.prep) || 0, note: cfg.note, promptpay: !!settings.promptpay,
      now: now.hm, day: now.day, acceptingNow: cfg.open && now.min >= Shop.toMin(cfg.from) && now.min < Shop.toMin(cfg.to) }, menu: Shop.publicMenu(menu) };
  }

  async function placeOrder(who, body) {
    const { settings, cfg, menu } = await loadShop();
    const now = Shop.bkk();
    const pickup = Shop.checkPickup(cfg, body?.pickup, now);
    const priced = Shop.priceCart(menu, body?.items);
    const payMethod = body?.payMethod === 'promptpay' ? 'promptpay' : body?.payMethod === 'cash' ? 'cash' : null;
    if (!payMethod) throw new Shop.OrderError('เลือกวิธีชำระเงิน');
    if (payMethod === 'promptpay' && !settings.promptpay) throw new Shop.OrderError('ร้านยังไม่เปิดรับพร้อมเพย์ เลือกเงินสดตอนรับ', 409);
    const today = await ordersOn(now.day);
    if (today.filter(d => d.data.lineUserId === who.id && Shop.OPEN_STATUSES.includes(d.data.status)).length >= Shop.MAX_OPEN_PER_CUSTOMER)
      throw new Shop.OrderError('มีออเดอร์ที่ยังไม่ได้รับอยู่แล้ว รอรับก่อนแล้วค่อยสั่งเพิ่มนะ', 429);
    // the counter's increment is atomic and returns the new value = today's queue number
    const [res] = await db.commit([db.increment(`${shop}/counters/line-${now.day}`, 'next', 1)]);
    const n = Number(res.transformResults?.[0]?.integerValue) || 1;
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const o = { no: Shop.orderNo(n), day: now.day, status: 'new', lineUserId: who.id, displayName: who.name, ...priced, payMethod,
      paid: false, payClaimed: false, pickup, note: String(body?.note || '').slice(0, 120), createdAt: Date.now(), updatedAt: Date.now() };
    await db.commit([db.create(`${shop}/orders/${id}`, o)]);
    return Shop.publicOrder(id, o, settings);
  }

  async function myOrder(who, id) {
    if (!/^[A-Za-z0-9]{1,40}$/.test(id)) throw new Shop.OrderError('ไม่พบออเดอร์', 404);
    const doc = await db.get(`${shop}/orders/${id}`);
    if (!doc || doc.data.lineUserId !== who.id) throw new Shop.OrderError('ไม่พบออเดอร์', 404);
    return doc;
  }
  // customer changes, checked against the latest copy of the order
  const customerChange = (who, id, check) => withRetry(async () => {
    const doc = await myOrder(who, id);
    const patch = check(doc.data);
    await db.commit([db.patch(`${shop}/orders/${id}`, { ...patch, updatedAt: Date.now() }, doc.updateTime)]);
  });
  const claim = o => {
    if (o.payMethod !== 'promptpay' || o.paid || !Shop.OPEN_STATUSES.includes(o.status)) throw new Shop.OrderError('ออเดอร์นี้แจ้งโอนไม่ได้', 409);
    return { payClaimed: true, payClaimedAt: Date.now() };
  };
  const toCash = o => {
    if (o.paid || !Shop.OPEN_STATUSES.includes(o.status)) throw new Shop.OrderError('เปลี่ยนวิธีจ่ายไม่ได้แล้ว', 409);
    return { payMethod: 'cash', payClaimed: false };
  };
  const cancel = o => {
    if (o.status !== 'new') throw new Shop.OrderError('ร้านเริ่มทำแล้ว ยกเลิกเองไม่ได้ ทักแชทร้านได้เลย', 409);
    if (o.paid || o.payClaimed) throw new Shop.OrderError('แจ้งโอนแล้ว ทักแชทร้านเพื่อยกเลิก', 409);
    return { status: 'cancelled', cancelledBy: 'customer' };
  };

  // ---------- shop (POS) ----------
  async function shopChange(id, action, reason) {
    if (!/^[A-Za-z0-9]{1,40}$/.test(id)) throw new Shop.OrderError('ไม่พบออเดอร์', 404);
    let after;
    await withRetry(async () => {
      const doc = await db.get(`${shop}/orders/${id}`);
      if (!doc) throw new Shop.OrderError('ไม่พบออเดอร์', 404);
      const patch = { ...Shop.shopAction(doc.data, action, reason), updatedAt: Date.now() };
      after = { ...doc.data, ...patch };
      const writes = [];
      if (after.status === 'done' && after.paid && !after.txId) {
        const tx = Shop.saleFromOrder(id, after, Shop.bkk().hm);
        Object.assign(patch, { txId: tx.id, doneAt: Date.now() });
        writes.push(db.set(`${shop}/tx/${tx.id}`, tx));
        writes.push(db.mergeIncrement(`${shop}/customers/${after.lineUserId}`, { name: after.displayName, lastAt: Date.now() },
          { stamps: after.cups || 0, orders: 1, spent: after.total || 0 }));
      }
      writes.unshift(db.patch(`${shop}/orders/${id}`, patch, doc.updateTime));
      await db.commit(writes);
    });
    // customer messages (push counts against the OA's monthly quota: only these two)
    if (action === 'ready') await line('message/push', { to: after.lineUserId, messages: [{ type: 'text',
      text: `☕ คิว ${after.no} พร้อมรับแล้ว!\n${itemsText(after)}\n${after.paid ? 'ชำระแล้ว ✅' : `ยอด ${baht(after.total)} · ${payText(after)}`}` }] }).catch(e => console.error(e));
    if (action === 'cancel') await line('message/push', { to: after.lineUserId, messages: [{ type: 'text',
      text: `ขออภัย ร้านยกเลิกคิว ${after.no}${after.cancelReason ? `\nเหตุผล: ${after.cancelReason}` : ''}${after.payClaimed || after.paid ? '\nร้านจะติดต่อเรื่องคืนเงินทางแชทนี้' : ''}` }] }).catch(e => console.error(e));
    return { ok: true, status: after.status, paid: after.paid };
  }

  // ---------- webhook ----------
  async function handleEvent(ev) {
    const userId = ev.source?.userId;
    const reply = messages => line('message/reply', { replyToken: ev.replyToken, messages: [].concat(messages) });
    if (ev.type === 'follow') {
      const { name } = await loadShop();
      return reply(orderButton(`สวัสดีจาก ${name} 🐣 กดสั่งเครื่องดื่มได้เลย สั่งแล้วรับเลย หรือนัดเวลารับก็ได้`));
    }
    if (ev.type !== 'message' || ev.message?.type !== 'text' || !userId) return;
    const text = ev.message.text.trim();
    const mine = async () => (await ordersOn(Shop.bkk().day)).filter(d => d.data.lineUserId === userId);
    const m = /ออเดอร์\s*(L\d{3,})/.exec(text);
    if (m) { // sent by the LIFF page after ordering: answering with reply is free
      const d = (await mine()).find(x => x.data.no === m[1]);
      return d ? reply(orderBubble(d.id, d.data, 'ร้านได้รับออเดอร์แล้ว 🧾')) : undefined;
    }
    if (/คิว|สถานะ|ออเดอร์/.test(text)) {
      const open = (await mine()).filter(d => Shop.OPEN_STATUSES.includes(d.data.status));
      return reply(open.length ? open.slice(0, 5).map(d => orderBubble(d.id, d.data, 'สถานะออเดอร์')) : orderButton('วันนี้ยังไม่มีออเดอร์ที่รออยู่'));
    }
    if (/แต้ม|สะสม/.test(text)) {
      const [c, { cfg }] = await Promise.all([db.get(`${shop}/customers/${userId}`), loadShop()]);
      const stamps = c?.data?.stamps || 0, goal = Number(cfg.stampGoal) || 10, rounds = Math.floor(stamps / goal);
      return reply({ type: 'text', text: `แต้มสะสม ${stamps % goal}/${goal} แก้ว ⭐${rounds ? `\nครบแล้ว ${rounds} รอบ 🎉` : ''}` });
    }
    if (/เมนู|สั่ง|ราคา/.test(text)) return reply(orderButton('ดูเมนูและสั่งได้ที่นี่เลย 👇'));
    // anything else: the shop answers in LINE OA Manager chat
  }

  // ---------- router ----------
  function corsHeaders(req) {
    const origin = req.headers.get('origin');
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!origin || !(allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin))) return {};
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' };
  }
  const bearer = req => /^Bearer (.+)$/.exec(req.headers.get('authorization') || '')?.[1];

  return async function handle(req, ctx) {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'webhook') {
      if (req.method !== 'POST') return new Response('', { status: 405 });
      const raw = await req.text();
      if (!await validSignature(raw, req.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET)) return new Response('bad signature', { status: 401 });
      const events = JSON.parse(raw || '{}').events || [];
      const work = Promise.all(events.map(ev => handleEvent(ev).catch(e => console.error('event', e))));
      ctx?.waitUntil ? ctx.waitUntil(work) : await work;
      return new Response('OK');
    }
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const send = (d, s) => json(d, s, cors);
    try {
      if (req.method === 'GET' && parts[0] === 'menu') return send(await menu());
      if (parts[0] === 'shop') {
        const claims = await verifyFirebaseToken(bearer(req), projectId, fetchFn).catch(() => null);
        const owner = claims && claims.email_verified && String(claims.email || '').toLowerCase() === String(env.OWNER_EMAIL || '').toLowerCase();
        if (!owner) return send({ error: 'เฉพาะบัญชีเจ้าของร้าน' }, 403);
        if (req.method === 'POST' && parts[1] === 'orders' && parts[2]) {
          const body = await req.json().catch(() => ({}));
          return send(await shopChange(parts[2], body.action, body.reason));
        }
        return send({ error: 'not found' }, 404);
      }
      const token = bearer(req);
      const who = token ? await verifyLiffToken(env, token, fetchFn) : null;
      if (!who) return send({ error: 'การยืนยันตัวตนหมดอายุ ปิดแล้วเปิดหน้านี้ใหม่' }, 401);
      if (parts[0] === 'orders') {
        if (parts.length === 1 && req.method === 'POST') return send(await placeOrder(who, await req.json().catch(() => ({}))), 201);
        if (parts.length === 1 && req.method === 'GET') {
          const [rows, { settings }] = await Promise.all([ordersOn(Shop.bkk().day), loadShop()]);
          return send(rows.filter(d => d.data.lineUserId === who.id).map(d => Shop.publicOrder(d.id, d.data, settings)).sort((a, b) => b.createdAt - a.createdAt));
        }
        const id = parts[1];
        if (parts.length === 2 && req.method === 'GET') {
          const [doc, { settings }] = await Promise.all([myOrder(who, id), loadShop()]);
          return send(Shop.publicOrder(id, doc.data, settings));
        }
        const step = { claim, cash: toCash, cancel }[parts[2]];
        if (req.method === 'POST' && step) { await customerChange(who, id, step); return send({ ok: true }); }
      }
      if (parts[0] === 'me') {
        const [c, { cfg }] = await Promise.all([db.get(`${shop}/customers/${who.id}`), loadShop()]);
        return send({ name: who.name, stamps: c?.data?.stamps || 0, stampGoal: Number(cfg.stampGoal) || 10 });
      }
      return send({ error: 'not found' }, 404);
    } catch (e) {
      if (e instanceof Shop.OrderError) return send({ error: e.message }, e.status);
      console.error(e);
      return send({ error: 'ระบบขัดข้อง ลองใหม่อีกครั้ง' }, 500);
    }
  };
}

let app = null;
export default {
  fetch(req, env, ctx) {
    app ||= createApp(env);
    return app(req, ctx);
  },
};
