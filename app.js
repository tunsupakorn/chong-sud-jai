import * as S from './store.js';
import { readFile, testKey, DEFAULT_MODEL, setModelChangeHandler, setFallbackHandler, setStatusHandler, cancelAll, resetCancel } from './gemini.js';
import { categoryBars, dailyColumns, bindColumnTips } from './charts.js';
import * as Sheet from './sheets.js';
import { readSlipQR } from './qr.js';
import * as PP from './promptpay.js';

const { state, prefs } = S;
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
const baht = n => '฿' + nf.format(Math.round((n || 0) * 100) / 100);
const todayISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const monthLabel = ym => new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric' }).format(parseISO(ym + '-01'));
const dayLabel = iso => new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short' }).format(parseISO(iso));
const shortDay = iso => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short' }).format(parseISO(iso));
const METHODS = { cash: '💵 เงินสด', promptpay: '📲 พร้อมเพย์', scan: '📷 สแกนจ่าย', transfer: '🏦 โอน', card: '💳 บัตร' };

const ui = {
  view: 'home',
  month: todayISO().slice(0, 7),
  statsType: 'expense',
  search: '',
  scan: { busy: false, done: 0, total: 0, items: [], errors: [], skipped: [], only30: true },
  cart: [], sellTab: 'all', showBills: false, pay: null, bill: null,
  tray: [],        // picked files waiting to be read: { file, url }
  slipNote: '',
  authMode: 'signin',
  authBusy: false,
  authError: '',
  obStep: 0,
};

const cats = () => state.settings.categories || S.DEFAULT_CATEGORIES;
// Gemini key: this device first, else the one synced with your account (enter once, every device gets it)
const geminiKey = () => prefs.geminiKey || state.settings.geminiKey || '';
const TRANSFER_CAT ={ id: 'transfer', name: 'ย้ายเงิน', emoji: '🔄', type: 'transfer' };
const catById = id => id === 'transfer' ? TRANSFER_CAT : cats().find(c => c.id === id) || { id, name: 'ไม่ระบุ', emoji: '❔', type: 'expense' };
const SIGN = { expense: '−', income: '+', transfer: '↔ ' };
const EMOJIS = ['🥤', '🧋', '🍓', '🥭', '🍌', '🍍', '🍉', '🥥', '🍋', '🥛', '🍵', '☕', '🍫', '🍯', '🧊', '🥡', '🥄', '🧃', '🛒', '🏪', '🏠', '⚡', '🚰', '📱', '👥', '🔧', '🧽', '📣', '🧾', '🛠️', '🎨', '🔑', '🏗️', '🛵', '💰', '💵', '📈', '🏦', '💳', '🧺', '📦', '🎁', '🚚', '🧹', '🪑', '🖨️'];
// owner names for spotting transfers between your own accounts: what you typed + your account name
const ownerNames = () => [...String(state.settings.ownerNames || '').split(/[,\n]/), state.user?.name || '']
  .map(s => s.trim()).filter(s => s.length > 1);
const monthTx = () => state.tx.filter(t => t.date?.startsWith(ui.month));
const sum = (list, type) => list.filter(t => t.type === type).reduce((s, t) => s + Number(t.amount || 0), 0);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

