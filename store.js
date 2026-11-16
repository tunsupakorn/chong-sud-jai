// Data layer: works locally (localStorage) and switches to Firebase Firestore for multi-device sync.
import { vapidPublicKey as VAPID_KEY, ownerLiffId as OWNER_LIFF_ID, lineApi as LINE_API, firebaseConfig as FILE_CONFIG, ownerUid as OWNER_UID, ownerEmail as OWNER_EMAIL, shopDataUid as SHOP_UID, inviteOnly as INVITE_ONLY, privateApp as PRIVATE_APP } from './firebase-config.js';
export const inviteOnly = !!INVITE_ONLY && !PRIVATE_APP;
export const privateApp = !!PRIVATE_APP;

const FB_VERSION = '11.0.2';

export const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// group: cogs = ต้นทุนสินค้า (คิดกำไรขั้นต้น) · opex = ค่าใช้จ่ายร้าน · invest = เงินลงทุน (ไม่นับในกำไร ใช้คิดคืนทุน)
export const DEFAULT_CATEGORIES = [
  { id: 'sales', name: 'ขายหน้าร้าน', emoji: '🥤', type: 'income' },
  { id: 'delivery', name: 'เดลิเวอรี', emoji: '🛵', type: 'income' },
  { id: 'inc_other', name: 'รายรับอื่นๆ', emoji: '💰', type: 'income' },
  { id: 'fruit', name: 'ผลไม้', emoji: '🍓', type: 'expense', group: 'cogs' },
  { id: 'dairy', name: 'นม/ครีม/โยเกิร์ต', emoji: '🥛', type: 'expense', group: 'cogs' },
  { id: 'powder', name: 'ผงชา/กาแฟ/โกโก้', emoji: '🍵', type: 'expense', group: 'cogs' },
  { id: 'syrup', name: 'น้ำเชื่อม/น้ำผึ้ง', emoji: '🍯', type: 'expense', group: 'cogs' },
  { id: 'ice', name: 'น้ำแข็ง', emoji: '🧊', type: 'expense', group: 'cogs' },
  { id: 'topping', name: 'ท็อปปิ้ง', emoji: '🧋', type: 'expense', group: 'cogs' },
  { id: 'packaging', name: 'แก้ว/ฝา/หลอด/ถุง', emoji: '🥡', type: 'expense', group: 'cogs' },
  { id: 'cogs_other', name: 'วัตถุดิบอื่นๆ', emoji: '🧺', type: 'expense', group: 'cogs' },
  { id: 'rent', name: 'ค่าเช่า', emoji: '🏠', type: 'expense', group: 'opex' },
  { id: 'electric', name: 'ค่าไฟ', emoji: '⚡', type: 'expense', group: 'opex' },
  { id: 'water', name: 'ค่าน้ำ', emoji: '🚰', type: 'expense', group: 'opex' },
  { id: 'wage', name: 'ค่าแรง', emoji: '👥', type: 'expense', group: 'opex' },
  { id: 'internet', name: 'เน็ต/โทรศัพท์', emoji: '📱', type: 'expense', group: 'opex' },
  { id: 'repair', name: 'ซ่อม/อุปกรณ์เล็ก', emoji: '🔧', type: 'expense', group: 'opex' },
  { id: 'cleaning', name: 'ของใช้ทำความสะอาด', emoji: '🧽', type: 'expense', group: 'opex' },
  { id: 'marketing', name: 'โฆษณา/โปรโมชัน', emoji: '📣', type: 'expense', group: 'opex' },
  { id: 'fee', name: 'ค่าธรรมเนียม', emoji: '🧾', type: 'expense', group: 'opex' },
  { id: 'exp_other', name: 'ค่าใช้จ่ายอื่นๆ', emoji: '📦', type: 'expense', group: 'opex' },
  { id: 'equipment', name: 'เครื่องมือ/อุปกรณ์ร้าน', emoji: '🛠️', type: 'expense', group: 'invest' },
  { id: 'decor', name: 'ตกแต่ง/ป้ายร้าน', emoji: '🎨', type: 'expense', group: 'invest' },
  { id: 'deposit', name: 'มัดจำ/ค่าแรกเข้า', emoji: '🔑', type: 'expense', group: 'invest' },
  { id: 'invest_other', name: 'ลงทุนอื่นๆ', emoji: '🏗️', type: 'expense', group: 'invest' },
];
// เมนูร้าน (แก้ได้ในตั้งค่า) · group: fruit = ปั่นผลไม้, drink = ชา/กาแฟ/นม, topping = ท็อปปิ้ง · cost = ต้นทุนประมาณ/แก้ว
export const STYLES = { blend: { word: 'ปั่น', emoji: '🧊' }, iced: { word: 'เย็น', emoji: '🥤' }, hot: { word: 'ร้อน', emoji: '♨️' } };
// prices: price per style (ปั่น / เย็น / ร้อน); price = the first one, kept for older code and reports
const P = (blend, iced, hot) => { const p = {}; if (blend) p.blend = blend; if (iced) p.iced = iced; if (hot) p.hot = hot; return { prices: p, price: blend || iced || hot }; };
export const DEFAULT_MENU = [
  { id: 'm_watermelon', name: 'แตงโมปั่น', emoji: '🍉', ...P(35), cost: 12, group: 'fruit' },
  { id: 'm_pineapple', name: 'สับปะรดปั่น', emoji: '🍍', ...P(35), cost: 11, group: 'fruit' },
  { id: 'm_mango', name: 'มะม่วงปั่น', emoji: '🥭', ...P(45), cost: 17, group: 'fruit' },
  { id: 'm_strawberry', name: 'สตรอว์เบอร์รีปั่น', emoji: '🍓', ...P(45), cost: 18, group: 'fruit' },
  { id: 'm_coconut', name: 'มะพร้าวปั่น', emoji: '🥥', ...P(40), cost: 14, group: 'fruit' },
  { id: 'm_banana', name: 'กล้วยนมปั่น', emoji: '🍌', ...P(35), cost: 11, group: 'fruit' },
  { id: 'm_yogurt', name: 'โยเกิร์ตผลไม้ปั่น', emoji: '🥣', ...P(50), cost: 20, group: 'fruit' },
  { id: 'm_smoothie', name: 'สมูทตี้รวมผลไม้', emoji: '🍹', ...P(60), cost: 25, group: 'fruit' },
  { id: 'm_thaitea', name: 'ชาไทย', emoji: '🧋', ...P(35, 30, 25), cost: 12, group: 'drink' },
  { id: 'm_greentea', name: 'ชาเขียว', emoji: '🍵', ...P(40, 35, 30), cost: 14, group: 'drink' },
  { id: 'm_cocoa', name: 'โกโก้', emoji: '🍫', ...P(35, 30, 25), cost: 12, group: 'drink' },
  { id: 'm_coffee', name: 'กาแฟ', emoji: '☕', ...P(45, 40, 35), cost: 16, group: 'drink' },
  { id: 'm_milk', name: 'นมสด', emoji: '🥛', ...P(30, 25, 20), cost: 10, group: 'drink' },
  { id: 'm_ovaltine', name: 'โอวัลติน', emoji: '🥤', ...P(35, 30, 25), cost: 12, group: 'drink' },
  { id: 'm_honeylime', name: 'น้ำผึ้งมะนาวโซดา', emoji: '🍋', ...P(0, 25), cost: 8, group: 'drink' },
  { id: 't_pearl', name: 'ไข่มุก', emoji: '⚫', price: 10, cost: 3, group: 'topping' },
  { id: 't_konjac', name: 'บุก', emoji: '⚪', price: 10, cost: 3, group: 'topping' },
  { id: 't_whip', name: 'วิปครีม', emoji: '🍦', price: 5, cost: 2, group: 'topping' },
];
export const MENU_GROUPS = { fruit: '🍓 ปั่นผลไม้', drink: '🧋 ชา·กาแฟ·นม', topping: '✨ ท็อปปิ้ง' };

