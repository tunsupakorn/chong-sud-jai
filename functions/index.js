// จุกจิกการค้า × LINE OA — Cloud Functions (asia-southeast1)
//   api      : HTTP API for the LIFF ordering page (menu, place order, my orders)
//   webhook  : LINE Messaging API webhook (follow greeting, keyword replies, free order confirmation)
//   onOrderUpdated : when the shop changes an order (ready / cancelled / done) → push to customer, record the sale
import { createHmac, timingSafeEqual } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { setGlobalOptions, logger } from 'firebase-functions/v2';
import { defineSecret, defineString } from 'firebase-functions/params';
import * as Shop from './shop.js';

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: 'asia-southeast1', maxInstances: 5 });

// ---- configuration (set in functions/.env, secrets via `firebase functions:secrets:set`) ----
const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET');
const LINE_CHANNEL_ID = defineString('LINE_CHANNEL_ID', { description: 'Channel ID of the Messaging API channel' });
const SHOP_UID = defineString('SHOP_UID', { default: '6aNH4DgIqSfQA9KbOWVcwLc3Jzn1' });
const LOGIN_CHANNEL_ID = defineString('LINE_LOGIN_CHANNEL_ID', { description: 'Channel ID of the LINE Login channel that owns the LIFF app' });
const LIFF_ID = defineString('LIFF_ID', { description: 'LIFF app id, e.g. 2001234567-AbCdEfGh' });
const ALLOWED_ORIGINS = defineString('ALLOWED_ORIGINS', { default: 'https://tunsupakorn.github.io' });

const shopRef = () => db.doc(`users/${SHOP_UID.value()}`);
const ordersCol = () => shopRef().collection('orders');
const liffUrl = (path = '') => `https://liff.line.me/${LIFF_ID.value()}${path}`;
const baht = n => '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });

async function loadShop() {
  const snap = await shopRef().get();
  const settings = snap.exists ? snap.data().settings || {} : {};
  return { settings, cfg: Shop.lineSettings(settings), menu: Array.isArray(settings.menu) ? settings.menu : [] };
}

// ---------------- LINE platform ----------------
export function validSignature(rawBody, signature, secret) {
  if (!rawBody || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const got = Buffer.from(String(signature), 'base64');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// Stateless channel access token (valid 15 min) issued from the channel ID + secret, so no long-lived token has to be stored.
let token = { value: '', until: 0 };
async function accessToken() {
  if (token.value && Date.now() < token.until) return token.value;
  const res = await fetch('https://api.line.me/oauth2/v3/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: LINE_CHANNEL_ID.value(), client_secret: LINE_CHANNEL_SECRET.value() }),
  });
  if (!res.ok) throw new Error(`LINE token ${res.status}: ${await res.text()}`);
  const d = await res.json();
  token = { value: d.access_token, until: Date.now() + (Number(d.expires_in) || 900) * 1000 - 60e3 };
  return token.value;
}

async function lineApi(path, body) {
  const res = await fetch(`https://api.line.me/v2/bot/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LINE ${path} ${res.status}: ${await res.text()}`);
}
const reply = (replyToken, messages) => lineApi('message/reply', { replyToken, messages: [].concat(messages) });
const push = (to, messages) => lineApi('message/push', { to, messages: [].concat(messages) });

// LIFF sends liff.getIDToken(); LINE verifies it and tells us who the customer is.
async function customerFrom(req) {
  const token = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1];
  if (!token) throw new Shop.OrderError('กรุณาเปิดจาก LINE', 401);
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: token, client_id: LOGIN_CHANNEL_ID.value() }),
  });
  if (!res.ok) throw new Shop.OrderError('การยืนยันตัวตนหมดอายุ ปิดแล้วเปิดหน้านี้ใหม่', 401);
  const p = await res.json();
  return { id: p.sub, name: String(p.name || 'ลูกค้า LINE').slice(0, 60) };
}

