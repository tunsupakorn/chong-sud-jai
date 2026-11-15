// Reads the mini QR code printed on Thai bank e-slips — free, on the device, no AI.
// The QR carries the sending bank code and the bank's transaction reference, which
// makes duplicate detection exact. (It does not contain the amount.)

const BANKS = {
  '002': 'กรุงเทพ', '004': 'กสิกรไทย', '006': 'กรุงไทย', '011': 'ทหารไทยธนชาต', '014': 'ไทยพาณิชย์',
  '022': 'ซีไอเอ็มบี', '024': 'ยูโอบี', '025': 'กรุงศรี', '030': 'ออมสิน', '033': 'ธอส.', '034': 'ธ.ก.ส.',
  '066': 'อิสลาม', '067': 'ทิสโก้', '069': 'เกียรตินาคินภัทร', '070': 'ไอซีบีซี', '071': 'ไทยเครดิต', '073': 'แลนด์ แอนด์ เฮ้าส์',
};

// EMVCo-style TLV: 2-digit id, 2-digit length, value
function tlv(s) {
  const out = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const id = s.slice(i, i + 2), len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(len) || i + 4 + len > s.length) break;
    out[id] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

// e.g. "0041000600000101030040220014242082547BPM049095102TH9104ABCD"
export function parseSlipQR(text) {
  if (!text || typeof text !== 'string') return null;
  const top = tlv(text.trim());
  if (!top['00']) return null;
  const inner = tlv(top['00']);
  if (inner['00'] !== '000001' || !inner['02']) return null;       // not a bank slip QR (e.g. PromptPay payment QR)
  const bankCode = inner['01'] || '';
  return { ref: inner['02'], bankCode, bank: BANKS[bankCode] || bankCode, key: `${bankCode}:${inner['02']}` };
}

let jsQR = null;
async function loadJsQR() {
  if (!jsQR) jsQR = import('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm').then(m => m.default);
  return jsQR;
}

function imageData(bmp, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export async function readSlipQR(file) {
  if (!file || !/^image\//.test(file.type || '')) return null;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return null; }
  // 1) built-in detector (Chrome on Android) — fast
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const codes = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(bmp);
        for (const c of codes) { const p = parseSlipQR(c.rawValue); if (p) return p; }
      }
    } catch {}
  }
  // 2) jsQR fallback (iPhone/iPad) — try two sizes, small QR codes need more pixels
  try {
    const decode = await loadJsQR();
    for (const side of [1400, 2200]) {
      const d = imageData(bmp, side);
      const r = decode(d.data, d.width, d.height, { inversionAttempts: 'dontInvert' });
      const p = parseSlipQR(r?.data);
      if (p) return p;
    }
  } catch {}
  return null;
}