function applyTheme() {
  const t = prefs.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------- shared pieces ----------
const SYNC = {
  local: ['ในเครื่องนี้', 'local'], 'signed-out': ['ยังไม่ล็อกอิน', 'warn'], pending: ['กำลังซิงก์…', 'pending'],
  synced: ['ซิงก์แล้ว', 'ok'], error: ['ซิงก์ผิดพลาด', 'bad'],
};
function header(title, back) {
  const [label, cls] = SYNC[state.syncStatus] || SYNC.local;
  return `<header class="top">
    <div class="brand">${back ? `<button class="icon-btn back-btn" data-action="back" data-to="${back}" aria-label="ย้อนกลับ">‹</button>` : ''}<img src="icons/icon.svg" alt="" width="40" height="40"><div><h1>${title || 'ชงสุดใจ'}</h1><small>บัญชีร้าน</small></div></div>
    <button class="sync ${cls}" data-nav="settings" title="สถานะการซิงก์"><i></i>${label}</button>
  </header>`;
}
function monthSwitch() {
  return `<div class="month">
    <button class="icon-btn" data-action="month" data-d="-1" aria-label="เดือนก่อน">‹</button>
    <strong>${monthLabel(ui.month)}</strong>
    <button class="icon-btn" data-action="month" data-d="1" aria-label="เดือนถัดไป">›</button>
  </div>`;
}
function txRow(t) {
  const c = catById(t.cat);
  const sub = [t.merchant, t.note].filter(Boolean).join(' · ');
  return `<li><button class="tx" data-action="edit" data-id="${esc(t.id)}">
    <span class="bubble" aria-hidden="true">${c.emoji}</span>
    <span class="tx-main"><b>${esc(c.name)}</b><small>${esc(sub || METHODS[t.method] || '')}</small></span>
    <span class="tx-amt num ${t.type}">${t.slipUrl || t.hasSlip ? '<i class="clip" title="มีสลิป">📎</i>' : ''}${SIGN[t.type] || ''}${baht(t.amount)}</span>
  </button></li>`;
}

// ---------- views ----------
// ---------- shop money helpers ----------
const amt = t => Number(t.amount || 0);
function money(list) {
  const r = { sales: 0, otherInc: 0, cogs: 0, opex: 0, invest: 0, cups: 0 };
  for (const t of list) {
    if (t.type === 'income') { if (t.cat === 'inc_other') r.otherInc += amt(t); else r.sales += amt(t); r.cups += Number(t.cups || 0); }
    else if (t.type === 'expense') r[S.catGroup(catById(t.cat))] += amt(t);
  }
  r.income = r.sales + r.otherInc;
  r.gross = r.sales - r.cogs;
  r.net = r.income - r.cogs - r.opex;
  r.cogsPct = r.sales ? r.cogs / r.sales : 0;
  r.grossPct = r.sales ? r.gross / r.sales : 0;
  return r;
}
const pct = x => `${Math.round(x * 100)}%`;
const signed = n => `${n < 0 ? '−' : ''}${baht(Math.abs(n))}`;
const CHANNELS = [['cash', '💵 เงินสด'], ['promptpay', '📲 พร้อมเพย์'], ['scan', '📷 สแกนจ่าย']];

function viewOnboarding() {
  const steps = [
    { e: '🥤', h: 'สวัสดี! นี่คือ ชงสุดใจ', p: 'ผู้ช่วยทำบัญชีร้านน้ำปั่น แยกจากเงินส่วนตัว รู้กำไรจริงทุกวัน' },
    { e: '📒', h: 'ปิดยอดวันละครั้ง', p: 'จบวันกรอกยอดขาย เงินสด · พร้อมเพย์ · สแกนจ่าย แค่ 3 ช่อง ไม่ต้องจดทีละแก้ว' },
    { e: '🧾', h: 'ส่งสลิป ใบเสร็จ มาให้อ่าน', p: 'ซื้อวัตถุดิบ ค่าเช่า ค่าไฟ อ่านสลิปและใบเสร็จได้ทุกธนาคาร จัดหมวดต้นทุน/ค่าใช้จ่าย/ลงทุนให้เอง' },
    { e: '📊', h: 'รู้กำไรและคืนทุน', p: 'กำไรขั้นต้น กำไรสุทธิ ต้นทุนต่อแก้ว วันขายดี และอีกกี่เดือนคืนทุน' },
  ];
  const s = steps[ui.obStep];
  const last = ui.obStep === steps.length - 1;
  return `<section class="onboard">
    <button class="link skip" data-action="ob-done">ข้าม</button>
    <div class="ob-art"><img src="icons/icon.svg" alt="" class="ob-chick"><span class="ob-emoji">${s.e}</span></div>
    <h2>${s.h}</h2><p>${s.p}</p>
    <div class="dots">${steps.map((_, i) => `<i class="${i === ui.obStep ? 'on' : ''}"></i>`).join('')}</div>
    ${last
      ? `<button class="btn primary big" data-action="ob-done">เริ่มทำบัญชีร้าน</button>
         <a class="link" href="guide.html">📖 อ่านวิธีใช้งานทั้งหมด</a>`
      : `<button class="btn primary big" data-action="ob-next">ถัดไป</button>`}
  </section>`;
}

// ---------- เป้าคืนทุน ----------
function paybackInfo() {
  const all = money(state.tx);
  const monthsActive = new Set(state.tx.filter(t => t.type === 'income').map(t => t.date.slice(0, 7))).size;
  const avgNet = monthsActive ? all.net / monthsActive : 0;
  const remain = Math.max(0, all.invest - all.net);
  const p = all.invest > 0 ? Math.max(0, Math.min(1, all.net / all.invest)) : 0;
  const goal = Number(state.settings.paybackGoal) || 12; // months
  const perMonth = all.invest / goal;
  return { all, avgNet, remain, p, goal, perMonth, monthsLeft: avgNet > 0 ? Math.ceil(remain / avgNet) : null };
}
const cheer = p => p >= 1 ? '🎉 คืนทุนแล้ว! จากนี้คือกำไรล้วน'
  : p >= 0.75 ? '🚀 อีกนิดเดียว ใกล้คืนทุนแล้ว' : p >= 0.5 ? '🔥 มาได้ครึ่งทางแล้ว สู้ต่อ!'
  : p >= 0.25 ? '💪 มาได้ 1 ใน 4 แล้ว ไปต่อ!' : p > 0 ? '🌱 เริ่มเก็บกำไรแล้ว ทุกแก้วคือก้าวต่อไป' : '☀️ เริ่มขายแก้วแรก แล้วดูหลอดนี้ขยับ';
function goalCard() {
  const g = paybackInfo();
  if (!g.all.invest) return `<section class="card goal empty-goal"><h3>🏁 เป้าคืนทุน</h3>
    <p class="small">ใส่ <b>เงินลงทุนเปิดร้าน</b> (เครื่องปั่น ตู้แช่ ตกแต่ง ป้าย มัดจำ) แล้วดูว่ากำไรแต่ละวันพาคืนทุนไปได้แค่ไหน</p>
    <button class="btn primary" data-action="rec-new" data-g="invest">🛠️ ใส่เงินลงทุนเปิดร้าน</button></section>`;
  const thisMonth = money(monthTx()).net;
  return `<section class="card goal">
    <div class="row between"><h3>🏁 เป้าคืนทุน</h3><b class="goal-pct num">${g.p > 0 && g.p < 0.1 ? (Math.floor(g.p * 1000) / 10).toFixed(1) : Math.floor(g.p * 100)}%</b></div>
    <div class="meter goal-meter" role="progressbar" aria-valuenow="${Math.floor(g.p * 100)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${Math.max(g.p > 0 ? 2 : 0, g.p * 100)}%"></div>
      ${[25, 50, 75].map(x => `<i style="left:${x}%" class="${g.p * 100 >= x ? 'on' : ''}"></i>`).join('')}</div>
    <p class="goal-cheer">${cheer(g.p)}</p>
    <div class="today-grid goal-grid">
      <div><small>ลงทุนทั้งหมด</small><b class="num">${baht(g.all.invest)}</b></div>
      <div><small>กำไรสะสม</small><b class="num ${g.all.net < 0 ? 'neg' : ''}">${signed(g.all.net)}</b></div>
      <div><small>เหลืออีก</small><b class="num">${baht(g.remain)}</b></div>
    </div>
    ${g.p < 1 ? `<p class="small goal-plan">เป้า: คืนทุนใน <select data-input="pbgoal" aria-label="เป้ากี่เดือน">${[6, 9, 12, 18, 24, 36].map(n => `<option value="${n}" ${n === g.goal ? 'selected' : ''}>${n} เดือน</option>`).join('')}</select>
      → ต้องกำไรเฉลี่ย <b class="num">${baht(Math.ceil(g.perMonth))}</b>/เดือน (≈ <b class="num">${baht(Math.ceil(g.perMonth / 30))}</b>/วัน)
      · เดือนนี้ได้ <b class="num ${thisMonth < 0 ? 'neg' : ''}">${signed(thisMonth)}</b>
      ${g.monthsLeft ? ` · ตามกำไรตอนนี้ คืนทุนในอีกประมาณ <b>${g.monthsLeft} เดือน</b>` : ''}</p>` : ''}
    <button class="link small" data-action="rec-new" data-g="invest">＋ เพิ่มเงินลงทุน</button>
  </section>`;
}

function viewHome() {
  const list = monthTx();
  const m = money(list);
  const today = todayISO();
  const todayTx = state.tx.filter(t => t.date === today);
  const t = money(todayTx);
  const drawer = (state.settings.drawers || {})[today];
  const closed = todayTx.some(x => x.source === 'close') || !!drawer;
  const byCh = Object.fromEntries(CHANNELS.map(([k]) => [k, todayTx.filter(x => x.type === 'income' && x.method === k).reduce((s, x) => s + amt(x), 0)]));
  const q = ui.search.trim().toLowerCase();
  const shown = list.filter(x => !q || [catById(x.cat).name, x.merchant, x.note, String(x.amount)].join(' ').toLowerCase().includes(q))
    .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')) || (b.createdAt || 0) - (a.createdAt || 0));
  const groups = {};
  shown.forEach(x => (groups[x.date] ||= []).push(x));
  const banner = state.mode === 'cloud' && state.localPendingCount > 0 ? `<section class="card notice">
      <p>📦 มี <b>${state.localPendingCount}</b> รายการที่จดไว้ในเครื่องนี้ก่อนล็อกอิน</p>
      <div class="row gap"><button class="btn primary sm" data-action="upload-local">อัปขึ้นบัญชี</button>
      <button class="btn ghost sm" data-action="discard-local">ไม่ต้อง</button></div></section>` : '';
  return `${header()}${monthSwitch()}
    <section class="hero">
      <span class="hero-label">กำไรสุทธิ${ui.month === today.slice(0, 7) ? 'เดือนนี้' : ''}</span>
      <div class="hero-num num">${signed(m.net)}</div>
      <div class="hero-split">
        <div><small>ยอดขาย</small><b class="num">${baht(m.sales)}</b></div>
        <div><small>ต้นทุน + ค่าใช้จ่าย</small><b class="num">${baht(m.cogs + m.opex)}</b></div>
      </div>
      <img src="icons/icon.svg" alt="" class="hero-chick">
    </section>
    ${banner}
    <section class="card today">
      <div class="row between"><h3>วันนี้ · ${shortDay(today)}</h3>${closed ? `<span class="ok-pill">✅ ปิดยอดแล้ว${drawer?.diff ? (drawer.diff < 0 ? ` · ขาด ${baht(-drawer.diff)}` : ` · เกิน ${baht(drawer.diff)}`) : ''}</span>` : ''}</div>
      <div class="today-grid">${CHANNELS.map(([k, l]) => `<div><small>${l}</small><b class="num">${baht(byCh[k])}</b></div>`).join('')}</div>
      <p class="small muted today-foot">ยอดขายวันนี้ <b class="num">${baht(t.sales)}</b>${t.cups ? ` · ${t.cups} แก้ว` : ''} · จ่ายวันนี้ <b class="num">${baht(t.cogs + t.opex + t.invest)}</b></p>
      <button class="btn primary big" data-action="close-open" data-date="${today}">📒 ${closed ? 'แก้ไขยอดปิดวันนี้' : 'ปิดยอดวันนี้'}</button>
    </section>
    ${goalCard()}
    ${list.length ? `<label class="search"><span aria-hidden="true">🔍</span><input type="search" placeholder="ค้นหารายการ" value="${esc(ui.search)}" data-input="search"></label>` : ''}
    ${Object.keys(groups).length ? Object.entries(groups).map(([d, items]) => {
      const dm = money(items);
      const out = dm.cogs + dm.opex + dm.invest;
      return `<section class="day">
        <div class="day-head"><span>${dayLabel(d)}</span><span class="num">${dm.sales ? `<span class="pos">+${baht(dm.sales)}</span> ` : ''}${out ? `−${baht(out)}` : ''}</span></div>
        <ul class="txs">${items.map(txRow).join('')}</ul>
      </section>`;
    }).join('')
    : `<section class="empty">
        <img src="icons/icon.svg" alt="" width="96" height="96">
        <h3>${q ? 'ไม่พบรายการที่ค้นหา' : 'ยังไม่มีรายการเดือนนี้'}</h3>
        ${q ? '' : `<p>เริ่มจาก <b>จดค่าลงทุนร้าน</b> (เครื่องปั่น ตกแต่ง มัดจำ) ด้วย <b>✏️ จดเอง</b> หรือส่งสลิปให้ <b>🧾 อ่านสลิป</b></p>`}
      </section>`}`;
}

// ---------- รายงานจากหน้าขาย: เมนูขายดี กำไรต่อเมนู ช่วงเวลา ยอดต่อบิล ----------
// which sweetness customers choose (counter and LINE), and how many cups have the ice on the side
function sweetReport(list) {
  const items = list.filter(t => t.source === 'pos').flatMap(t => t.items || []).filter(i => i.sweet !== undefined);
  const n = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  if (!n) return '';
  const by = [100, 50, 25, 0].map(v => ({ v, q: items.filter(i => i.sweet === v).reduce((s, i) => s + (Number(i.qty) || 0), 0) }));
  const ice = items.filter(i => i.iceSep).reduce((s, i) => s + (Number(i.qty) || 0), 0);
  return `<section class="card"><h3>🍯 ความหวานยอดนิยม</h3>
    <ul class="sweet-bars">${by.map(r => `<li><span>${r.v}%</span><i style="width:${Math.round(r.q / n * 100)}%"></i><b class="num">${pct(r.q / n)}</b></li>`).join('')}</ul>
    <p class="small muted">จาก ${nf.format(n)} แก้วที่เลือกความหวาน${ice ? ` · 🧊 แยกน้ำแข็ง ${pct(ice / n)}` : ''}</p></section>`;
}

function posReport(list) {
  const bills = list.filter(t => t.source === 'pos');
  if (!bills.length) return `<section class="card"><h3>🛒 รายงานจากหน้าขาย</h3>
    <p class="muted small">ยังไม่มีบิลจากหน้าขายในเดือนนี้ · เมื่อขายผ่าน 🛒 ขาย จะเห็นเมนูขายดี กำไรต่อเมนู และช่วงเวลาขายดีที่นี่</p></section>`;
  const sales = bills.reduce((s, t) => s + amt(t), 0);
  const days = new Set(bills.map(t => t.date)).size;
  const cups = bills.reduce((s, t) => s + (Number(t.cups) || 0), 0);
  // items: grouped by menu + style (e.g. ชาไทย เย็น)
  const byItem = {};
  for (const t of bills) for (const i of t.items || []) {
    const key = `${i.id}|${i.style || ''}`;
    const m = menuItem(i.id);
    const r = byItem[key] ||= { name: i.name, emoji: m?.emoji || '🥤', topping: m?.group === 'topping', unit: m?.group === 'topping' ? 'ที่' : m?.group === 'snack' ? 'ชิ้น' : 'แก้ว', qty: 0, sales: 0, cost: 0 };
    r.qty += Number(i.qty) || 0;
    r.sales += (Number(i.price) || 0) * (Number(i.qty) || 0);
    r.cost += (Number(i.cost) || 0) * (Number(i.qty) || 0);
  }
  const by = ui.topBy || 'qty';
  const rows = Object.values(byItem).map(r => ({ ...r, profit: r.sales - r.cost, margin: r.sales ? (r.sales - r.cost) / r.sales : 0 }))
    .sort((a, b) => b[by] - a[by] || b.sales - a.sales);
  const max = Math.max(1, ...rows.map(r => Math.max(0, r[by])));
  const noCost = rows.some(r => !r.cost);
  const fmt = (v, r) => by === 'qty' ? `${nf.format(v)} ${r.unit}` : baht(v);
  // hours: total sales per hour over the month
  const hours = Array(24).fill(0), hourBills = Array(24).fill(0);
  bills.forEach(t => { const h = Number(String(t.time || '').slice(0, 2)); if (h >= 0 && h < 24 && t.time) { hours[h] += amt(t); hourBills[h]++; } });
  const used = hours.map((v, h) => v ? h : -1).filter(h => h >= 0);
  const from = used.length ? Math.min(...used) : 0, to = used.length ? Math.max(...used) : 0;
  const hv = hours.slice(from, to + 1);
  const hl = hv.map((_, i) => `${String(from + i).padStart(2, '0')}:00–${String(from + i + 1).padStart(2, '0')}:00 · ${hourBills[from + i]} บิล`);
  const peak = used.length ? used.reduce((a, h) => hours[h] > hours[a] ? h : a, used[0]) : null;
  const xt = hv.map((_, i) => i).filter(i => hv.length <= 8 || i % 2 === 0).map(i => ({ i, label: String(from + i) }));
  return `<section class="card"><h3>🛒 รายงานจากหน้าขาย</h3>
      <section class="stat-tiles">
        <div class="tile"><small>บิล</small><b class="num">${nf.format(bills.length)}</b><small>${days ? `เฉลี่ย ${nf.format(Math.round(bills.length / days))}/วัน` : ''}</small></div>
        <div class="tile"><small>ยอดเฉลี่ยต่อบิล</small><b class="num">${baht(Math.round(sales / bills.length))}</b></div>
        <div class="tile"><small>แก้วต่อบิล</small><b class="num">${(cups / bills.length).toFixed(1)}</b></div>
      </section>
    </section>
    <section class="card"><div class="row between"><h3>🏆 เมนูขายดี</h3></div>
      <div class="seg">${[['qty', 'จำนวนแก้ว'], ['sales', 'ยอดขาย'], ['profit', 'กำไร']].map(([k, l]) =>
        `<button aria-selected="${by === k}" data-action="top-by" data-k="${k}">${l}</button>`).join('')}</div>
      <ol class="topmenu">${rows.slice(0, ui.topAll ? rows.length : 10).map((r, i) => `<li>
        <div class="tm-head"><span class="tm-rank num">${i + 1}</span><span aria-hidden="true">${r.emoji}</span><span class="tm-name">${esc(r.name)}</span>
          <b class="num">${fmt(r[by], r)}</b></div>
        <div class="cb-track"><div class="cb-fill" style="width:${Math.max(2, Math.max(0, r[by]) / max * 100)}%"></div></div>
        <small class="muted">${nf.format(r.qty)} ${r.unit} · ขาย ${baht(r.sales)} · ต้นทุน ${r.cost ? baht(r.cost) : '—'} · กำไร <b class="${r.profit < 0 ? 'neg' : ''}">${baht(r.profit)}</b>${r.cost ? ` (${pct(r.margin)})` : ''}</small>
      </li>`).join('')}</ol>
      ${rows.length > 10 ? `<button class="link small" data-action="top-all">${ui.topAll ? 'ย่อ' : `ดูทั้งหมด ${rows.length} รายการ`}</button>` : ''}
      ${noCost ? `<p class="small muted">💡 บางเมนูยังไม่ได้ใส่ต้นทุน/แก้ว กำไรจะดูสูงเกินจริง · ใส่ได้ที่ ⚙️ ตั้งค่า › 🧋 เมนูร้าน (มีผลกับบิลถัดไป)</p>` : ''}
    </section>
    ${used.length ? `<section class="card"><h3>⏰ ช่วงเวลาขายดี <small class="muted">(รวมทั้งเดือน)</small></h3>
      ${dailyColumns(hv, hl, baht, 'income', xt)}
      <p class="small muted">ขายดีสุดช่วง <b>${String(peak).padStart(2, '0')}:00–${String(peak + 1).padStart(2, '0')}:00</b> · ${baht(hours[peak])} จาก ${hourBills[peak]} บิล</p>
    </section>` : ''}`;
}

function viewStats() {
  const list = monthTx();
  const m = money(list);
  const [y, mo] = ui.month.split('-').map(Number);
  const days = new Date(y, mo, 0).getDate();
  const salesTx = list.filter(t => t.type === 'income' && t.cat !== 'inc_other');
  const values = Array(days).fill(0);
  salesTx.forEach(t => values[+t.date.slice(8, 10) - 1] += amt(t));
  const labels = values.map((_, i) => shortDay(`${ui.month}-${String(i + 1).padStart(2, '0')}`));
  const openDays = values.filter(v => v > 0).length;
  const ch = {};
  salesTx.forEach(t => ch[t.method || 'cash'] = (ch[t.method || 'cash'] || 0) + amt(t));
  const wd = Array.from({ length: 7 }, () => ({ total: 0, n: 0 }));
  values.forEach((v, i) => { if (v > 0) { const d = new Date(y, mo - 1, i + 1).getDay(); wd[d].total += v; wd[d].n++; } });
  const WD = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสฯ', 'ศุกร์', 'เสาร์'];
  const wdRows = [1, 2, 3, 4, 5, 6, 0].filter(d => wd[d].n).map(d => ({ emoji: '📅', name: WD[d], amount: wd[d].total / wd[d].n }))
    .sort((a, b) => b.amount - a.amount);
  const byCat = {};
  list.filter(t => t.type === 'expense' && S.catGroup(catById(t.cat)) !== 'invest').forEach(t => byCat[t.cat] = (byCat[t.cat] || 0) + amt(t));
  const catRows = Object.entries(byCat).map(([id, amount]) => ({ ...catById(id), amount })).sort((a, b) => b.amount - a.amount);
  const all = money(state.tx);
  const monthsActive = new Set(state.tx.filter(t => t.type === 'income').map(t => t.date.slice(0, 7))).size;
  const avgNet = monthsActive ? all.net / monthsActive : 0;
  const remain = Math.max(0, all.invest - all.net);
  const payback = all.invest <= 0 ? '' : remain <= 0 ? '🎉 คืนทุนแล้ว!'
    : avgNet > 0 ? `อีกประมาณ <b>${Math.ceil(remain / avgNet)} เดือน</b> (กำไรเฉลี่ย ${baht(avgNet)}/เดือน)` : 'ยังคำนวณไม่ได้ (ต้องเริ่มมีกำไรก่อน)';
  const cogsWarn = m.sales && m.cogsPct > 0.45 ? ' <span class="tag warn">สูงไป</span>' : '';
  return `${header('รายงานร้าน')}${monthSwitch()}
    <section class="stat-tiles">
      <div class="tile"><small>ยอดขาย</small><b class="num">${baht(m.sales)}</b></div>
      <div class="tile"><small>กำไรขั้นต้น</small><b class="num">${pct(m.grossPct)}</b></div>
      <div class="tile"><small>กำไรสุทธิ</small><b class="num ${m.net < 0 ? 'neg' : ''}">${signed(m.net)}</b></div>
    </section>
    <section class="card"><h3>📋 งบกำไรขาดทุน · ${monthLabel(ui.month)}</h3>
      <ul class="pl">
        <li><span>ยอดขาย</span><b class="num">${baht(m.sales)}</b></li>
        ${m.otherInc ? `<li><span>รายรับอื่นๆ</span><b class="num">${baht(m.otherInc)}</b></li>` : ''}
        <li class="minus"><span>ต้นทุนสินค้า <small>${pct(m.cogsPct)} ของยอดขาย · ปกติ 30–40%</small>${cogsWarn}</span><b class="num">−${baht(m.cogs)}</b></li>
        <li class="sub"><span>กำไรขั้นต้น</span><b class="num">${signed(m.gross)}</b></li>
        <li class="minus"><span>ค่าใช้จ่ายร้าน</span><b class="num">−${baht(m.opex)}</b></li>
        <li class="total"><span>กำไรสุทธิ</span><b class="num ${m.net < 0 ? 'neg' : 'pos'}">${signed(m.net)}</b></li>
        ${m.invest ? `<li class="note"><span>🛠️ เงินลงทุนเดือนนี้ (ไม่นับในกำไร)</span><b class="num">${baht(m.invest)}</b></li>` : ''}
      </ul>
      <p class="small muted">ขาย ${openDays} วัน · เฉลี่ย ${baht(openDays ? m.sales / openDays : 0)}/วันที่เปิด${m.cups ? ` · ${m.cups} แก้ว · ต้นทุนเฉลี่ย ${baht(m.cogs / m.cups)}/แก้ว · ขายเฉลี่ย ${baht(m.sales / m.cups)}/แก้ว` : ''}</p>
    </section>
    ${all.invest ? `<section class="card"><h3>🏁 คืนทุน</h3>
      <ul class="pl"><li><span>ลงทุนทั้งหมด</span><b class="num">${baht(all.invest)}</b></li>
      <li><span>กำไรสุทธิสะสม</span><b class="num ${all.net < 0 ? 'neg' : 'pos'}">${signed(all.net)}</b></li>
      <li class="total"><span>เหลือต้องคืนทุน</span><b class="num">${baht(remain)}</b></li></ul>
      <div class="meter"><div style="width:${Math.min(100, Math.max(0, all.net / all.invest * 100))}%"></div></div>
      <p class="small">${payback}</p></section>` : ''}
    <section class="card"><h3>ยอดขายรายวัน</h3>${dailyColumns(values, labels, baht, 'income')}</section>
    ${Object.keys(ch).length ? `<section class="card"><h3>ช่องทางรับเงิน</h3><ul class="methods">${Object.entries(ch).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<li><span>${METHODS[k] || k}</span><span class="num">${baht(v)} <small class="muted">${pct(m.sales ? v / m.sales : 0)}</small></span></li>`).join('')}</ul></section>` : ''}
    ${posReport(list)}
    ${sweetReport(list)}
    ${wdRows.length ? `<section class="card"><h3>วันขายดี <small class="muted">(เฉลี่ยต่อวัน)</small></h3>${categoryBars(wdRows, baht, 'income')}</section>` : ''}
    <section class="card"><h3>ต้นทุน + ค่าใช้จ่าย แยกหมวด</h3>${categoryBars(catRows, baht, 'expense')}</section>`;
}

function viewScan() {
  const sc = ui.scan;
  const hasKey = !!geminiKey();
  const selected = sc.items.filter(i => i.keep).length;
  const off = sc.busy || !hasKey ? 'disabled' : '';
  const tray = ui.tray;
  return `${header('อ่านสลิป', 'record')}
    ${!hasKey ? `<section class="card notice"><p>🔑 ต้องใส่ Gemini API key ก่อน (ฟรี) เพื่อให้จุกจิกอ่านสลิปได้</p>
      <button class="btn primary sm" data-action="goto-gemini">ไปใส่ key</button></section>` : ''}
    <section class="pick ${off}" data-drop>
      <label class="pick-main">
        <input type="file" accept="image/*" multiple data-input="pick" ${off}>
        <span class="pick-icon">🖼️</span>
        <span><b>เลือกรูปสลิป</b><small>เปิดแกลเลอรี แตะเลือกได้หลายรูป</small></span>
      </label>
      <div class="pick-row">
        <label class="pick-btn"><input type="file" accept="image/*" capture="environment" data-input="pick" ${off}>📸<span>ถ่ายรูป</span></label>
        <label class="pick-btn"><input type="file" accept="application/pdf,.pdf" multiple data-input="pick" ${off}>📄<span>ใบแจ้งยอด PDF</span></label>
        <button class="pick-btn" data-action="paste-img" ${off}>📋<span>วางรูป</span></button>
      </div>
      <small class="pick-hint">💡 ${/Android/.test(navigator.userAgent) ? 'แชร์รูปจากแกลเลอรี / LINE / แอปธนาคาร มาที่ “จุกจิก” ได้เลย (ติดตั้งแอปบนหน้าจอหลักก่อน)' : 'ลากรูปมาวาง หรือกด Ctrl+V เพื่อวางรูปได้เลย'}</small>
    </section>
    ${tray.length ? `<section class="tray">
      <div class="row between"><b>เลือกไว้ ${tray.length} ไฟล์</b><button class="link small" data-action="tray-clear">ล้าง</button></div>
      <div class="tray-grid">${tray.map((t, i) => `<figure>
        ${t.url ? `<img src="${t.url}" alt="">` : `<div class="tray-pdf">📄<small>${esc(t.file.name)}</small></div>`}
        <button class="tray-x" data-action="tray-remove" data-i="${i}" aria-label="เอาออก">×</button></figure>`).join('')}
        <label class="tray-add"><input type="file" accept="image/*" multiple data-input="pick">＋</label></div>
      <button class="btn primary big sticky" data-action="tray-read" ${off}>🐣 อ่าน ${tray.length} ${tray.length > 1 ? 'ไฟล์' : 'สลิป'}</button>
    </section>` : ''}
    ${ui.slipNote ? `<p class="muted small center" id="slip-note">${esc(ui.slipNote)}</p>` : ''}
    <label class="check"><input type="checkbox" data-input="only30" ${sc.only30 ? 'checked' : ''}> เลือกเฉพาะสลิป 30 วันล่าสุดให้อัตโนมัติ</label>
    ${sc.busy ? `<section class="card progress"><div class="spinner"></div><p>จุกจิกกำลังอ่าน… ${sc.done}/${sc.total}</p>
      <div class="meter"><div style="width:${sc.total ? sc.done / sc.total * 100 : 0}%"></div></div>
      <small class="muted" id="scan-note">${esc(scanNote())}</small>
      <button class="btn ghost sm" data-action="scan-cancel" ${sc.cancel ? 'disabled' : ''}>${sc.cancel ? 'กำลังยกเลิก…' : 'ยกเลิก'}</button></section>` : ''}
    ${sc.skipped.length ? `<section class="card notice"><p>⏭️ ข้าม <b>${sc.skipped.length}</b> สลิปที่เคยบันทึกแล้ว (ตรวจจาก QR บนสลิป ไม่ใช้โควตา Gemini)</p></section>` : ''}
    ${sc.errors.length ? `<section class="card error"><b>อ่านไม่สำเร็จ ${sc.errors.length} ไฟล์</b><ul>${sc.errors.map(e => `<li>${esc(e.name)}: ${esc(e.msg)}</li>`).join('')}</ul>
      ${!sc.busy && sc.errors.some(e => e.file) ? `<button class="btn primary sm" data-action="scan-retry">🔄 ลองอ่านไฟล์เหล่านี้อีกครั้ง</button>` : ''}</section>` : ''}
    ${sc.items.length ? `<section class="review">
      <div class="row between"><h3>ตรวจก่อนบันทึก (${sc.items.length})</h3>
        <button class="link" data-action="scan-clear">ล้าง</button></div>
      <ul>${sc.items.map((it, i) => reviewRow(it, i)).join('')}</ul>
      <button class="btn primary big sticky" data-action="scan-save" ${selected ? '' : 'disabled'}>บันทึก ${selected} รายการ</button>
    </section>` : ''}
    <section class="card tips"><h3>💡 เคล็ดลับ</h3><ul>
      <li>แอปธนาคารส่วนใหญ่บันทึกสลิปลงอัลบั้มให้อัตโนมัติ เปิดอัลบั้มนั้นแล้วเลือกหลายรูปได้เลย</li>
      <li>ใบแจ้งยอดบัตรเครดิตที่มีรหัส PDF ให้ปลดรหัสก่อน (เช่น เปิดแล้วสั่งพิมพ์เป็น PDF ใหม่)</li>
      <li>สลิปที่เคยบันทึกแล้วจะถูกทำเครื่องหมาย "ซ้ำ" และไม่ถูกเลือกให้</li>
    </ul><a class="link" href="guide.html#sec-slip">📖 ดูวิธีใช้แบบละเอียด</a></section>`;
}

function reviewRow(it, i) {
  const options = it.type === 'transfer' ? `<option value="transfer">🔄 ย้ายเงิน (ไม่นับรายรับ/รายจ่าย)</option>`
    : cats().filter(c => c.type === it.type).map(c => `<option value="${c.id}" ${c.id === it.cat ? 'selected' : ''}>${c.emoji} ${esc(c.name)}</option>`).join('');
  return `<li class="rv ${it.keep ? '' : 'off'}">
    <label class="rv-check"><input type="checkbox" data-rv="keep" data-i="${i}" ${it.keep ? 'checked' : ''} aria-label="เลือกรายการ"></label>
    <div class="rv-body">
      <div class="row between"><b>${esc(it.merchant || it.fileName)}</b>
<span class="row gap">${it.qrRef ? '<span class="tag ok" title="เลขอ้างอิงยืนยันจาก QR บนสลิป">✓ QR</span>' : ''}
        ${it.dup ? '<span class="tag warn">ซ้ำ</span>' : it.old ? '<span class="tag">เกิน 30 วัน</span>' : ''}</span></div>
      <div class="rv-grid">
        <select data-rv="type" data-i="${i}" aria-label="ประเภท">${[['expense', 'รายจ่าย'], ['income', 'รายรับ'], ['transfer', 'ย้ายเงิน']]
          .map(([v, l]) => `<option value="${v}" ${it.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="number" inputmode="decimal" step="0.01" value="${it.amount}" data-rv="amount" data-i="${i}" aria-label="จำนวนเงิน">
        <select data-rv="cat" data-i="${i}" aria-label="หมวด">${options}</select>
        <input type="date" value="${it.date}" data-rv="date" data-i="${i}" aria-label="วันที่">
      </div>
      ${it.note ? `<small class="muted">${esc(it.note)}</small>` : ''}
    </div></li>`;
}

function viewSettings() {
  const cfg = S.getFirebaseConfig();
  const expCats = cats().filter(c => c.type === 'expense'), incCats = cats().filter(c => c.type === 'income');
  const catChips = list => list.map(c => `<button class="chip edit" data-action="cat-edit" data-id="${c.id}" aria-label="แก้ไขหมวด ${esc(c.name)}">${c.emoji} ${esc(c.name)} <i aria-hidden="true">✎</i></button>`).join('');
  const missingDefaults = S.DEFAULT_CATEGORIES.filter(d => !cats().some(c => c.id === d.id)).length;

  let account;
  if (!cfg) {
    account = `<p>ตอนนี้ข้อมูลเก็บ <b>ในเครื่องนี้เท่านั้น</b> หากต้องการซิงก์หลายเครื่อง ให้สร้างโปรเจกต์ Firebase (ฟรี) ตามคู่มือใน README แล้ววางค่า config ที่นี่</p>
      <details><summary>วางค่า Firebase config</summary>
        <textarea rows="7" data-input="fbcfg" placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}'></textarea>
        <button class="btn primary sm" data-action="fbcfg-save">บันทึกและเชื่อมต่อ</button>
      </details>`;
  } else if (state.user) {
    account = `<div class="row between"><div><b>${esc(state.user.name || state.user.email)}</b><br><small class="muted">${esc(state.user.email || '')}</small></div>
      <button class="btn ghost sm" data-action="signout">ออกจากระบบ</button></div>
      <p class="muted small">ล็อกอินบัญชีนี้บนเครื่องอื่น ข้อมูลจะตรงกันอัตโนมัติ · ใช้งานออฟไลน์ได้ แล้วซิงก์เมื่อกลับมาออนไลน์</p>`;
  } else {
    const up = ui.authMode === 'signup';
    account = `<form class="auth" data-form="auth">
        <input type="email" name="email" placeholder="อีเมล" autocomplete="email" required>
        <input type="password" name="pw" placeholder="รหัสผ่าน (6 ตัวขึ้นไป)" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="6" required>
        ${ui.authError ? `<p class="err">${esc(ui.authError)}</p>` : ''}
        <button class="btn primary" ${ui.authBusy ? 'disabled' : ''}>${ui.authBusy ? 'กำลังดำเนินการ…' : up ? 'สมัครบัญชีใหม่' : 'เข้าสู่ระบบ'}</button>
        <button type="button" class="btn ghost" data-action="google">เข้าสู่ระบบด้วย Google</button>
        <div class="row between small">${S.privateApp ? '<span></span>' : `<button type="button" class="link" data-action="auth-mode">${up ? 'มีบัญชีแล้ว? เข้าสู่ระบบ' : 'ยังไม่มีบัญชี? สมัครใหม่'}</button>`}
        <button type="button" class="link" data-action="reset-pw">ลืมรหัสผ่าน</button></div>
      </form>
      ${state.syncStatus === 'error' ? `<p class="err">${esc(state.syncError)}</p>` : ''}`;
  }

  return `${header('ตั้งค่า')}
    <section class="card"><h3>🔄 บัญชีและการซิงก์</h3>${account}</section>

    ${menuCard()}

    ${promptpayCard()}

    ${lineCard()}

    ${geminiCard()}

    ${sheetCard()}
    ${S.inviteOnly && state.isOwner ? ownerCard() : ''}



    <section class="card" id="cats"><h3>🗂️ หมวดหมู่</h3>
      <p class="muted small">แตะหมวดเพื่อเปลี่ยนชื่อ อีโมจิ ลำดับ หรือลบ</p>
      ${Object.entries(S.GROUPS).map(([g, G]) => {
        const list = cats().filter(c => S.catGroup(c) === g);
        return `<div class="row between"><small class="muted">${G.emoji} ${G.name} (${list.length})${G.hint ? ` · ${G.hint}` : ''}</small>
          <button class="link small" data-action="cat-new" data-t="${g === 'income' ? 'income' : 'expense'}" data-g="${g}">+ เพิ่ม</button></div>
          <div class="chips">${catChips(list)}</div>`;
      }).join('')}
      ${missingDefaults ? `<button class="link small" data-action="cat-restore">↺ คืนหมวดเริ่มต้นที่ลบไป (${missingDefaults})</button>` : ''}
    </section>

    <details class="card more-settings"><summary><b>⚙️ ตั้งค่าเพิ่มเติม</b> <small class="muted">ธีม · สำรอง/ส่งออกข้อมูล</small></summary>
    <section><h3>🎨 ธีม</h3>
      <div class="seg">${[['auto', 'ตามเครื่อง'], ['light', 'สว่าง'], ['dark', 'มืด']].map(([k, l]) =>
        `<button aria-selected="${prefs.theme === k}" data-action="theme" data-t="${k}">${l}</button>`).join('')}</div>
    </section>

    <section><h3>💾 ข้อมูล</h3>
      <div class="row gap wrap">
        <button class="btn ghost sm" data-action="export-json">สำรอง (JSON)</button>
        <button class="btn ghost sm" data-action="export-csv">ส่งออก CSV</button>
        <label class="btn ghost sm">นำเข้า JSON<input type="file" accept="application/json" data-input="import" hidden></label>
      </div>
      <small class="muted">ทั้งหมด ${state.tx.length} รายการ</small>
    </section></details>

    <section class="card"><h3>📖 วิธีใช้งาน</h3>
      <p class="small">ปิดยอด หน้าขาย จดต้นทุน อ่านสลิป รายงานกำไร และการติดตั้ง</p>
      <div class="row gap wrap">
        <a class="btn primary sm" href="guide.html">เปิดคู่มือ</a>
        <a class="btn ghost sm" href="guide.html#sec-install">วิธีติดตั้ง</a>
      </div>
      <button class="link" data-action="show-ob">ดูหน้าแนะนำแอปอีกครั้ง</button>
    </section>
    <section class="card dev-contact"><h3>🛠️ ติดต่อผู้พัฒนา</h3>
      <p class="muted small">พบปัญหา อยากเพิ่มฟีเจอร์ หรือสอบถามการใช้งาน ติดต่อได้ที่</p>
      <div class="row gap wrap">
        <a class="btn line-btn sm" href="https://line.me/ti/p/~t36abz" target="_blank" rel="noopener">💬 LINE ID: t36abz</a>
        <a class="btn ghost sm" href="mailto:supakorn.nty@gmail.com?subject=${encodeURIComponent('ชงสุดใจ')}">✉️ supakorn.nty@gmail.com</a>
      </div>
    </section>
    <p class="center muted small pad">ชงสุดใจ v${esc(window.APP_VERSION || '')}${window.APP_UPDATED ? ` · อัปเดต ${new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }).format(parseISO(window.APP_UPDATED))}` : ''}</p>`;
}

// ---------- access gate (email not verified / not on the allow list) ----------
function viewGate() {
  const email = esc(state.user?.email || '');
  if (S.privateApp && state.access === 'private') {
    return `<section class="onboard gate">
      <div class="ob-art"><img src="icons/icon.svg" alt="" class="ob-chick"><span class="ob-emoji">🔒</span></div>
      <h2>แอปส่วนตัว</h2>
      <p>แอปนี้ใช้ได้เฉพาะบัญชีของเจ้าของร้านเท่านั้น<br>ตอนนี้ล็อกอินอยู่ด้วย <b>${email || esc(state.user?.name || '')}</b></p>
      <button class="btn primary big" data-action="signout-now">ออกจากระบบ แล้วเข้าด้วย LINE ของร้าน</button>
    </section>`;
  }
  if (S.privateApp && state.mode !== 'cloud') {
    return `<section class="onboard gate">
      <div class="ob-art"><img src="icons/icon.svg" alt="" class="ob-chick"><span class="ob-emoji">🔐</span></div>
      <h2>เข้าสู่ระบบชงสุดใจ</h2>
      <p>แอปของร้าน · ล็อกอินด้วย LINE ของเจ้าของร้าน ข้อมูลซิงก์ทุกเครื่อง</p>
      ${S.lineLoginReady()
        ? `<button class="btn big line-btn" data-action="line-login" ${ui.authBusy ? 'disabled' : ''}>${ui.authBusy ? 'กำลังเข้าสู่ระบบ…' : '💬 เข้าสู่ระบบด้วย LINE'}</button>`
        : '<p class="g-note">ยังตั้งค่าการล็อกอินด้วย LINE ไม่เสร็จ (ownerLiffId ใน firebase-config.js)</p>'}
      ${ui.lineDenied ? `<div class="g-note">LINE <b>${esc(ui.lineDenied.name || '')}</b> ยังไม่ได้รับสิทธิ์ ส่งรหัสนี้ให้ผู้ดูแลเพิ่มให้:
        <p class="gate-email">${esc(ui.lineDenied.id)}</p><button class="btn ghost sm" data-action="line-copy">📋 คัดลอกรหัส</button></div>` : ''}
      ${ui.authError ? `<p class="err">${esc(ui.authError)}</p>` : ''}
      ${state.syncStatus === 'error' ? `<p class="err">${esc(state.syncError)}</p>` : ''}
    </section>`;
  }
  const verify = state.access === 'verify';
  return `<section class="onboard gate">
    <div class="ob-art"><img src="icons/icon.svg" alt="" class="ob-chick"><span class="ob-emoji">${verify ? '📧' : '🔒'}</span></div>
    <h2>${verify ? 'ยืนยันอีเมลก่อนใช้งาน' : 'บัญชีนี้ยังไม่ได้รับอนุญาต'}</h2>
    ${verify
      ? `<p>จุกจิกส่งลิงก์ยืนยันไปที่ <b>${email}</b> แล้ว เปิดอีเมล (ดูในโฟลเดอร์สแปมด้วย) กดลิงก์ แล้วกลับมากดปุ่มด้านล่าง</p>
         <button class="btn primary big" data-action="gate-recheck">ยืนยันแล้ว เข้าใช้งาน</button>
         <button class="btn ghost" data-action="gate-resend">ส่งอีเมลยืนยันอีกครั้ง</button>`
      : `<p>แอปนี้เปิดให้เฉพาะคนที่เจ้าของแอปอนุญาต ส่งอีเมลนี้ให้เจ้าของแอปเพิ่มให้:</p>
         <p class="gate-email">${email}</p>
         <button class="btn primary big" data-action="gate-recheck">ได้รับอนุญาตแล้ว ลองอีกครั้ง</button>
         <button class="btn ghost" data-action="gate-copy">📋 คัดลอกอีเมล</button>`}
    <button class="link" data-action="signout">ออกจากระบบ / ใช้บัญชีอื่น</button>
    ${ui.gateMsg ? `<p class="small muted">${esc(ui.gateMsg)}</p>` : ''}
  </section>`;
}

// ---------- owner: who may use the app ----------
const APP_URL = 'https://tunsupakorn.github.io/jukjik-kaa/';
const TEMPLATE_URL = ''; // ชีตต้นแบบของร้าน: เพิ่มในเฟสถัดไป
function inviteText(name) {
  return `${name ? `สวัสดี ${name} ` : ''}ชวนมาใช้ "ชงสุดใจ" แอปจดรายรับรายจ่าย อ่านสลิปให้อัตโนมัติ 🐣
1) เปิด ${APP_URL} แล้วติดตั้งลงหน้าจอ (วิธีติดตั้ง: ${APP_URL}guide.html#sec-install)
2) ตั้งค่า › สมัคร/เข้าสู่ระบบด้วย Google หรืออีเมลที่ให้ไว้
3) (ไม่บังคับ) อยากได้ Google Sheet ของตัวเอง: ${TEMPLATE_URL.includes('TEMPLATE_ID') ? APP_URL + 'guide.html#sheet-template' : TEMPLATE_URL}`;
}
function ownerCard() {
  const list = state.allowList;
  return `<section class="card" id="access"><h3>👥 ใครใช้แอปได้บ้าง</h3>
    <label class="check"><input type="checkbox" data-input="opensignup" ${state.openSignup ? 'checked' : ''}> เปิดให้ทุกคนที่มีลิงก์ใช้ได้</label>
    <p class="muted small">${state.openSignup ? '⚠️ ตอนนี้ใครก็สมัครใช้ได้ (ข้อมูลยังแยกกันของใครของมัน)' : `🔒 ใช้ได้เฉพาะคุณ และอีเมลด้านล่าง (${list.length})`}</p>
    <ul class="allow-list">${list.map(a => `<li><span><b>${esc(a.name || a.email)}</b>${a.name ? `<small>${esc(a.email)}</small>` : ''}</span>
      <span class="row gap"><button class="link small" data-action="allow-invite" data-e="${esc(a.email)}">ข้อความชวน</button>
      <button class="x" data-action="allow-remove" data-e="${esc(a.email)}" aria-label="เอาออก ${esc(a.email)}">×</button></span></li>`).join('')
      || '<li class="muted small">ยังไม่มีใคร เพิ่มอีเมลของคนที่จะชวนได้เลย</li>'}</ul>
    <form class="row gap wrap" data-form="allow">
      <input name="email" type="email" placeholder="อีเมลของคนที่ชวน" required class="grow" autocomplete="off">
      <input name="name" placeholder="ชื่อเล่น (ไม่บังคับ)" class="w-name" autocomplete="off">
      <button class="btn primary sm">อนุญาต</button>
    </form>
    <small class="muted">คนที่สมัครด้วยอีเมล+รหัสผ่านต้องกดยืนยันอีเมลก่อน · บัญชี Google ใช้ได้ทันที</small>
  </section>`;
}

function geminiCard() {
  const key = geminiKey();
  const synced = state.mode === 'cloud' && state.settings.geminiKey;
  const more = `<details class="more"><summary>ตั้งค่าเพิ่มเติม</summary>
      <label class="lbl">โมเดล<input type="text" value="${esc(prefs.geminiModel)}" data-input="gmodel"></label>
      <label class="lbl">ชื่อ-นามสกุลของคุณ ตามบัญชีธนาคาร (แอปจำจากสลิปให้เองได้)
        <input type="text" placeholder="เช่น ศุภกร นิตยวรรณ, Supakorn Nittayawan" value="${esc(state.settings.ownerNames || '')}" data-input="owner"></label>
      <div class="row gap wrap"><button class="btn ghost sm" data-action="owner-save">บันทึกชื่อ</button>
        ${key ? `<button class="btn ghost sm" data-action="gtest">ทดสอบ key</button><button class="btn ghost sm" data-action="gkey-change">เปลี่ยน key</button>` : ''}</div>
    </details>`;
  if (key && !ui.editKey) {
    return `<section class="card compact" id="gemini">
      <div class="row between"><h3>🔑 อ่านสลิป</h3><span class="ok-pill">✅ พร้อมใช้</span></div>
      <p class="muted small">${esc(prefs.geminiModel)} · ${synced ? 'key ซิงก์กับทุกเครื่องในบัญชีนี้แล้ว' : state.mode === 'cloud' ? 'key อยู่ในเครื่องนี้' : 'key อยู่ในเครื่องนี้ (ล็อกอินเพื่อใช้กับทุกเครื่อง)'}
        ${state.settings.ownerNames ? ` · ชื่อ: ${esc(state.settings.ownerNames)}` : ''}</p>
      ${more}
    </section>`;
  }
  return `<section class="card" id="gemini"><h3>🔑 ตั้งค่าอ่านสลิป (ทำครั้งเดียว)</h3>
    <ol class="steps">
      <li><a class="btn ghost sm" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">① เปิดหน้าสร้าง key ฟรี ↗</a>
        <small class="muted">กด “Create API key” แล้วกดคัดลอก</small></li>
      <li><button class="btn primary sm" data-action="gkey-paste">② 📋 วาง key จากคลิปบอร์ด</button>
        <small class="muted">แอปจะทดสอบให้เอง แล้วใช้กับทุกเครื่องที่ล็อกอินบัญชีนี้</small></li>
    </ol>
    <div class="row gap"><input type="password" class="grow" placeholder="หรือวาง key ที่นี่ (AIza…)" data-input="gkey" autocomplete="off">
      <button class="btn ghost sm" data-action="gkey-save">บันทึก</button></div>
    ${ui.keyMsg ? `<p class="small ${ui.keyMsg.startsWith('❌') ? 'err' : ''}">${esc(ui.keyMsg)}</p>` : ''}
    ${ui.editKey ? `<button class="link small" data-action="gkey-cancel">ยกเลิก</button>` : ''}
    ${more}
  </section>`;
}

async function saveGeminiKey(raw) {
  const key = String(raw || '').trim().replace(/\s+/g, '');
  if (!key) { ui.keyMsg = '❌ ไม่พบ key'; return render(); }
  if (!/^AIza[\w-]{20,}$/.test(key)) { ui.keyMsg = '❌ ดูไม่เหมือน Gemini API key (ควรขึ้นต้นด้วย AIza)'; return render(); }
  ui.keyMsg = '⏳ กำลังทดสอบ key…'; render();
  try {
    await testKey(key, prefs.geminiModel);
  } catch (e) { ui.keyMsg = '❌ ' + e.message; return render(); }
  S.savePrefs({ geminiKey: key });
  if (state.mode === 'cloud') S.saveSettings({ geminiKey: key });
  ui.keyMsg = ''; ui.editKey = false;
  toast(state.mode === 'cloud' ? '✅ key ใช้งานได้ และใช้กับทุกเครื่องแล้ว' : '✅ key ใช้งานได้');
  render();
}

function sheetCard() {
  if (!Sheet.isConnected()) {
    return `<section class="card" id="gsheet"><h3>📗 Google Sheet & Drive <small class="muted">(ไม่บังคับ)</small></h3>
      <p class="muted small">เก็บสำเนาทุกรายการไว้ใน Google Sheet และรูปสลิปไว้ใน Google Drive ของคุณเอง</p>
      ${state.mode !== 'cloud' ? '<p class="small">🔐 ล็อกอินบัญชีก่อน แล้วค่อยเชื่อมชีต</p>' : ''}
      <ol class="steps">
        <li class="small"><b>ทำบนคอมพิวเตอร์ ครั้งเดียว ~5 นาที</b> ใช้บัญชี Google ที่จะเก็บชีตและสลิป</li>
        <li><a class="btn primary sm" href="https://sheets.new" target="_blank" rel="noopener">① 📗 สร้างชีตใหม่ ↗</a>
          <span class="small">ตั้งชื่อ เช่น “ชงสุดใจ – บัญชีร้าน”</span></li>
        <li><span class="small">② ในชีต: เมนู <b>ส่วนขยาย › Apps Script</b> › ลบโค้ดเดิมทั้งหมด › วางโค้ดจากปุ่มนี้ › กด 💾 บันทึก</span>
          <button class="btn ghost sm" data-action="sheet-copy-code">📋 คัดลอกโค้ดสคริปต์</button></li>
        <li><span class="small">③ ปุ่ม <b>การทำให้ใช้งานได้ › การทำให้ใช้งานได้รายการใหม่</b> › ⚙️ เลือก <b>เว็บแอป</b> ›
          เรียกใช้ในฐานะ <b>ฉัน</b> · ผู้มีสิทธิ์เข้าถึง <b>ทุกคน</b> › ทำให้ใช้งานได้ › <b>ให้สิทธิ์</b> (ขั้นสูง › ไปที่… › อนุญาต)</span></li>
        <li><span class="small">④ กลับไปที่ชีต <b>รีเฟรชหน้า</b> › เมนู <b>🐣 จุกจิก › เชื่อมกับแอปจุกจิก</b> › กดปุ่ม
          <b>“เปิดแอปจุกจิกและเชื่อมต่อให้อัตโนมัติ”</b> — เสร็จ!</span></li>
      </ol>
      <details class="more"><summary>มีลิงก์ web app อยู่แล้ว</summary>
        <input type="url" placeholder="https://script.google.com/macros/s/…/exec" data-input="sheeturl" autocomplete="off">
        <div class="row gap wrap"><button class="btn ghost sm" data-action="sheet-paste">📋 วางลิงก์</button>
          <button class="btn primary sm" data-action="sheet-connect">เชื่อมต่อ</button></div>
      </details>
      ${Sheet.sheet.status === 'error' ? `<p class="err">${esc(Sheet.sheet.msg)}</p>` : ''}
    </section>`;
  }
  const s = Sheet.sheet;
  const time = s.at ? new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' }).format(s.at) : '';
  const line = s.status === 'syncing' ? '⏳ กำลังส่งข้อมูลลงชีต…'
    : s.status === 'ok' ? `✅ ซิงก์ลงชีตแล้ว ${time} น. · ${s.rows} รายการ`
    : s.status === 'error' ? `⚠️ ${esc(s.msg)}`
    : state.cloudConfigured && state.syncStatus !== 'synced' ? '⏸️ รอซิงก์กับบัญชีให้เสร็จก่อน แล้วจะส่งลงชีตให้'
    : '🟢 เชื่อมต่อแล้ว ข้อมูลจะถูกส่งลงชีตอัตโนมัติเมื่อมีการเปลี่ยนแปลง';
  const slips = state.settings.saveSlips !== false;
  return `<section class="card compact" id="gsheet">
    <div class="row between"><h3>📗 Google Sheet & Drive</h3>${s.status === 'error' ? '<span class="tag warn">มีปัญหา</span>' : '<span class="ok-pill">✅ เชื่อมแล้ว</span>'}</div>
    <p class="small ${s.status === 'error' ? 'err' : 'muted'}">${line}${slips ? ' · เก็บสลิปใน Drive' : ''}</p>
    <div class="row gap wrap">
      ${Sheet.sheetUrl() ? `<a class="btn ghost sm" href="${esc(Sheet.sheetUrl())}" target="_blank" rel="noopener">📗 เปิดชีต</a>` : ''}
      ${Sheet.slipFolderUrl() ? `<a class="btn ghost sm" href="${esc(Sheet.slipFolderUrl())}" target="_blank" rel="noopener">📁 โฟลเดอร์สลิป</a>` : ''}
    </div>
    <details class="more"><summary>ตั้งค่าเพิ่มเติม</summary>
      <label class="check"><input type="checkbox" data-input="saveslips" ${slips ? 'checked' : ''}> เก็บรูปสลิปไว้ใน Google Drive (โฟลเดอร์ “จุกจิก JukJik — สลิป” แยกตามเดือน)</label>
      <div class="row gap wrap">
        <button class="btn ghost sm" data-action="sheet-sync" ${s.status === 'syncing' ? 'disabled' : ''}>ซิงก์ตอนนี้</button>
        <button class="btn ghost sm" data-action="sheet-disconnect">ยกเลิกการเชื่อม</button>
      </div>
    </details>
  </section>`;
}

// ---------- category editor ----------
let catDraft = null;
function openCatEditor(id, type, group) {
  const c = id && cats().find(x => x.id === id);
  catDraft = c ? { ...c, group: c.type === 'income' ? undefined : S.catGroup(c), isNew: false }
    : { id: 'c_' + S.newId(), name: '', emoji: type === 'income' ? '💰' : '🏷️', type, group: type === 'income' ? undefined : (group || 'opex'), isNew: true };
  renderCatEditor();
  if (!$('#sheet').open) $('#sheet').showModal();
}
function renderCatEditor() {
  const d = catDraft;
  const same = cats().filter(c => S.catGroup(c) === S.catGroup(d));
  const pos = same.findIndex(c => c.id === d.id);
  const used = state.tx.filter(t => t.cat === d.id).length;
  $('#sheet').innerHTML = `<form method="dialog" class="sheet-body" data-form="cat-edit">
    <div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>${d.isNew ? 'เพิ่มหมวด' : 'แก้ไขหมวด'} · ${S.GROUPS[S.catGroup(d)].name}</h2>
      <button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    <div class="row gap">
      <input class="w-emoji ce-emoji" value="${esc(d.emoji)}" data-ce="emoji" maxlength="8" aria-label="อีโมจิ">
      <input class="grow" value="${esc(d.name)}" data-ce="name" placeholder="ชื่อหมวด เช่น ค่าเทอมลูก" required maxlength="30" aria-label="ชื่อหมวด">
    </div>
    ${d.type === 'expense' ? `<div class="seg">${['cogs', 'opex', 'invest'].map(g => `<button type="button" aria-selected="${d.group === g}" data-action="ce-group" data-g="${g}">${S.GROUPS[g].emoji} ${S.GROUPS[g].name}</button>`).join('')}</div>
    <small class="muted">${S.GROUPS[d.group].hint}</small>` : ''}
    <div class="emoji-grid" role="group" aria-label="เลือกอีโมจิ">${EMOJIS.map(e => `<button type="button" class="${e === d.emoji ? 'on' : ''}" data-action="ce-emoji" data-e="${e}">${e}</button>`).join('')}</div>
    ${d.isNew ? '' : `<div class="row between">
      <small class="muted">ลำดับ ${pos + 1} จาก ${same.length}${used ? ` · ใช้อยู่ ${used} รายการ` : ''}</small>
      <div class="row gap"><button type="button" class="btn ghost sm" data-action="ce-move" data-d="-1" ${pos <= 0 ? 'disabled' : ''}>‹ เลื่อนก่อน</button>
      <button type="button" class="btn ghost sm" data-action="ce-move" data-d="1" ${pos >= same.length - 1 ? 'disabled' : ''}>เลื่อนหลัง ›</button></div></div>`}
    <div class="row gap">
      ${d.isNew ? '' : `<button type="button" class="btn danger" data-action="ce-delete">ลบหมวด</button>`}
      <button type="submit" class="btn primary big grow">${d.isNew ? 'เพิ่มหมวด' : 'บันทึก'}</button>
    </div>
  </form>`;
}
function deleteCategory(id) {
  const c = cats().find(x => x.id === id);
  const same = cats().filter(x => x.type === c.type && x.id !== id);
  const sameGroup = same.filter(x => S.catGroup(x) === S.catGroup(c));
  if (!same.length) return toast('ต้องมีอย่างน้อย 1 หมวด');
  const otherId = { income: 'inc_other', cogs: 'cogs_other', opex: 'exp_other', invest: 'invest_other' }[S.catGroup(c)];
  const other = sameGroup.find(x => x.id === otherId) || sameGroup[sameGroup.length - 1] || same.find(x => x.id === otherId) || same[same.length - 1];
  const used = state.tx.filter(t => t.cat === id);
  const msg = used.length ? `ลบหมวด "${c.name}"? รายการ ${used.length} รายการในหมวดนี้จะย้ายไปหมวด "${other.name}"` : `ลบหมวด "${c.name}"?`;
  if (!confirm(msg)) return;
  if (used.length) S.saveMany(used.map(t => ({ ...t, cat: other.id })));
  S.saveSettings({ categories: cats().filter(x => x.id !== id) });
  $('#sheet').close();
  toast('ลบหมวดแล้ว');
}
function moveCategory(id, dir) {
  const list = [...cats()];
  const i = list.findIndex(c => c.id === id);
  let j = i + dir;
  while (j >= 0 && j < list.length && S.catGroup(list[j]) !== S.catGroup(list[i])) j += dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  S.saveSettings({ categories: list });
  renderCatEditor();
}

// ---------- daily close (ปิดยอดขาย + นับเงินลิ้นชัก) ----------
// Manual sales: one entry per channel per day with fixed ids (closing again replaces them).
// Sell-page bills are counted automatically; the drawer count is kept in settings.drawers[date].
let closeDraft = null;
const closeId = (date, ch) => `close-${date}-${ch}`;
const posOn = date => {
  const list = state.tx.filter(t => t.source === 'pos' && t.date === date);
  const by = Object.fromEntries(CHANNELS.map(([k]) => [k, list.filter(t => t.method === k).reduce((s, t) => s + amt(t), 0)]));
  return { n: list.length, by, total: list.reduce((s, t) => s + amt(t), 0) };
};
function loadCloseDraft(date) {
  const get = k => state.tx.find(t => t.id === closeId(date, k));
  const cups = CHANNELS.reduce((s, [k]) => s + Number(get(k)?.cups || 0), 0);
  const first = CHANNELS.map(([k]) => get(k)).find(Boolean);
  const dr = (state.settings.drawers || {})[date];
  closeDraft = { date, cash: get('cash')?.amount ?? '', promptpay: get('promptpay')?.amount ?? '', scan: get('scan')?.amount ?? '',
    cups: cups || '', note: first?.note && first.note !== 'ปิดยอดขาย' ? first.note : '', existed: !!first || !!dr,
    float: dr?.float ?? (state.settings.floatDefault ?? ''), counted: dr?.counted ?? '' };
}
function openCloseSheet(date) {
  loadCloseDraft(date || todayISO());
  renderCloseSheet();
  if (!$('#sheet').open) $('#sheet').showModal();
}
const closeManual = () => CHANNELS.reduce((s, [k]) => s + (Number(closeDraft[k]) || 0), 0);
const closeTotal = () => closeManual() + posOn(closeDraft.date).total;
function drawerCalc() {
  const d = closeDraft, pos = posOn(d.date);
  const expected = (Number(d.float) || 0) + pos.by.cash + (Number(d.cash) || 0);
  const counted = d.counted === '' ? null : Number(d.counted) || 0;
  return { expected, counted, diff: counted === null ? null : Math.round((counted - expected) * 100) / 100 };
}
const diffText = c => c.diff === null ? 'ใส่ยอดที่นับได้ เพื่อดูว่าเงินขาด/เกิน'
  : c.diff === 0 ? '✅ เงินตรงพอดี' : c.diff > 0 ? `⬆️ เงินเกิน ${baht(c.diff)}` : `⚠️ เงินขาด ${baht(-c.diff)}`;
function updateCloseLive() {
  const t = $('#close-total'); if (t) t.textContent = baht(closeTotal());
  const c = drawerCalc();
  const e = $('#drawer-exp'); if (e) e.textContent = baht(c.expected);
  const dd = $('#drawer-diff'); if (dd) { dd.textContent = diffText(c); dd.className = 'change' + (c.diff < 0 ? ' short' : ''); }
}
function renderCloseSheet() {
  const d = closeDraft;
  const pos = posOn(d.date);
  const c = drawerCalc();
  const manualOpen = !pos.n || closeManual() > 0;
  $('#sheet').innerHTML = `<form method="dialog" class="sheet-body" data-form="close">
    <div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>📒 ปิดยอดขาย</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    <label class="lbl">วันที่<input type="date" value="${d.date}" data-cl="date" required></label>
    ${pos.n ? `<div class="pos-sum"><b>🛒 จากหน้าขาย ${pos.n} บิล</b>
      <div class="today-grid">${CHANNELS.map(([k, l]) => `<div><small>${l}</small><b class="num">${baht(pos.by[k])}</b></div>`).join('')}</div></div>` : ''}
    <details class="more" ${manualOpen ? 'open' : ''}><summary>${pos.n ? '➕ ยอดขายที่ไม่ได้ผ่านหน้าขาย' : 'ยอดขายวันนี้'}</summary>
      ${CHANNELS.map(([k, l]) => `<label class="close-row"><span>${l}</span>
        <input type="number" inputmode="decimal" step="0.01" min="0" placeholder="0" value="${d[k]}" data-cl="${k}" aria-label="${l}"></label>`).join('')}
      ${pos.n ? '' : `<label class="lbl">จำนวนแก้ว (ไม่บังคับ)<input type="number" inputmode="numeric" min="0" step="1" placeholder="เช่น 85" value="${d.cups}" data-cl="cups"></label>`}
    </details>
    <div class="close-total"><span>รวมยอดขาย</span><b class="num" id="close-total">${baht(closeTotal())}</b></div>
    <section class="drawer"><h3>💵 นับเงินลิ้นชัก</h3>
      <div class="row gap">
        <label class="lbl grow">เงินทอนตั้งต้น (ตอนเปิดร้าน)<input type="number" inputmode="decimal" min="0" step="1" placeholder="เช่น 500" value="${d.float}" data-cl="float"></label>
        <label class="lbl grow">นับได้ตอนปิด<input type="number" inputmode="decimal" min="0" step="1" placeholder="นับเงินสดทั้งหมด" value="${d.counted}" data-cl="counted"></label>
      </div>
      <p class="small muted">ควรมีในลิ้นชัก = เงินทอนตั้งต้น + ขายเงินสด = <b class="num" id="drawer-exp">${baht(c.expected)}</b></p>
      <div class="change ${c.diff < 0 ? 'short' : ''}" id="drawer-diff">${diffText(c)}</div>
    </section>
    <label class="lbl">โน้ต<input type="text" placeholder="เช่น ฝนตก ขายน้อย" value="${esc(d.note)}" data-cl="note"></label>
    <div class="row gap">
      ${d.existed ? `<button type="button" class="btn danger" data-action="close-delete">ลบยอดปิดวันนี้</button>` : ''}
      <button type="submit" class="btn primary big grow">บันทึกปิดยอด</button>
    </div>
  </form>`;
}
function saveClose() {
  const d = closeDraft;
  const pos = posOn(d.date);
  const firstPaid = CHANNELS.map(([k]) => k).find(k => Number(d[k]) > 0);
  if (!firstPaid && !pos.n && d.counted === '') return toast('ใส่ยอดขายอย่างน้อย 1 ช่อง');
  for (const [k, label] of CHANNELS) {
    const id = closeId(d.date, k);
    const v = Math.round((Number(d[k]) || 0) * 100) / 100;
    if (v > 0) {
      const old = state.tx.find(t => t.id === id) || {};
      S.saveTx({ ...old, id, type: 'income', cat: 'sales', method: k, amount: v, date: d.date, source: 'close',
        merchant: `ปิดยอดขาย · ${label.replace(/^\S+\s/, '')}`, note: d.note || 'ปิดยอดขาย', cups: k === firstPaid ? Number(d.cups) || 0 : 0 });
    } else if (state.tx.some(t => t.id === id)) S.deleteTx(id);
  }
  const c = drawerCalc();
  const drawers = { ...(state.settings.drawers || {}) };
  if (d.counted !== '' || d.float !== '') drawers[d.date] = { float: Number(d.float) || 0, counted: c.counted, expected: c.expected, diff: c.diff, note: d.note || '', at: Date.now() };
  S.saveSettings({ drawers, ...(d.float !== '' ? { floatDefault: Number(d.float) || 0 } : {}) });
  ui.month = d.date.slice(0, 7);
  $('#sheet').close();
  toast(`ปิดยอด ${shortDay(d.date)} แล้ว · ${baht(closeTotal())}${c.diff ? (c.diff < 0 ? ` · เงินขาด ${baht(-c.diff)}` : ` · เงินเกิน ${baht(c.diff)}`) : ''}`);
}

// ---------- พร้อมเพย์ร้าน ----------
function promptpayCard() {
  const id = state.settings.promptpay || '';
  const n = PP.normalizeId(id);
  return `<section class="card" id="pp"><h3>📲 พร้อมเพย์ร้าน</h3>
    <p class="muted small">ใช้สร้าง QR พร้อมยอดเงินในหน้าขาย ลูกค้าสแกนแล้วยอดขึ้นเอง ไม่ต้องพิมพ์</p>
    <div class="row gap"><input inputmode="numeric" class="grow" placeholder="เบอร์มือถือ 10 หลัก หรือเลขบัตร 13 หลัก" value="${esc(id)}" data-input="ppid" autocomplete="off">
      <button class="btn primary sm" data-action="pp-save">บันทึก</button></div>
    ${n ? `<p class="small">✅ ${n.label} ${PP.mask(id)}</p><button class="btn ghost" data-action="pp-test">📲 แสดง QR ทดสอบ ฿1</button><p class="small muted">สแกนโอน ฿1 ด้วยแอปธนาคารของคุณเอง ดูว่าชื่อบัญชีเป็นของร้านก่อนใช้กับลูกค้า</p>` : '<p class="small muted">ยังไม่ได้ตั้ง — หน้าขายจะใช้แบบกดยืนยันรับเงินแทน</p>'}
    <div id="pp-preview" class="pp-qr" hidden></div>
  </section>`;
}
async function showQR(el, amount) {
  try {
    const url = await PP.qrDataUrl(state.settings.promptpay, amount, 300);
    el.innerHTML = `<img src="${url}" alt="QR พร้อมเพย์ ${baht(amount)}" width="240" height="240"><small>พร้อมเพย์ ${PP.mask(state.settings.promptpay)} · <b>${baht(amount)}</b></small>`;
    el.hidden = false;
  } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; el.hidden = false; }
}

