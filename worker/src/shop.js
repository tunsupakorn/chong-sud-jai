// Pure ordering logic (no Firebase / LINE calls) so it can be unit tested.
// Menu rules mirror the POS in app.js: stylesOf / priceOf / lineName.

export const STYLES = { blend: 'ปั่น', iced: 'เย็น', hot: 'ร้อน' };
export const OPEN_STATUSES = ['new', 'accepted', 'ready'];
export const MAX_OPEN_PER_CUSTOMER = 2;
export const MAX_LINES = 30;
export const MAX_QTY = 20;

// LINE ordering settings live in users/{shop}.settings.line
export const lineSettings = s => ({ open: false, from: '09:00', to: '20:00', prep: 10, stampGoal: 10, note: '', deliveryMin: 100, ...(s?.line || {}) });

// Thailand has no daylight saving: Bangkok = UTC+7 all year.
export function bkk(d = new Date()) {
  const s = new Date(d.getTime() + 7 * 3600e3).toISOString();
  const hm = s.slice(11, 16);
  return { day: s.slice(0, 10), hm, min: toMin(hm) };
}
export const toMin = hm => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
export const toHM = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export const stylesOf = m => m.group === 'topping' || !m.prices ? [] : Object.keys(STYLES).filter(k => Number(m.prices[k]) > 0);
export const priceOf = (m, style) => (style && Number(m.prices?.[style])) || Number(m.price) || 0;
export const lineName = (m, style) => style && stylesOf(m).length > 1 ? `${m.name} ${STYLES[style]}` : m.name;

// What customers may see: never the cost per cup.
export function publicMenu(menu = []) {
  return menu.filter(m => m.active !== false && priceOf(m, stylesOf(m)[0]) > 0)
    .map(m => ({ id: m.id, name: m.name, emoji: m.emoji || '🥤', group: m.group || 'drink',
      ...(m.group === 'topping' ? { price: Number(m.price) || 0 } : { prices: Object.fromEntries(stylesOf(m).map(k => [k, Number(m.prices[k])])), price: priceOf(m, stylesOf(m)[0]) }) }));
}

export class OrderError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

// Rebuild the cart from the shop's menu; the client's prices are never trusted.
export function priceCart(menu, lines) {
  if (!Array.isArray(lines) || !lines.length) throw new OrderError('ตะกร้าว่าง');
  if (lines.length > MAX_LINES) throw new OrderError('รายการเยอะเกินไป');
  const byId = new Map(menu.filter(m => m.active !== false).map(m => [m.id, m]));
  const merged = new Map();
  for (const l of lines) {
    const m = byId.get(String(l?.id || ''));
    if (!m) throw new OrderError('มีเมนูที่ร้านปิดขายไปแล้ว ลองโหลดเมนูใหม่', 409);
    const st = stylesOf(m);
    const style = st.length ? String(l.style || st[0]) : '';
    if (st.length && !st.includes(style)) throw new OrderError(`${m.name} ไม่มีแบบนี้`, 409);
    const qty = Math.floor(Number(l.qty));
    if (!(qty >= 1 && qty <= MAX_QTY)) throw new OrderError('จำนวนไม่ถูกต้อง');
    const key = `${m.id}|${style}`;
    const prev = merged.get(key);
    if (prev) prev.qty += qty;
    else merged.set(key, { id: m.id, name: lineName(m, style), qty, price: priceOf(m, style), cost: Number(m.cost) || 0, topping: m.group === 'topping', ...(style ? { style } : {}) });
  }
  const items = [...merged.values()];
  if (items.some(i => i.qty > MAX_QTY)) throw new OrderError('จำนวนเยอะเกินไป');
  if (items.some(i => !(i.price > 0))) throw new OrderError('มีเมนูที่ยังไม่ได้ตั้งราคา', 409);
  const cups = items.filter(i => !i.topping).reduce((s, i) => s + i.qty, 0);
  if (!cups) throw new OrderError('สั่งเครื่องดื่มอย่างน้อย 1 แก้ว');
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  return { items: items.map(({ topping, ...i }) => i), cups, total };
}