export const GROUPS = {
  income: { name: 'รายรับ', emoji: '💰' },
  cogs: { name: 'ต้นทุนสินค้า', emoji: '🧊', hint: 'วัตถุดิบและบรรจุภัณฑ์ (คิดกำไรขั้นต้น)' },
  opex: { name: 'ค่าใช้จ่ายร้าน', emoji: '🏪', hint: 'ค่าเช่า ค่าไฟ ค่าแรง ฯลฯ (คิดกำไรสุทธิ)' },
  invest: { name: 'เงินลงทุน', emoji: '🛠️', hint: 'ไม่นับในกำไร ใช้คิดคืนทุน' },
};
export const catGroup = c => (!c ? 'opex' : c.type === 'income' ? 'income' : (GROUPS[c.group] ? c.group : 'opex'));

const CAT_VERSION = 2;
const defaultSettings = () => ({ categories: DEFAULT_CATEGORIES, budget: 0, catVersion: CAT_VERSION, ownerNames: '' });

// Bring a saved category list up to date (v2 adds bill categories); returns true if it changed.
function migrateSettings(s) {
  if ((s.catVersion || 1) >= CAT_VERSION) return false;
  const list = [...(s.categories || DEFAULT_CATEGORIES)];
  const has = id => list.some(c => c.id === id);
  const bills = list.findIndex(c => c.id === 'bills');
  const add = ['electric', 'water', 'internet'].filter(id => !has(id)).map(id => DEFAULT_CATEGORIES.find(c => c.id === id)).filter(Boolean);
  list.splice(bills >= 0 ? bills : list.length, 0, ...add);
  const b = list.find(c => c.id === 'bills');
  
  s.categories = list;
  s.catVersion = CAT_VERSION;
  return true;
}

