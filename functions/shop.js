// Pure ordering logic (no Firebase / LINE calls) so it can be unit tested.
// Menu rules mirror the POS in app.js: stylesOf / priceOf / lineName.

export const STYLES = { blend: 'ปั่น', iced: 'เย็น', hot: 'ร้อน' };
export const OPEN_STATUSES = ['new', 'accepted', 'ready'];
export const MAX_OPEN_PER_CUSTOMER = 2;
export const MAX_LINES = 30;
export const MAX_QTY = 20;

// LINE ordering settings live in users/{shop}.settings.line
export const lineSettings = s => ({ open: false, from: '09:00', to: '20:00', prep: 10, stampGoal: 10, note: '', ...(s?.line || {}) });

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
    payMethod: o.payMethod, paid: !!o.paid, payClaimed: !!o.payClaimed, pickup: o.pickup, day: o.day, createdAt: o.createdAt,
    ...(o.payMethod === 'promptpay' && !o.paid && shop.promptpay ? { promptpay: shop.promptpay } : {}) };
}

export const STATUS_TEXT = { new: 'รอร้านรับออเดอร์', accepted: 'กำลังทำ', ready: 'พร้อมรับแล้ว', done: 'รับแล้ว', cancelled: 'ยกเลิกแล้ว' };
