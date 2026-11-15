// หน้าสั่งน้ำใน LINE (LIFF) — เมนู › ตะกร้า › เวลารับ + วิธีจ่าย › ติดตามคิว
import { LIFF_ID, API_BASE } from './config.js';
import * as PP from '../promptpay.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
const baht = n => '฿' + nf.format(n || 0);
const STYLES = { blend: { word: 'ปั่น', emoji: '🧊' }, iced: { word: 'เย็น', emoji: '🥤' }, hot: { word: 'ร้อน', emoji: '♨️' } };
const STATUS = { new: 'รอร้านรับออเดอร์', accepted: 'ร้านกำลังทำ 🧑‍🍳', ready: 'พร้อมรับแล้ว! ☕', done: 'รับแล้ว ขอบคุณค่ะ 💙', cancelled: 'ออเดอร์ถูกยกเลิก' };
const toMin = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const toHM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const ui = { view: 'loading', shop: null, menu: [], cart: [], tab: 'all', pickup: { mode: 'asap', at: '' }, pay: '', note: '',
  order: null, orders: [], me: null, busy: false, error: '' };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = window.liff?.getIDToken?.();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && window.liff?.isLoggedIn?.()) { liff.logout(); liff.login({ redirectUri: location.href }); }
  if (!res.ok) throw new Error(data.error || 'เชื่อมต่อร้านไม่ได้ ลองใหม่อีกครั้ง');
  return data;
}

// ---------- menu helpers (same rules as the POS) ----------
const stylesOf = m => m.group === 'topping' || !m.prices ? [] : Object.keys(STYLES).filter(k => Number(m.prices[k]) > 0);
const priceOf = (m, s) => (s && Number(m.prices?.[s])) || Number(m.price) || 0;
const lineName = (m, s) => s && stylesOf(m).length > 1 ? `${m.name} ${STYLES[s].word}` : m.name;
const item = id => ui.menu.find(m => m.id === id);
const lines = () => ui.cart.map(l => ({ ...l, m: item(l.id) })).filter(l => l.m).map(l => ({ ...l, name: lineName(l.m, l.style), price: priceOf(l.m, l.style) }));
const total = () => lines().reduce((s, l) => s + l.price * l.qty, 0);
const cups = () => lines().filter(l => l.m.group !== 'topping').reduce((s, l) => s + l.qty, 0);
function cartAdd(id, n, style = '') {
  const l = ui.cart.find(x => x.id === id && x.style === style);
  if (l) l.qty += n; else if (n > 0) ui.cart.push({ id, style, qty: n });
  ui.cart = ui.cart.filter(x => x.qty > 0);
  try { sessionStorage.setItem('kaa_cart', JSON.stringify(ui.cart)); } catch {}
}
const priceRange = m => {
  const p = stylesOf(m).map(k => Number(m.prices[k]));
  if (p.length < 2) return baht(p[0] || m.price);
  const lo = Math.min(...p), hi = Math.max(...p);
  return lo === hi ? baht(lo) : `฿${lo}–${hi}`;
};

// pickup times: every 10 minutes from the earliest possible until closing
function timeSlots() {
  const s = ui.shop, now = toMin(s.now), from = toMin(s.from), to = toMin(s.to);
  let t = Math.max(now + s.prep, from);
  t = Math.ceil(t / 10) * 10;
  const out = [];
  for (; t <= to; t += 10) out.push(toHM(t));
  return out;
}