export const state = {
  mode: 'local',            // 'local' | 'cloud'
  cloudConfigured: false,
  syncStatus: 'local',      // local | signed-out | pending | synced | error
  syncError: '',
  user: null,
  tx: [],
  orders: [],               // LINE OA orders still open (new / accepted / ready), cloud only
  settings: defaultSettings(),
  localPendingCount: 0,     // local items that can be uploaded after sign-in
  access: 'ok',             // ok | verify (email not verified yet) | denied (email not on the allow list)
  isOwner: false,
  allowList: [],            // owner only: [{ email, name, addedAt }]
  openSignup: false,        // owner only: anyone may use the app
};

import { DEFAULT_MODEL } from './gemini.js';
const RETIRED_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
export const prefs = Object.assign({ theme: 'auto', geminiKey: '', geminiModel: DEFAULT_MODEL, onboarded: false }, LS.get('jj_prefs', {}));
if (!prefs.geminiModel || RETIRED_MODELS.includes(prefs.geminiModel)) { prefs.geminiModel = DEFAULT_MODEL; LS.set('jj_prefs', prefs); }
// one-time switch of the old default (gemini-3.8-flash) to Flash-Lite; a later manual choice is kept
if (!prefs.liteDefaultApplied) {
  if (prefs.geminiModel === 'gemini-3.8-flash') prefs.geminiModel = DEFAULT_MODEL;
  prefs.liteDefaultApplied = true;
  LS.set('jj_prefs', prefs);
}
export function savePrefs(patch) { Object.assign(prefs, patch); LS.set('jj_prefs', prefs); }

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach(fn => fn(state)); }

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

let fb = null;                 // { auth, db, A (auth module), F (firestore module) }
let unsubs = [];

export function getFirebaseConfig() { return LS.get('jj_fbconfig', null) || FILE_CONFIG; }
export function setFirebaseConfig(cfg) { cfg ? LS.set('jj_fbconfig', cfg) : LS.del('jj_fbconfig'); }

function loadLocal() {
  state.tx = LS.get('jj_tx', []);
  const saved = LS.get('jj_settings', {});
  state.settings = { ...defaultSettings(), catVersion: saved.categories ? 1 : CAT_VERSION, ...saved };
  if (migrateSettings(state.settings)) LS.set('jj_settings', state.settings);
}

