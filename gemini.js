// Reads bank slips (images) and credit-card statements (PDF) with the Gemini API.

export const DEFAULT_MODEL = 'gemini-3.8-flash-lite'; // fast & light; the real name is looked up if this one doesn't exist
let onModelChange = () => {};
export function setModelChangeHandler(fn) { onModelChange = fn; }
let onFallback = () => {};
export function setFallbackHandler(fn) { onFallback = fn; }
let onStatus = () => {};
export function setStatusHandler(fn) { onStatus = fn; }

// Time limits so a stuck request never hangs the scan screen.
const CALL_TIMEOUT = 40000;   // one request
const FILE_DEADLINE = 120000; // all retries for one file
let cancelled = false;
const live = new Set();
export function cancelAll() { cancelled = true; live.forEach(c => c.abort()); live.clear(); }
export function resetCancel() { cancelled = false; }

const ENDPOINT = m =>`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`;

function blobToBase64(blob) {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => bad(r.error);
    r.readAsDataURL(blob);
  });
}

// Shrink photos so uploads are fast; slips stay readable at ~1600px.
async function imagePart(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return { inline_data: { mime_type: 'image/jpeg', data: await blobToBase64(blob) } };
  } catch {
    return { inline_data: { mime_type: file.type || 'image/jpeg', data: await blobToBase64(file) } };
  }
}

async function filePart(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > 18 * 1024 * 1024) throw new Error('ไฟล์ PDF ใหญ่เกิน 18MB');
    return { inline_data: { mime_type: 'application/pdf', data: await blobToBase64(file) } };
  }
  return imagePart(file);
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['slip', 'statement', 'receipt', 'other'] },
    transactions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date: { type: 'STRING', description: 'YYYY-MM-DD, Gregorian calendar' },
          time: { type: 'STRING', description: 'HH:MM if visible' },
          amount: { type: 'NUMBER', description: 'positive number in THB' },
          type: { type: 'STRING', enum: ['expense', 'income', 'transfer'] },
          category: { type: 'STRING' },
          merchant: { type: 'STRING', description: 'recipient, shop, biller or merchant name' },
          note: { type: 'STRING' },
          ref: { type: 'STRING', description: 'transaction/reference number if visible' },
          method: { type: 'STRING', enum: ['transfer', 'card', 'cash'] },
          from_name: { type: 'STRING', description: 'sender name exactly as printed (may be masked, e.g. นายศุภกร น***)' },
          from_bank: { type: 'STRING' },
          from_account: { type: 'STRING', description: 'sender account as printed, e.g. XXX-X-XX563-1' },
          to_name: { type: 'STRING', description: 'recipient name exactly as printed' },
          to_bank: { type: 'STRING' },
          to_account: { type: 'STRING' },
          fee: { type: 'NUMBER', description: 'transfer/payment fee in THB, 0 if none' },
          bill_ref: { type: 'STRING', description: 'customer/meter/phone number for utility or phone bills' },
        },
        required: ['date', 'amount', 'type', 'category'],
      },
    },
  },
  required: ['kind', 'transactions'],
};