// pickup: { mode: 'asap' } or { mode: 'later', at: 'HH:MM' } (today only, within opening hours)
export function checkPickup(cfg, pickup, now = bkk()) {
  if (!cfg.open) throw new OrderError('ร้านปิดรับออเดอร์ทาง LINE อยู่ตอนนี้', 409);
  const from = toMin(cfg.from), to = toMin(cfg.to), prep = Math.max(0, Number(cfg.prep) || 0);
  if (now.min < from) {
    if (pickup?.mode !== 'later') throw new OrderError(`ร้านเปิด ${cfg.from} สั่งล่วงหน้าแบบนัดเวลารับได้`, 409);
  }
  if (now.min >= to) throw new OrderError(`ร้านปิดแล้ว (เปิด ${cfg.from}–${cfg.to})`, 409);
  if (pickup?.mode === 'later') {
    const at = toMin(pickup.at);
    if (Number.isNaN(at)) throw new OrderError('เวลารับไม่ถูกต้อง');
    const earliest = Math.max(now.min + prep, from);
    if (at < earliest) throw new OrderError(`รับได้เร็วสุด ${toHM(earliest)}`);
    if (at > to) throw new OrderError(`ร้านปิด ${cfg.to} เลือกเวลาก่อนนั้น`);
    return { mode: 'later', at: toHM(at) };
  }
  return { mode: 'asap', at: toHM(Math.min(now.min + prep, to)) };
}

export const orderNo = n => 'L' + String(n).padStart(3, '0');

// The order as the customer sees it (no cost, no internal fields).
export function publicOrder(id, o, shop = {}) {
  return { id, no: o.no, status: o.status, items: (o.items || []).map(({ cost, ...i }) => i), cups: o.cups, total: o.total,
    payMethod: o.payMethod, paid: !!o.paid, payClaimed: !!o.payClaimed, hasSlip: !!o.hasSlip, pickup: o.pickup, fulfil: o.fulfil || { mode: 'pickup' }, day: o.day, createdAt: o.createdAt,
    ...(o.payMethod === 'promptpay' && !o.paid && shop.promptpay ? { promptpay: shop.promptpay } : {}) };
}

export const STATUS_TEXT = { new: 'รอร้านรับออเดอร์', accepted: 'กำลังทำ', ready: 'พร้อมรับแล้ว', done: 'รับแล้ว', cancelled: 'ยกเลิกแล้ว' };

// ---- shop (POS) actions on an order → the fields to change ----
export function shopAction(o, action, reason = '', now = Date.now()) {
  const open = OPEN_STATUSES.includes(o.status);
  const bad = msg => { throw new OrderError(msg, 409); };
  switch (action) {
    case 'accept': if (o.status !== 'new') bad('ออเดอร์นี้รับไปแล้ว'); return { status: 'accepted' };
    case 'ready': if (!['new', 'accepted'].includes(o.status)) bad('สถานะเปลี่ยนไปแล้ว'); return { status: 'ready', readyAt: now };
    case 'paid': if (o.paid) bad('ชำระแล้ว'); if (!open) bad('ออเดอร์ปิดไปแล้ว'); return { paid: true, paidAt: now };
    case 'cash': if (!open) bad('ออเดอร์ปิดไปแล้ว'); return { payMethod: 'cash', paid: true, paidAt: now, status: 'done' };
    case 'done': if (!open) bad('ออเดอร์ปิดไปแล้ว'); if (!o.paid) bad('ยังไม่ได้รับเงิน'); return { status: 'done' };
    case 'cancel': if (!open) bad('ออเดอร์ปิดไปแล้ว'); return { status: 'cancelled', cancelledBy: 'shop', cancelReason: String(reason || '').slice(0, 120) };
    default: throw new OrderError('คำสั่งไม่ถูกต้อง');
  }
}