// ==================== LINE OA: ออเดอร์จากลูกค้า ====================
const lineCfg = () => ({ open: false, from: '09:00', to: '20:00', prep: 10, stampGoal: 10, note: '', deliveryMin: 100, ...(state.settings.line || {}) });
const FULFIL = { pickup: '🛍️ รับที่ร้าน', delivery: '🛵 จัดส่ง' };
const lineModes = () => (Array.isArray(lineCfg().modes) && lineCfg().modes.length ? lineCfg().modes : Object.keys(FULFIL)).filter(k => FULFIL[k]);
const ORDER_STATUS = { new: '🆕 ออเดอร์ใหม่', accepted: '🧑‍🍳 กำลังทำ', ready: '☕ รอลูกค้ารับ' };
const pickupMin = o => { const [h, m] = String(o.pickup?.at || '23:59').split(':').map(Number); return h * 60 + m; };
const openOrders = () => [...state.orders].sort((a, b) => pickupMin(a) - pickupMin(b) || (a.createdAt || 0) - (b.createdAt || 0));
const newOrderCount = () => state.orders.filter(o => o.status === 'new').length;

// LINE messages to customers this month (push quota) and the "accepted" notice switch
function quotaRow() {
  if (state.mode !== 'cloud') return '';
  if (ui.quota === undefined) { ui.quota = null; S.lineQuota().then(q => { ui.quota = q; render(); }).catch(e => { ui.quota = { error: e.message }; render(); }); }
  const q = ui.quota, on = lineCfg().notifyAccept !== false, per = on ? 2 : 1;
  let bar = '<p class="small muted" style="margin:0">กำลังดูโควตา…</p>';
  if (q?.error) bar = `<p class="small muted" style="margin:0">ดูโควตาไม่ได้: ${esc(q.error)}</p>`;
  else if (q && q.limit === null) bar = `<p class="small" style="margin:0">📨 ส่งข้อความหาลูกค้าเดือนนี้ <b>${nf.format(q.used)}</b> ข้อความ (แพ็กเกจไม่จำกัด)</p>`;
  else if (q) {
    const left = Math.max(0, q.limit - q.used), p = q.limit ? q.used / q.limit : 0;
    bar = `<p class="small" style="margin:0">📨 ข้อความแจ้งลูกค้า เดือนนี้ <b class="num">${nf.format(q.used)} / ${nf.format(q.limit)}</b></p>
      <div class="meter quota ${p >= 1 ? 'full' : p >= 0.8 ? 'near' : ''}"><div style="width:${Math.min(100, Math.round(p * 100))}%"></div></div>
      <p class="small muted" style="margin:0">${left ? `เหลือ ${nf.format(left)} · พอสำหรับอีก ~${nf.format(Math.floor(left / per))} ออเดอร์ (ออเดอร์ละ ${per} ข้อความ)` : '⚠️ ใช้ครบแล้ว ลูกค้าจะไม่ได้ข้อความแจ้งจนถึงเดือนหน้า (หน้าออเดอร์ยังแสดงสถานะ)'}</p>`;
  }
  return `<div class="quota-row">${bar}
    <label class="check" style="margin:4px 0 0"><input type="checkbox" data-input="notify-accept" ${on ? 'checked' : ''}> แจ้งลูกค้าตอนกด "รับออเดอร์" (ใช้ 1 ข้อความ/ออเดอร์)</label></div>`;
}

