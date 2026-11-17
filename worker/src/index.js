// จุกจิกการค้า × LINE OA — Cloudflare Worker (free plan)
//   GET  /menu                      public menu for the LIFF page (no cost)
//   *    /orders...                 customer, signed in with the LIFF ID token
//   POST /shop/orders/:id           shop owner (POS), signed in with the Firebase ID token
//   POST /webhook                   LINE Messaging API webhook (signature checked)
// Data stays in Firestore (users/{SHOP_UID}/...), reached with the Firestore REST API and a service account.
import * as Shop from './shop.js';
import { Firestore, withRetry } from './firestore.js';
import { googleToken, verifyFirebaseToken, firebaseCustomToken } from './auth.js';
import { validSignature, lineApi, verifyLiffToken, accessToken } from './line.js';
import { payload as ppPayload, qrPng } from './qrpng.js';
import { subId, sendPush } from './push.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const baht = n => '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });

export function createApp(env, fetchFn = (...a) => fetch(...a)) {
  const sa = typeof env.FIREBASE_SERVICE_ACCOUNT === 'string' ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}') : env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa?.private_key || !sa?.client_email)
    console.error('FIREBASE_SERVICE_ACCOUNT is not a Firebase service-account JSON (needs private_key and client_email)');
  const projectId = env.FIREBASE_PROJECT_ID || sa?.project_id;
  const db = new Firestore(projectId, () => googleToken(sa, fetchFn), fetchFn);
  const shop = `users/${env.SHOP_UID}`;
  const liffUrl = (q = '') => `https://liff.line.me/${env.LIFF_ID}${q}`;
  const line = (path, body) => lineApi(env, path, body, fetchFn);

  async function loadShop() {
    const doc = await db.get(shop);
    const settings = doc?.data?.settings || {};
    const cfg = Shop.lineSettings(settings);
    return { settings, cfg, menu: Array.isArray(settings.menu) ? settings.menu : [], name: cfg.name || env.SHOP_NAME || 'ชงสุดใจ' };
  }
  // today's orders (one equality filter: no composite index needed)
  const ordersOn = day => db.where(shop, 'orders', [['day', day]]);

  // ---------- messages ----------
  const itemsText = o => o.items.map(i => `${Shop.itemLabel(i)}${i.qty > 1 ? ' ×' + i.qty : ''}`).join(', ');
  const pickupText = o => `${o.pickup?.mode === 'later' ? `นัด ${o.pickup.at} น.` : `ประมาณ ${o.pickup?.at || ''} น.`} · ${Shop.fulfilText(o.fulfil || { mode: 'pickup' })}`;
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

  // ---------- shop notifications (Web Push to the shop's devices) ----------
  async function notifyShop(title, body, tag) {
    if (!env.VAPID_PRIVATE_JWK) return;
    const subs = await db.where(shop, 'pushSubs', [['active', true]]);
    await Promise.all(subs.map(async d => {
      // the text waits on the subscription doc; the device's service worker picks it up with /push/peek/{id}
      await db.commit([db.patch(`${shop}/pushSubs/${d.id}`, { last: { title, body, tag, at: Date.now() } })]).catch(() => {});
      const r = await sendPush(d.data.endpoint, env, fetchFn);
      if (r === 'gone') await db.commit([db.patch(`${shop}/pushSubs/${d.id}`, { active: false })]).catch(() => {});
    }));
  }
  const later = (ctx, p) => { const w = p.catch(e => console.error('notify', e)); if (ctx?.waitUntil) ctx.waitUntil(w); return w; };
  const orderLine = o => `${o.no} · ${o.items.map(i => `${Shop.itemLabel(i)}${i.qty > 1 ? '×' + i.qty : ''}`).join(', ')} · ${baht(o.total)}`;

  // ---------- customer API ----------
  async function menu() {
    const { settings, cfg, menu, name } = await loadShop();
    const now = Shop.bkk();
    return { shop: { name, ...(env.BOT_BASIC_ID ? { oaId: env.BOT_BASIC_ID } : {}), modes: Shop.fulfilModes(cfg), deliveryMin: Math.max(0, Number(cfg.deliveryMin) || 0), open: cfg.open, from: cfg.from, to: cfg.to, prep: Number(cfg.prep) || 0, note: cfg.note, promptpay: !!settings.promptpay,
      now: now.hm, day: now.day, acceptingNow: cfg.open && now.min >= Shop.toMin(cfg.from) && now.min < Shop.toMin(cfg.to),
      ...(cfg.banner?.on && (cfg.banner.text || cfg.banner.photo) ? { banner: { text: String(cfg.banner.text || '').slice(0, 120), ...(cfg.banner.photo ? { photo: cfg.banner.photo } : {}) } } : {}) },
      menu: Shop.publicMenu(menu) };
  }

  // "เมนู" in the chat: a carousel of menu cards (photos first). LINE shows JPEG/PNG only, so a WebP photo is left out of the card.
  let selfOrigin = '';
  async function menuCarousel() {
    const { menu: items, name } = await loadShop();
    const list = items.filter(m => m.active !== false && !m.soldOut && m.group !== 'topping' && Shop.priceOf(m, Shop.stylesOf(m)[0]) > 0)
      .sort((a, b) => (b.photoType === 'jpeg') - (a.photoType === 'jpeg')).slice(0, 11);
    const price = m => { const p = Shop.stylesOf(m).map(k => Number(m.prices[k])); const lo = Math.min(...(p.length ? p : [Number(m.price)])), hi = Math.max(...(p.length ? p : [Number(m.price)])); return lo === hi ? baht(lo) : `฿${lo}–${hi}`; };
    const card = m => ({ type: 'bubble', size: 'micro',
      ...(m.photo && m.photoType === 'jpeg' && selfOrigin ? { hero: { type: 'image', url: `${selfOrigin}/photo/${encodeURIComponent(m.id)}?v=${m.photo}`, size: 'full', aspectRatio: '1:1', aspectMode: 'cover' } } : {}),
      body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
        ...(m.photo && m.photoType === 'jpeg' ? [] : [{ type: 'text', text: m.emoji || '🥤', size: '3xl', align: 'center' }]),
        { type: 'text', text: m.name, weight: 'bold', size: 'sm', wrap: true },
        { type: 'text', text: price(m), size: 'sm', color: '#2F7FD6', weight: 'bold' }] },
      footer: { type: 'box', layout: 'vertical', contents: [
        { type: 'button', style: 'primary', color: '#2F7FD6', height: 'sm', action: { type: 'uri', label: 'สั่งเลย', uri: liffUrl(`?item=${encodeURIComponent(m.id)}`) } }] } });
    const all = { type: 'bubble', size: 'micro', body: { type: 'box', layout: 'vertical', justifyContent: 'center', spacing: 'md', contents: [
      { type: 'text', text: '🧋', size: '3xl', align: 'center' }, { type: 'text', text: 'ดูเมนูทั้งหมด', weight: 'bold', align: 'center', wrap: true }] },
      footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', color: '#06C755', height: 'sm', action: { type: 'uri', label: 'เปิดหน้าสั่ง', uri: liffUrl() } }] } };
    if (!list.length) return orderButton('ดูเมนูและสั่งได้ที่นี่เลย 👇');
    return { type: 'flex', altText: `เมนู ${name}`, contents: { type: 'carousel', contents: [...list.map(card), all] } };
  }

  async function placeOrder(who, body, ctx) {
    const { settings, cfg, menu } = await loadShop();
    const now = Shop.bkk();
    const pickup = Shop.checkPickup(cfg, body?.pickup, now);
    const priced = Shop.priceCart(menu, body?.items);
    const fulfil = Shop.checkFulfil(cfg, body?.fulfil, priced.total);
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
      paid: false, payClaimed: false, pickup, fulfil, note: String(body?.note || '').slice(0, 120), createdAt: Date.now(), updatedAt: Date.now() };
    await db.commit([db.create(`${shop}/orders/${id}`, o)]);
    later(ctx, notifyShop('💚 ออเดอร์ใหม่', `${orderLine(o)}\n${Shop.fulfilText(o.fulfil)} · ${o.pickup.mode === 'later' ? 'นัด ' : '~'}${o.pickup.at} น. · ${o.payMethod === 'promptpay' ? 'พร้อมเพย์' : 'เงินสด'}`, `order-${id}`));
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
  // slip: stored at slips/line-{id} (the sale's id later), order marked as transfer claimed
  async function attachSlip(who, id, body) {
    const { image, ref } = Shop.checkSlip(body);
    if (ref) {
      const used = await db.where(shop, 'orders', [['slipRef', ref]]);
      if (used.some(d => d.id !== id)) throw new Shop.OrderError('สลิปนี้เคยใช้กับออเดอร์อื่นแล้ว', 409);
    }
    await withRetry(async () => {
      const doc = await myOrder(who, id);
      const o = doc.data;
      if (o.payMethod !== 'promptpay' || o.paid || !Shop.OPEN_STATUSES.includes(o.status)) throw new Shop.OrderError('ออเดอร์นี้แนบสลิปไม่ได้แล้ว', 409);
      await db.commit([
        db.set(`${shop}/slips/line-${id}`, { data: image, at: Date.now(), orderId: id }),
        db.patch(`${shop}/orders/${id}`, { payClaimed: true, payClaimedAt: Date.now(), hasSlip: true, slipRef: ref || null, updatedAt: Date.now() }, doc.updateTime),
      ]);
    });
  }
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
    // the customer hears from the shop only once it has accepted the order (push: counts against the OA's monthly quota)
    const notifyAccept = action === 'accept' && (await loadShop()).cfg.notifyAccept !== false; // the shop can switch this one off to save quota
    if (notifyAccept) await line('message/push', { to: after.lineUserId, messages: [orderBubble(id, after, 'ร้านรับออเดอร์แล้ว ✅')] }).catch(e => console.error(e));
    if (action === 'ready') await line('message/push', { to: after.lineUserId, messages: [{ type: 'text',
      text: `${Shop.readyText(after)}\n${itemsText(after)}\n${after.paid ? 'ชำระแล้ว ✅' : `ยอด ${baht(after.total)} · ${payText(after)}`}` }] }).catch(e => console.error(e));
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
    // "💬 L021: …" from the order page's chat button: a person should answer, so no bot reply; ring the shop's devices instead
    const chat = /^💬\s*(L\d{3,})?\s*:?\s*([\s\S]*)$/.exec(text);
    if (chat) {
      const who = (await mine().catch(() => [])).find(x => !chat[1] || x.data.no === chat[1]);
      return notifyShop(`💬 ลูกค้าทักแชท${chat[1] ? ` · ${chat[1]}` : ''}${who ? ` · ${who.data.displayName}` : ''}`, chat[2].trim().slice(0, 120) || 'เปิดแอป LINE OA เพื่อตอบลูกค้า', `chat-${userId}`);
    }
    const m = /ออเดอร์\s*(L\d{3,})/.exec(text);
    if (m) { // customer asks about an order by its number: answering with reply is free
      const d = (await mine()).find(x => x.data.no === m[1]);
      return d ? reply(orderBubble(d.id, d.data, 'สถานะออเดอร์')) : undefined;
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
    if (/เมนู|ราคา/.test(text)) return reply(await menuCarousel());
    if (/สั่ง/.test(text)) return reply(orderButton('ดูเมนูและสั่งได้ที่นี่เลย 👇'));
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
    selfOrigin ||= url.origin; // for image links in LINE messages
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
      // service worker of a subscribed device: what to show for the push it just got (id = hash of its own endpoint)
      if (req.method === 'GET' && parts[0] === 'push' && parts[1] === 'peek' && /^[\w-]{20,40}$/.test(parts[2] || '')) {
        const d = await db.get(`${shop}/pushSubs/${parts[2]}`);
        return send(d?.data?.last ? { title: d.data.last.title, body: d.data.last.body, tag: d.data.last.tag } : { title: '💚 ชงสุดใจ', body: 'มีความเคลื่อนไหวของออเดอร์ LINE' });
      }
      // menu photo (stored small in Firestore menuPhotos/{id}); ?v= changes with each new photo, so it can be cached for good
      if (req.method === 'GET' && parts[0] === 'photo' && /^[\w-]{1,60}$/.test(parts[1] || '')) {
        const cache = typeof caches !== 'undefined' ? caches.default : null;
        const hit = cache && await cache.match(req);
        if (hit) return hit;
        const d = await db.get(`${shop}/menuPhotos/${parts[1]}`);
        const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(d?.data?.data || '');
        if (!m) return new Response('ไม่มีรูป', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
        const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
        const res = new Response(bytes, { headers: { 'Content-Type': m[1], 'Access-Control-Allow-Origin': '*',
          'Cache-Control': url.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300' } });
        if (cache) later(ctx, cache.put(req, res.clone()));
        return res;
      }
      // PromptPay QR of an unpaid order as a real image file: the LINE in-app browser hands this link to Chrome/Safari to save
      if (req.method === 'GET' && parts[0] === 'qr' && /^[A-Za-z0-9]{1,40}\.png$/.test(parts[1] || '')) {
        const id = parts[1].slice(0, -4);
        const [doc, { settings }] = await Promise.all([db.get(`${shop}/orders/${id}`), loadShop()]);
        const o = doc?.data;
        if (!o || o.payMethod !== 'promptpay' || o.paid || !Shop.OPEN_STATUSES.includes(o.status) || !settings.promptpay)
          return new Response('QR นี้ใช้ไม่ได้แล้ว', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        const png = await qrPng(ppPayload(settings.promptpay, o.total));
        return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store',
          ...(url.searchParams.get('dl') ? { 'Content-Disposition': `attachment; filename="QR-${o.no}-${o.total}THB.png"` } : {}) } });
      }
      // POS sign-in with LINE: a LINE account on OWNER_LINE_IDS gets a Firebase custom token (claim lineOwner)
      if (req.method === 'POST' && parts[0] === 'auth' && parts[1] === 'line') {
        const body = await req.json().catch(() => ({}));
        const who = body.idToken ? await verifyLiffToken(env, String(body.idToken), fetchFn) : null;
        if (!who) return send({ error: 'ยืนยันตัวตน LINE ไม่ได้ ลองใหม่อีกครั้ง' }, 401);
        const owners = String(env.OWNER_LINE_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
        if (!owners.includes(who.id)) return send({ error: 'บัญชี LINE นี้ยังไม่ได้รับสิทธิ์ใช้แอปร้าน', lineUserId: who.id, name: who.name }, 403);
        return send({ token: await firebaseCustomToken(sa, `line:${who.id}`, { lineOwner: true, name: who.name }), name: who.name });
      }
      if (parts[0] === 'shop') {
        const claims = await verifyFirebaseToken(bearer(req), projectId, fetchFn).catch(() => null);
        const owner = claims && (claims.lineOwner === true
          || (claims.email_verified && String(claims.email || '').toLowerCase() === String(env.OWNER_EMAIL || '').toLowerCase()));
        if (!owner) return send({ error: 'เฉพาะบัญชีเจ้าของร้าน' }, 403);
        // LINE push quota this month (only push messages count; replies are free)
        if (req.method === 'GET' && parts[1] === 'quota') {
          const h = { Authorization: `Bearer ${await accessToken(env, fetchFn)}` };
          const [q, c] = await Promise.all(['quota', 'quota/consumption'].map(p => fetchFn(`https://api.line.me/v2/bot/message/${p}`, { headers: h }).then(r => r.json())));
          const { cfg } = await loadShop();
          return send({ type: q.type, limit: q.type === 'limited' ? Number(q.value) || 0 : null, used: Number(c.totalUsage) || 0, notifyAccept: cfg.notifyAccept !== false });
        }
        if (req.method === 'POST' && parts[1] === 'push') {
          const body = await req.json().catch(() => ({}));
          const ep = String(body.endpoint || '');
          if (!/^https:\/\/[\w.-]+\//.test(ep) || ep.length > 1000) return send({ error: 'subscription ไม่ถูกต้อง' }, 400);
          const id = await subId(ep);
          if (parts[2] === 'unsubscribe') { await db.commit([db.patch(`${shop}/pushSubs/${id}`, { active: false })]).catch(() => {}); return send({ ok: true }); }
          await db.commit([db.set(`${shop}/pushSubs/${id}`, { endpoint: ep, active: true, device: String(body.device || '').slice(0, 80), by: claims.sub, at: Date.now(),
            last: { title: '🔔 เปิดแจ้งเตือนแล้ว', body: 'เครื่องนี้จะได้รับแจ้งเตือนเมื่อมีออเดอร์ LINE ใหม่', tag: 'test', at: Date.now() } })]);
          if (body.test && env.VAPID_PRIVATE_JWK) later(ctx, sendPush(ep, env, fetchFn)); // a test notification on this device only
          return send({ ok: true, id });
        }
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
        if (parts.length === 1 && req.method === 'POST') return send(await placeOrder(who, await req.json().catch(() => ({})), ctx), 201);
        if (parts.length === 1 && req.method === 'GET') {
          // the customer's order history, newest first (one equality filter: no composite index needed)
          const [rows, { settings }] = await Promise.all([db.where(shop, 'orders', [['lineUserId', who.id]]), loadShop()]);
          return send(rows.map(d => Shop.publicOrder(d.id, d.data, settings)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50));
        }
        const id = parts[1];
        if (parts.length === 2 && req.method === 'GET') {
          const [doc, { settings }] = await Promise.all([myOrder(who, id), loadShop()]);
          return send(Shop.publicOrder(id, doc.data, settings));
        }
        const step = { claim, cash: toCash, cancel }[parts[2]];
        const pay = async (text) => { const d = await db.get(`${shop}/orders/${id}`); if (d) later(ctx, notifyShop(text, orderLine(d.data), `pay-${id}`)); };
        if (req.method === 'POST' && step) {
          await customerChange(who, id, step);
          if (parts[2] === 'claim') await pay('📲 ลูกค้าแจ้งโอนแล้ว · เช็กยอดเข้า');
          return send({ ok: true });
        }
        if (req.method === 'POST' && parts[2] === 'slip') { await attachSlip(who, id, await req.json().catch(() => ({}))); await pay('🧾 ลูกค้าแนบสลิปแล้ว · เช็กยอดเข้า'); return send({ ok: true }); }
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