function prompt(categories, today, ownerNames) {
  const cats = categories.map(c => `${c.id} (${c.type === 'income' ? 'income' : (c.group || 'opex')}: ${c.name})`).join(', ');
  const owner = ownerNames.length ? ownerNames.join(' / ') : '(unknown — infer from the slip)';
  return `You extract money transactions for the bookkeeping app of a small Thai smoothie / blended-drink shop. Today is ${today}.
The shop owner's name(s) / shop account name(s): ${owner}.
Category groups: "cogs" = ingredients and packaging used to make drinks (fruit, milk, powders, syrup, ice, toppings, cups/lids/straws/bags);
"opex" = running costs (rent, electricity, water, wages, phone/internet, repairs, cleaning supplies, marketing, fees);
"invest" = start-up / long-lived purchases (blenders, freezers, fridges, counters, furniture, signs, decoration, deposits).
SHOP RULES:
- A supplier receipt or market bill (Makro, Lotus's, Big C, fruit market, wholesale) with several kinds of items: return ONE transaction PER CATEGORY,
  summing the lines that belong to it (e.g. fruit 450, packaging 320). Put the main items in note.
- Equipment or decoration costing a lot and lasting a long time → an "invest" category, not cogs.
- Money paid TO the shop by a customer (recipient is the shop/owner, sender is someone else) is "income" with category "sales" and method "transfer".
The file is a Thai bank transfer slip (e-slip), a bill/payment receipt, or a credit card statement.

TYPE rules for slips and receipts (return exactly one transaction, method "transfer" unless it says card/cash):
- "transfer" = moving money between the owner's OWN accounts: sender and recipient are the same person
  (same first name, same surname or matching surname initial; masked names like "นายศุภกร น***" match "นายศุภกร นิตยวรรณ"),
  or both match the owner's name. Also "transfer" when topping up the owner's own e-wallet/savings/investment account,
  and when paying the owner's own credit card bill (recipient is a card issuer, e.g. KTC, บัตรเครดิต, Credit Card) —
  put "ชำระบัตรเครดิต" in note. For transfers set category "transfer".
- "expense" = money sent from the owner to someone else, or a bill/shop payment.
- "income" = money received by the owner from someone else (recipient is the owner, sender is another person).
- Always fill from_name/from_bank/from_account and to_name/to_bank/to_account exactly as printed when visible.
- fee = the fee (ค่าธรรมเนียม) if printed, else 0. amount must NOT include the fee.

BILLS and receipts — pick the most specific category:
- Electricity: การไฟฟ้านครหลวง / MEA, การไฟฟ้าส่วนภูมิภาค / PEA → "electric".
- Water: การประปานครหลวง / MWA, การประปาส่วนภูมิภาค / PWA → "water".
- Internet: 3BB, AIS Fibre, True Online, NT broadband, TOT → "internet".
- Mobile phone: AIS, True, dtac, NT mobile top-up or postpaid bill → "internet".
- Put the account/meter/phone number in bill_ref and the billing period in note when printed.

Credit card statement (kind "statement"): return every purchase line as "expense" with method "card". Interest, fees and
late charges are separate "expense" items with category "fee". Installments (e.g. 3/10) are expenses; put the installment
info in note. Cashback, refunds and reversals are "income" with category "inc_other". SKIP payments made to the card itself
("PAYMENT", "ชำระเงิน", "ขอบคุณสำหรับการชำระ") and previous-balance/total lines.

General:
- Thai dates often use the Buddhist year (e.g. 2569 or "69"): subtract 543. Output YYYY-MM-DD. Thai months: ม.ค.=01 ก.พ.=02 มี.ค.=03 เม.ย.=04 พ.ค.=05 มิ.ย.=06 ก.ค.=07 ส.ค.=08 ก.ย.=09 ต.ค.=10 พ.ย.=11 ธ.ค.=12. If the year is missing, use the most recent date not after today.
- amount is a positive number in baht without currency symbols.
- category must be one of these ids: ${cats}, or "transfer". Use "exp_other" / "inc_other" when unsure.
- merchant: recipient, biller or shop name as printed. ref: the reference/transaction number (รหัสอ้างอิง / เลขที่รายการ).
- If the file contains no transaction, return an empty transactions array with kind "other".`;
}

// "นายศุภกร น***" vs "นายศุภกร นิตยวรรณ" → same person (title-less first name equal, surname initial equal)
const TITLES = /^(นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.?|mrs\.?|ms\.?|miss)\s*/i;
function nameParts(s) {
  const parts = String(s || '').trim().replace(TITLES, '').replace(/\s+/g, ' ').toLowerCase().split(' ');
  return { first: parts[0] || '', last: (parts[1] || '').replace(/[*xX.]+$/, '') };
}
export function samePerson(a, b) {
  const x = nameParts(a), y = nameParts(b);
  if (!x.first || !y.first || x.first !== y.first) return false;
  if (!x.last || !y.last) return true;
  return x.last.startsWith(y.last) || y.last.startsWith(x.last);
}
const isOwner = (name, owners) => owners.some(o => samePerson(name, o));
const acct = (bank, no) => [bank, no].filter(Boolean).join(' ');

export async function readFile(file, { key, model, categories, today, ownerNames = [] }) {
  if (!key) throw new Error('ยังไม่ได้ใส่ Gemini API key (ไปที่ ตั้งค่า)');
  const part = await filePart(file);
  const data = await generate(key, model, {
    contents: [{ role: 'user', parts: [{ text: prompt(categories, today, ownerNames) }, part] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 },
  });
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('อ่านผลลัพธ์จาก Gemini ไม่ได้'); }
  return normalize(out, { categories, today, ownerNames });
}

