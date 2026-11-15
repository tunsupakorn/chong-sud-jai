/**
 * จุกจิก JukJik → Google Sheet mirror
 *
 * แอปจุกจิกส่งรายการทั้งหมดมาที่ web app นี้ แล้วสคริปต์เขียนทับลงชีตให้ตรงกับแอปเสมอ
 * (Firebase ยังเป็นที่เก็บหลัก ชีตนี้มีไว้ดู/วิเคราะห์ — แก้ในชีตจะถูกเขียนทับรอบถัดไป)
 *
 * ความปลอดภัย: ครั้งแรกที่แอปเชื่อมต่อ จะส่งรหัสลับ (token) มาจับคู่ไว้
 * หลังจากนั้นทุกคำขอต้องมีรหัสเดียวกัน — ถ้าต้องการจับคู่ใหม่ ให้รัน resetPairing()
 */

const APP_URL = 'https://tunsupakorn.github.io/jukjik-kaa/';
const SHEET_TX = 'รายการ';
const SHEET_MONTH = 'สรุปรายเดือน';
const SHEET_CAT = 'แยกหมวด';
const SHEET_INFO = 'เกี่ยวกับ';
const HEADER_BG = '#FFC83D';
const METHOD = { cash: 'เงินสด', transfer: 'โอน', card: 'บัตร' };
const SOURCE = { manual: 'จดเอง', slip: 'สลิป', statement: 'ใบแจ้งยอด' };

/** รันครั้งแรกจากหน้าแก้ไขสคริปต์ เพื่ออนุญาตสิทธิ์และเตรียมชีต */
function setup() {
  const ss = book();
  ss.setSpreadsheetTimeZone('Asia/Bangkok');
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  [SHEET_TX, SHEET_MONTH, SHEET_CAT, SHEET_INFO].forEach(getSheet);
  removeDefaultSheet(ss);
  writeInfo(0, 'ยังไม่ได้เชื่อมกับแอป');
  Logger.log('พร้อมแล้ว: ' + ss.getUrl());
}

// ---- เมนู 🐣 จุกจิก ในชีต: พาเชื่อมกับแอปทีละขั้น ----
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🐣 จุกจิก')
    .addItem('เชื่อมกับแอปจุกจิก (เริ่มที่นี่)', 'showConnect')
    .addSeparator()
    .addItem('ยกเลิกการจับคู่กับแอป', 'resetPairingMenu')
    .addToUi();
}

function webAppUrl() {
  try { const u = ScriptApp.getService().getUrl(); return u && /\/exec$/.test(u) ? u : ''; } catch (e) { return ''; }
}

function showConnect() {
  setup();
  const url = webAppUrl();
  const paired = !!PropertiesService.getScriptProperties().getProperty('TOKEN');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const css = '<style>body{font-family:Sarabun,Tahoma,sans-serif;font-size:14px;line-height:1.6;color:#2B2118}' +
    'ol{padding-left:20px}li{margin-bottom:6px}b{color:#000}.box{background:#FFF1D2;border-radius:10px;padding:10px;margin:10px 0}' +
    'input{width:100%;padding:8px;font-size:13px;border:1px solid #F1E3C6;border-radius:8px}' +
    'button{background:#FFC83D;border:0;border-radius:10px;padding:10px 14px;font-weight:bold;cursor:pointer;margin-top:8px}</style>';
  let html;
  if (url) {
    // one-click connect: the sheet owner (who is the only one who can open this menu) issues a fresh key,
    // and the app receives it in the link's #fragment (never sent to any server)
    const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    PropertiesService.getScriptProperties().setProperty('TOKEN', token);
    const link = APP_URL + '#connect=' + encodeURIComponent(url) + '&key=' + token;
    html = css + '<p>✅ ชีตนี้พร้อมแล้ว' + (paired ? ' (การเชื่อมเดิมจะถูกแทนที่ด้วยปุ่มนี้)' : '') + '</p>' +
      '<a href="' + esc(link) + '" target="_blank" style="display:block;text-align:center;background:#FFC83D;color:#2B2118;font-weight:bold;' +
      'text-decoration:none;border-radius:12px;padding:14px;font-size:16px;margin:8px 0">🐣 เปิดแอปจุกจิกและเชื่อมต่อให้อัตโนมัติ</a>' +
      '<p>กดปุ่มด้านบน แอปจะเปิดขึ้นแล้วถามยืนยัน กด <b>ตกลง</b> — เสร็จแล้ว! (ต้องล็อกอินแอปไว้ก่อน)</p>' +
      '<details><summary style="cursor:pointer;color:#8C7C66">เชื่อมจากมือถือ / คัดลอกลิงก์เอง</summary>' +
      '<div class="box">ส่งลิงก์นี้ไปเปิดในเครื่องที่ใช้แอป (เช่น ส่ง LINE หาตัวเอง)<input id="u" value="' + esc(link) + '" readonly onclick="this.select()">' +
      '<button onclick="var i=document.getElementById(\'u\');i.select();document.execCommand(\'copy\');this.textContent=\'คัดลอกแล้ว ✓\'">📋 คัดลอกลิงก์เชื่อมต่อ</button></div></details>' +
      '<p style="color:#8C7C66">อย่าส่งลิงก์นี้ให้คนอื่น ใครเปิดลิงก์นี้จะเชื่อมกับชีตของคุณได้</p>';
  } else {
    html = css + '<p>เหลืออีกขั้นเดียว: เปิดชีตนี้เป็น <b>web app</b> (ทำครั้งเดียว ~1 นาที)</p><ol>' +
      '<li>เมนู <b>ส่วนขยาย › Apps Script</b></li>' +
      '<li>มุมขวาบน กด <b>การทำให้ใช้งานได้ › การทำให้ใช้งานได้รายการใหม่</b> (Deploy › New deployment)</li>' +
      '<li>ตรงไอคอนฟันเฟือง เลือก <b>เว็บแอป</b> (Web app)</li>' +
      '<li>ตั้งค่า: เรียกใช้ในฐานะ <b>ฉัน</b> · ผู้มีสิทธิ์เข้าถึง <b>ทุกคน</b> (Execute as: Me · Who has access: Anyone)</li>' +
      '<li>กด <b>ทำให้ใช้งานได้</b> แล้วกด <b>ให้สิทธิ์</b> › เลือกบัญชี › Advanced › Go to … › <b>Allow</b></li>' +
      '<li>กลับมาที่ชีตนี้ เปิดเมนู <b>🐣 จุกจิก › เชื่อมกับแอปจุกจิก</b> อีกครั้ง จะมีปุ่มเปิดแอปและเชื่อมต่อให้อัตโนมัติ</li></ol>';
  }
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(460).setHeight(url ? 340 : 420), '🐣 เชื่อมกับแอปจุกจิก');
}