// ---------- views ----------
function viewMenu() {
  const s = ui.shop;
  const drinks = ui.menu.filter(m => m.group !== 'topping' && (ui.tab === 'all' || m.group === ui.tab));
  const toppings = ui.menu.filter(m => m.group === 'topping');
  const qtyOf = id => ui.cart.filter(l => l.id === id).reduce((a, l) => a + l.qty, 0);
  const canOrder = s.open && timeSlots().length > 0;
  return `<header class="shop-head"><div><h1>🐣 ${esc(s.name)}</h1><small>เปิด ${esc(s.from)}–${esc(s.to)} น.</small></div>
      <div class="row gap">${ui.me ? `<span class="stamp">⭐ ${ui.me.stamps % ui.me.stampGoal}/${ui.me.stampGoal}</span>` : ''}
      <button class="icon-btn" data-action="my-orders" aria-label="ออเดอร์ของฉัน">🧾</button></div></header>
    ${!s.open ? '<p class="closed">😴 ร้านปิดรับออเดอร์ทาง LINE อยู่ตอนนี้ ดูเมนูได้ก่อนนะ</p>'
      : !canOrder ? `<p class="closed">ร้านปิดแล้ววันนี้ พรุ่งนี้เปิด ${esc(s.from)} น.</p>`
      : !s.acceptingNow ? `<p class="closed">⏰ ยังไม่ถึงเวลาเปิด สั่งล่วงหน้าแล้วนัดเวลารับได้</p>` : ''}
    ${s.note ? `<p class="g-note">📣 ${esc(s.note)}</p>` : ''}
    <div class="seg sell-tabs" style="margin:12px 0">${[['all', 'ทั้งหมด'], ['fruit', '🍓 ปั่นผลไม้'], ['drink', '🧋 ชา·กาแฟ·นม']].map(([k, l]) =>
      `<button aria-selected="${ui.tab === k}" data-action="tab" data-t="${k}">${l}</button>`).join('')}</div>
    <div class="menu-grid">${drinks.map(m => { const q = qtyOf(m.id); return `<div class="menu-cell">
      <button class="menu-btn ${q ? 'in' : ''}" data-action="add" data-id="${esc(m.id)}" ${canOrder ? '' : 'disabled'}>
        <span class="m-emoji">${esc(m.emoji)}</span><span class="m-name">${esc(m.name)}</span><b class="num">${priceRange(m)}</b>
        ${q ? `<i class="m-qty">${q}</i>` : ''}</button>
      ${q ? `<button class="m-minus" data-action="undo" data-id="${esc(m.id)}" aria-label="ลด ${esc(m.name)}">−</button>` : ''}</div>`; }).join('')
      || '<p class="muted center pad">ยังไม่มีเมนู</p>'}</div>
    ${toppings.length ? `<div class="top-row"><small class="muted">ท็อปปิ้ง</small>${toppings.map(m => { const q = qtyOf(m.id); return `<span class="top-wrap">
      <button class="chip top-chip ${q ? 'in' : ''}" data-action="add" data-id="${esc(m.id)}" ${canOrder ? '' : 'disabled'}>${esc(m.emoji)} ${esc(m.name)} +${m.price}${q ? ` <b>×${q}</b>` : ''}</button>
      ${q ? `<button class="chip top-minus" data-action="undo" data-id="${esc(m.id)}" aria-label="ลด ${esc(m.name)}">−</button>` : ''}</span>`; }).join('')}</div>` : ''}
    <div class="cart-spacer"></div>
    ${ui.cart.length ? `<div class="cart-bar">
      <button class="cart-sum" data-action="checkout"><b>🧾 ${cups()} แก้ว</b><span class="num">${baht(total())}</span></button>
      <button class="btn primary cart-pay" data-action="checkout">สั่งเลย ▶</button></div>` : ''}`;
}