// Turn Gemini's answer into app transactions; double-checks own-account transfers and splits fees.
export function normalize(out, { categories, today, ownerNames = [] }) {
  const ids = new Set(categories.map(c => c.id));
  const statement = out.kind === 'statement';
  const res = [];
  for (const t of out.transactions || []) {
    if (!t || !(Number(t.amount) > 0)) continue;
    let type = ['income', 'expense', 'transfer'].includes(t.type) ? t.type : 'expense';
    const fromMe = t.from_name && (isOwner(t.from_name, ownerNames) || (t.to_name && samePerson(t.from_name, t.to_name)));
    const toMe = t.to_name && (isOwner(t.to_name, ownerNames) || (t.from_name && samePerson(t.from_name, t.to_name)));
    if (!statement && fromMe && toMe) type = 'transfer';
    else if (!statement && type === 'transfer' && t.from_name && t.to_name && !samePerson(t.from_name, t.to_name) && ownerNames.length
      && !(isOwner(t.from_name, ownerNames) && isOwner(t.to_name, ownerNames)) && !/บัตรเครดิต|credit/i.test(t.note || '')) {
      type = isOwner(t.to_name, ownerNames) ? 'income' : 'expense'; // model said transfer but names say otherwise
    }
    const route = (t.from_account || t.to_account) ? `${acct(t.from_bank, t.from_account)} → ${acct(t.to_bank, t.to_account)}` : '';
    const note = [t.note, t.bill_ref && `เลขที่ ${t.bill_ref}`, type === 'transfer' && route].filter(Boolean).join(' · ');
    const base = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : today,
      time: t.time || '',
      method: !statement && t.type === 'income' && (!t.method || t.method === 'transfer') ? 'promptpay' : (t.method || (statement ? 'card' : 'transfer')),
      source: statement ? 'statement' : 'slip',
      ref: t.ref || '',
    };
    res.push({
      ...base,
      amount: Math.round(Number(t.amount) * 100) / 100,
      type,
      cat: type === 'transfer' ? 'transfer' : ids.has(t.category) ? t.category : (type === 'income' ? 'inc_other' : 'exp_other'),
      merchant: type === 'transfer' ? (t.to_name || t.merchant || '') : (type === 'income' ? (t.from_name || t.merchant || '') : (t.merchant || t.to_name || '')),
      note,
    });
    const fee = Math.round((Number(t.fee) || 0) * 100) / 100;
    if (!statement && fee > 0) {
      res.push({ ...base, amount: fee, type: 'expense', cat: ids.has('fee') ? 'fee' : 'exp_other', merchant: t.from_bank || 'ค่าธรรมเนียม',
        note: 'ค่าธรรมเนียมการโอน', ref: base.ref ? base.ref + '-fee' : '' });
    }
  }
  return res;
}

export async function testKey(key, model) {
  await generate(key, model, { contents: [{ parts: [{ text: 'ตอบคำว่า OK' }] }] });
  return true;
}

const BUSY = new Set([0, 408, 429, 500, 502, 503, 504]); // 0 = network hiccup, 408 = our timeout
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callOnce(key, model, body, timeoutMs) {
  const ctrl = new AbortController();
  live.add(ctrl);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(1000, timeoutMs));
  try {
    const res = await fetch(ENDPOINT(model), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true, data: await res.json() };
    let msg = ''; try { msg = (await res.json()).error?.message || ''; } catch {}
    return { ok: false, status: res.status, msg };
  } catch {
    if (cancelled) return { ok: false, status: -1, msg: 'cancelled' };
    return { ok: false, status: timedOut ? 408 : 0, msg: timedOut ? 'timeout' : '' };
  } finally {
    clearTimeout(timer);
    live.delete(ctrl);
  }
}