function resetPairingMenu() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('ยกเลิกการจับคู่กับแอป?', 'ใช้เมื่อต้องการเชื่อมกับบัญชีจุกจิกใหม่ ข้อมูลในชีตยังอยู่', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  resetPairing();
  ui.alert('ยกเลิกแล้ว เปิดแอปแล้วกดเชื่อมต่อใหม่ได้เลย');
}

/** ยกเลิกการจับคู่กับแอป (ให้แอปเชื่อมต่อใหม่ได้) */
function resetPairing() {
  PropertiesService.getScriptProperties().deleteProperty('TOKEN');
  Logger.log('ยกเลิกการจับคู่แล้ว');
}

function doGet() {
  return json({ ok: true, app: 'jukjik-sheet', paired: !!PropertiesService.getScriptProperties().getProperty('TOKEN') });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'bad-request' }); }
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('TOKEN');
  if (!req.token || String(req.token).length < 24) return json({ ok: false, error: 'missing-token' });

  if (req.action === 'pair') {
    if (!saved) props.setProperty('TOKEN', String(req.token));
    else if (saved !== req.token) return json({ ok: false, error: 'already-paired' });
    return json({ ok: true, paired: true, sheetUrl: book().getUrl() });
  }

  if (!saved || saved !== req.token) return json({ ok: false, error: 'unauthorized' });

  if (req.action === 'sync') {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return json({ ok: false, error: 'busy' });
    try {
      const n = writeAll(req);
      return json({ ok: true, rows: n, sheetUrl: book().getUrl(), at: new Date().toISOString() });
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) });
    } finally {
      lock.releaseLock();
    }
  }
  if (req.action === 'slip') {
    try { return json(Object.assign({ ok: true }, saveSlip(req))); }
    catch (err) { return json({ ok: false, error: 'drive: ' + String(err && err.message || err) }); }
  }
  return json({ ok: false, error: 'unknown-action' });
}

// ---- เก็บรูปสลิปใน Google Drive: "จุกจิก JukJik — สลิป/2026-11/..." ----
const SLIP_ROOT = 'จุกจิก JukJik — สลิป';

// Built-in Drive service. The script only ever creates and writes inside the
// "จุกจิก JukJik — สลิป" folder; folder ids are remembered in Script Properties.
function storedFolder(key, create) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(key);
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const f = create();
  props.setProperty(key, f.getId());
  return f;
}
function slipRoot() {
  return storedFolder('SLIP_ROOT_ID', () => {
    const it = DriveApp.getFoldersByName(SLIP_ROOT);
    while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
    return DriveApp.createFolder(SLIP_ROOT);
  });
}
function monthFolder(month) {
  const root = slipRoot();
  return storedFolder('SLIP_M_' + root.getId() + '_' + month, () => {
    const it = root.getFoldersByName(month);
    return it.hasNext() ? it.next() : root.createFolder(month);
  });
}