// ---------------- messages ----------------
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
      row('รายการ', itemsText(o)),
      row('ยอด', baht(o.total), true),
      row('ชำระ', payText(o)),
      row('สถานะ', Shop.STATUS_TEXT[o.status] || o.status),
      row('รับ', pickupText(o)),
    ] },
    footer: { type: 'box', layout: 'vertical', contents: [
      { type: 'button', style: 'primary', color: '#2F7FD6', action: { type: 'uri', label: 'ดูออเดอร์', uri: liffUrl(`?order=${id}`) } }] } } };
}
const orderButton = (text, label = '🥤 สั่งเครื่องดื่ม') => ({ type: 'template', altText: text,
  template: { type: 'buttons', text: text.slice(0, 160), actions: [{ type: 'uri', label, uri: liffUrl() }] } });

// ---------------- HTTP API for the LIFF page ----------------
function cors(req, res) {
  const allowed = ALLOWED_ORIGINS.value().split(',').map(s => s.trim());
  const origin = req.get('origin');
  if (origin && (allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'authorization, content-type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

async function getMenu() {
  const { settings, cfg, menu } = await loadShop();
  const now = Shop.bkk();
  return { shop: { name: cfg.name || 'จุกจิกการค้า', open: cfg.open, from: cfg.from, to: cfg.to, prep: Number(cfg.prep) || 0, note: cfg.note,
    promptpay: !!settings.promptpay, now: now.hm, day: now.day, acceptingNow: cfg.open && now.min >= Shop.toMin(cfg.from) && now.min < Shop.toMin(cfg.to) },
    menu: Shop.publicMenu(menu) };
}

async function placeOrder(who, body) {
  const { settings, cfg, menu } = await loadShop();
  const now = Shop.bkk();
  const pickup = Shop.checkPickup(cfg, body?.pickup, now);
  const priced = Shop.priceCart(menu, body?.items);
  const payMethod = body?.payMethod === 'promptpay' ? 'promptpay' : body?.payMethod === 'cash' ? 'cash' : null;
  if (!payMethod) throw new Shop.OrderError('เลือกวิธีชำระเงิน');
  if (payMethod === 'promptpay' && !settings.promptpay) throw new Shop.OrderError('ร้านยังไม่เปิดรับพร้อมเพย์ เลือกเงินสดตอนรับ', 409);
  const mine = await ordersCol().where('lineUserId', '==', who.id).where('day', '==', now.day).get();
  if (mine.docs.filter(d => Shop.OPEN_STATUSES.includes(d.data().status)).length >= Shop.MAX_OPEN_PER_CUSTOMER)
    throw new Shop.OrderError('มีออเดอร์ที่ยังไม่ได้รับอยู่แล้ว รอรับก่อนแล้วค่อยสั่งเพิ่มนะ', 429);

  const ref = ordersCol().doc();
  const counter = shopRef().collection('counters').doc(`line-${now.day}`);
  const order = await db.runTransaction(async t => {
    const c = await t.get(counter);
    const n = (c.exists ? c.data().next : 0) + 1;
    const o = { no: Shop.orderNo(n), day: now.day, status: 'new', lineUserId: who.id, displayName: who.name,
      ...priced, payMethod, paid: false, payClaimed: false, pickup, note: String(body?.note || '').slice(0, 120),
      createdAt: Date.now(), updatedAt: Date.now() };
    t.set(counter, { next: n }, { merge: true });
    t.create(ref, o);
    return o;
  });
  logger.info('order placed', { id: ref.id, no: order.no, total: order.total });
  return Shop.publicOrder(ref.id, order, settings);
}

async function myOrder(who, id) {
  const snap = await ordersCol().doc(id).get();
  if (!snap.exists || snap.data().lineUserId !== who.id) throw new Shop.OrderError('ไม่พบออเดอร์', 404);
  return snap;
}

async function myOrders(who) {
  const { settings } = await loadShop();
  const snap = await ordersCol().where('lineUserId', '==', who.id).where('day', '==', Shop.bkk().day).get();
  return snap.docs.map(d => Shop.publicOrder(d.id, d.data(), settings)).sort((a, b) => b.createdAt - a.createdAt);
}

// customer: "I have transferred" (shop still checks the bank app and confirms)
async function claimPaid(who, id) {
  const ref = (await myOrder(who, id)).ref;
  await db.runTransaction(async t => {
    const o = (await t.get(ref)).data();
    if (o.payMethod !== 'promptpay' || o.paid || o.status === 'cancelled') throw new Shop.OrderError('ออเดอร์นี้แจ้งโอนไม่ได้', 409);
    t.update(ref, { payClaimed: true, payClaimedAt: Date.now(), updatedAt: Date.now() });
  });
}
async function switchToCash(who, id) {
  const ref = (await myOrder(who, id)).ref;
  await db.runTransaction(async t => {
    const o = (await t.get(ref)).data();
    if (o.paid || o.status === 'cancelled' || o.status === 'done') throw new Shop.OrderError('เปลี่ยนวิธีจ่ายไม่ได้แล้ว', 409);
    t.update(ref, { payMethod: 'cash', payClaimed: false, updatedAt: Date.now() });
  });
}
async function cancelMine(who, id) {
  const ref = (await myOrder(who, id)).ref;
  await db.runTransaction(async t => {
    const o = (await t.get(ref)).data();
    if (o.status !== 'new') throw new Shop.OrderError('ร้านเริ่มทำแล้ว ยกเลิกเองไม่ได้ ทักแชทร้านได้เลย', 409);
    if (o.paid || o.payClaimed) throw new Shop.OrderError('แจ้งโอนแล้ว ทักแชทร้านเพื่อยกเลิก', 409);
    t.update(ref, { status: 'cancelled', cancelledBy: 'customer', updatedAt: Date.now() });
  });
}

export const api = onRequest({ cors: false, invoker: 'public' }, async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const parts = req.path.split('/').filter(Boolean); // e.g. ['orders', '<id>', 'claim']
  try {
    if (req.method === 'GET' && parts[0] === 'menu') return res.json(await getMenu());
    const who = await customerFrom(req);
    if (parts[0] === 'orders') {
      if (req.method === 'POST' && parts.length === 1) return res.status(201).json(await placeOrder(who, req.body));
      if (req.method === 'GET' && parts.length === 1) return res.json(await myOrders(who));
      const id = parts[1];
      if (req.method === 'GET' && parts.length === 2) {
        const snap = await myOrder(who, id);
        return res.json(Shop.publicOrder(id, snap.data(), (await loadShop()).settings));
      }
      if (req.method === 'POST' && parts[2] === 'claim') { await claimPaid(who, id); return res.json({ ok: true }); }
      if (req.method === 'POST' && parts[2] === 'cash') { await switchToCash(who, id); return res.json({ ok: true }); }
      if (req.method === 'POST' && parts[2] === 'cancel') { await cancelMine(who, id); return res.json({ ok: true }); }
    }
    if (parts[0] === 'me') {
      const c = await shopRef().collection('customers').doc(who.id).get();
      const { cfg } = await loadShop();
      return res.json({ name: who.name, stamps: c.exists ? c.data().stamps || 0 : 0, stampGoal: Number(cfg.stampGoal) || 10 });
    }
    res.status(404).json({ error: 'not found' });
  } catch (e) {
    if (e instanceof Shop.OrderError) return res.status(e.status).json({ error: e.message });
    logger.error(e);
    res.status(500).json({ error: 'ระบบขัดข้อง ลองใหม่อีกครั้ง' });
  }
});

// ---------------- LINE webhook ----------------
async function handleEvent(ev) {
  const userId = ev.source?.userId;
  if (ev.type === 'follow') {
    return reply(ev.replyToken, orderButton('สวัสดีจาก จุกจิกการค้า 🐣 กดสั่งน้ำปั่นได้เลย สั่งแล้วรับเลย หรือนัดเวลารับก็ได้'));
  }
  if (ev.type !== 'message' || ev.message?.type !== 'text' || !userId) return;
  const text = ev.message.text.trim();
  const today = Shop.bkk().day;

  // sent by the LIFF page right after ordering (liff.sendMessages): reply is free, unlike push
  const m = /ออเดอร์\s*(L\d{3,})/.exec(text);
  if (m) {
    const snap = await ordersCol().where('lineUserId', '==', userId).where('day', '==', today).get();
    const d = snap.docs.find(x => x.data().no === m[1]);
    if (d) return reply(ev.replyToken, orderBubble(d.id, d.data(), 'ร้านได้รับออเดอร์แล้ว 🧾'));
    return;
  }
  if (/คิว|สถานะ|ออเดอร์/.test(text)) {
    const snap = await ordersCol().where('lineUserId', '==', userId).where('day', '==', today).get();
    const open = snap.docs.filter(d => Shop.OPEN_STATUSES.includes(d.data().status));
    if (!open.length) return reply(ev.replyToken, orderButton('วันนี้ยังไม่มีออเดอร์ที่รออยู่'));
    return reply(ev.replyToken, open.slice(0, 5).map(d => orderBubble(d.id, d.data(), 'สถานะออเดอร์')));
  }
  if (/แต้ม|สะสม/.test(text)) {
    const c = await shopRef().collection('customers').doc(userId).get();
    const { cfg } = await loadShop();
    const stamps = c.exists ? c.data().stamps || 0 : 0, goal = Number(cfg.stampGoal) || 10;
    return reply(ev.replyToken, { type: 'text', text: `แต้มสะสม ${stamps % goal}/${goal} แก้ว ⭐${Math.floor(stamps / goal) ? `\nครบแล้ว ${Math.floor(stamps / goal)} รอบ 🎉` : ''}` });
  }
  if (/เมนู|สั่ง|ราคา/.test(text)) return reply(ev.replyToken, orderButton('ดูเมนูและสั่งได้ที่นี่เลย 👇'));
  // anything else: leave it for the shop to answer in LINE OA Manager chat
}

export const webhook = onRequest({ secrets: [LINE_CHANNEL_SECRET], invoker: 'public' }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('');
  if (!validSignature(req.rawBody, req.get('x-line-signature'), LINE_CHANNEL_SECRET.value())) return res.status(401).send('bad signature');
  const events = req.body?.events || [];
  await Promise.all(events.map(ev => handleEvent(ev).catch(e => logger.error('event failed', e))));
  res.status(200).send('OK');
});

// ---------------- order changes from the POS ----------------
export function saleFromOrder(id, o, hm) {
  return { id: `line-${id}`, type: 'income', cat: 'sales', method: o.payMethod === 'promptpay' ? 'promptpay' : 'cash', amount: o.total,
    date: o.day, time: hm, source: 'pos', channel: 'line', cups: o.cups, orderId: id, orderNo: o.no,
    merchant: `${o.no} ${o.items.map(i => `${i.name}${i.qty > 1 ? '×' + i.qty : ''}`).join(', ')}`,
    items: o.items, createdAt: Date.now(), updatedAt: Date.now() };
}

export const onOrderUpdated = onDocumentUpdated({ document: 'users/{uid}/orders/{orderId}', secrets: [LINE_CHANNEL_SECRET] }, async event => {
  if (event.params.uid !== SHOP_UID.value()) return;
  const before = event.data.before.data(), after = event.data.after.data(), id = event.params.orderId;

  // a finished, paid order becomes a sale in the books (same shape as a POS bill, so reports/close/Sheet count it)
  if (after.status === 'done' && after.paid && !after.txId) {
    const ref = event.data.after.ref;
    await db.runTransaction(async t => {
      const cur = (await t.get(ref)).data();
      if (cur.txId) return;
      const tx = saleFromOrder(id, cur, Shop.bkk().hm);
      t.set(shopRef().collection('tx').doc(tx.id), tx);
      t.update(ref, { txId: tx.id, doneAt: Date.now() });
      t.set(shopRef().collection('customers').doc(cur.lineUserId), { name: cur.displayName, stamps: FieldValue.increment(cur.cups || 0),
        orders: FieldValue.increment(1), spent: FieldValue.increment(cur.total || 0), lastAt: Date.now() }, { merge: true });
    });
  }

  if (before.status === after.status) return;
  try {
    if (after.status === 'ready') {
      await push(after.lineUserId, { type: 'text', text: `☕ คิว ${after.no} พร้อมรับแล้ว!\n${itemsText(after)}\n${after.paid ? 'ชำระแล้ว ✅' : `ยอด ${baht(after.total)} · ${payText(after)}`}` });
    } else if (after.status === 'cancelled' && after.cancelledBy === 'shop') {
      await push(after.lineUserId, { type: 'text', text: `ขออภัย ร้านยกเลิกคิว ${after.no}${after.cancelReason ? `\nเหตุผล: ${after.cancelReason}` : ''}${after.payClaimed || after.paid ? '\nร้านจะติดต่อเรื่องคืนเงินทางแชทนี้' : ''}` });
    }
  } catch (e) { logger.error('push failed', e); }
});