// notifications on this device
function pushRow() {
  if (ui.pushState === undefined) { ui.pushState = 'checking'; S.pushState().then(s => { ui.pushState = s; render(); }).catch(() => { ui.pushState = 'unsupported'; render(); }); }
  const s = ui.pushState;
  const txt = {
    checking: '',
    on: '🔔 <b>เครื่องนี้เปิดแจ้งเตือนแล้ว</b> · เด้งเตือนเมื่อมีออเดอร์ใหม่หรือลูกค้าแนบสลิป',
    off: '🔕 เครื่องนี้ยังไม่ได้เปิดแจ้งเตือนออเดอร์',
    denied: '🔕 เครื่องนี้ปิดการแจ้งเตือนของแอปไว้ เปิดได้ที่ ตั้งค่าเครื่อง › แอป/การแจ้งเตือน › ชงสุดใจ (หรือตั้งค่าเว็บไซต์ในเบราว์เซอร์)',
    'ios-install': '📱 iPhone/iPad: เพิ่มแอปไปที่หน้าจอโฮมก่อน (ปุ่มแชร์ › เพิ่มไปยังหน้าจอโฮม) แล้วเปิดจากไอคอน จึงจะเปิดแจ้งเตือนได้',
    unsupported: '🔕 เบราว์เซอร์นี้รับแจ้งเตือนไม่ได้ ลองเปิดแอปด้วย Chrome หรือติดตั้งแอปลงหน้าจอโฮม',
  }[s] || '';
  return `<div class="push-row ${s}"><p class="small" style="margin:0">${txt}</p>
    ${s === 'off' ? `<button class="btn primary sm" data-action="push-on" ${ui.pushBusy ? 'disabled' : ''}>${ui.pushBusy ? 'กำลังเปิด…' : '🔔 เปิดแจ้งเตือนบนเครื่องนี้'}</button>` : ''}
    ${s === 'on' ? `<button class="btn ghost sm" data-action="push-test">ส่งทดสอบ</button><button class="btn ghost sm" data-action="push-off">ปิด</button>` : ''}</div>`;
}

function lineCard() {
  const c = lineCfg();
  return `<section class="card" id="line"><h3>💚 สั่งผ่าน LINE OA</h3>
    <p class="muted small">ลูกค้าสั่งและจ่ายผ่าน LINE ออเดอร์เข้ามาที่ 🛒 ขาย › ออเดอร์ LINE · ตั้งค่าบัญชี LINE ตามคู่มือใน README</p>
    ${pushRow()}
    ${quotaRow()}
    <div class="seg"><button aria-selected="${c.open}" data-action="line-open" data-v="1">🟢 เปิดรับออเดอร์</button>
      <button aria-selected="${!c.open}" data-action="line-open" data-v="">⏸️ ปิดรับ</button></div>
    <p class="small muted" style="margin:12px 0 4px">วิธีรับที่ให้ลูกค้าเลือก</p>
    <div class="chips">${Object.entries(FULFIL).map(([k, l]) => { const on = lineModes().includes(k); return `<button class="chip ${on ? 'on' : 'mode-off'}" data-action="line-mode" data-m="${k}" aria-pressed="${on}">${on ? '✓' : '✕'} ${l} · ${on ? 'เปิด' : 'ปิด'}</button>`; }).join('')}</div>
    <div class="line-grid">
      <label>เปิด<input type="time" value="${esc(c.from)}" data-line="from"></label>
      <label>ปิด<input type="time" value="${esc(c.to)}" data-line="to"></label>
      <label>เวลาทำ (นาที)<input type="number" inputmode="numeric" min="0" max="120" value="${esc(c.prep)}" data-line="prep"></label>
      <label>สะสมครบ (แก้ว)<input type="number" inputmode="numeric" min="1" max="99" value="${esc(c.stampGoal)}" data-line="stampGoal"></label>
      ${lineModes().includes('delivery') ? `<label>จัดส่งขั้นต่ำ (บาท)<input type="number" inputmode="numeric" min="0" max="5000" step="10" value="${esc(c.deliveryMin)}" data-line="deliveryMin"></label>` : ''}
    </div>
    <label class="line-note">ชื่อร้านที่ลูกค้าเห็น<input maxlength="40" placeholder="ชงสุดใจ" value="${esc(c.name || '')}" data-line="name"></label>
    <div class="banner-edit"><label class="check"><input type="checkbox" data-input="banner-on" ${c.banner?.on ? 'checked' : ''}> 📣 แบนเนอร์โปรโมชันบนหน้าสั่ง</label>
      ${c.banner?.photo ? `<img src="${S.photoUrl('_banner', c.banner.photo)}" alt="แบนเนอร์">` : ''}
      <div class="row gap wrap"><label class="btn ghost sm">🖼️ ${c.banner?.photo ? 'เปลี่ยนรูป' : 'ใส่รูปแนวนอน'}<input type="file" accept="image/*" data-input="bannerphoto" hidden></label>
        ${c.banner?.photo ? '<button class="link small" data-action="banner-photo-remove">ลบรูป</button>' : ''}</div>
      <input maxlength="120" placeholder="ข้อความ เช่น 🎉 ซื้อ 2 แก้ว ลด 10% วันนี้เท่านั้น" value="${esc(c.banner?.text || '')}" data-banner="text">
      <p class="small muted" style="margin:0">แสดงผลอย่างเดียว ยังไม่ลดราคาให้อัตโนมัติ</p></div>
    <label class="line-note">ประกาศถึงลูกค้า<input maxlength="120" placeholder="เช่น วันนี้มะม่วงหมด" value="${esc(c.note)}" data-line="note"></label>
    <button class="btn primary sm" data-action="line-save">บันทึก</button>
    ${state.settings.promptpay ? '' : '<p class="small muted">ยังไม่ได้ตั้งพร้อมเพย์ร้าน ลูกค้าจะเลือกได้แค่เงินสดตอนรับ</p>'}
  </section>`;
}
function saveLine(patch) {
  const next = { ...lineCfg(), ...patch };
  // the ordering page reads the menu from the account, so make sure it is saved there (not only the built-in default)
  S.saveSettings({ line: next, ...(state.settings.menu ? {} : { menu: menu() }) });
}

function orderCard(o) {
  const pay = o.paid ? '<span class="pill ok">ชำระแล้ว</span>'
    : o.payMethod === 'promptpay' ? (o.hasSlip ? '<span class="pill warn">แนบสลิปแล้ว · เช็กยอดเข้า</span>' : o.payClaimed ? '<span class="pill warn">ลูกค้าแจ้งโอนแล้ว · เช็กแอปธนาคาร</span>' : '<span class="pill">พร้อมเพย์ · ยังไม่โอน</span>')
    : '<span class="pill">💵 เงินสดตอนรับ</span>';
  const confirmPP = o.payMethod === 'promptpay' && !o.paid ? `<button class="btn ghost sm" data-action="ord-paid" data-id="${esc(o.id)}">✓ เงินเข้าแล้ว</button>` : '';
  const actions = o.status === 'new'
    ? `<button class="btn primary" data-action="ord-status" data-id="${esc(o.id)}" data-s="accept">รับออเดอร์</button>${confirmPP}
       <button class="btn danger sm" data-action="ord-cancel" data-id="${esc(o.id)}">ยกเลิก</button>`
    : o.status === 'accepted'
    ? `<button class="btn primary" data-action="ord-status" data-id="${esc(o.id)}" data-s="ready">${o.fulfil?.mode === 'delivery' ? 'ออกไปส่ง · แจ้งลูกค้า' : 'ทำเสร็จ · แจ้งลูกค้า'}</button>${confirmPP}
       <button class="btn danger sm" data-action="ord-cancel" data-id="${esc(o.id)}">ยกเลิก</button>`
    : o.paid ? `<button class="btn primary" data-action="ord-done" data-id="${esc(o.id)}">ส่งมอบแล้ว ✓</button>`
    : o.payMethod === 'promptpay' ? `${confirmPP}<button class="btn ghost sm" data-action="ord-cash" data-id="${esc(o.id)}">💵 ลูกค้าจ่ายเงินสดแทน</button>`
    : `<button class="btn primary" data-action="ord-cash" data-id="${esc(o.id)}">💵 รับเงินสด ${baht(o.total)} · ส่งมอบ</button>`;
  return `<article class="card order ${o.status}">
    <div class="row between"><div><b class="order-no">${esc(o.no)}</b> <span class="muted small">${esc(o.displayName || '')}</span></div>
      <span class="order-time">${o.pickup?.mode === 'later' ? `⏰ นัด ${esc(o.pickup.at)}` : `⚡ รับเลย ~${esc(o.pickup?.at || '')}`}</span></div>
    <p class="small muted">${ORDER_STATUS[o.status] || ''}</p>
    <p class="order-fulfil"><b>${FULFIL[o.fulfil?.mode] || FULFIL.pickup}</b>${o.fulfil?.detail ? ` · ${esc(o.fulfil.detail)}` : ''}
      ${o.fulfil?.phone ? ` · <a href="tel:${esc(o.fulfil.phone)}">📞 ${esc(o.fulfil.phone)}</a>` : ''}</p>
    <ul class="order-items">${(o.items || []).map(i => `<li><span>${esc(i.name)} ${optTags(i)}</span><b>×${i.qty}</b></li>`).join('')}</ul>
    ${o.note ? `<p class="order-note">📝 ${esc(o.note)}</p>` : ''}
    <div class="row between wrap gap"><b class="num order-total">${baht(o.total)}</b>${pay}</div>
    <div class="order-actions">${o.hasSlip ? `<button class="btn ghost sm" data-action="ord-slip" data-id="${esc(o.id)}">🧾 ดูสลิป</button>` : ''}${actions}
      <button class="btn ghost sm" data-action="ord-chat" data-id="${esc(o.id)}" title="คัดลอกชื่อลูกค้า แล้วเปิดแชทของร้าน">💬 แชท</button></div>
  </article>`;
}

function viewOrders() {
  const c = lineCfg(), list = openOrders();
  return `${header('ออเดอร์ LINE', 'sell')}
    <div class="row between gap" style="margin-bottom:6px"><span class="small">${c.open ? '🟢 เปิดรับออเดอร์อยู่' : '⏸️ ปิดรับออเดอร์อยู่'} · ${esc(c.from)}–${esc(c.to)}</span>
      <button class="btn ghost sm" data-action="line-open" data-v="${c.open ? '' : '1'}">${c.open ? 'ปิดรับ' : 'เปิดรับ'}</button></div>
    ${state.mode !== 'cloud' ? '<p class="g-note">ต้องล็อกอินบัญชีร้านก่อน ถึงจะเห็นออเดอร์จาก LINE</p>' : ''}
    ${ui.pushState === 'off' ? '<button class="line-banner" data-action="push-on"><span>🔔 เปิดแจ้งเตือนออเดอร์ใหม่บนเครื่องนี้</span><span>›</span></button>' : ''}
    ${list.length ? list.map(orderCard).join('') : '<p class="muted center pad">ยังไม่มีออเดอร์ที่ค้างอยู่ 💤</p>'}`;
}

function lineBanner() {
  const n = state.orders.length, fresh = newOrderCount();
  if (!n && !lineCfg().open) return '';
  return `<button class="line-banner ${fresh ? 'hot' : ''}" data-action="orders-open">
    <span>💚 ออเดอร์ LINE ${n ? `<b>${n}</b> รายการ` : '· ยังไม่มี'}</span>${fresh ? `<i>ใหม่ ${fresh}</i>` : '<span>›</span>'}</button>`;
}

// new-order alert: sound + vibrate + toast, whatever page is open
const seenOrders = new Set();
let ordersPrimed = false;
function beep() {
  try {
    const ac = beep.ac ||= new (window.AudioContext || window.webkitAudioContext)();
    [0, .22].forEach(t => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(.25, ac.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, ac.currentTime + t + .18); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + .2); });
  } catch {}
}
function watchNewOrders() {
  const fresh = state.orders.filter(o => o.status === 'new' && !seenOrders.has(o.id));
  fresh.forEach(o => seenOrders.add(o.id));
  if (!ordersPrimed) { ordersPrimed = state.mode === 'cloud' && state.syncStatus === 'synced'; return; }
  if (!fresh.length) return;
  beep(); if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  toast(`💚 ออเดอร์ LINE ใหม่ ${fresh.map(o => o.no).join(', ')}`);
}
const orderById = id => state.orders.find(o => o.id === id);
async function orderAction(id, action, msg, reason) {
  try { await S.orderAction(id, action, reason); if (msg) toast(msg); } catch (e) { toast('อัปเดตไม่ได้: ' + e.message); }
}