function saveSlip(req) {
  if (!req.data || !req.name) throw new Error('missing file');
  const folder = monthFolder(/^\d{4}-\d{2}$/.test(req.month || '') ? req.month : 'อื่นๆ');
  const name = String(req.name).replace(/[\/:*?"<>|]/g, '-').slice(0, 120);
  const mime = /^(image\/(jpeg|png|webp|heic)|application\/pdf)$/.test(req.mime || '') ? req.mime : 'image/jpeg';
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(req.data), mime, name));
  if (req.desc) file.setDescription(String(req.desc).slice(0, 500));
  return { id: file.getId(), url: file.getUrl(), folderUrl: slipRoot().getUrl() };
}

/** รันจากหน้าแก้ไขสคริปต์ เพื่ออนุญาตสิทธิ์ Google Drive (สร้างโฟลเดอร์สลิป) */
function setupDrive() {
  const root = slipRoot();
  Logger.log('โฟลเดอร์สลิป: ' + root.getUrl());
}

// ---------------------------------------------------------------------------

function book() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
}

function getSheet(name) {
  const ss = book();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function removeDefaultSheet(ss) {
  ['Sheet1', 'ชีต1', 'แผ่น1'].forEach(n => {
    const sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1 && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// กันสูตรแปลกปลอม (เช่น ชื่อร้านที่ขึ้นต้นด้วย =)
function safe(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function ensureSize(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}

function styleHeader(sh, cols) {
  sh.getRange(1, 1, 1, cols).setFontWeight('bold').setBackground(HEADER_BG).setFontColor('#2B2118');
  sh.setFrozenRows(1);
}

function writeAll(req) {
  const ss = book();
  removeDefaultSheet(ss);
  if (ss.getSpreadsheetTimeZone() !== 'Asia/Bangkok') ss.setSpreadsheetTimeZone('Asia/Bangkok');
  const catName = {};
  (req.categories || []).forEach(c => { catName[c.id] = (c.emoji ? c.emoji + ' ' : '') + c.name; });
  catName.transfer = '🔄 ย้ายเงิน';

  const tx = (req.tx || []).filter(t => t && /^\d{4}-\d{2}-\d{2}$/.test(t.date))
    .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));

  // ---- รายการ ----
  const HEAD = ['วันที่', 'เดือน', 'ประเภท', 'หมวด', 'จำนวนเงิน', 'ยอดสุทธิ', 'ช่องทาง', 'ผู้รับ/ร้าน', 'โน้ต', 'ที่มา', 'เลขอ้างอิง', 'เวลา', 'สลิป', 'id'];
  const slipLink = u => /^https:\/\/drive\.google\.com\/[\w\/?=&.-]+$/.test(u || '') ? '=HYPERLINK("' + u + '","📎 ดูสลิป")' : '';
  const rows = tx.map(t => {
    const amt = Math.round((Number(t.amount) || 0) * 100) / 100;
    const inc = t.type === 'income', move = t.type === 'transfer';
    const p = t.date.split('-').map(Number);
    // noon, so the day can't shift across time zones
    return [new Date(p[0], p[1] - 1, p[2], 12), t.date.slice(0, 7), move ? 'ย้ายเงิน' : inc ? 'รายรับ' : 'รายจ่าย', safe(catName[t.cat] || t.cat || 'ไม่ระบุ'),
      amt, move ? 0 : inc ? amt : -amt, METHOD[t.method] || safe(t.method), safe(t.merchant), safe(t.note),
      SOURCE[t.source] || safe(t.source), safe(t.ref), safe(t.time), slipLink(t.slipUrl), safe(t.id)];
  });
  const sh = getSheet(SHEET_TX);
  sh.clear();
  ensureSize(sh, rows.length + 1, HEAD.length);
  sh.getRange(1, 2, Math.max(rows.length + 1, 2), 1).setNumberFormat('@');           // เดือน เป็นข้อความ
  sh.showColumns(1, HEAD.length);
  sh.getRange(1, 11, Math.max(rows.length + 1, 2), 2).setNumberFormat('@');          // อ้างอิง เวลา
  sh.getRange(1, 13, Math.max(rows.length + 1, 2), 1).setNumberFormat('General');    // ลิงก์สลิป (สูตร)
  sh.getRange(1, 14, Math.max(rows.length + 1, 2), 1).setNumberFormat('@');          // id
  sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, HEAD.length).setValues(rows);
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(2, 5, rows.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(2, 6, rows.length, 1).setNumberFormat('[Color10]+#,##0.00;[Red]-#,##0.00;0.00');
  }
  styleHeader(sh, HEAD.length);
  sh.hideColumns(14);

  // ---- สรุปรายเดือน ----
  const byMonth = {};
  tx.forEach(t => {
    const m = t.date.slice(0, 7);
    const o = byMonth[m] || (byMonth[m] = { inc: 0, exp: 0, move: 0, n: 0 });
    const a = Number(t.amount) || 0;
    if (t.type === 'income') o.inc += a; else if (t.type === 'transfer') o.move += a; else o.exp += a;
    o.n++;
  });
  const months = Object.keys(byMonth).sort().reverse();
  const MHEAD = ['เดือน', 'รายรับ', 'รายจ่าย', 'คงเหลือ', 'จำนวนรายการ', 'ย้ายเงิน (ไม่นับ)'];
  const mrows = months.map(m => [m, byMonth[m].inc, byMonth[m].exp, byMonth[m].inc - byMonth[m].exp, byMonth[m].n, byMonth[m].move]);
  const ms = getSheet(SHEET_MONTH);
  ms.clear();
  ensureSize(ms, mrows.length + 1, MHEAD.length);
  ms.getRange(1, 1, Math.max(mrows.length + 1, 2), 1).setNumberFormat('@');
  ms.getRange(1, 1, 1, MHEAD.length).setValues([MHEAD]);
  if (mrows.length) {
    ms.getRange(2, 1, mrows.length, MHEAD.length).setValues(mrows);
    ms.getRange(2, 2, mrows.length, 2).setNumberFormat('#,##0.00');
    ms.getRange(2, 6, mrows.length, 1).setNumberFormat('#,##0.00');
    ms.getRange(2, 4, mrows.length, 1).setNumberFormat('[Color10]#,##0.00;[Red]-#,##0.00;0.00');
  }
  styleHeader(ms, MHEAD.length);

  // ---- แยกหมวด (รายจ่าย 12 เดือนล่าสุด) ----
  const last12 = months.slice(0, 12);
  const byCat = {};
  tx.filter(t => t.type === 'expense' && last12.indexOf(t.date.slice(0, 7)) >= 0).forEach(t => {
    const c = catName[t.cat] || t.cat || 'ไม่ระบุ';
    const o = byCat[c] || (byCat[c] = { total: 0 });
    const m = t.date.slice(0, 7);
    o[m] = (o[m] || 0) + (Number(t.amount) || 0);
    o.total += Number(t.amount) || 0;
  });
  const cats = Object.keys(byCat).sort((a, b) => byCat[b].total - byCat[a].total);
  const CHEAD = ['หมวด (รายจ่าย)'].concat(last12, ['รวม']);
  const crows = cats.map(c => [safe(c)].concat(last12.map(m => byCat[c][m] || 0), [byCat[c].total]));
  const cs = getSheet(SHEET_CAT);
  cs.clear();
  ensureSize(cs, crows.length + 1, CHEAD.length);
  cs.getRange(1, 1, 1, CHEAD.length).setNumberFormat('@').setValues([CHEAD]);
  if (crows.length) {
    cs.getRange(2, 1, crows.length, CHEAD.length).setValues(crows);
    cs.getRange(2, 2, crows.length, CHEAD.length - 1).setNumberFormat('#,##0.00');
  }
  styleHeader(cs, CHEAD.length);
  cs.setFrozenColumns(1);

  writeInfo(rows.length, req.device || '');
  return rows.length;
}

function writeInfo(count, device) {
  const sh = getSheet(SHEET_INFO);
  sh.clear();
  const tz = Session.getScriptTimeZone() || 'Asia/Bangkok';
  const values = [
    ['🐣 จุกจิก JukJik — สำเนาข้อมูลอัตโนมัติ', ''],
    ['ซิงก์ล่าสุด', Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy HH:mm:ss')],
    ['จำนวนรายการ', count],
    ['ส่งจาก', device],
    ['', ''],
    ['⚠️ หมายเหตุ', 'ชีตนี้ถูกเขียนทับจากแอปจุกจิกทุกครั้งที่มีการเปลี่ยนแปลง ถ้าแก้ไขในชีตนี้ จะหายในการซิงก์รอบถัดไป'],
    ['', 'ถ้าต้องการทำสูตร/กราฟเพิ่ม ให้สร้างชีตใหม่ (แท็บใหม่) แล้วอ้างอิงข้อมูลจากชีต "รายการ"'],
  ];
  sh.getRange(1, 1, values.length, 2).setValues(values);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  sh.getRange(2, 1, 3, 1).setFontWeight('bold');
  sh.getRange(6, 1).setFontWeight('bold');
  sh.setColumnWidth(1, 160);
  sh.setColumnWidth(2, 560);
  sh.getRange(6, 2, 2, 1).setWrap(true);
}
