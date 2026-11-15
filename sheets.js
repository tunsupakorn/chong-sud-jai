// Mirrors all transactions to a Google Sheet through the user's Apps Script web app.
// Firebase stays the source of truth; the Sheet is rewritten to match after each change.
import * as S from './store.js';

const { state, LS } = S;
export const sheet = { status: 'off', at: 0, rows: 0, msg: '' }; // off | idle | syncing | ok | error

let notify = () => {};
export function onSheetChange(fn) { notify = fn; }

const cfg = () => state.settings.sheet || null;
export const isConnected = () => !!cfg()?.webapp;
export const sheetUrl = () => cfg()?.sheetUrl || '';
export const slipFolderUrl = () => cfg()?.slipFolderUrl || '';
export const saveSlipsOn = () => isConnected() && state.settings.saveSlips !== false;

// ---- slip images → Google Drive (via the same Apps Script) ----
function blobToBase64(blob) {
  return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => bad(r.error); r.readAsDataURL(blob); });
}
async function shrink(file) {
  if (!/^image\//.test(file.type)) return { blob: file, mime: file.type || 'application/pdf' };
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return { blob: await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85)), mime: 'image/jpeg' };
  } catch { return { blob: file, mime: file.type || 'image/jpeg' }; }
}
const TYPE_TH = { expense: 'รายจ่าย', income: 'รายรับ', transfer: 'ย้ายเงิน' };

export async function uploadSlip(file, tx, catName = '') {
  const c = cfg();
  if (!c?.webapp) throw new Error('ยังไม่ได้เชื่อม Google Sheet');
  if (file.size > 15 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 15MB');
  const { blob, mime } = await shrink(file);
  const ext = mime === 'application/pdf' ? 'pdf' : 'jpg';
  const name = `${tx.date} ${(tx.time || '').replace(':', '')} ${TYPE_TH[tx.type] || ''} ${Number(tx.amount).toFixed(2)} ${tx.merchant || catName}`
    .replace(/\s+/g, ' ').trim() + '.' + ext;
  const r = await post(c.webapp, {
    action: 'slip', token: c.token, month: tx.date.slice(0, 7), name, mime, data: await blobToBase64(blob),
    desc: [TYPE_TH[tx.type], catName, tx.note, tx.ref && `อ้างอิง ${tx.ref}`].filter(Boolean).join(' · '),
  });
  if (r.folderUrl && r.folderUrl !== c.slipFolderUrl) S.saveSettings({ sheet: { ...cfg(), slipFolderUrl: r.folderUrl } });
  return { id: r.id, url: r.url };
}

const ERR = {
  'already-paired': 'สคริปต์นี้จับคู่กับแอปอื่นไว้แล้ว ให้รัน resetPairing ในหน้าแก้ไขสคริปต์ก่อน แล้วเชื่อมใหม่',
  'unauthorized': 'รหัสจับคู่ไม่ตรง ลองกด "ยกเลิกการเชื่อม" แล้วเชื่อมใหม่',
  'missing-token': 'คำขอไม่สมบูรณ์ ลองเชื่อมใหม่',
  'busy': 'ชีตกำลังถูกเขียนจากอีกเครื่อง เดี๋ยวจะลองใหม่ให้',
};

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android' : 'แท็บเล็ต Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'อุปกรณ์อื่น';
}

async function post(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' }, // simple request: no CORS preflight
      body: JSON.stringify(body),
      redirect: 'follow',
    });
  } catch { throw new Error('เชื่อมต่อสคริปต์ไม่ได้ ตรวจอินเทอร์เน็ต หรือว่ากด Allow สิทธิ์ในสคริปต์แล้ว'); }
  let data;
  try { data = await res.json(); } catch { throw new Error('สคริปต์ตอบกลับไม่ถูกต้อง ตรวจลิงก์ web app และการตั้งสิทธิ์ (Anyone)'); }
  if (!data.ok) throw new Error(ERR[data.error] || ('สคริปต์แจ้งข้อผิดพลาด: ' + data.error));
  return data;
}