export async function initStore() {
  loadLocal();
  emit();
  const cfg = getFirebaseConfig();
  if (!cfg) return;
  state.cloudConfigured = true;
  state.syncStatus = 'signed-out';
  emit();
  try { await initFirebase(cfg); }
  catch (e) { console.error(e); state.syncStatus = 'error'; state.syncError = e.message || String(e); emit(); }
}

async function initFirebase(cfg) {
  const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}`;
  const [appM, A, F] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-firestore.js`)]);
  const app = appM.initializeApp(cfg);
  const auth = A.getAuth(app);
  let db;
  try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
  catch { db = F.getFirestore(app); }
  fb = { auth, db, A, F };
  // a LINE sign-in carries the claim lineOwner (set by the Worker for the shop's LINE accounts)
  A.onAuthStateChanged(auth, user => user
    ? user.getIdTokenResult().then(r => attachUser(user, r.claims), () => attachUser(user, {}))
    : detachUser());
}

function denied(err) {
  if (err?.code !== 'permission-denied') return false;
  unsubs.forEach(u => u()); unsubs = [];
  state.access = 'denied';
  state.tx = [];
  state.syncStatus = 'error';
  state.syncError = 'บัญชีนี้ยังไม่ได้รับอนุญาตให้ใช้แอป';
  emit();
  return true;
}

function attachUser(user, claims = {}) {
  const { db, F } = fb;
  unsubs.forEach(u => u()); unsubs = [];
  state.mode = 'cloud';
  state.isOwner = claims.lineOwner === true || (!!OWNER_UID && user.uid === OWNER_UID) ||
    (!!OWNER_EMAIL && user.emailVerified && String(user.email || '').toLowerCase() === OWNER_EMAIL.toLowerCase());
  // the shop's data lives under one fixed id, so changing the owner's Gmail keeps all records
  const dataUid = (PRIVATE_APP && SHOP_UID) || user.uid;
  state.user = { uid: user.uid, dataUid: (PRIVATE_APP && SHOP_UID) || user.uid, email: user.email, name: user.displayName || claims.name || '', verified: user.emailVerified,
    provider: claims.lineOwner ? 'line' : user.providerData?.[0]?.providerId || 'password' };
  state.access = 'ok';
  state.localPendingCount = LS.get('jj_tx', []).length;
  // private app: only the owner's account may use it
  if (PRIVATE_APP && !state.isOwner) {
    state.access = 'private';
    state.syncStatus = 'signed-out';
    state.tx = [];
    emit();
    return;
  }
  // accounts made with email + password must confirm the address first (Google accounts are already verified)
  if (INVITE_ONLY && !state.isOwner && !user.emailVerified) {
    state.access = 'verify';
    state.syncStatus = 'signed-out';
    state.tx = [];
    emit();
    return;
  }
  state.syncStatus = 'pending';
  emit();
  unsubs.push(F.onSnapshot(F.collection(db, 'users', dataUid, 'tx'), { includeMetadataChanges: true }, snap => {
    state.tx = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.syncStatus = snap.metadata.hasPendingWrites || snap.metadata.fromCache ? 'pending' : 'synced';
    emit();
  }, err => { if (!denied(err)) { state.syncStatus = 'error'; state.syncError = err.message; emit(); } }));
  if (INVITE_ONLY && state.isOwner) {
    unsubs.push(F.onSnapshot(F.collection(db, 'allow'), snap => {
      state.allowList = snap.docs.map(d => ({ email: d.id, ...d.data() })).sort((a, b) => a.email.localeCompare(b.email));
      emit();
    }, err => console.warn('allow list', err)));
    unsubs.push(F.onSnapshot(F.doc(db, 'config', 'access'), snap => {
      state.openSignup = snap.exists() && snap.data().open === true;
      emit();
    }, err => console.warn('access', err)));
  }
  // LINE OA orders that still need the shop (finished/cancelled ones drop out of this list)
  unsubs.push(F.onSnapshot(F.query(F.collection(db, 'users', dataUid, 'orders'), F.where('status', 'in', ['new', 'accepted', 'ready'])), snap => {
    state.orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    emit();
  }, err => console.warn('orders', err)));
  unsubs.push(F.onSnapshot(F.doc(db, 'users', dataUid), snap => {
    const s = snap.exists() ? snap.data().settings : null;
    state.settings = { ...defaultSettings(), catVersion: s?.categories ? 1 : CAT_VERSION, ...(s || {}) };
    if (s && migrateSettings(state.settings) && !snap.metadata.fromCache)
      F.setDoc(F.doc(db, 'users', dataUid), { settings: clean(state.settings) }, { mergeFields: ['settings'] }).catch(syncFail);
    emit();
  }, err => { if (!denied(err)) console.warn(err); }));
}