function viewCheckout() {
  const s = ui.shop, slots = timeSlots();
  const asapOk = s.acceptingNow;
  if (!asapOk && ui.pickup.mode === 'asap') ui.pickup = { mode: 'later', at: slots[0] || '' };
  if (ui.pickup.mode === 'later' && !slots.includes(ui.pickup.at)) ui.pickup.at = slots[0] || '';
  if (!ui.pay) ui.pay = s.promptpay ? 'promptpay' : 'cash';
  return `<header class="shop-head"><button class="icon-btn" data-action="back" aria-label="กลับ">←</button><h1 class="grow">ยืนยันออเดอร์</h1></header>
    <section class="card"><h3>🧾 รายการ</h3>
      <ul class="cart-lines">${lines().map(l => `<li><span>${esc(l.m.emoji)} ${esc(l.name)}</span>
        <span class="qty"><button class="icon-btn" data-action="dec" data-id="${esc(l.id)}" data-s="${l.style}" aria-label="ลด">−</button><b>${l.qty}</b>
        <button class="icon-btn" data-action="inc" data-id="${esc(l.id)}" data-s="${l.style}" aria-label="เพิ่ม">+</button></span>
        <b class="num">${baht(l.price * l.qty)}</b></li>`).join('')}</ul>
      <div class="close-total"><span>รวม ${cups()} แก้ว</span><b class="num">${baht(total())}</b></div>
    </section>
    <section class="card"><h3>⏰ รับเมื่อไหร่</h3>
      <div class="seg">
        <button aria-selected="${ui.pickup.mode === 'asap'}" data-action="pickup" data-m="asap" ${asapOk ? '' : 'disabled'}>รับเลย (~${s.prep} นาที)</button>
        <button aria-selected="${ui.pickup.mode === 'later'}" data-action="pickup" data-m="later" ${slots.length ? '' : 'disabled'}>นัดเวลารับ</button></div>
      ${ui.pickup.mode === 'later' ? `<select class="time-pick" data-input="at" aria-label="เวลารับ" style="margin-top:10px">
        ${slots.map(t => `<option ${t === ui.pickup.at ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}
    </section>
    <section class="card"><h3>💳 จ่ายยังไง</h3>
      <div class="seg">
        ${s.promptpay ? `<button aria-selected="${ui.pay === 'promptpay'}" data-action="pay" data-m="promptpay">📲 โอนพร้อมเพย์</button>` : ''}
        <button aria-selected="${ui.pay === 'cash'}" data-action="pay" data-m="cash">💵 เงินสดตอนรับ</button></div>
      <p class="small muted" style="margin:8px 0 0">${ui.pay === 'promptpay' ? 'สั่งแล้วจะมี QR ยอดพอดีให้สแกน' : 'จ่ายที่ร้านตอนมารับ'}</p>
    </section>
    <section class="card"><h3>📝 หมายเหตุถึงร้าน</h3>
      <input class="time-pick" maxlength="120" placeholder="เช่น หวานน้อย ไม่ใส่น้ำแข็ง" value="${esc(ui.note)}" data-input="note"></section>
    ${ui.error ? `<p class="err center" style="margin-top:12px">${esc(ui.error)}</p>` : ''}
    <div style="margin-top:16px"><button class="btn primary big" data-action="place" ${ui.busy || !ui.cart.length ? 'disabled' : ''}>
      ${ui.busy ? 'กำลังส่งออเดอร์…' : `✅ ยืนยันสั่ง · ${baht(total())}`}</button></div>`;
}

function viewOrder() {
  const o = ui.order;
  if (!o) return '<div class="center pad"><div class="spinner" style="margin:40px auto"></div></div>';
  const step = { new: 0, accepted: 1, ready: 2, done: 3 }[o.status] ?? -1;
  const payBox = o.payMethod === 'promptpay' && !o.paid && o.status !== 'cancelled';
  return `<header class="shop-head"><button class="icon-btn" data-action="home" aria-label="เมนู">←</button><h1 class="grow">ออเดอร์ของฉัน</h1>
      <button class="icon-btn" data-action="refresh" aria-label="รีเฟรช">↻</button></header>
    <section class="card">
      <div class="queue-no"><small>คิวของคุณ</small><b>${esc(o.no)}</b></div>
      ${o.status !== 'cancelled' ? `<ol class="steps">${['รับออเดอร์', 'กำลังทำ', 'พร้อมรับ', 'รับแล้ว'].map((l, i) => `<li class="${i <= step ? 'on' : ''}">${l}</li>`).join('')}</ol>` : ''}
      <p class="status-line ${o.status}">${STATUS[o.status] || esc(o.status)}</p>
      <p class="small muted center" style="margin:4px 0 0">${o.pickup?.mode === 'later' ? `นัดรับ ${esc(o.pickup.at)} น.` : `รับได้ประมาณ ${esc(o.pickup?.at || '')} น.`}</p>
    </section>
    ${payBox ? `<section class="card"><h3>📲 โอนพร้อมเพย์ ${baht(o.total)}</h3>
      ${o.payClaimed ? '<p class="g-note">✅ แจ้งโอนแล้ว ร้านกำลังตรวจยอด</p>' : `<div class="pp-qr" id="qr"><div class="spinner"></div></div>
      <p class="small muted center">แคปหน้าจอแล้วสแกนในแอปธนาคาร ยอดขึ้นเอง</p>
      <div class="btn-col"><button class="btn primary big" data-action="claim">โอนแล้ว แจ้งร้าน</button>
      <button class="btn ghost" data-action="to-cash">เปลี่ยนเป็นจ่ายเงินสดตอนรับ</button></div>`}</section>` : ''}
    <section class="card"><h3>🧾 รายการ</h3>
      <ul class="cart-lines">${o.items.map(i => `<li><span>${esc(i.name)}</span><span>×${i.qty}</span><b class="num">${baht(i.price * i.qty)}</b></li>`).join('')}</ul>
      <div class="close-total"><span>${o.paid ? 'ชำระแล้ว ✅' : o.payMethod === 'cash' ? 'จ่ายเงินสดตอนรับ' : 'ยอดรวม'}</span><b class="num">${baht(o.total)}</b></div>
    </section>
    <div class="btn-col" style="margin-top:16px">
      ${o.status === 'new' && !o.payClaimed ? '<button class="btn danger" data-action="cancel">ยกเลิกออเดอร์</button>' : ''}
      <button class="btn ghost" data-action="home">🥤 สั่งเพิ่ม</button>
      ${window.liff?.isInClient?.() ? '<button class="btn ghost" data-action="close">กลับไปที่แชท</button>' : ''}</div>`;
}

function viewOrders() {
  return `<header class="shop-head"><button class="icon-btn" data-action="home" aria-label="เมนู">←</button><h1 class="grow">ออเดอร์วันนี้</h1></header>
    ${ui.orders.length ? `<ul class="order-list">${ui.orders.map(o => `<li><button data-action="open-order" data-id="${esc(o.id)}">
      <span><b>${esc(o.no)}</b> · ${esc(STATUS[o.status] || o.status)}<br><small class="muted">${esc(o.items.map(i => i.name + (i.qty > 1 ? '×' + i.qty : '')).join(', '))}</small></span>
      <b class="num">${baht(o.total)}</b></button></li>`).join('')}</ul>` : '<p class="muted center pad">วันนี้ยังไม่มีออเดอร์</p>'}`;
}

function viewError() {
  return `<div class="center pad"><p style="font-size:3rem;margin:30px 0 0">😵</p><p>${esc(ui.error)}</p>
    <button class="btn primary" data-action="reload">ลองใหม่</button></div>`;
}

function render() {
  $('#app').innerHTML = ui.view === 'menu' ? viewMenu() : ui.view === 'checkout' ? viewCheckout() : ui.view === 'order' ? viewOrder()
    : ui.view === 'orders' ? viewOrders() : ui.view === 'error' ? viewError() : '<div class="center pad"><div class="spinner" style="margin:40px auto"></div></div>';
  const qr = $('#qr');
  if (qr && ui.order?.promptpay) PP.qrDataUrl(ui.order.promptpay, ui.order.total, 300)
    .then(url => { qr.innerHTML = `<img src="${url}" alt="QR พร้อมเพย์ ${baht(ui.order.total)}" width="240" height="240"><small>${esc(ui.shop?.name || '')} · <b>${baht(ui.order.total)}</b></small>`; })
    .catch(e => { qr.innerHTML = `<p class="err">${esc(e.message)}</p>`; });
}
function go(view) { ui.view = view; ui.error = ''; window.scrollTo(0, 0); render(); }

// ---------- order tracking ----------
let poll = null;
async function openOrder(id) {
  ui.order = ui.order?.id === id ? ui.order : null;
  go('order');
  history.replaceState(null, '', `?order=${encodeURIComponent(id)}`);
  await refreshOrder(id);
  clearInterval(poll);
  poll = setInterval(() => { if (document.visibilityState === 'visible' && ui.view === 'order' && ['new', 'accepted', 'ready'].includes(ui.order?.status)) refreshOrder(id); }, 10000);
}
async function refreshOrder(id) {
  try {
    const prev = ui.order?.status;
    ui.order = await api(`/orders/${encodeURIComponent(id)}`);
    if (ui.view === 'order') render();
    if (prev && prev !== ui.order.status && ui.order.status === 'ready' && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } catch (e) { toast(e.message); }
}

function openStylePicker(m) {
  $('#sheet').innerHTML = `<div class="sheet-body"><div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>${esc(m.emoji)} ${esc(m.name)}</h2><button class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    <div class="style-pick">${stylesOf(m).map(k => `<button class="style-btn" data-action="style-add" data-id="${esc(m.id)}" data-s="${k}">
      <span class="m-emoji">${STYLES[k].emoji}</span><span>${STYLES[k].word}</span><b class="num">${baht(m.prices[k])}</b></button>`).join('')}</div></div>`;
  $('#sheet').showModal();
}

async function placeOrder() {
  ui.busy = true; ui.error = ''; render();
  try {
    const o = await api('/orders', { method: 'POST', body: {
      items: ui.cart.map(({ id, style, qty }) => ({ id, style, qty })), pickup: ui.pickup, payMethod: ui.pay, note: ui.note } });
    ui.cart = []; ui.note = '';
    try { sessionStorage.removeItem('kaa_cart'); } catch {}
    // a message from the customer lets the shop's bot answer with a free reply (push messages count against the quota)
    try { if (liff.isInClient() && liff.getContext()?.type === 'utou') await liff.sendMessages([{ type: 'text', text: `🧾 ออเดอร์ ${o.no}` }]); } catch {}
    ui.order = o;
    ui.busy = false;
    openOrder(o.id);
  } catch (e) {
    ui.busy = false; ui.error = e.message; render();
    if (/เมนู/.test(e.message)) loadMenu();
  }
}

async function loadMenu() {
  const data = await api('/menu');
  ui.shop = data.shop; ui.menu = data.menu;
  ui.cart = ui.cart.filter(l => item(l.id));
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'tab': ui.tab = el.dataset.t; return render();
    case 'add': {
      const m = item(id); if (!m) return;
      const st = stylesOf(m);
      if (st.length > 1) return openStylePicker(m);
      cartAdd(id, 1, st[0] || ''); if (navigator.vibrate) navigator.vibrate(10); return render();
    }
    case 'style-add': cartAdd(id, 1, el.dataset.s); $('#sheet').close(); return render();
    case 'close-sheet': return $('#sheet').close();
    case 'undo': { const l = [...ui.cart].reverse().find(x => x.id === id); if (l) cartAdd(id, -1, l.style); return render(); }
    case 'inc': cartAdd(id, 1, el.dataset.s); return render();
    case 'dec': cartAdd(id, -1, el.dataset.s); if (!ui.cart.length) return go('menu'); return render();
    case 'checkout': return go('checkout');
    case 'back': case 'home': clearInterval(poll); history.replaceState(null, '', location.pathname);
      try { await loadMenu(); } catch {} return go('menu');
    case 'pickup': ui.pickup = { mode: el.dataset.m, at: ui.pickup.at }; return render();
    case 'pay': ui.pay = el.dataset.m; return render();
    case 'place': return placeOrder();
    case 'my-orders': go('orders'); try { ui.orders = await api('/orders'); } catch (err) { toast(err.message); } return render();
    case 'open-order': return openOrder(id);
    case 'refresh': return refreshOrder(ui.order.id);
    case 'claim':
      try { await api(`/orders/${ui.order.id}/claim`, { method: 'POST' }); toast('แจ้งร้านแล้ว 💙'); } catch (err) { toast(err.message); }
      return refreshOrder(ui.order.id);
    case 'to-cash':
      try { await api(`/orders/${ui.order.id}/cash`, { method: 'POST' }); } catch (err) { toast(err.message); }
      return refreshOrder(ui.order.id);
    case 'cancel':
      if (!confirm(`ยกเลิกคิว ${ui.order.no}?`)) return;
      try { await api(`/orders/${ui.order.id}/cancel`, { method: 'POST' }); toast('ยกเลิกแล้ว'); } catch (err) { toast(err.message); }
      return refreshOrder(ui.order.id);
    case 'close': return liff.closeWindow();
    case 'reload': return location.reload();
  }
});
document.addEventListener('change', e => { if (e.target.dataset.input === 'at') ui.pickup.at = e.target.value; });
document.addEventListener('input', e => { if (e.target.dataset.input === 'note') ui.note = e.target.value; });
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') e.target.close(); });

// ---------- boot ----------
async function boot() {
  try {
    if (!LIFF_ID || !API_BASE) throw new Error('ร้านยังตั้งค่าระบบสั่งไม่เสร็จ (liff/config.js)');
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) return liff.login({ redirectUri: location.href });
    try { ui.cart = JSON.parse(sessionStorage.getItem('kaa_cart') || '[]'); } catch {}
    await loadMenu();
    api('/me').then(me => { ui.me = me; if (ui.view === 'menu') render(); }).catch(() => {});
    // ?order=<id> from a chat button; liff.state carries it when opened via liff.line.me
    const params = new URLSearchParams(location.search);
    const inner = params.get('liff.state') ? new URLSearchParams(params.get('liff.state').replace(/^[^?]*\?/, '')) : null;
    const orderId = params.get('order') || inner?.get('order');
    if (orderId) return openOrder(orderId);
    go('menu');
  } catch (e) { ui.error = e.message; go('error'); }
}
boot();
