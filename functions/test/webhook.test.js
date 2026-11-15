import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
process.env.GCLOUD_PROJECT ||= 'demo-test';
const { validSignature, saleFromOrder } = await import('../index.js');

test('LINE signature check', () => {
  const body = Buffer.from('{"events":[]}');
  const sig = createHmac('sha256', 'secret').update(body).digest('base64');
  assert.equal(validSignature(body, sig, 'secret'), true);
  assert.equal(validSignature(body, sig, 'other'), false);
  assert.equal(validSignature(body, 'short', 'secret'), false);
  assert.equal(validSignature(body, undefined, 'secret'), false);
});

test('a done order becomes a POS-shaped sale', () => {
  const tx = saleFromOrder('abc', { no: 'L003', day: '2026-11-15', total: 70, cups: 2, payMethod: 'promptpay',
    items: [{ id: 'm_thaitea', name: 'ชาไทย เย็น', qty: 2, price: 30, cost: 12, style: 'iced' }, { id: 't_pearl', name: 'ไข่มุก', qty: 1, price: 10, cost: 3 }] }, '10:20');
  assert.equal(tx.id, 'line-abc');
  assert.equal(tx.source, 'pos');
  assert.equal(tx.channel, 'line');
  assert.equal(tx.method, 'promptpay');
  assert.equal(tx.cat, 'sales');
  assert.equal(tx.merchant, 'L003 ชาไทย เย็น×2, ไข่มุก');
});