function detachUser() {
  unsubs.forEach(u => u()); unsubs = [];
  state.mode = 'local';
  state.user = null;
  state.access = 'ok';
  state.isOwner = false;
  state.allowList = [];
  state.orders = [];
  state.syncStatus = state.cloudConfigured ? 'signed-out' : 'local';
  loadLocal();
  emit();
}

const clean = o => JSON.parse(JSON.stringify(o)); // drop undefined for Firestore
const userPath = (...p) => [fb.db, 'users', state.user.dataUid || state.user.uid, ...p];

function writeLocal() { LS.set('jj_tx', state.tx); emit(); }

export function saveTx(tx) {
  tx = { ...tx, id: tx.id || newId(), updatedAt: Date.now() };
  tx.createdAt ||= tx.updatedAt;
  if (state.mode === 'cloud') {
    fb.F.setDoc(fb.F.doc(...userPath('tx', tx.id)), clean(tx)).catch(syncFail);
  } else {
    const i = state.tx.findIndex(t => t.id === tx.id);
    if (i >= 0) state.tx[i] = tx; else state.tx.push(tx);
    writeLocal();
  }
  return tx;
}

export async function saveMany(list) {
  const items = list.map(t => ({ ...t, id: t.id || newId(), createdAt: t.createdAt || Date.now(), updatedAt: Date.now() }));
  if (state.mode === 'cloud') {
    const { F, db } = fb;
    for (let i = 0; i < items.length; i += 400) {
      const b = F.writeBatch(db);
      items.slice(i, i + 400).forEach(t => b.set(F.doc(...userPath('tx', t.id)), clean(t)));
      b.commit().catch(syncFail);
    }
  } else {
    const byId = new Map(state.tx.map(t => [t.id, t]));
    items.forEach(t => byId.set(t.id, t));
    state.tx = [...byId.values()];
    writeLocal();
  }
  return items.length;
}

// slip photos: one doc per transaction in users/{uid}/slips/{txId}, kept apart so the tx list stays light
export async function saveSlipImage(id, data) {
  if (state.mode === 'cloud') return fb.F.setDoc(fb.F.doc(...userPath('slips', id)), { data, at: Date.now() });
  try { localStorage.setItem('jj_slip_' + id, data); } catch { throw new Error('ที่เก็บในเครื่องเต็ม'); }
}
export async function getSlipImage(id) {
  if (state.mode === 'cloud') { const snap = await fb.F.getDoc(fb.F.doc(...userPath('slips', id))); return snap.exists() ? snap.data().data : ''; }
  return localStorage.getItem('jj_slip_' + id) || '';
}
export function deleteSlipImage(id) {
  if (state.mode === 'cloud') fb.F.deleteDoc(fb.F.doc(...userPath('slips', id))).catch(() => {});
  else localStorage.removeItem('jj_slip_' + id);
}

export function deleteTx(id) {
  if (state.tx.find(x => x.id === id)?.hasSlip) deleteSlipImage(id);
  if (state.mode === 'cloud') fb.F.deleteDoc(fb.F.doc(...userPath('tx', id))).catch(syncFail);
  else { state.tx = state.tx.filter(t => t.id !== id); writeLocal(); }
}

