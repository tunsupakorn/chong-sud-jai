// PromptPay "Thai QR Payment" (EMVCo) with a fixed amount — built on the device, no service needed.
// Supports a mobile number (10 digits), national/tax ID (13 digits) or e-wallet ID (15 digits).

const f = (id, value) => id + String(value.length).padStart(2, '0') + value;

function crc16(str) { // CRC-16/CCITT-FALSE
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function normalizeId(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(d)) return { kind: 'phone', id: d, label: 'เบอร์มือถือ' };
  if (/^\d{13}$/.test(d)) return { kind: 'tax', id: d, label: 'เลขบัตร/เลขผู้เสียภาษี' };
  if (/^\d{15}$/.test(d)) return { kind: 'ewallet', id: d, label: 'e-Wallet' };
  return null;
}

export function payload(rawId, amount) {
  const n = normalizeId(rawId);
  if (!n) throw new Error('เลขพร้อมเพย์ไม่ถูกต้อง (เบอร์ 10 หลัก หรือเลข 13 หลัก)');
  const target = n.kind === 'phone' ? f('01', ('0066' + n.id.slice(1)).padStart(13, '0'))
    : n.kind === 'tax' ? f('02', n.id) : f('03', n.id);
  const merchant = f('00', 'A000000677010111') + target;
  const amt = Number(amount) > 0 ? f('54', Number(amount).toFixed(2)) : '';
  // field order follows the widely used promptpay-qr library: 00, 01, 29, 58, 53, 54, 63
  const body = f('00', '01') + f('01', amt ? '12' : '11') + f('29', merchant) + f('58', 'TH') + f('53', '764') + amt + '6304';
  return body + crc16(body);
}

let QR = null;
async function lib() {
  if (!QR) QR = import('https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm').then(m => m.default);
  return QR;
}
// returns a data: URL of the QR image
export async function qrDataUrl(rawId, amount, size = 280) {
  const q = await lib();
  return q.toDataURL(payload(rawId, amount), { width: size, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0B1F3A', light: '#FFFFFF' } });
}
export const mask = raw => { const n = normalizeId(raw); return n ? n.id.replace(/^(\d{3})\d+(\d{3})$/, '$1-xxx-$2') : ''; };