// ---------- add / edit sheet ----------
let draft = null;
function openSheet(tx) {
  draft = tx ? { ...tx } : { type: 'expense', amount: '', cat: 'food', date: todayISO(), note: '', method: 'cash', source: 'manual' };
  renderSheet();
  $('#sheet').showModal();
  if (!tx) setTimeout(() => $('#sheet [data-d="amount"]')?.focus(), 60);
}
function renderSheet() {
  const d = draft;
  const list = d.type === 'transfer' ? [] : cats().filter(c => c.type === d.type);
  if (d.type === 'transfer') d.cat = 'transfer';
  else if (!list.some(c => c.id === d.cat)) d.cat = list[0]?.id;
  $('#sheet').innerHTML = `<form method="dialog" class="sheet-body" data-form="tx">
    <div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>${d.id ? 'แก้ไขรายการ' : 'จดรายการใหม่'}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    <div class="seg ${d.type}">
      <button type="button" aria-selected="${d.type === 'expense'}" data-action="d-type" data-t="expense">รายจ่าย</button>
      <button type="button" aria-selected="${d.type === 'income'}" data-action="d-type" data-t="income">รายรับ</button>
      <button type="button" aria-selected="${d.type === 'transfer'}" data-action="d-type" data-t="transfer">ย้ายเงิน</button>
    </div>
    <label class="amount ${d.type}"><span>฿</span><input type="number" inputmode="decimal" step="0.01" min="0" placeholder="0" value="${d.amount}" data-d="amount" required aria-label="จำนวนเงิน"></label>
    ${d.type === 'transfer'
      ? `<p class="g-note">🔄 โอนระหว่างบัญชีของคุณเอง หรือชำระบัตรเครดิต · <b>ไม่นับ</b>เป็นรายรับหรือรายจ่าย</p>`
      : `<div class="cat-grid">${list.map(c => `<button type="button" class="cat ${c.id === d.cat ? 'on' : ''}" data-action="d-cat" data-id="${c.id}">
      <span>${c.emoji}</span><small>${esc(c.name)}</small></button>`).join('')}</div>`}
    <div class="row gap">
      <label class="lbl grow">วันที่<input type="date" value="${d.date}" data-d="date" required></label>
      <label class="lbl grow">ช่องทาง<select data-d="method">${Object.entries(METHODS).map(([k, l]) => `<option value="${k}" ${d.method === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label class="lbl">โน้ต<input type="text" value="${esc(d.note || '')}" placeholder="เช่น ข้าวมันไก่ร้านประจำ" data-d="note"></label>
    ${d.merchant ? `<small class="muted">ผู้รับ: ${esc(d.merchant)}${d.ref ? ' · อ้างอิง ' + esc(d.ref) : ''}</small>` : ''}
    ${/^https:\/\/drive\.google\.com\//.test(d.slipUrl || '') ? `<a class="btn ghost sm" href="${esc(d.slipUrl)}" target="_blank" rel="noopener">📎 ดูสลิปใน Google Drive</a>` : ''}
    <div class="row gap">
      ${d.id ? `<button type="button" class="btn danger" data-action="d-delete">ลบ</button>` : ''}
      <button type="submit" class="btn primary big grow">บันทึก</button>
    </div>
  </form>`;
}

// ==================== หน้าขาย (POS) ====================
// a menu saved before drink styles existed: default drinks named "…ปั่น" get the new ปั่น/เย็น/ร้อน prices (their saved price stays the ปั่น price)
// toppings and snacks have one price (no ปั่น/เย็น/ร้อน); drinks are counted in แก้ว, snacks in ชิ้น
const single = g => g === 'topping' || g === 'snack';
const isDrinkItem = m => !!m && !single(m.group);
const upgradeItem = m => {
  if (m.prices || single(m.group)) return m;
  const d = S.DEFAULT_MENU.find(x => x.id === m.id);
  if (d && d.group === 'drink' && m.name === d.name + 'ปั่น') return { ...m, name: d.name, prices: { ...d.prices, blend: m.price } };
  return m;
};
const menu = () => state.settings.menu ? state.settings.menu.map(upgradeItem) : S.DEFAULT_MENU;
const menuItem = id => menu().find(m => m.id === id);
const nowHM = () => new Date().toTimeString().slice(0, 5);
// drink styles: each menu item may offer some of these, each with its own price (item.prices)
const STYLES = S.STYLES;
const stylesOf = m => single(m.group) || !m.prices ? [] : Object.keys(STYLES).filter(k => Number(m.prices[k]) > 0);
const priceOf = (m, style) => (style && Number(m.prices?.[style])) || Number(m.price) || 0;
const lineName = (m, style) => style && stylesOf(m).length > 1 ? `${m.name} ${STYLES[style].word}` : m.name;
const priceRange = m => {
  const p = stylesOf(m).map(k => Number(m.prices[k]));
  if (p.length < 2) return baht(p[0] || m.price);
  const lo = Math.min(...p), hi = Math.max(...p);
  return lo === hi ? baht(lo) : `฿${lo}–${hi}`;
};
const cartLines = () => ui.cart.map(l => ({ ...l, item: menuItem(l.id) })).filter(l => l.item)
  .map(l => ({ ...l, price: priceOf(l.item, l.style), name: lineName(l.item, l.style) }));
const cartTotal = () => cartLines().reduce((s, l) => s + l.price * l.qty, 0);
const cartCups = () => cartLines().filter(l => isDrinkItem(l.item)).reduce((s, l) => s + l.qty, 0);
const cartPieces = () => cartLines().filter(l => l.item.group === 'snack').reduce((s, l) => s + l.qty, 0);
const cartCount = () => [cartCups() ? `${cartCups()} แก้ว` : '', cartPieces() ? `${cartPieces()} ชิ้น` : ''].filter(Boolean).join(' · ') || '0 แก้ว';
const todaySales = () => state.tx.filter(t => t.source === 'pos' && t.date === todayISO())
  .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

const posKey = l => `${l.id}|${l.style || ''}|${l.sweet ?? ''}|${l.note || ''}`;
function cartAdd(id, n = 1, style = '', sweet, note = '') {
  const add = { id, style, ...(sweet !== undefined ? { sweet } : {}), ...(note ? { note } : {}) };
  const l = ui.cart.find(x => posKey(x) === posKey(add));
  if (l) l.qty += n; else if (n > 0) ui.cart.push({ ...add, qty: n });
  if (n > 0) (l || ui.cart[ui.cart.length - 1]).t = Date.now();
  ui.cart = ui.cart.filter(x => x.qty > 0);
}
// "−" on a tile: take back the most recent tap of that item (whatever style it was)
function cartUndo(id) {
  const l = ui.cart.filter(x => x.id === id).sort((a, b) => (b.t || 0) - (a.t || 0))[0];
  if (l) cartAdd(id, -1, l.style || '', l.sweet, l.note);
}
// ask sweetness and a note (e.g. แยกน้ำแข็ง) when selling at the counter (setting; on by default)
const askOpts = m => isDrinkItem(m) && m.opts !== false && state.settings.posOpts !== false;
function openPick(m) {
  ui.pick = { id: m.id, style: stylesOf(m)[0] || '', sweet: 100, note: '' };
  renderPick();
  if (!$('#sheet').open) $('#sheet').showModal();
}
function renderPick() {
  const p = ui.pick, m = menuItem(p.id);
  if (!m) return $('#sheet').close();
  const st = stylesOf(m);
  $('#sheet').innerHTML = `<div class="sheet-body pick">
    <div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>${m.emoji} ${esc(m.name)}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    ${st.length > 1 ? `<div class="seg">${st.map(k => `<button aria-selected="${p.style === k}" data-action="pick-style" data-s="${k}">${STYLES[k].emoji} ${STYLES[k].word} <b class="num">${baht(m.prices[k])}</b></button>`).join('')}</div>` : ''}
    <div><small class="muted">ความหวาน</small><div class="seg">${[0, 25, 50, 100].map(v => `<button aria-selected="${p.sweet === v}" data-action="pick-sweet" data-v="${v}">${v}%</button>`).join('')}</div></div>
    <label class="lbl">📝 หมายเหตุแก้วนี้ (ถ้ามี)<input maxlength="60" placeholder="เช่น แยกน้ำแข็ง น้ำแข็งน้อย ไม่ใส่วิป" value="${esc(p.note)}" data-input="pick-note"></label>
    <button class="btn primary big" data-action="pick-add">＋ ใส่ตะกร้า · ${baht(priceOf(m, p.style))}</button>
  </div>`;
}
function setSoldOut(id, soldOut) {
  S.saveSettings({ menu: menu().map(m => {
    if (m.id !== id) return m;
    const { soldOut: _, ...rest } = m;
    return soldOut ? { ...rest, soldOut: true } : rest;
  }) });
}
function tapMenu(id) {
  const m = menuItem(id); if (!m) return;
  if (!ui.soldMode && !m.soldOut && askOpts(m)) return openPick(m);
  if (ui.soldMode) { setSoldOut(id, !m.soldOut); toast(m.soldOut ? `${m.name} · มีของแล้ว ✅` : `${m.name} · หมด 🚫`); return render(); }
  if (m.soldOut) return toast(`${m.name} หมดอยู่ · แตะ 🚫 ของหมด เพื่อเปิดขายอีกครั้ง`);
  const st = stylesOf(m);
  if (st.length > 1) return openStylePicker(m);
  cartAdd(id, 1, st[0] || '');
  if (navigator.vibrate) navigator.vibrate(10);
  render();
}
function openStylePicker(m) {
  const st = stylesOf(m);
  $('#sheet').innerHTML = `<div class="sheet-body">
    <div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>${m.emoji} ${esc(m.name)}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    <div class="style-pick">${st.map(k => `<button class="style-btn" data-action="style-add" data-id="${m.id}" data-s="${k}">
      <span class="m-emoji">${STYLES[k].emoji}</span><span>${STYLES[k].word}</span><b class="num">${baht(m.prices[k])}</b>
      ${(ui.cart.find(l => l.id === m.id && l.style === k)?.qty) ? `<i class="m-qty">${ui.cart.find(l => l.id === m.id && l.style === k).qty}</i>` : ''}</button>`).join('')}</div>
  </div>`;
  if (!$('#sheet').open) $('#sheet').showModal();
}

function viewSell() {
  const tab = ui.sellTab;
  const drinks = menu().filter(m => m.group !== 'topping' && m.active !== false && (tab === 'all' || m.group === tab));
  const toppings = menu().filter(m => m.group === 'topping' && m.active !== false);
  const hasSnacks = menu().some(m => m.group === 'snack' && m.active !== false);
  const soldMode = ui.soldMode;
  const qtyOf = id => ui.cart.filter(l => l.id === id).reduce((s, l) => s + l.qty, 0);
  const styleNote = m => stylesOf(m).length > 1 ? ui.cart.filter(l => l.id === m.id && l.style)
    .map(l => `${STYLES[l.style].word}${l.qty > 1 ? '×' + l.qty : ''}`).join(' ') : '';
  const sales = todaySales();
  const total = cartTotal();
  return `${header('ขาย')}
    ${lineBanner()}
    <p class="small muted sell-today">วันนี้ขายแล้ว <b>${sales.length}</b> บิล · <b class="num">${baht(sales.reduce((s, t) => s + amt(t), 0))}</b>
      ${sales.length ? `· <button class="link small" data-action="bills-toggle">${ui.showBills ? 'ซ่อนบิล' : 'ดูบิลวันนี้'}</button>` : ''}</p>
    <div class="seg sell-tabs">${[['all', 'ทั้งหมด'], ['fruit', S.MENU_GROUPS.fruit], ['drink', S.MENU_GROUPS.drink], ...(hasSnacks ? [['snack', S.MENU_GROUPS.snack]] : [])].map(([k, l]) =>
      `<button aria-selected="${tab === k}" data-action="sell-tab" data-t="${k}">${l}</button>`).join('')}</div>
    <div class="row between sold-bar ${soldMode ? 'on' : ''}"><small>${soldMode ? '🚫 แตะเมนูเพื่อสลับ <b>หมด / มีของ</b> · ลูกค้าใน LINE เห็นทันที' : ''}</small>
      <button class="btn ${soldMode ? 'primary' : 'ghost'} sm" data-action="sold-mode">${soldMode ? '✓ เสร็จ' : '🚫 ของหมด'}</button></div>
    <div class="menu-grid">${drinks.map(m => { const q = qtyOf(m.id), note = styleNote(m); return `<div class="menu-cell">
      <button class="menu-btn ${q ? 'in' : ''} ${m.soldOut ? 'sold' : ''}" data-action="sell-add" data-id="${m.id}">
      <span class="m-emoji">${m.emoji}</span><span class="m-name">${esc(m.name)}</span>
      ${m.soldOut ? '<span class="sold-tag">หมด</span>' : note ? `<span class="m-note">${note}</span>` : `<b class="num">${priceRange(m)}</b>`}
      ${q ? `<i class="m-qty">${q}</i>` : ''}</button>
      ${q ? `<button class="m-minus" data-action="sell-undo" data-id="${m.id}" aria-label="ลด ${esc(m.name)} 1">−</button>` : ''}</div>`; }).join('')
      || '<p class="muted center pad">ยังไม่มีเมนู เพิ่มได้ที่ ⚙️ ตั้งค่า › เมนูร้าน</p>'}</div>
    ${toppings.length ? `<div class="top-row"><small class="muted">ท็อปปิ้ง</small>${toppings.map(m => { const q = qtyOf(m.id); return `<span class="top-wrap">
      <button class="chip top-chip ${q ? 'in' : ''} ${m.soldOut ? 'sold' : ''}" data-action="sell-add" data-id="${m.id}">${m.emoji} ${esc(m.name)} ${m.soldOut ? '· หมด' : `+${m.price}`}${q ? ` <b>×${q}</b>` : ''}</button>
      ${q ? `<button class="chip top-minus" data-action="sell-undo" data-id="${m.id}" aria-label="ลด ${esc(m.name)} 1">−</button>` : ''}</span>`; }).join('')}</div>` : ''}
    ${ui.showBills && sales.length ? `<section class="card bills"><h3>🧾 บิลวันนี้</h3><ul>${sales.map(t => `<li>
      <button class="bill-row" data-action="bill-open" data-id="${esc(t.id)}"><span class="num">${esc(t.time || '')}</span>
      <span class="grow">${esc(t.merchant || '')}</span><span>${METHODS[t.method]?.split(' ')[0] || ''}</span><b class="num">${baht(t.amount)}</b></button></li>`).join('')}</ul></section>` : ''}
    <div class="cart-spacer"></div>
    ${ui.cart.length ? `<div class="cart-bar">
      <button class="cart-sum" data-action="cart-open"><b>🧾 ${cartCount()}</b><span class="num">${baht(total)}</span></button>
      <button class="btn primary cart-pay" data-action="pay-open">ชำระเงิน ▶</button>
    </div>` : ''}`;
}

function openCartSheet() {
  const lines = cartLines();
  $('#sheet').innerHTML = `<div class="sheet-body">
    <div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>🧾 ตะกร้า</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    <ul class="cart-lines">${lines.map(l => `<li><span>${l.item.emoji} ${esc(l.name)} ${optTags(l)}</span>
      <span class="qty"><button class="icon-btn" data-action="cart-dec" data-k="${esc(posKey(l))}" aria-label="ลด">−</button><b>${l.qty}</b>
      <button class="icon-btn" data-action="cart-inc" data-k="${esc(posKey(l))}" aria-label="เพิ่ม">+</button></span>
      <b class="num">${baht(l.price * l.qty)}</b></li>`).join('') || '<li class="muted">ตะกร้าว่าง</li>'}</ul>
    <div class="close-total"><span>รวม ${cartCount()}</span><b class="num">${baht(cartTotal())}</b></div>
    <div class="row gap"><button class="btn danger" data-action="cart-clear">ล้างตะกร้า</button>
      <button class="btn primary big grow" data-action="pay-open" ${lines.length ? '' : 'disabled'}>ชำระเงิน ▶</button></div>
  </div>`;
  if (!$('#sheet').open) $('#sheet').showModal();
}

function openPaySheet() {
  if (!ui.cart.length) return;
  ui.pay = { method: ui.pay?.method || 'cash', received: '' };
  renderPaySheet();
  if (!$('#sheet').open) $('#sheet').showModal();
}
function renderPaySheet() {
  const total = cartTotal();
  const p = ui.pay;
  const rec = Number(p.received) || 0;
  const change = rec - total;
  const quick = [total, 50, 100, 500, 1000].filter((v, i, a) => (i === 0 || v > total) && a.indexOf(v) === i).slice(0, 5);
  $('#sheet').innerHTML = `<div class="sheet-body pay">
    <div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>ชำระเงิน</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    <div class="pay-total"><small>${cartCount()}</small><b class="num">${baht(total)}</b></div>
    <div class="seg pay-methods">${CHANNELS.map(([k, l]) => `<button aria-selected="${p.method === k}" data-action="pay-method" data-m="${k}">${l}</button>`).join('')}</div>
    ${p.method === 'cash' ? `
      <label class="close-row"><span>รับเงินมา</span><input type="number" inputmode="decimal" min="0" step="1" placeholder="${total}" value="${p.received}" data-pay="received" aria-label="รับเงินมา"></label>
      <div class="quick-cash">${quick.map(v => `<button class="chip" data-action="pay-quick" data-v="${v}">${v === total ? 'พอดี' : '฿' + nf.format(v)}</button>`).join('')}</div>
      <div class="change ${rec && change < 0 ? 'short' : ''}" id="pay-change">${rec ? (change < 0 ? `ขาดอีก ${baht(-change)}` : `เงินทอน <b class="num">${baht(change)}</b>`) : 'แตะยอดที่รับมา หรือกด “พอดี”'}</div>
      <button class="btn primary big" data-action="pay-confirm" ${rec && change < 0 ? 'disabled' : ''}>✅ ยืนยันขาย${rec && change > 0 ? ` · ทอน ${baht(change)}` : ''}</button>`
    : `${p.method === 'promptpay' ? (PP.normalizeId(state.settings.promptpay) ? '<div class="pp-qr" id="pay-qr"><div class="spinner"></div></div><p class="small muted center">ให้ลูกค้าสแกนด้วยแอปธนาคาร ยอดจะขึ้นเอง · เช็กว่าเงินเข้าก่อนกดยืนยัน</p>' : '<p class="g-note">📲 ยังไม่ได้ตั้งเลขพร้อมเพย์ร้าน <button type="button" class="link" data-action="pp-goto">ตั้งค่าตอนนี้</button> · หรือให้ลูกค้าโอนแล้วกดยืนยัน</p>') : '<p class="g-note">📷 ให้ลูกค้าสแกน QR ของร้าน แล้วเช็กว่าเงินเข้าก่อนกดยืนยัน</p>'}
      <button class="btn primary big" data-action="pay-confirm">✅ ได้รับเงินแล้ว · ยืนยันขาย</button>`}
  </div>`;
  const q = $('#pay-qr'); if (q) showQR(q, total);
}
function confirmSale() {
  const lines = cartLines();
  if (!lines.length) return;
  const total = cartTotal();
  const rec = ui.pay.method === 'cash' ? (Number(ui.pay.received) || total) : total;
  if (rec < total) return toast('รับเงินยังไม่ครบ');
  const tx = {
    id: 'pos-' + S.newId(), type: 'income', cat: 'sales', method: ui.pay.method, amount: total,
    date: todayISO(), time: nowHM(), source: 'pos', cups: cartCups(),
    merchant: lines.map(l => { const o = [l.sweet !== undefined && l.sweet !== 100 ? `หวาน ${l.sweet}%` : '', l.note || ''].filter(Boolean).join(' · ');
      return `${l.name}${o ? ` (${o})` : ''}${l.qty > 1 ? '×' + l.qty : ''}`; }).join(', '),
    items: lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, price: l.price, cost: Number(l.item.cost) || 0, ...(l.style ? { style: l.style } : {}),
      ...(l.sweet !== undefined ? { sweet: l.sweet } : {}), ...(l.note ? { note: l.note } : {}) })),
    ...(ui.pay.method === 'cash' ? { received: rec, change: rec - total } : {}),
  };
  S.saveTx(tx);
  ui.cart = [];
  $('#sheet').close();
  toast(`ขายแล้ว ${baht(total)}${tx.change ? ` · ทอน ${baht(tx.change)}` : ''} 🥤`);
  render();
}

function openBillSheet(tx) {
  ui.bill = tx;
  $('#sheet').innerHTML = `<div class="sheet-body">
    <div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>🧾 บิล ${esc(tx.time || '')}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    <p class="small muted">${dayLabel(tx.date)} · ${METHODS[tx.method] || ''}${tx.received ? ` · รับ ${baht(tx.received)} ทอน ${baht(tx.change || 0)}` : ''}${tx.channel === 'line' ? ` · 💚 LINE ${esc(tx.orderNo || '')}` : ''}</p>
    <ul class="cart-lines">${(tx.items || []).map(i => `<li><span>${esc(i.name)} ${optTags(i)}</span><span>×${i.qty}</span><b class="num">${baht(i.price * i.qty)}</b></li>`).join('')}</ul>
    <div class="close-total"><span>รวม</span><b class="num">${baht(tx.amount)}</b></div>
    ${tx.hasSlip ? `<div><small class="muted">🧾 สลิป${tx.qrRef ? ' · ✓ อ่าน QR บนสลิปได้' : ''}</small><div class="slip-box" id="bill-slip"></div></div>`
      : tx.method === 'promptpay' && tx.channel === 'line' ? '<p class="small muted">ลูกค้าไม่ได้แนบสลิป</p>' : ''}
    <button class="btn danger" data-action="bill-void">ยกเลิกบิลนี้</button>
  </div>`;
  if (!$('#sheet').open) $('#sheet').showModal();
  if (tx.hasSlip) showSlipIn($('#bill-slip'), tx.id);
}

// ==================== หน้า "จด" ====================
function repeatCandidates() {
  const seen = new Set(), out = [];
  const list = state.tx.filter(t => t.type === 'expense' && t.source !== 'close')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const t of list) {
    const k = `${t.cat}|${t.merchant || ''}|${t.amount}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}
function viewRecord() {
  const tiles = [['cogs', '🧊', 'ซื้อวัตถุดิบ', 'ผลไม้ นม น้ำแข็ง แก้ว'], ['opex', '🏪', 'ค่าใช้จ่ายร้าน', 'ค่าเช่า ไฟ น้ำ ค่าแรง'], ['invest', '🛠️', 'ลงทุน', 'อุปกรณ์ ตกแต่ง มัดจำ']];
  const rep = repeatCandidates();
  const recent = state.tx.filter(t => t.source !== 'pos' && t.source !== 'close').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
  return `${header('จด')}
    <h3 class="rec-q">จดอะไร?</h3>
    <div class="rec-tiles">${tiles.map(([g, e, n, h]) => `<button class="rec-tile" data-action="rec-new" data-g="${g}"><span>${e}</span><b>${n}</b><small>${h}</small></button>`).join('')}
      <button class="rec-tile scan" data-nav="scan"><span>📷</span><b>อ่านสลิป/ใบเสร็จ</b><small>ให้ AI จดให้</small></button></div>
    ${rep.length ? `<section class="card"><h3>⚡ จดซ้ำ (แตะเดียวจดเป็นของวันนี้)</h3><div class="chips">${rep.map(t => `<button class="chip" data-action="rec-repeat" data-id="${esc(t.id)}">
      ${catById(t.cat).emoji} ${esc(t.merchant || catById(t.cat).name)} <b class="num">${baht(t.amount)}</b></button>`).join('')}</div></section>` : ''}
    <section class="card"><h3>อื่นๆ</h3><div class="chips">
      <button class="chip" data-action="rec-new" data-g="income">💰 รายรับอื่น</button>
      <button class="chip" data-action="rec-new" data-g="owner" data-dir="in">💼 เจ้าของใส่เงินเข้าร้าน</button>
      <button class="chip" data-action="rec-new" data-g="owner" data-dir="out">🏧 เจ้าของถอนเงินไปใช้</button>
      <button class="chip" data-action="close-open" data-date="${todayISO()}">📒 ปิดยอดขาย (ไม่ได้ใช้หน้าขาย)</button>
    </div></section>
    ${recent.length ? `<section class="day"><div class="day-head"><span>จดล่าสุด</span></div><ul class="txs">${recent.map(txRow).join('')}</ul></section>` : ''}`;
}

// ---------- แบบฟอร์มจด (ตามกลุ่ม) ----------
const FORM = {
  cogs: { title: '🧊 ซื้อวัตถุดิบ', hint: 'ร้าน/ที่ซื้อ เช่น ตลาดผลไม้, Makro' },
  opex: { title: '🏪 ค่าใช้จ่ายร้าน', hint: 'รายละเอียด เช่น ค่าเช่าเดือน พ.ย.' },
  invest: { title: '🛠️ ลงทุน', hint: 'เช่น เครื่องปั่น Otto 2 เครื่อง' },
  income: { title: '💰 รายรับอื่น', hint: 'เช่น ขายลังกระดาษ' },
  owner: { title: '💼 เงินเจ้าของ', hint: 'รายละเอียด (ไม่บังคับ)' },
};
const groupOfTx = t => t.type === 'transfer' ? 'owner' : t.type === 'income' ? 'income' : S.catGroup(catById(t.cat));
const isoShift = n => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

// slip photos are stored small (≈100–300 KB) so they sync through Firestore without Google Drive
async function slipDataUrl(file) {
  const bmp = await createImageBitmap(file);
  for (const [side, q] of [[1400, 0.72], [1100, 0.62], [900, 0.55]]) {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', q);
    if (url.length < 700000) return url;
  }
  throw new Error('รูปใหญ่เกินไป');
}
async function showSlipIn(el, id) {
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const url = await S.getSlipImage(id);
    el.innerHTML = url ? `<img src="${url}" alt="สลิป" data-action="slip-zoom">` : '<p class="small muted">ไม่พบรูปสลิป (อาจยังซิงก์ไม่เสร็จ)</p>';
  } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

function openEntry(tx, group = 'cogs', dir = 'in') {
  if (tx?.source === 'pos') return openBillSheet(tx);
  if (tx) draft = { ...tx, group: groupOfTx(tx), dir: /ถอน/.test(tx.note || tx.merchant || '') ? 'out' : 'in' };
  else {
    const first = cats().find(c => (group === 'income' ? c.type === 'income' && c.id !== 'sales' && c.id !== 'delivery' : S.catGroup(c) === group));
    draft = { group, dir, type: group === 'owner' ? 'transfer' : group === 'income' ? 'income' : 'expense',
      cat: group === 'owner' ? 'transfer' : group === 'income' ? 'inc_other' : first?.id, amount: '', date: todayISO(), method: 'cash', merchant: '', note: '', source: 'manual' };
  }
  renderEntry();
  if (!$('#sheet').open) $('#sheet').showModal();
  if (!tx) setTimeout(() => $('#sheet [data-d="amount"]')?.focus(), 60);
}
function renderEntry() {
  const d = draft;
  const F = FORM[d.group];
  const catList = d.group === 'owner' ? [] : d.group === 'income' ? cats().filter(c => c.type === 'income') : cats().filter(c => S.catGroup(c) === d.group);
  if (d.group !== 'owner' && !catList.some(c => c.id === d.cat)) d.cat = catList[0]?.id;
  const methods = d.group === 'income' ? [['cash', '💵 เงินสด'], ['promptpay', '📲 พร้อมเพย์'], ['scan', '📷 สแกน'], ['transfer', '🏦 โอน']] : [['cash', '💵 เงินสด'], ['transfer', '🏦 โอน']];
  const suggest = [...new Set(state.tx.filter(t => t.merchant && t.source !== 'pos' && t.source !== 'close' && groupOfTx(t) === d.group).map(t => t.merchant))].slice(0, 12);
  const isToday = d.date === todayISO(), isYesterday = d.date === isoShift(-1);
  $('#sheet').innerHTML = `<form method="dialog" class="sheet-body" data-form="entry">
    <div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>${d.id ? 'แก้ไข · ' : ''}${F.title}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    ${['cogs', 'opex', 'invest'].includes(d.group) && d.id ? `<div class="seg">${['cogs', 'opex', 'invest'].map(g => `<button type="button" aria-selected="${d.group === g}" data-action="e-group" data-g="${g}">${FORM[g].title}</button>`).join('')}</div>` : ''}
    ${d.group === 'owner' ? `<div class="seg">${[['in', '💼 ใส่เงินเข้าร้าน'], ['out', '🏧 ถอนเงินไปใช้']].map(([k, l]) => `<button type="button" aria-selected="${d.dir === k}" data-action="e-dir" data-v="${k}">${l}</button>`).join('')}</div>
      <p class="g-note">ไม่นับเป็นรายรับหรือรายจ่ายของร้าน</p>` : ''}
    <label class="amount ${d.type}"><span>฿</span><input type="number" inputmode="decimal" step="0.01" min="0" placeholder="0" value="${d.amount}" data-d="amount" required aria-label="จำนวนเงิน"></label>
    ${catList.length ? `<div class="cat-grid">${catList.map(c => `<button type="button" class="cat ${c.id === d.cat ? 'on' : ''}" data-action="d-cat" data-id="${c.id}">
      <span>${c.emoji}</span><small>${esc(c.name)}</small></button>`).join('')}</div>` : ''}
    <div class="chips">${methods.map(([k, l]) => `<button type="button" class="chip ${d.method === k ? 'on' : ''}" data-action="e-method" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="chips date-chips">
      <button type="button" class="chip ${isToday ? 'on' : ''}" data-action="e-date" data-v="0">วันนี้</button>
      <button type="button" class="chip ${isYesterday ? 'on' : ''}" data-action="e-date" data-v="-1">เมื่อวาน</button>
      <input type="date" class="date-pick ${!isToday && !isYesterday ? 'on' : ''}" value="${d.date}" data-d="date" aria-label="เลือกวัน">
    </div>
    <input type="text" list="merchant-list" value="${esc(d.merchant || '')}" placeholder="${F.hint}" data-d="merchant" aria-label="รายละเอียด">
    <datalist id="merchant-list">${suggest.map(m => `<option value="${esc(m)}"></option>`).join('')}</datalist>
    ${/^https:\/\/drive\.google\.com\//.test(d.slipUrl || '') ? `<a class="btn ghost sm" href="${esc(d.slipUrl)}" target="_blank" rel="noopener">📎 ดูสลิปใน Google Drive</a>` : ''}
    ${d.group === 'owner' ? '' : `<div class="slip-attach">
      ${d.slipData ? `<div class="slip-box"><img src="${d.slipData}" alt="สลิปที่แนบ" data-action="slip-zoom"></div>`
        : d.hasSlip && !d.slipRemove ? `<div class="slip-box" id="slip-box"></div>` : ''}
      <div class="row gap">
        <label class="btn ghost sm grow"><input type="file" accept="image/*" data-input="slip" hidden>📎 ${d.slipData || (d.hasSlip && !d.slipRemove) ? 'เปลี่ยนรูปสลิป' : 'แนบสลิป / ใบเสร็จ'}</label>
        ${d.slipData || (d.hasSlip && !d.slipRemove) ? '<button type="button" class="btn ghost sm" data-action="slip-remove">เอาออก</button>' : ''}
      </div></div>`}
    <div class="row gap">
      ${d.id ? `<button type="button" class="btn danger" data-action="d-delete">ลบ</button>` : ''}
      <button type="submit" class="btn primary big grow">บันทึก</button>
    </div>
  </form>`;
  const box = $('#slip-box'); if (box && draft.id) showSlipIn(box, draft.id);
}
function saveEntry() {
  const d = draft;
  const amount = Math.round((Number(d.amount) || 0) * 100) / 100;
  if (!(amount > 0)) return toast('ใส่จำนวนเงินก่อน');
  const ownerLabel = d.dir === 'out' ? 'เจ้าของถอนเงินไปใช้' : 'เจ้าของใส่เงินเข้าร้าน';
  const { group, dir, slipData, slipRemove, ...rest } = d;
  if (slipData) rest.hasSlip = true; else if (slipRemove) delete rest.hasSlip;
  const tx = { ...rest, amount,
    ...(group === 'owner' ? { type: 'transfer', cat: 'transfer', note: ownerLabel, merchant: d.merchant || ownerLabel } : {}),
    ...(group === 'income' ? { type: 'income' } : {}),
    ...(['cogs', 'opex', 'invest'].includes(group) ? { type: 'expense' } : {}) };
  const saved = S.saveTx(tx);
  if (slipData) S.saveSlipImage(saved.id, slipData).catch(e => toast('❌ เก็บสลิปไม่สำเร็จ: ' + e.message));
  else if (slipRemove) S.deleteSlipImage(saved.id);
  ui.month = d.date.slice(0, 7);
  $('#sheet').close();
  toast(d.id ? 'แก้ไขแล้ว' : `จดแล้ว · ${catById(tx.cat).name} ${baht(amount)}`);
}

// ---------- ตั้งค่า: เมนูร้าน ----------
let menuDraft = null;
function menuCard() {
  const groups = Object.entries(S.MENU_GROUPS);
  return `<section class="card" id="menu"><h3>🧋 เมนูร้าน</h3>
    <p class="muted small">แตะเมนูเพื่อแก้ราคา (ปั่น / เย็น / ร้อน) ต้นทุน หรือพักขาย · ใช้ในหน้า 🛒 ขาย</p>
    <label class="check"><input type="checkbox" data-input="posopts" ${state.settings.posOpts !== false ? 'checked' : ''}> ถามความหวานและหมายเหตุตอนขายหน้าร้าน</label>
    ${groups.map(([g, label]) => `<div class="row between"><small class="muted">${label}</small>
      <button class="link small" data-action="menu-new" data-g="${g}">+ เพิ่ม</button></div>
      <div class="chips">${menu().filter(m => m.group === g).map(m => `<button class="chip edit ${m.active === false ? 'off' : ''}" data-action="menu-edit" data-id="${m.id}">
        ${m.emoji} ${esc(m.name)}${m.photo ? ' 📷' : ''} <b class="num">${single(m.group) ? m.price : priceRange(m).replace('฿', '')}</b>${m.active === false ? ' · พัก' : ''}${m.soldOut ? ' · หมด' : ''}</button>`).join('')}</div>`).join('')}
  </section>`;
}
// drink options (sweetness / ice on the side) as small tags, e.g. on order cards and bills
const optTags = i => [i.sweet !== undefined && i.sweet !== 100 ? `<span class="opt-tag">🍯 หวาน ${i.sweet}%</span>` : '',
  i.iceSep ? '<span class="opt-tag">🧊 แยกน้ำแข็ง</span>' : '', i.note ? `<span class="opt-tag">📝 ${esc(i.note)}</span>` : ''].join('');
// centre crop to w×h (menu 600×600, banner 1200×600), JPEG so LINE chat cards can show it too — ~40–80 KB
async function photoData(file, w = 600, h = 600) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(bmp.width / w, bmp.height / h), sw = w * k, sh = h * k;
  const scale = Math.min(1, bmp.width / w, bmp.height / h);
  const c = document.createElement('canvas'); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, c.width, c.height);
  for (const q of [0.82, 0.7, 0.55]) { const url = c.toDataURL('image/jpeg', q); if (url.length < 400000) return url; }
  throw new Error('รูปใหญ่เกินไป');
}
const menuPhotoData = file => photoData(file, 600, 600);

function openMenuEditor(id, group) {
  const m = id && menuItem(id);
  menuDraft = m ? { ...m, isNew: false } : { id: 'm_' + S.newId(), name: '', emoji: group === 'topping' ? '✨' : group === 'snack' ? '🍰' : '🥤', price: '', cost: '', group: group || 'fruit', active: true, isNew: true };
  // style prices as editable strings; an item without styles shows its price under ปั่น
  menuDraft.sp = Object.fromEntries(Object.keys(STYLES).map(k => [k, m?.prices ? (m.prices[k] ?? '') : (k === 'blend' && m ? m.price : '')]));
  renderMenuEditor();
  if (!$('#sheet').open) $('#sheet').showModal();
}
function renderMenuEditor() {
  const d = menuDraft;
  $('#sheet').innerHTML = `<form method="dialog" class="sheet-body" data-form="menu">
    <div class="grab" aria-hidden="true"></div>
    <div class="row between"><h2>${d.isNew ? 'เพิ่มเมนู' : 'แก้ไขเมนู'}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
    <div class="seg">${Object.entries(S.MENU_GROUPS).map(([g, l]) => `<button type="button" aria-selected="${d.group === g}" data-action="mn-group" data-g="${g}">${l}</button>`).join('')}</div>
    <div class="row gap">
      <input class="w-emoji ce-emoji" value="${esc(d.emoji)}" data-mn="emoji" maxlength="8" aria-label="อีโมจิ">
      <input class="grow" value="${esc(d.name)}" data-mn="name" placeholder="ชื่อเมนู เช่น เสาวรสปั่น" required maxlength="40" aria-label="ชื่อเมนู">
    </div>
    ${single(d.group) ? `<div class="row gap">
      <label class="lbl grow">ราคาขาย (บาท)<input type="number" inputmode="decimal" min="0" step="1" value="${d.price}" data-mn="price" required></label>
      <label class="lbl grow">ต้นทุน (ไม่บังคับ)<input type="number" inputmode="decimal" min="0" step="0.5" value="${d.cost ?? ''}" data-mn="cost"></label>
    </div>` : `<div class="lbl">ราคาตามแบบ (เว้นว่าง = ไม่มีแบบนั้น)</div>
    <div class="row gap style-prices">${Object.entries(STYLES).map(([k, st]) => `<label class="lbl grow">${st.emoji} ${st.word}
      <input type="number" inputmode="decimal" min="0" step="1" placeholder="—" value="${d.sp[k]}" data-sp="${k}"></label>`).join('')}</div>
    <label class="lbl">ต้นทุน/แก้ว โดยประมาณ (ไม่บังคับ)<input type="number" inputmode="decimal" min="0" step="0.5" value="${d.cost ?? ''}" data-mn="cost"></label>`}
    <div class="mn-photo">
      ${d.photoData || (d.photo && !d.photoRemove) ? `<img src="${d.photoData || S.photoUrl(d.id, d.photo)}" alt="รูป ${esc(d.name)}">` : `<span class="mn-photo-empty">${esc(d.emoji || '📷')}</span>`}
      <div class="grow">
        <label class="btn ghost sm">📷 ${d.photoData || (d.photo && !d.photoRemove) ? 'เปลี่ยนรูป' : 'เพิ่มรูปสินค้า'}<input type="file" accept="image/*" data-input="mnphoto" hidden></label>
        ${d.photoData || (d.photo && !d.photoRemove) ? '<button type="button" class="link small" data-action="mn-photo-remove">ลบรูป</button>' : ''}
        <p class="small muted" style="margin:6px 0 0">ลูกค้าเห็นรูปนี้ในหน้าสั่ง · ระบบครอปเป็นสี่เหลี่ยมและย่อให้เอง</p>
      </div>
    </div>
    <label class="lbl">คำอธิบายสั้นๆ (ลูกค้าเห็น · ไม่บังคับ)<input value="${esc(d.desc || '')}" data-mn="desc" maxlength="120" placeholder="เช่น มะม่วงน้ำดอกไม้สุก หวานธรรมชาติ"></label>
    ${!single(d.group) ? `<label class="check"><input type="checkbox" data-mn="opts" ${d.opts !== false ? 'checked' : ''}> ให้ลูกค้าเลือกความหวาน (0–100%)</label>` : ''}
    <label class="check"><input type="checkbox" data-mn="soldOut" ${d.soldOut ? 'checked' : ''}> 🚫 หมดชั่วคราว (ลูกค้ายังเห็นเมนู แต่สั่งไม่ได้)</label>
    <label class="check"><input type="checkbox" data-mn="active" ${d.active !== false ? 'checked' : ''}> เปิดขาย (เอาเครื่องหมายออกเพื่อพักขายชั่วคราว)</label>
    <div class="emoji-grid">${EMOJIS.map(e => `<button type="button" class="${e === d.emoji ? 'on' : ''}" data-action="mn-emoji" data-e="${e}">${e}</button>`).join('')}</div>
    <div class="row gap">
      ${d.isNew ? '' : `<button type="button" class="btn danger" data-action="mn-delete">ลบเมนู</button>`}
      <button type="submit" class="btn primary big grow">${d.isNew ? 'เพิ่มเมนู' : 'บันทึก'}</button>
    </div>
  </form>`;
}
async function saveMenuItem() {
  const d = menuDraft;
  if (!d.name.trim()) return toast('ใส่ชื่อเมนูก่อน');
  const prices = {};
  if (!single(d.group)) for (const k of Object.keys(STYLES)) if (Number(d.sp[k]) > 0) prices[k] = Number(d.sp[k]);
  // an item moved from drinks to snacks/toppings keeps its first price as the single price
  const price = single(d.group) ? Number(d.price) || Number(Object.values(d.sp || {}).find(v => Number(v) > 0)) || 0 : Number(Object.values(prices)[0]);
  if (!(price > 0)) return toast(single(d.group) ? 'ใส่ราคาก่อน' : 'ใส่ราคาอย่างน้อย 1 แบบ');
  let photo = d.photoRemove ? 0 : d.photo || 0;
  try {
    if (d.photoData) { toast('กำลังอัปโหลดรูป…'); photo = await S.saveMenuPhoto(d.id, d.photoData); d.photoType = 'jpeg'; }
    else if (d.photoRemove && d.photo) await S.deleteMenuPhoto(d.id);
  } catch (e) { return toast('อัปโหลดรูปไม่ได้: ' + e.message); }
  const desc = String(d.desc || '').trim().slice(0, 120);
  const item = { id: d.id, name: d.name.trim(), emoji: d.emoji.trim() || '🥤', price, cost: Number(d.cost) || 0, group: d.group, active: d.active !== false,
    ...(!single(d.group) ? { prices, ...(d.opts === false ? { opts: false } : {}) } : {}), ...(desc ? { desc } : {}), ...(photo ? { photo, ...(d.photoType ? { photoType: d.photoType } : {}) } : {}), ...(d.soldOut ? { soldOut: true } : {}) };
  // a menu item's id stays the same, so drop cart lines whose style was removed
  ui.cart = ui.cart.filter(l => l.id !== d.id || !l.style || prices[l.style]);
  const list = d.isNew ? [...menu(), item] : menu().map(m => m.id === d.id ? item : m);
  S.saveSettings({ menu: list });
  $('#sheet').close();
  toast(d.isNew ? 'เพิ่มเมนูแล้ว' : 'บันทึกเมนูแล้ว');
}

// ---------- scan ----------
function isDup(it, existing) {
  return existing.some(t => (it.qrRef && t.qrRef === it.qrRef) || (it.ref && t.ref && t.ref === it.ref) ||
    (t.date === it.date && Number(t.amount) === Number(it.amount) && t.type === it.type && (t.merchant || '') === (it.merchant || '') && (t.time || '') === (it.time || '')));
}
// ---------- picking slips: tray with thumbnails ----------
const OK_FILE = f => /^image\//.test(f.type) || f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
function addToTray(files) {
  const add = [...files].filter(OK_FILE)
    .filter(f => !ui.tray.some(t => t.file.name === f.name && t.file.size === f.size && t.file.lastModified === f.lastModified));
  if (!add.length) { if (files.length) toast('รองรับเฉพาะรูปภาพและ PDF'); return; }
  ui.tray.push(...add.map(file => ({ file, url: /^image\//.test(file.type) ? URL.createObjectURL(file) : '' })));
  if (ui.view !== 'scan') ui.view = 'scan';
  render();
}
function clearTray(keep = []) {
  ui.tray.forEach(t => { if (!keep.includes(t) && t.url) URL.revokeObjectURL(t.url); });
  ui.tray = keep;
}
async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    const files = [];
    for (const it of items) {
      const type = it.types.find(t => /^image\//.test(t));
      if (type) { const b = await it.getType(type); files.push(new File([b], `วาง-${Date.now()}.${type.split('/')[1]}`, { type })); }
    }
    files.length ? addToTray(files) : toast('ไม่มีรูปในคลิปบอร์ด');
  } catch { toast('วางรูปไม่ได้ ลองกดค้างในช่องแล้วเลือก “วาง” หรือใช้ปุ่มเลือกรูป'); }
}
document.addEventListener('paste', e => {
  if (ui.view !== 'scan' || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addToTray(files); }
});
document.addEventListener('dragover', e => { if (e.target.closest?.('[data-drop]')) { e.preventDefault(); e.target.closest('[data-drop]').classList.add('over'); } });
document.addEventListener('dragleave', e => e.target.closest?.('[data-drop]')?.classList.remove('over'));
document.addEventListener('drop', e => {
  const zone = e.target.closest?.('[data-drop]');
  if (!zone) return;
  e.preventDefault(); zone.classList.remove('over');
  addToTray(e.dataTransfer?.files || []);
});

// One-click Sheet connect: the Sheet's 🐣 menu opens the app with #connect=<web app url>&key=<key>.
// The fragment never reaches a server; it is kept until the account is ready, then removed from the address bar.
function takeConnectLink() {
  const m = location.hash.match(/^#connect=([^&]+)&key=([\w-]+)$/);
  if (m) {
    try { sessionStorage.setItem('jj_connect', JSON.stringify({ webapp: decodeURIComponent(m[1]), key: m[2] })); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
  }
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem('jj_connect') || 'null'); } catch {}
  if (!pending) return;
  ui.view = 'settings';
  if (state.cloudConfigured && !(state.mode === 'cloud' && state.syncStatus === 'synced')) {
    if (state.syncStatus === 'signed-out' && !takeConnectLink.told) { takeConnectLink.told = true; toast('ล็อกอินก่อน แล้วจุกจิกจะเชื่อม Google Sheet ให้เอง'); render(); }
    return; // try again once the account has loaded
  }
  try { sessionStorage.removeItem('jj_connect'); } catch {}
  if (!confirm(`เชื่อม Google Sheet นี้กับบัญชี ${state.user?.email || 'นี้'}?\n(ถ้าเคยเชื่อมชีตอื่นไว้ จะเปลี่ยนมาใช้ชีตนี้แทน)`)) return render();
  toast('กำลังเชื่อม Google Sheet…');
  Sheet.connectWithKey(pending.webapp, pending.key)
    .then(() => toast(Sheet.sheet.status === 'error' ? '⚠️ ' + Sheet.sheet.msg : 'เชื่อม Google Sheet แล้ว 📗'))
    .catch(err => { Sheet.sheet.status = 'error'; Sheet.sheet.msg = err.message; })
    .finally(() => render());
}
window.addEventListener('hashchange', takeConnectLink);

// Files shared to the app (Android share sheet → "จุกจิก"): the service worker parks them in a cache.
async function takeSharedFiles() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('kaa-share');
    const keys = await cache.keys();
    const files = [];
    for (const req of keys) {
      const res = await cache.match(req);
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-name') || 'slip.jpg');
      files.push(new File([blob], name, { type: blob.type || res.headers.get('content-type') || 'image/jpeg' }));
      await cache.delete(req);
    }
    if (files.length) { ui.view = 'scan'; addToTray(files); toast(`รับ ${files.length} ไฟล์จากการแชร์แล้ว`); }
  } catch (e) { console.warn('share', e); }
}

// Upload saved slips to Google Drive in the background, then link each entry to its file.
let slipQueue = Promise.resolve();
function uploadSlips(pairs) {
  if (!pairs.length) return;
  slipQueue = slipQueue.then(async () => {
    let ok = 0, fail = 0;
    for (const { tx, file } of pairs) {
      try {
        const r = await Sheet.uploadSlip(file, tx, catById(tx.cat).name);
        const cur = state.tx.find(t => t.id === tx.id) || tx;
        S.saveTx({ ...cur, slipUrl: r.url, slipId: r.id });
        ok++;
      } catch (e) { fail++; console.warn('slip upload', e); ui.slipError = e.message; }
      ui.slipNote = `กำลังเก็บสลิปเข้า Google Drive ${ok + fail}/${pairs.length}`;
      if (ui.view === 'scan') { const el = $('#slip-note'); if (el) el.textContent = ui.slipNote; }
    }
    ui.slipNote = '';
    toast(fail ? `เก็บสลิปเข้า Drive ได้ ${ok}/${pairs.length} (${ui.slipError})` : `📁 เก็บสลิปเข้า Google Drive แล้ว ${ok} รูป`);
    if (ui.view === 'scan') render();
  });
}

// When a slip shows a transfer between your own accounts with an unmasked name, remember that name.
function learnOwnerName(list) {
  if (String(state.settings.ownerNames || '').trim()) return;
  const t = list.find(x => x.type === 'transfer' && x.merchant && !/[*xX]{2,}/.test(x.merchant) && /\s/.test(x.merchant.trim()));
  if (!t) return;
  const name = t.merchant.replace(/^(นาย|นางสาว|นาง|น\.ส\.)\s*/, '').trim();
  S.saveSettings({ ownerNames: name });
  toast(`จำชื่อของคุณแล้ว: ${name}`);
}

const scanNote = () => `${ui.scan.note || 'ปกติใช้เวลา 5–20 วินาทีต่อใบ'} · ${Math.round((Date.now() - (ui.scan.started || Date.now())) / 1000)} วินาที`;

async function runScan(files) {
  const sc = ui.scan;
  Object.assign(sc, { busy: true, done: 0, total: files.length, errors: [], skipped: [], note: '', cancel: false, started: Date.now() });
  resetCancel();
  render();
  const ticker = setInterval(() => { const el = $('#scan-note'); if (el) el.textContent = scanNote(); }, 1000);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const cutISO = new Date(cutoff - cutoff.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const queue = [...files];
  const opts = { key: geminiKey(), model: prefs.geminiModel, categories: cats(), today: todayISO(), ownerNames: ownerNames() };
  const seenQR = new Set(sc.items.map(i => i.qrRef).filter(Boolean));
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      if (sc.cancel) { sc.errors.push({ name: f.name, msg: 'ยกเลิกแล้ว', file: f }); sc.done++; continue; }
      sc.note = '';
      try {
        // free on-device QR check first: a slip already saved is skipped without calling Gemini
        const qr = await readSlipQR(f);
        if (qr && (seenQR.has(qr.key) || state.tx.some(t => t.qrRef === qr.key))) {
          sc.skipped.push(f.name); sc.done++; render(); continue;
        }
        if (qr) seenQR.add(qr.key);
        const found = await readFile(f, opts);
        if (!found.length) sc.errors.push({ name: f.name, msg: 'ไม่พบรายการเงินในไฟล์นี้', file: f });
        if (qr && found[0]) Object.assign(found[0], { qrRef: qr.key, ref: found[0].ref || qr.ref });
        if (found[0]) found[0].file = f; // the slip image goes to Drive with its main entry
        found.forEach(t => {
          const it = { ...t, fileName: f.name };
          it.dup = isDup(it, state.tx) || isDup(it, sc.items);
          it.old = it.source === 'slip' && it.date < cutISO;
          it.keep = !it.dup && !(sc.only30 && it.old);
          sc.items.push(it);
        });
      } catch (e) { sc.errors.push({ name: f.name, msg: e.message, file: f }); }
      sc.done++;
      render();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  clearInterval(ticker);
  sc.items.sort((a, b) => b.date.localeCompare(a.date));
  Object.assign(sc, { busy: false, note: '', cancel: false });
  render();
}

// ---------- export / import ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- render ----------
function render() {
  const app = $('#app');
  const onboarding = !prefs.onboarded;
  // private app: nothing is shown until the owner's account is signed in (wait quietly while Firebase starts)
  const privateGate = S.privateApp && state.cloudConfigured && state.syncStatus !== 'local' && (state.mode !== 'cloud' || state.access !== 'ok');
  const gated = privateGate || (state.mode === 'cloud' && state.access !== 'ok');
  document.body.classList.toggle('no-nav', onboarding || gated);
  if (gated && !onboarding) { $('#app').innerHTML = viewGate(); return; }
  const keepScroll = window.scrollY;
  const active = document.activeElement;
  const focusKey = active?.dataset?.input;
  // a sync arriving while a settings field is being edited would wipe what was typed: redraw after the field is left
  // (checkboxes, radios and file pickers hold nothing typed, so they never hold the redraw back)
  if (ui.view === 'settings' && active?.closest?.('#app') && active.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select') && focusKey !== 'search') {
    ui.renderPending = true; return;
  }
  ui.renderPending = false;
  app.innerHTML = onboarding ? viewOnboarding()
    : ui.view === 'stats' ? viewStats() : ui.view === 'scan' ? viewScan() : ui.view === 'settings' ? viewSettings()
    : ui.view === 'sell' ? viewSell() : ui.view === 'orders' ? viewOrders() : ui.view === 'record' ? viewRecord() : viewHome();
  const navKey = ui.view === 'scan' ? 'record' : ui.view === 'orders' ? 'sell' : ui.view;
  const sellTab = document.querySelector('.tabbar [data-nav="sell"]');
  if (sellTab) { const n = newOrderCount(); n ? sellTab.dataset.badge = n : delete sellTab.dataset.badge; }
  document.querySelectorAll('.tabbar [data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === navKey));
  document.body.classList.toggle('has-cart', ui.view === 'sell' && ui.cart.length > 0);
  bindColumnTips(app);
  if (focusKey === 'search') { const el = $('[data-input="search"]'); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }
  window.scrollTo(0, keepScroll);
}

function go(view) {
  if (view === 'scan' && ui.view !== 'scan') history.pushState({ v: 'scan' }, '');
  else if (view !== 'scan' && history.state?.v === 'scan') history.replaceState(null, '');
  ui.view = view; window.scrollTo(0, 0); render();
}
window.addEventListener('popstate', () => { if (ui.view === 'scan') { if ($('#sheet').open) $('#sheet').close(); ui.view = 'record'; window.scrollTo(0, 0); render(); } });

// ---------- events ----------
document.addEventListener('click', async e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { if ($('#sheet').open) $('#sheet').close(); return go(nav.dataset.nav); }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'add': return openEntry(null, 'cogs');
    case 'edit': return openEntry(state.tx.find(t => t.id === el.dataset.id));
    // --- sell ---
    case 'sell-add': return tapMenu(el.dataset.id);
    case 'back': if (history.state?.v === 'scan') return history.back(); return go(el.dataset.to);
    case 'slip-remove': draft.slipData = ''; draft.slipRemove = true; return renderEntry();
    case 'slip-zoom': return el.classList.toggle('zoom');
    case 'top-by': ui.topBy = el.dataset.k; return render();
    case 'top-all': ui.topAll = !ui.topAll; return render();
    case 'sell-undo': cartUndo(el.dataset.id); return render();
    case 'style-add': cartAdd(el.dataset.id, 1, el.dataset.s); if (navigator.vibrate) navigator.vibrate(10); $('#sheet').close(); return render();
    case 'sell-tab': ui.sellTab = el.dataset.t; return render();
    case 'sold-mode': ui.soldMode = !ui.soldMode; return render();
    case 'bills-toggle': ui.showBills = !ui.showBills; return render();
    case 'cart-open': return openCartSheet();
    case 'cart-inc': case 'cart-dec': {
      const l = ui.cart.find(x => posKey(x) === el.dataset.k); if (!l) return;
      cartAdd(l.id, a === 'cart-inc' ? 1 : -1, l.style || '', l.sweet, l.note); render();
      return ui.cart.length ? openCartSheet() : $('#sheet').close();
    }
    case 'pick-style': ui.pick.style = el.dataset.s; return renderPick();
    case 'pick-sweet': ui.pick.sweet = Number(el.dataset.v); return renderPick();
    case 'pick-add': {
      const p = ui.pick; cartAdd(p.id, 1, p.style, p.sweet, String(p.note || '').trim().slice(0, 60));
      if (navigator.vibrate) navigator.vibrate(10); $('#sheet').close(); return render();
    }
    case 'cart-clear': ui.cart = []; $('#sheet').close(); return render();
    case 'pay-open': return openPaySheet();
    case 'pay-method': ui.pay.method = el.dataset.m; return renderPaySheet();
    case 'pay-quick': ui.pay.received = el.dataset.v; return renderPaySheet();
    case 'pay-confirm': return confirmSale();
    // --- LINE OA orders ---
    case 'orders-open': return go('orders');
    case 'line-open': saveLine({ open: !!el.dataset.v }); return toast(el.dataset.v ? 'เปิดรับออเดอร์ LINE แล้ว 🟢' : 'ปิดรับออเดอร์ LINE แล้ว');
    case 'line-save': {
      const v = k => $(`[data-line="${k}"]`)?.value ?? '';
      if (!v('from') || !v('to') || v('from') >= v('to')) return toast('เวลาเปิดต้องก่อนเวลาปิด');
      saveLine({ from: v('from'), to: v('to'), prep: Math.max(0, Number(v('prep')) || 0), stampGoal: Math.max(1, Number(v('stampGoal')) || 10), note: v('note').trim(), name: v('name').trim() });
      return toast('บันทึกการตั้งค่า LINE แล้ว');
    }
    case 'ord-status': return orderAction(el.dataset.id, el.dataset.s, el.dataset.s === 'ready' ? 'แจ้งลูกค้าแล้ว ☕' : 'รับออเดอร์แล้ว');
    case 'push-on': case 'push-test':
      ui.pushBusy = true; render();
      try { await S.pushEnable(); toast('เปิดแจ้งเตือนแล้ว · กำลังส่งแจ้งเตือนทดสอบ 🔔'); } catch (e) { toast(e.message); }
      ui.pushBusy = false; ui.pushState = await S.pushState().catch(() => 'unsupported'); return render();
    case 'push-off': await S.pushDisable().catch(() => {}); ui.pushState = 'off'; toast('ปิดแจ้งเตือนบนเครื่องนี้แล้ว'); return render();
    case 'banner-photo-remove': await S.deleteMenuPhoto('_banner'); saveLine({ banner: { ...(lineCfg().banner || {}), photo: 0 } }); return toast('ลบรูปแบนเนอร์แล้ว');
    case 'line-mode': {
      const m = el.dataset.m, cur = lineModes();
      const next = cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m];
      if (!next.length) return toast('ต้องเปิดอย่างน้อย 1 วิธี');
      saveLine({ modes: Object.keys(FULFIL).filter(k => next.includes(k)) });
      return toast(`${FULFIL[m]} · ${next.includes(m) ? 'เปิด' : 'ปิด'}แล้ว`);
    }
    case 'ord-paid': {
      const o = orderById(el.dataset.id);
      if (!o || !confirm(`เช็กแล้วว่าเงิน ${baht(o.total)} ของ ${o.no} เข้าบัญชีร้าน?`)) return;
      if ($('#sheet').open) $('#sheet').close();
      return orderAction(o.id, 'paid', `${o.no} ชำระแล้ว ✅`);
    }
    case 'ord-cash': {
      const o = orderById(el.dataset.id); if (!o) return;
      return orderAction(o.id, 'cash', `${o.no} รับเงินสด ${baht(o.total)} · บันทึกยอดขายแล้ว`);
    }
    case 'ord-chat': {
      // LINE has no link to one customer's chat: copy the name, open the shop's chat list to search it
      const o = orderById(el.dataset.id); if (!o) return;
      try { await navigator.clipboard.writeText(o.displayName || ''); } catch {}
      window.open('https://chat.line.biz/', '_blank', 'noopener');
      return toast(`คัดลอกชื่อ "${o.displayName || ''}" แล้ว · วางในช่องค้นหาแชทของ LINE OA`);
    }
    case 'ord-slip': {
      const o = orderById(el.dataset.id); if (!o) return;
      $('#sheet').innerHTML = `<div class="sheet-body"><div class="grab" aria-hidden="true"></div>
        <div class="row between"><h2>🧾 สลิป ${esc(o.no)} · ${baht(o.total)}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="ปิด">✕</button></div>
        <p class="small muted">${esc(o.displayName || '')}${o.slipRef ? ' · ✓ อ่าน QR บนสลิปได้ (กันสลิปซ้ำแล้ว)' : ' · อ่าน QR บนสลิปไม่ได้ ตรวจในแอปธนาคารด้วย'}</p>
        <div class="slip-box" id="ord-slip-box"></div>
        ${!o.paid ? `<button class="btn primary big" data-action="ord-paid" data-id="${esc(o.id)}">✓ ยอด ${baht(o.total)} เข้าแล้ว</button>` : ''}
      </div>`;
      if (!$('#sheet').open) $('#sheet').showModal();
      return showSlipIn($('#ord-slip-box'), `line-${o.id}`);
    }
    case 'ord-done': return orderAction(el.dataset.id, 'done', 'ส่งมอบแล้ว · บันทึกยอดขายแล้ว 🥤');
    case 'ord-cancel': {
      const o = orderById(el.dataset.id); if (!o) return;
      const reason = prompt(`ยกเลิก ${o.no}? ใส่เหตุผลถึงลูกค้า (เช่น วัตถุดิบหมด)`, '');
      if (reason === null) return;
      return orderAction(o.id, 'cancel', `ยกเลิก ${o.no} แล้ว`, reason.trim().slice(0, 120));
    }
    case 'pp-save': {
      const v = $('[data-input="ppid"]').value.trim();
      if (v && !PP.normalizeId(v)) return toast('เลขไม่ถูกต้อง ใช้เบอร์มือถือ 10 หลัก หรือเลข 13 หลัก');
      S.saveSettings({ promptpay: v.replace(/\D/g, '') });
      return toast(v ? 'บันทึกพร้อมเพย์ร้านแล้ว' : 'ลบเลขพร้อมเพย์แล้ว');
    }
    case 'pp-test': return showQR($('#pp-preview'), 1);
    case 'pp-goto': $('#sheet').close(); go('settings'); return setTimeout(() => $('#pp')?.scrollIntoView({ behavior: 'smooth' }), 50);
    case 'bill-open': return openBillSheet(state.tx.find(t => t.id === el.dataset.id));
    case 'bill-void': {
      const b = ui.bill;
      if (!b || !confirm(`ยกเลิกบิล ${b.time || ''} ยอด ${baht(b.amount)}?`)) return;
      S.deleteTx(b.id); $('#sheet').close(); return toast('ยกเลิกบิลแล้ว');
    }
    // --- record ---
    case 'rec-new': return openEntry(null, el.dataset.g, el.dataset.dir || 'in');
    case 'rec-repeat': {
      const src = state.tx.find(t => t.id === el.dataset.id);
      if (!src) return;
      const { id, createdAt, updatedAt, slipUrl, slipId, qrRef, ref, ...rest } = src;
      S.saveTx({ ...rest, date: todayISO(), time: '', source: 'manual' });
      return toast(`จดแล้ว · ${src.merchant || catById(src.cat).name} ${baht(src.amount)} (วันนี้)`);
    }
    case 'e-group': draft.group = el.dataset.g; return renderEntry();
    case 'e-dir': draft.dir = el.dataset.v; return renderEntry();
    case 'e-method': draft.method = el.dataset.v; return renderEntry();
    case 'e-date': draft.date = isoShift(Number(el.dataset.v)); return renderEntry();
    // --- menu ---
    case 'menu-new': return openMenuEditor(null, el.dataset.g);
    case 'menu-edit': return openMenuEditor(el.dataset.id);
    case 'mn-group': menuDraft.group = el.dataset.g; return renderMenuEditor();
    case 'mn-emoji': menuDraft.emoji = el.dataset.e; return renderMenuEditor();
    case 'mn-photo-remove': menuDraft.photoData = ''; menuDraft.photoRemove = true; return renderMenuEditor();
    case 'mn-delete':
      if (!confirm(`ลบเมนู ${menuDraft.name}?`)) return;
      S.saveSettings({ menu: menu().filter(m => m.id !== menuDraft.id) }); ui.cart = ui.cart.filter(l => l.id !== menuDraft.id);
      $('#sheet').close(); return toast('ลบเมนูแล้ว');
    case 'close-sheet': return $('#sheet').close();
    case 'close-open': return openCloseSheet(el.dataset.date);
    case 'close-delete':
      if (!confirm(`ลบยอดปิดวันที่ ${shortDay(closeDraft.date)}?`)) return;
      CHANNELS.forEach(([k]) => { const id = closeId(closeDraft.date, k); if (state.tx.some(t => t.id === id)) S.deleteTx(id); });
      { const dr = { ...(state.settings.drawers || {}) }; if (dr[closeDraft.date]) { delete dr[closeDraft.date]; S.saveSettings({ drawers: dr }); } }
      $('#sheet').close(); return toast('ลบยอดปิดวันแล้ว');
    case 'month': {
      const [y, m] = ui.month.split('-').map(Number);
      const d = new Date(y, m - 1 + Number(el.dataset.d), 1);
      ui.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return render();
    }
    case 'stats-type': ui.statsType = el.dataset.t; return render();
    case 'd-type': draft.type = el.dataset.t; return renderSheet();
    case 'd-cat': draft.cat = el.dataset.id; return draft.group ? renderEntry() : renderSheet();
    case 'd-delete':
      if (confirm('ลบรายการนี้?')) { S.deleteTx(draft.id); $('#sheet').close(); toast('ลบแล้ว'); }
      return;
    case 'ob-next': ui.obStep++; return render();
    case 'ob-done': S.savePrefs({ onboarded: true }); return go('home');
    case 'ob-sync': S.savePrefs({ onboarded: true }); return go('settings');
    case 'show-ob': ui.obStep = 0; S.savePrefs({ onboarded: false }); window.scrollTo(0, 0); return render();
    case 'goto-gemini': go('settings'); return $('#gemini')?.scrollIntoView({ behavior: 'smooth' });
    case 'scan-clear': Object.assign(ui.scan, { items: [], errors: [], skipped: [] }); return render();
    case 'scan-cancel': ui.scan.cancel = true; cancelAll(); return render();
    case 'tray-read': { const files = ui.tray.map(t => t.file); clearTray(); if (files.length) runScan(files); return; }
    case 'tray-remove': { const t = ui.tray.splice(Number(el.dataset.i), 1)[0]; if (t?.url) URL.revokeObjectURL(t.url); return render(); }
    case 'tray-clear': clearTray(); return render();
    case 'paste-img': return pasteFromClipboard();
    case 'scan-retry': { const files = ui.scan.errors.map(e => e.file).filter(Boolean); if (files.length) runScan(files); return; }
    case 'scan-save': {
      const chosen = ui.scan.items.filter(i => i.keep);
      const pairs = chosen.map(({ keep, dup, old, fileName, file, ...t }) => ({ tx: { ...t, id: t.id || S.newId() }, file }));
      pairs.forEach(p => { if (p.file && /^image\//.test(p.file.type)) p.tx.hasSlip = true; });
      const n = await S.saveMany(pairs.map(p => p.tx));
      (async () => { for (const p of pairs) if (p.tx.hasSlip) try { await S.saveSlipImage(p.tx.id, await slipDataUrl(p.file)); } catch (e) { console.warn('slip', e); } })();
      ui.scan.items = ui.scan.items.filter(i => !i.keep);
      toast(`บันทึก ${n} รายการแล้ว 🐣`);
      if (pairs[0]) ui.month = pairs[0].tx.date.slice(0, 7);
      learnOwnerName(pairs.map(p => p.tx));
      render();
      if (Sheet.saveSlipsOn()) uploadSlips(pairs.filter(p => p.file));
      return;
    }
    case 'upload-local': { const n = await S.uploadLocalToCloud(); return toast(`อัปขึ้นบัญชีแล้ว ${n} รายการ`); }
    case 'discard-local': if (confirm('ไม่อัปข้อมูลในเครื่องนี้? (ข้อมูลในเครื่องจะถูกลบ)')) S.discardLocalPending(); return;
    case 'auth-mode': ui.authMode = ui.authMode === 'signin' ? 'signup' : 'signin'; ui.authError = ''; return render();
    case 'google':
      try { await S.signInGoogle(); ui.authError = ''; toast('เข้าสู่ระบบแล้ว'); } catch (err) { ui.authError = err.message; render(); }
      return;
    case 'reset-pw': {
      const email = $('[data-form="auth"] [name="email"]')?.value;
      if (!email) { ui.authError = 'กรอกอีเมลก่อน แล้วกด "ลืมรหัสผ่าน"'; return render(); }
      try { await S.resetPassword(email); toast('ส่งลิงก์ตั้งรหัสใหม่ไปที่อีเมลแล้ว'); } catch (err) { ui.authError = err.message; render(); }
      return;
    }
    case 'signout': if (confirm('ออกจากระบบในเครื่องนี้?')) await S.signOut(); return;
    case 'line-login': return lineLogin();
    case 'line-copy': try { await navigator.clipboard.writeText(ui.lineDenied.id); toast('คัดลอกแล้ว'); } catch { toast(ui.lineDenied.id); } return;
    case 'signout-now': await S.signOut(); return;
    case 'gate-recheck':
      ui.gateMsg = 'กำลังตรวจสอบ…'; render();
      try { await S.recheckAccess(); ui.gateMsg = state.access === 'ok' ? '' : (state.access === 'verify' ? 'ยังไม่ได้ยืนยันอีเมล ลองกดลิงก์ในอีเมลก่อน' : 'ยังไม่ได้รับอนุญาต'); }
      catch (err) { ui.gateMsg = err.message; }
      return render();
    case 'gate-resend':
      try { await S.resendVerification(); ui.gateMsg = 'ส่งอีเมลยืนยันอีกครั้งแล้ว'; } catch (err) { ui.gateMsg = err.message; }
      return render();
    case 'gate-copy':
      try { await navigator.clipboard.writeText(state.user?.email || ''); toast('คัดลอกอีเมลแล้ว'); } catch { toast(state.user?.email || ''); }
      return;
    case 'allow-remove':
      if (!confirm(`เอา ${el.dataset.e} ออกจากรายชื่อ? (ข้อมูลของเขายังอยู่ แต่จะเข้าใช้ไม่ได้)`)) return;
      try { await S.removeEmail(el.dataset.e); toast('เอาออกแล้ว'); } catch (err) { toast('❌ ' + err.message); }
      return;
    case 'allow-invite': {
      const a = state.allowList.find(x => x.email === el.dataset.e);
      const text = inviteText(a?.name);
      try { if (navigator.share) await navigator.share({ title: 'ชวนใช้จุกจิก', text }); else { await navigator.clipboard.writeText(text); toast('คัดลอกข้อความชวนแล้ว ส่งทาง LINE ได้เลย'); } }
      catch (err) { if (err?.name !== 'AbortError') { try { await navigator.clipboard.writeText(text); toast('คัดลอกข้อความชวนแล้ว'); } catch { prompt('คัดลอกข้อความนี้', text); } } }
      return;
    }
    case 'fbcfg-save': {
      const raw = $('[data-input="fbcfg"]').value.trim();
      try {
        const jsonish = raw.replace(/^[^{]*/, '').replace(/[^}]*$/, '').replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/'/g, '"').replace(/,\s*}/, '}');
        const cfg = JSON.parse(jsonish);
        if (!cfg.apiKey || !cfg.projectId) throw new Error();
        S.setFirebaseConfig(cfg); toast('บันทึกแล้ว กำลังเชื่อมต่อ…'); setTimeout(() => location.reload(), 600);
      } catch { toast('รูปแบบ config ไม่ถูกต้อง'); }
      return;
    }
    case 'gtest':
      if (!geminiKey()) return toast('ใส่ key ก่อน');
      toast('กำลังทดสอบ…');
      try { await testKey(geminiKey(), prefs.geminiModel); toast('✅ key ใช้งานได้'); } catch (err) { toast('❌ ' + err.message); }
      return;
    case 'gkey-paste': {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch { ui.keyMsg = '❌ อ่านคลิปบอร์ดไม่ได้ วาง key ในช่องด้านล่างแทน'; return render(); }
      return saveGeminiKey(text);
    }
    case 'gkey-save': return saveGeminiKey($('[data-input="gkey"]')?.value);
    case 'gkey-change': ui.editKey = true; ui.keyMsg = ''; return render();
    case 'gkey-cancel': ui.editKey = false; ui.keyMsg = ''; return render();
    case 'sheet-connect': {
      const url = $('[data-input="sheeturl"]').value;
      el.disabled = true; el.textContent = 'กำลังเชื่อมต่อ…';
      try { await Sheet.connect(url); toast('เชื่อม Google Sheet แล้ว 📗'); }
      catch (err) { Sheet.sheet.status = 'error'; Sheet.sheet.msg = err.message; render(); }
      return;
    }
    case 'sheet-copy-code': {
      try {
        const code = await (await fetch('apps-script/Code.gs', { cache: 'no-cache' })).text();
        if (!/function doPost/.test(code)) throw new Error('โหลดโค้ดไม่ได้');
        await navigator.clipboard.writeText(code);
        return toast('คัดลอกโค้ดแล้ว ไปวางใน Apps Script ได้เลย');
      } catch (e) { window.open('https://github.com/tunsupakorn/jukjik-kaa/blob/main/apps-script/Code.gs', '_blank', 'noopener'); return toast('คัดลอกเองจากหน้าที่เปิดขึ้น (ปุ่ม Copy raw file)'); }
    }
    case 'sheet-paste': {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        const m = text.match(/#connect=([^&\s]+)&key=([\w-]+)/);
        if (m) { location.hash = `connect=${m[1]}&key=${m[2]}`; return takeConnectLink(); }
        $('[data-input="sheeturl"]').value = text;
        if (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(text)) $('[data-action="sheet-connect"]').click();
        else toast('ในคลิปบอร์ดไม่ใช่ลิงก์ web app');
      } catch { toast('อ่านคลิปบอร์ดไม่ได้ ลองกดค้างในช่องแล้วเลือก “วาง”'); }
      return;
    }
    case 'sheet-sync':
      if (state.cloudConfigured && state.syncStatus !== 'synced') return toast('รอซิงก์กับบัญชีให้เสร็จก่อน');
      return Sheet.syncNow(true);
    case 'sheet-disconnect':
      if (confirm('ยกเลิกการเชื่อม Google Sheet? (ข้อมูลในชีตเดิมยังอยู่ แต่จะไม่อัปเดตอีก)')) { Sheet.disconnect(); toast('ยกเลิกการเชื่อมแล้ว'); }
      return;
    case 'budget-save': S.saveSettings({ budget: Math.max(0, Number($('[data-input="budget"]').value) || 0) }); return toast('บันทึกงบแล้ว');
    case 'cat-edit': return openCatEditor(el.dataset.id);
    case 'cat-new': return openCatEditor(null, el.dataset.t, el.dataset.g);
    case 'ce-group': catDraft.group = el.dataset.g; return renderCatEditor();
    case 'ce-emoji': catDraft.emoji = el.dataset.e; return renderCatEditor();
    case 'ce-move': return moveCategory(catDraft.id, Number(el.dataset.d));
    case 'ce-delete': return deleteCategory(catDraft.id);
    case 'cat-restore': {
      const list = [...cats()];
      S.DEFAULT_CATEGORIES.forEach(d => { if (!list.some(c => c.id === d.id)) list.push({ ...d }); });
      S.saveSettings({ categories: list });
      return toast('คืนหมวดเริ่มต้นแล้ว');
    }
    case 'owner-save': S.saveSettings({ ownerNames: $('[data-input="owner"]').value.trim() }); return toast('บันทึกชื่อแล้ว');
    case 'theme': S.savePrefs({ theme: el.dataset.t }); applyTheme(); return render();
    case 'export-json':
      return download(`jukjik-backup-${todayISO()}.json`, JSON.stringify({ app: 'jukjik', version: 1, tx: state.tx, settings: state.settings }, null, 2), 'application/json');
    case 'export-csv': {
      const head = 'date,type,amount,category,method,merchant,note';
      const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = [...state.tx].sort((a, b) => a.date.localeCompare(b.date))
        .map(t => [t.date, t.type, t.amount, catById(t.cat).name, t.method, t.merchant, t.note].map(q).join(','));
      return download(`jukjik-${todayISO()}.csv`, '﻿' + [head, ...rows].join('\n'), 'text/csv');
    }
  }
});

document.addEventListener('submit', async e => {
  const f = e.target.dataset.form;
  if (!f) return;
  e.preventDefault();
  if (f === 'tx') {
    const amount = Number(draft.amount);
    if (!(amount > 0)) return toast('ใส่จำนวนเงินก่อน');
    S.saveTx({ ...draft, amount: Math.round(amount * 100) / 100 });
    ui.month = draft.date.slice(0, 7);
    $('#sheet').close();
    toast(draft.id ? 'แก้ไขแล้ว' : 'จดแล้ว 🐣');
  } else if (f === 'auth') {
    const fd = new FormData(e.target);
    ui.authBusy = true; ui.authError = ''; render();
    try {
      await (ui.authMode === 'signup' ? S.signUp : S.signIn)(fd.get('email'), fd.get('pw'));
      toast('เข้าสู่ระบบแล้ว');
    } catch (err) { ui.authError = err.message; }
    ui.authBusy = false; render();
  } else if (f === 'allow') {
    const fd = new FormData(e.target);
    try {
      await S.allowEmail(fd.get('email'), fd.get('name'));
      toast(`อนุญาต ${String(fd.get('email')).trim().toLowerCase()} แล้ว · กด “ข้อความชวน” เพื่อส่งลิงก์`);
      e.target.reset();
    } catch (err) { toast('❌ ' + err.message); }
  } else if (f === 'entry') {
    saveEntry();
  } else if (f === 'menu') {
    saveMenuItem();
  } else if (f === 'close') {
    saveClose();
  } else if (f === 'cat-edit') {
    const d = catDraft;
    d.name = d.name.trim();
    if (!d.name) return toast('ใส่ชื่อหมวดก่อน');
    if (cats().some(c => c.id !== d.id && c.type === d.type && c.name === d.name)) return toast('มีหมวดชื่อนี้แล้ว');
    const item = { id: d.id, name: d.name, emoji: d.emoji.trim() || '🏷️', type: d.type, ...(d.type === 'expense' ? { group: d.group || 'opex' } : {}) };
    const list = d.isNew ? [...cats(), item] : cats().map(c => c.id === d.id ? item : c);
    S.saveSettings({ categories: list });
    $('#sheet').close();
    toast(d.isNew ? 'เพิ่มหมวดแล้ว' : 'บันทึกหมวดแล้ว');
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.d) { draft[t.dataset.d] = t.value; return; }
  if (t.dataset.ce) { catDraft[t.dataset.ce] = t.value; return; }
  if (t.dataset.mn) { menuDraft[t.dataset.mn] = t.type === 'checkbox' ? t.checked : t.value; return; }
  if (t.dataset.input === 'pick-note' && ui.pick) { ui.pick.note = t.value; return; }
  if (t.dataset.sp) { menuDraft.sp[t.dataset.sp] = t.value; return; }
  if (t.dataset.pay) {
    ui.pay.received = t.value;
    const total = cartTotal(), rec = Number(t.value) || 0, ch = rec - total;
    const el = $('#pay-change'); if (el) { el.className = 'change' + (rec && ch < 0 ? ' short' : ''); el.innerHTML = rec ? (ch < 0 ? `ขาดอีก ${baht(-ch)}` : `เงินทอน <b class="num">${baht(ch)}</b>`) : 'แตะยอดที่รับมา หรือกด “พอดี”'; }
    const btn = $('[data-action="pay-confirm"]'); if (btn) { btn.disabled = !!(rec && ch < 0); btn.textContent = `✅ ยืนยันขาย${rec && ch > 0 ? ' · ทอน ' + baht(ch) : ''}`; }
    return;
  }
  if (t.dataset.cl) {
    if (t.dataset.cl === 'date') { if (t.value) { loadCloseDraft(t.value); renderCloseSheet(); } return; }
    closeDraft[t.dataset.cl] = t.value;
    updateCloseLive();
    return;
  }
  if (t.dataset.rv) {
    const it = ui.scan.items[+t.dataset.i];
    const k = t.dataset.rv;
    if (k === 'keep') { it.keep = t.checked; render(); }
    else if (k === 'amount') it.amount = Number(t.value);
    else if (k === 'type') { it.type = t.value; it.cat = it.type === 'transfer' ? 'transfer' : it.type === 'income' ? 'inc_other' : 'exp_other'; render(); }
    else it[k] = t.value;
    return;
  }
  switch (t.dataset.input) {
    case 'search': ui.search = t.value; return render();
    case 'gkey': {
      const v = t.value.trim();
      if (/^AIza[\w-]{30,}$/.test(v)) saveGeminiKey(v); // pasted a full key: test & save right away
      return;
    }
    case 'gmodel': return S.savePrefs({ geminiModel: t.value.trim() || DEFAULT_MODEL });
  }
});

// redraw postponed while editing (see render); wait a moment so a tap on a button still lands on it
document.addEventListener('focusout', () => {
  if (!ui.renderPending) return;
  setTimeout(() => { if (ui.renderPending) render(); }, 300); // render() waits again if another field got the focus
});

// LINE settings save as soon as a value changes (no need to press บันทึก)
document.addEventListener('change', e => {
  if (e.target.dataset?.banner === 'text') { const text = e.target.value.trim().slice(0, 120); return setTimeout(() => { saveLine({ banner: { ...(lineCfg().banner || {}), text } }); toast('บันทึกข้อความแบนเนอร์แล้ว'); }, 250); }
  const k = e.target.dataset?.line;
  if (!k) return;
  // after the tap that moved the focus has landed (saving redraws the page)
  setTimeout(() => saveLineField(k, e.target.value), 250);
});
function saveLineField(k, raw) {
  const v = String(raw || '').trim();
  if (k === 'from' || k === 'to') {
    const from = k === 'from' ? v : lineCfg().from, to = k === 'to' ? v : lineCfg().to;
    if (!from || !to || from >= to) return toast('เวลาเปิดต้องก่อนเวลาปิด');
    saveLine({ from, to });
    return toast(`บันทึกเวลาแล้ว · เปิด ${from}–${to} น.`);
  }
  const val = k === 'deliveryMin' ? Math.max(0, Math.min(5000, Math.round(Number(v) || 0))) : k === 'prep' ? Math.max(0, Math.min(120, Number(v) || 0)) : k === 'stampGoal' ? Math.max(1, Math.min(99, Number(v) || 10)) : v.slice(0, k === 'name' ? 40 : 120);
  saveLine({ [k]: val });
  toast('บันทึกแล้ว');
}

document.addEventListener('change', async e => {
  const t = e.target;
  switch (t.dataset.input) {
    case 'saveslips': S.saveSettings({ saveSlips: t.checked }); return toast(t.checked ? 'จะเก็บสลิปไว้ใน Google Drive' : 'ปิดการเก็บสลิปแล้ว');
    case 'opensignup':
      if (t.checked && !confirm('เปิดให้ทุกคนที่มีลิงก์สมัครใช้ได้? (ข้อมูลยังแยกกันของใครของมัน)')) { t.checked = false; return; }
      try { await S.setOpenSignup(t.checked); toast(t.checked ? 'เปิดให้ทุกคนใช้ได้แล้ว' : 'จำกัดเฉพาะอีเมลที่อนุญาตแล้ว'); } catch (err) { toast('❌ ' + err.message); }
      return;
    case 'notify-accept': saveLine({ notifyAccept: t.checked }); render(); return toast(t.checked ? 'จะแจ้งลูกค้าตอนรับออเดอร์' : 'ไม่แจ้งตอนรับออเดอร์ (แจ้งเฉพาะตอนพร้อม)');
    case 'posopts': S.saveSettings({ posOpts: t.checked }); return toast(t.checked ? 'หน้าขายจะถามความหวานทุกแก้ว' : 'หน้าขายแตะครั้งเดียวใส่ตะกร้า (ไม่ถามความหวาน)');
    case 'banner-on': saveLine({ banner: { ...(lineCfg().banner || {}), on: t.checked } }); return toast(t.checked ? 'แสดงแบนเนอร์แล้ว' : 'ซ่อนแบนเนอร์แล้ว');
    case 'bannerphoto': {
      const file = t.files[0]; t.value = '';
      if (!file) return;
      try {
        toast('กำลังอัปโหลดแบนเนอร์…');
        const v = await S.saveMenuPhoto('_banner', await photoData(file, 1200, 600));
        saveLine({ banner: { ...(lineCfg().banner || {}), on: true, photo: v } });
        toast('ใส่รูปแบนเนอร์แล้ว');
      } catch (err) { toast('❌ ' + err.message); }
      return;
    }
    case 'mnphoto': {
      const file = t.files[0]; t.value = '';
      if (!file || !menuDraft) return;
      try { menuDraft.photoData = await menuPhotoData(file); menuDraft.photoRemove = false; renderMenuEditor(); }
      catch (err) { toast('❌ ใช้รูปนี้ไม่ได้: ' + err.message); }
      return;
    }
    case 'only30':
      ui.scan.only30 = t.checked;
      ui.scan.items.forEach(it => { if (!it.dup) it.keep = !(t.checked && it.old); });
      return render();
    case 'files': { const files = [...t.files]; t.value = ''; if (files.length) runScan(files); return; }
    case 'pbgoal': S.saveSettings({ paybackGoal: Number(t.value) || 12 }); return;
    case 'slip': {
      const file = t.files[0]; t.value = '';
      if (!file || !draft) return;
      try { draft.slipData = await slipDataUrl(file); draft.slipRemove = false; renderEntry(); }
      catch (err) { toast('❌ แนบรูปไม่ได้: ' + err.message); }
      return;
    }
    case 'pick': { const files = [...t.files]; t.value = ''; addToTray(files); return; }
    case 'import': {
      const file = t.files[0]; t.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.tx)) throw new Error();
        if (!confirm(`นำเข้า ${data.tx.length} รายการ? (รายการที่มี id เดียวกันจะถูกแทนที่)`)) return;
        await S.saveMany(data.tx);
        if (data.settings?.categories) S.saveSettings({ categories: data.settings.categories, budget: data.settings.budget || 0 });
        toast(`นำเข้าแล้ว ${data.tx.length} รายการ`);
      } catch { toast('ไฟล์ไม่ถูกต้อง'); }
    }
  }
});

// close sheet when tapping the backdrop
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') e.target.close(); });

// ---------- sign in with LINE ----------
async function lineLogin() {
  ui.authBusy = true; ui.authError = ''; ui.lineDenied = null; render();
  try { await S.signInLine(); }
  catch (e) {
    if (e.lineUserId) ui.lineDenied = { id: e.lineUserId, name: e.lineName };
    else ui.authError = e.message;
  }
  ui.authBusy = false; render();
}

// ---------- boot ----------
applyTheme();
setModelChangeHandler(m => {
  S.savePrefs({ geminiModel: m });
  const el = $('[data-input="gmodel"]'); if (el) el.value = m;
  toast(`เปลี่ยนเป็นโมเดล ${m} ให้อัตโนมัติ`);
});
setFallbackHandler(m => toast(`รุ่นหลักคนใช้เยอะ ใช้ ${m} แทนชั่วคราว`));
setStatusHandler(msg => { ui.scan.note = msg; if (ui.view === 'scan') render(); });
Sheet.onSheetChange(() => { if (ui.view === 'settings') render(); });
S.subscribe(() => {
  // a key saved only on this device (older version) is shared to the account once it is synced
  if (prefs.geminiKey && state.mode === 'cloud' && state.syncStatus === 'synced' && !state.settings.geminiKey) S.saveSettings({ geminiKey: prefs.geminiKey });
  watchNewOrders();
  render(); Sheet.schedule();
  if (state.mode === 'cloud' && state.syncStatus === 'synced' && sessionStorage.getItem?.('jj_connect')) setTimeout(takeConnectLink, 0);
});
render();
S.initStore().then(() => { if (S.lineLoginPending()) lineLogin(); });
// tapped a "new order" notification: open the LINE orders page
if (new URLSearchParams(location.search).get('view') === 'orders') { ui.view = 'orders'; history.replaceState(null, '', location.pathname); render(); }
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.go === 'orders') { if ($('#sheet').open) $('#sheet').close(); go('orders'); } });
takeSharedFiles();
takeConnectLink();
if ('serviceWorker' in navigator && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js').catch(() => {});