// LINE OA order: the shop moves it along through the Worker (it checks the owner's sign-in, messages the customer
// and records the sale). action: accept | ready | paid | cash | done | cancel
export async function orderAction(id, action, reason = '') {
  if (state.mode !== 'cloud' || !fb?.auth.currentUser) throw new Error('ต้องล็อกอินก่อน');
  if (!LINE_API) throw new Error('ยังไม่ได้ตั้ง lineApi ใน firebase-config.js');
  const res = await fetch(`${LINE_API.replace(/\/$/, '')}/shop/orders/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await fb.auth.currentUser.getIdToken()}` },
    body: JSON.stringify({ action, reason }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `ระบบ LINE ตอบกลับ ${res.status}`);
  return data;
}

export function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  if (state.mode === 'cloud') fb.F.setDoc(fb.F.doc(...userPath()), { settings: clean(state.settings) }, { mergeFields: ['settings'] }).catch(syncFail);
  else LS.set('jj_settings', state.settings);
  emit();
}

function syncFail(e) { console.error(e); state.syncStatus = 'error'; state.syncError = e.message; emit(); }

// Upload transactions saved on this device before signing in.
export async function uploadLocalToCloud() {
  const local = LS.get('jj_tx', []);
  const n = await saveMany(local);
  LS.del('jj_tx');
  state.localPendingCount = 0;
  emit();
  return n;
}
export function discardLocalPending() { LS.del('jj_tx'); state.localPendingCount = 0; emit(); }

// ---- auth ----
const authMsg = e => ({
  'auth/invalid-email': 'อีเมลไม่ถูกต้อง',
  'auth/invalid-credential': 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  'auth/wrong-password': 'รหัสผ่านไม่ถูกต้อง',
  'auth/user-not-found': 'ไม่พบบัญชีนี้ ลองกด "สมัครใหม่"',
  'auth/email-already-in-use': 'อีเมลนี้มีบัญชีแล้ว ลองกด "เข้าสู่ระบบ"',
  'auth/weak-password': 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัว',
  'auth/popup-blocked': 'เบราว์เซอร์บล็อกหน้าต่างล็อกอิน ลองใช้อีเมลแทน',
  'auth/popup-closed-by-user': 'ปิดหน้าต่างล็อกอินก่อนเสร็จ',
  'auth/unauthorized-domain': 'โดเมนนี้ยังไม่ได้เพิ่มใน Firebase > Authentication > Settings > Authorized domains',
  'auth/operation-not-allowed': 'ยังไม่ได้เปิดวิธีล็อกอินนี้ใน Firebase Console',
  'auth/network-request-failed': 'เชื่อมต่ออินเทอร์เน็ตไม่ได้',
  'auth/too-many-requests': 'ส่งคำขอบ่อยเกินไป รอสักครู่แล้วลองใหม่',
}[e.code] || e.message);

function needFb() { if (!fb) throw new Error('ยังไม่ได้ตั้งค่า Firebase'); }
export async function signIn(email, pw) { needFb(); try { await fb.A.signInWithEmailAndPassword(fb.auth, email, pw); } catch (e) { throw new Error(authMsg(e)); } }
export async function signUp(email, pw) {
  needFb();
  try {
    const cred = await fb.A.createUserWithEmailAndPassword(fb.auth, email, pw);
    await fb.A.sendEmailVerification(cred.user).catch(() => {});
  } catch (e) { throw new Error(authMsg(e)); }
}
export async function resendVerification() {
  needFb();
  if (!fb.auth.currentUser) return;
  try { await fb.A.sendEmailVerification(fb.auth.currentUser); } catch (e) { throw new Error(authMsg(e)); }
}
// after clicking the link in the email: refresh the account and try again
export async function recheckAccess() {
  needFb();
  const u = fb.auth.currentUser;
  if (!u) return;
  await u.reload();
  const r = await u.getIdTokenResult(true);
  attachUser(fb.auth.currentUser, r.claims);
}

