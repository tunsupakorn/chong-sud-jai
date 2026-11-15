// PromptPay QR as a PNG file, made in the Worker (a real https image the LINE in-app browser can hand to Chrome to save).
// payload() and crc16() are copied from ../../promptpay.js (the app's version).
import qrcode from 'qrcode-generator';

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

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xFFFFFFFF; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function chunk(type, data) {
  const t = [...type].map(c => c.charCodeAt(0));
  return [...u32(data.length), ...t, ...data, ...u32(crc32([...t, ...data]))];
}
async function zlib(bytes) { // CompressionStream('deflate') = zlib format, as PNG needs
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 8-bit grayscale PNG of the QR: `scale` px per module, 4-module quiet zone
export async function qrPng(text, scale = 10) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), margin = 4, size = (n + margin * 2) * scale;
  const raw = new Uint8Array((size + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size + 1);
    raw[row] = 0; // filter: none
    const my = Math.floor(y / scale) - margin;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin;
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.isDark(my, mx);
      raw[row + 1 + x] = dark ? 0x0B : 0xFF;
    }
  }
  const ihdr = [...u32(size), ...u32(size), 8, 0, 0, 0, 0];
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr), ...chunk('IDAT', [...await zlib(raw)]), ...chunk('IEND', [])]);
}
