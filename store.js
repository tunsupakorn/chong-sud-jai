// Data layer: works locally (localStorage) and switches to Firebase Firestore for multi-device sync.
import { firebaseConfig as FILE_CONFIG, ownerUid as OWNER_UID, inviteOnly as INVITE_ONLY, privateApp as PRIVATE_APP } from './firebase-config.js';
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
export const DEFAULT_MENU = [
  { id: 'm_watermelon', name: 'แตงโมปั่น', emoji: '🍉', price: 35, cost: 12, group: 'fruit' },
  { id: 'm_pineapple', name: 'สับปะรดปั่น', emoji: '🍍', price: 35, cost: 11, group: 'fruit' },
  { id: 'm_mango', name: 'มะม่วงปั่น', emoji: '🥭', price: 45, cost: 17, group: 'fruit' },
  { id: 'm_strawberry', name: 'สตรอว์เบอร์รีปั่น', emoji: '🍓', price: 45, cost: 18, group: 'fruit' },
  { id: 'm_coconut', name: 'มะพร้าวปั่น', emoji: '🥥', price: 40, cost: 14, group: 'fruit' },
  { id: 'm_banana', name: 'กล้วยนมปั่น', emoji: '🍌', price: 35, cost: 11, group: 'fruit' },
  { id: 'm_yogurt', name: 'โยเกิร์ตผลไม้ปั่น', emoji: '🥣', price: 50, cost: 20, group: 'fruit' },
  { id: 'm_smoothie', name: 'สมูทตี้รวมผลไม้', emoji: '🍹', price: 60, cost: 25, group: 'fruit' },
  { id: 'm_thaitea', name: 'ชาไทยปั่น', emoji: '🧋', price: 35, cost: 12, group: 'drink' },
  { id: 'm_greentea', name: 'ชาเขียวปั่น', emoji: '🍵', price: 40, cost: 14, group: 'drink' },
  { id: 'm_cocoa', name: 'โกโก้ปั่น', emoji: '🍫', price: 35, cost: 12, group: 'drink' },
  { id: 'm_coffee', name: 'กาแฟปั่น', emoji: '☕', price: 45, cost: 16, group: 'drink' },
  { id: 'm_milk', name: 'นมสดปั่น', emoji: '🥛', price: 30, cost: 10, group: 'drink' },
  { id: 'm_ovaltine', name: 'โอวัลตินปั่น', emoji: '🥤', price: 35, cost: 12, group: 'drink' },
  { id: 'm_honeylime', name: 'น้ำผึ้งมะนาวโซดา', emoji: '🍋', price: 25, cost: 8, group: 'drink' },
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
  A.onAuthStateChanged(auth, user => user ? attachUser(user) : detachUser());
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

function attachUser(user) {
  const { db, F } = fb;
  unsubs.forEach(u => u()); unsubs = [];
  state.mode = 'cloud';
  state.isOwner = !!OWNER_UID && user.uid === OWNER_UID;
  state.user = { uid: user.uid, email: user.email, name: user.displayName, verified: user.emailVerified,
    provider: user.providerData?.[0]?.providerId || 'password' };
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
  unsubs.push(F.onSnapshot(F.collection(db, 'users', user.uid, 'tx'), { includeMetadataChanges: true }, snap => {
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
  unsubs.push(F.onSnapshot(F.doc(db, 'users', user.uid), snap => {
    const s = snap.exists() ? snap.data().settings : null;
    state.settings = { ...defaultSettings(), catVersion: s?.categories ? 1 : CAT_VERSION, ...(s || {}) };
    if (s && migrateSettings(state.settings) && !snap.metadata.fromCache)
      F.setDoc(F.doc(db, 'users', user.uid), { settings: clean(state.settings) }, { merge: true }).catch(syncFail);
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
  state.syncStatus = state.cloudConfigured ? 'signed-out' : 'local';
  loadLocal();
  emit();
}

const clean = o => JSON.parse(JSON.stringify(o)); // drop undefined for Firestore
const userPath = (...p) => [fb.db, 'users', state.user.uid, ...p];

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

export function deleteTx(id) {
  if (state.mode === 'cloud') fb.F.deleteDoc(fb.F.doc(...userPath('tx', id))).catch(syncFail);
  else { state.tx = state.tx.filter(t => t.id !== id); writeLocal(); }
}

export function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  if (state.mode === 'cloud') fb.F.setDoc(fb.F.doc(...userPath()), { settings: clean(state.settings) }, { merge: true }).catch(syncFail);
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
  await u.getIdToken(true);
  attachUser(fb.auth.currentUser);
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
export async function signInGoogle() { needFb(); try { await fb.A.signInWithPopup(fb.auth, new fb.A.GoogleAuthProvider()); } catch (e) { throw new Error(authMsg(e)); } }
export async function resetPassword(email) { needFb(); try { await fb.A.sendPasswordResetEmail(fb.auth, email); } catch (e) { throw new Error(authMsg(e)); } }
export async function signOut() { if (fb) await fb.A.signOut(fb.auth); }