// a finished, paid order as a POS bill (same shape as confirmSale in app.js, so reports / close / Sheet count it)
export function saleFromOrder(id, o, hm, now = Date.now()) {
  return { id: `line-${id}`, type: 'income', cat: 'sales', method: o.payMethod === 'promptpay' ? 'promptpay' : 'cash', amount: o.total,
    date: o.day, time: hm, source: 'pos', channel: 'line', cups: o.cups, orderId: id, orderNo: o.no,
    merchant: `${o.no} ${o.items.map(i => `${i.name}${i.qty > 1 ? '×' + i.qty : ''}`).join(', ')}`,
    items: o.items, createdAt: now, updatedAt: now,
    // the customer's slip is stored at slips/line-{orderId} = slips/{tx.id}, so the POS shows it on the bill
    ...(o.hasSlip ? { hasSlip: true } : {}), ...(o.slipRef ? { qrRef: o.slipRef } : {}) };
}

// customer's transfer slip: a compressed JPEG/PNG data URL (Firestore doc limit is 1 MB)
export const MAX_SLIP_CHARS = 900_000;
export function checkSlip(body) {
  const image = String(body?.image || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw new OrderError('ไฟล์สลิปไม่ถูกต้อง');
  if (image.length > MAX_SLIP_CHARS) throw new OrderError('รูปสลิปใหญ่เกินไป');
  const ref = body?.ref ? String(body.ref).slice(0, 80) : '';
  if (ref && !/^[0-9]{3}:[A-Za-z0-9]{6,60}$/.test(ref)) throw new OrderError('ข้อมูล QR บนสลิปไม่ถูกต้อง');
  return { image, ref };
}

// ---- how the customer receives the order ----
export const FULFIL = {
  pickup: { label: 'มารับเองที่ร้าน', emoji: '🛍️' },
  delivery: { label: 'ให้ร้านไปส่ง', emoji: '🛵' },
};
export const fulfilModes = cfg => (Array.isArray(cfg.modes) && cfg.modes.length ? cfg.modes : Object.keys(FULFIL)).filter(k => FULFIL[k]);
export function checkFulfil(cfg, f, total = Infinity) {
  const modes = fulfilModes(cfg);
  const mode = f?.mode || modes[0];
  if (!modes.includes(mode)) throw new OrderError('ร้านไม่ได้เปิดวิธีรับแบบนี้', 409);
  const min = Math.max(0, Number(cfg.deliveryMin) || 0);
  if (mode === 'delivery' && total < min) throw new OrderError(`จัดส่งเมื่อสั่งครบ ฿${min} (ขาดอีก ฿${min - total})`, 409);
  const detail = String(f?.detail || '').trim().slice(0, 200);
  const phone = String(f?.phone || '').replace(/\D/g, '').slice(0, 10);
  if (mode === 'delivery') {
    if (detail.length < 5) throw new OrderError('ใส่ที่อยู่สำหรับจัดส่ง');
    if (!/^0\d{8,9}$/.test(phone)) throw new OrderError('ใส่เบอร์โทรสำหรับติดต่อ');
  }
  if (mode === 'curbside' && !detail) throw new OrderError('บอกร้านหน่อยว่ารอตรงไหน เช่น ทะเบียนรถ/สีรถ');
  return { mode, ...(detail ? { detail } : {}), ...(phone ? { phone } : {}) };
}
export const fulfilText = f => f ? `${FULFIL[f.mode]?.emoji || ''} ${FULFIL[f.mode]?.label || f.mode}${f.detail ? ` · ${f.detail}` : ''}` : '';
// what "ready" means for the customer
export const readyText = (o) => ({
  delivery: `🛵 คิว ${o.no} กำลังออกไปส่งแล้ว`,
  dinein: `☕ คิว ${o.no} พร้อมเสิร์ฟแล้ว`,
  curbside: `🚗 คิว ${o.no} พร้อมแล้ว ร้านกำลังเดินไปส่ง${o.fulfil?.detail ? ` (${o.fulfil.detail})` : ''}`,
}[o.fulfil?.mode] || `☕ คิว ${o.no} พร้อมรับแล้ว!`);