// Picks another Flash model this key can use: same family first (Lite ↔ Lite), stable before
// preview, newest first. Used when the model is overloaded or its name doesn't exist.
let modelListCache = null;
async function pickFallback(key, current, wantLite = /lite/.test(current)) {
  try {
    if (!modelListCache) {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
        { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      modelListCache = ((await res.json()).models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));
    }
    const ver = n => parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
    const ok = modelListCache.filter(n => n !== current && /^gemini-.*flash/.test(n) &&
      !/image|tts|audio|live|embed|vision|thinking/.test(n));
    const family = n => (/lite/.test(n) === wantLite ? 0 : 1);
    ok.sort((a, b) => (family(a) - family(b)) || (/preview|exp/.test(a) - /preview|exp/.test(b)) || ver(b) - ver(a));
    return ok[0] || null;
  } catch { return null; }
}

function friendlyError({ status, msg }, model) {
  if (status === -1) return new Error('ยกเลิกแล้ว');
  if (status === 408) return new Error('Gemini ตอบช้าเกินไป (เซิร์ฟเวอร์อาจยุ่ง) ลองใหม่อีกครั้งในอีกสักครู่');
  if (status === 0) return new Error('เชื่อมต่อ Gemini ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่');
  if (status === 400 && /api key/i.test(msg)) return new Error('API key ไม่ถูกต้อง');
  if (status === 403) return new Error('API key ไม่มีสิทธิ์ใช้งาน (403)');
  if (status === 404 || /no longer available|not found/i.test(msg))
    return new Error(`โมเดล "${model}" ใช้ไม่ได้แล้ว ลองเปลี่ยนชื่อโมเดลในตั้งค่า (ดูรายชื่อใน aistudio.google.com)`);
  if (status === 429) return new Error('ใช้เกินโควตาฟรีชั่วคราว รอประมาณ 1 นาทีแล้วลองใหม่');
  if (status === 503 || status === 500 || status === 502 || status === 504)
    return new Error('เซิร์ฟเวอร์ Gemini มีคนใช้เยอะชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่');
  return new Error(`Gemini ตอบกลับผิดพลาด (${status}) ${msg}`.trim());
}

// Calls Gemini with automatic recovery:
//  - busy/overloaded (503, 429, 5xx): retry with backoff, then try another Flash model once (not saved)
//  - retired model whose error names a replacement: switch to it and remember it
async function generate(key, model, body, opts = {}) {
  model = model || DEFAULT_MODEL;
  const deadline = opts.deadline || Date.now() + FILE_DEADLINE;
  opts = { ...opts, deadline };
  let last = { status: 408, msg: 'timeout' };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (cancelled) return Promise.reject(friendlyError({ status: -1 }, model));
    if (attempt) {
      onStatus(`Gemini ยุ่งอยู่ กำลังลองใหม่ (${attempt + 1}/3)…`);
      await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 400);
    }
    const left = deadline - Date.now();
    if (left < 3000) break;
    const r = await callOnce(key, model, body, Math.min(CALL_TIMEOUT, left));
    if (r.ok) return r.data;
    last = r;
    if (r.status === -1) throw friendlyError(r, model);
    if (r.status === 408 && attempt >= 1 && !opts.fallbackHop) break; // two slow tries: leave time for a backup model
    const suggested = r.msg.match(/use\s+(?:models\/)?(gemini-[\w.-]*\w)/i)?.[1];
    if (!opts.retiredHop && suggested && suggested !== model) {
      onModelChange(suggested);
      return generate(key, suggested, body, { ...opts, retiredHop: true });
    }
    // model name doesn't exist for this key (e.g. a guessed Flash-Lite name): find the real one and remember it
    if (!opts.resolvedHop && (r.status === 404 || /not found|no longer available|is not supported/i.test(r.msg))) {
      onStatus('กำลังหารุ่น Gemini ที่ใช้ได้…');
      const alt = await pickFallback(key, model);
      if (alt) {
        onModelChange(alt);
        return generate(key, alt, body, { ...opts, retiredHop: true, resolvedHop: true });
      }
    }
    if (!BUSY.has(r.status)) break;
  }
  if (BUSY.has(last.status) && last.status !== 0 && !opts.fallbackHop && !cancelled && deadline - Date.now() > 10000) {
    const alt = await pickFallback(key, model);
    if (alt) {
      onFallback(alt);
      onStatus(`รุ่นหลักยุ่ง กำลังลองด้วย ${alt}…`);
      return generate(key, alt, body, { retiredHop: true, fallbackHop: true, deadline });
    }
  }
  throw friendlyError(last, model);
}