function signature() {
  let max = 0;
  for (const t of state.tx) max = Math.max(max, t.updatedAt || 0);
  const cats = (state.settings.categories || []).map(c => c.id + c.name + c.emoji).join('|');
  return `${state.tx.length}:${max}:${cats.length}:${cats.slice(-60)}`;
}

// Only push when this device has the real, complete data set.
function ready() {
  if (!isConnected() || !navigator.onLine) return false;
  if (state.cloudConfigured) return state.mode === 'cloud' && state.syncStatus === 'synced';
  return true;
}

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');

export async function connect(webapp) {
  webapp = String(webapp || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(webapp))
    throw new Error('ลิงก์ต้องเป็นแบบ https://script.google.com/macros/s/…/exec');
  const token = randomToken();
  const r = await post(webapp, { action: 'pair', token });
  S.saveSettings({ sheet: { webapp, token, sheetUrl: r.sheetUrl || '' } });
  LS.del('jj_sheet_sig');
  sheet.status = 'idle';
  notify();
  await syncNow(true);
}

// One-click connect from the Sheet's 🐣 menu: the sheet already holds this key, so no pairing call is needed.
export async function connectWithKey(webapp, token) {
  webapp = String(webapp || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(webapp)) throw new Error('ลิงก์เชื่อมต่อไม่ถูกต้อง');
  if (!/^[\w-]{24,}$/.test(token || '')) throw new Error('รหัสเชื่อมต่อไม่ถูกต้อง');
  S.saveSettings({ sheet: { webapp, token, sheetUrl: '' } });
  LS.del('jj_sheet_sig');
  sheet.status = 'idle';
  notify();
  await syncNow(true);
}

export function disconnect() {
  S.saveSettings({ sheet: null });
  LS.del('jj_sheet_sig');
  Object.assign(sheet, { status: 'off', msg: '', at: 0, rows: 0 });
  notify();
}

let timer = null, inflight = false, again = false;

export function schedule() {
  if (!ready()) return;
  if (signature() === LS.get('jj_sheet_sig', '')) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), 5000);
}

export async function syncNow(force = false) {
  const c = cfg();
  if (!c || !ready()) return;
  if (inflight) { again = true; return; }
  const sig = signature();
  if (!force && sig === LS.get('jj_sheet_sig', '')) return;
  // safety: never wipe a filled Sheet with an empty list unless asked
  if (!force && state.tx.length === 0 && LS.get('jj_sheet_rows', 0) > 0) return;
  inflight = true;
  Object.assign(sheet, { status: 'syncing', msg: '' });
  notify();
  try {
    const tx = state.tx.map(t => ({ id: t.id, date: t.date, time: t.time || '', type: t.type, amount: t.amount, cat: t.cat,
      method: t.method || '', merchant: t.merchant || '', note: t.note || '', source: t.source || '', ref: t.ref || '', slipUrl: t.slipUrl || '' }));
    const r = await post(c.webapp, { action: 'sync', token: c.token, tx, categories: state.settings.categories, device: deviceLabel() });
    LS.set('jj_sheet_sig', sig);
    LS.set('jj_sheet_rows', r.rows || 0);
    Object.assign(sheet, { status: 'ok', at: Date.now(), rows: r.rows || 0 });
    if (r.sheetUrl && r.sheetUrl !== c.sheetUrl) S.saveSettings({ sheet: { ...c, sheetUrl: r.sheetUrl } });
  } catch (e) {
    Object.assign(sheet, { status: 'error', msg: e.message });
    if (/อีกเครื่อง/.test(e.message)) again = true;
  } finally {
    inflight = false;
    notify();
    if (again) { again = false; clearTimeout(timer); timer = setTimeout(() => syncNow(), 8000); }
  }
}

window.addEventListener('online', () => schedule());