// ---- owner: who may use the app ----
const emailKey = e => String(e || '').trim().toLowerCase();
export async function allowEmail(email, name = '') {
  const key = emailKey(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) throw new Error('อีเมลไม่ถูกต้อง');
  await fb.F.setDoc(fb.F.doc(fb.db, 'allow', key), { name: String(name || '').trim(), addedAt: Date.now() });
}
export async function removeEmail(email) { await fb.F.deleteDoc(fb.F.doc(fb.db, 'allow', emailKey(email))); }
export async function setOpenSignup(open) { await fb.F.setDoc(fb.F.doc(fb.db, 'config', 'access'), { open: !!open }, { merge: true }); }
// ---- notifications on this device (Web Push) for new LINE orders ----
// → 'unsupported' | 'ios-install' | 'denied' | 'on' | 'off'
export async function pushState() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return ios && !standalone ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}
async function shopPost(path, body) {
  if (!fb?.auth.currentUser) throw new Error('ต้องล็อกอินก่อน');
  const res = await fetch(`${LINE_API.replace(/\/$/, '')}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await fb.auth.currentUser.getIdToken()}` }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `ระบบ LINE ตอบกลับ ${res.status}`);
  return data;
}
const b64ToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export async function pushEnable() {
  if (!VAPID_KEY || !LINE_API) throw new Error('ยังไม่ได้ตั้งค่าการแจ้งเตือน');
  if (await Notification.requestPermission() !== 'granted') throw new Error('ไม่ได้อนุญาตการแจ้งเตือน เปิดได้ที่ตั้งค่าของเบราว์เซอร์/ระบบ');
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_KEY) });
  const device = /Android/.test(navigator.userAgent) ? 'Android' : /iPad|iPhone/.test(navigator.userAgent) ? 'iPhone/iPad' : 'คอมพิวเตอร์';
  await shopPost('/shop/push', { endpoint: sub.endpoint, device, test: true });
}
export async function pushDisable() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await shopPost('/shop/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// ---- sign in with LINE (LIFF login → Worker checks the LINE account → Firebase custom token) ----
export const lineLoginReady = () => !!(OWNER_LIFF_ID && LINE_API);
let liffReady = null;
function loadLiff() {
  liffReady ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js'; s.charset = 'utf-8';
    s.onload = () => window.liff.init({ liffId: OWNER_LIFF_ID }).then(ok, fail);
    s.onerror = () => fail(new Error('โหลด LINE ไม่ได้ ตรวจอินเทอร์เน็ต'));
    document.head.appendChild(s);
  });
  return liffReady;
}
// returns once signed in; may first leave the page for LINE's login screen and come back (pending flag in sessionStorage)
export async function signInLine() {
  needFb();
  if (!lineLoginReady()) throw new Error('ยังไม่ได้ตั้งค่า ownerLiffId ใน firebase-config.js');
  await loadLiff();
  if (!liff.isLoggedIn()) {
    sessionStorage.setItem('jj_line_login', '1');
    liff.login({ redirectUri: location.origin + location.pathname });
    return new Promise(() => {}); // the page is leaving
  }
  sessionStorage.removeItem('jj_line_login');
  const res = await fetch(`${LINE_API.replace(/\/$/, '')}/auth/line`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: liff.getIDToken() }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { liff.logout(); }
    const e = new Error(data.error || 'เข้าสู่ระบบด้วย LINE ไม่ได้'); e.lineUserId = data.lineUserId; e.lineName = data.name; throw e;
  }
  await fb.A.signInWithCustomToken(fb.auth, data.token);
}
// coming back from LINE's login screen?
export const lineLoginPending = () => { try { return sessionStorage.getItem('jj_line_login') === '1' || /[?&](code|liffClientId)=/.test(location.search); } catch { return false; } };
export async function lineSignOutToo() { try { if (window.liff?.isLoggedIn?.()) liff.logout(); } catch {} }

export async function signInGoogle() { needFb(); try { await fb.A.signInWithPopup(fb.auth, new fb.A.GoogleAuthProvider()); } catch (e) { throw new Error(authMsg(e)); } }
export async function resetPassword(email) { needFb(); try { await fb.A.sendPasswordResetEmail(fb.auth, email); } catch (e) { throw new Error(authMsg(e)); } }
export async function signOut() { await lineSignOutToo(); if (fb) await fb.A.signOut(fb.auth); }
