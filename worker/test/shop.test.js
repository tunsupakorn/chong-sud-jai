import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Shop from '../src/shop.js';

const menu = [
  { id: 'm_thaitea', name: 'ชาไทย', emoji: '🧋', prices: { blend: 35, iced: 30, hot: 25 }, price: 35, cost: 12, group: 'drink' },
  { id: 'm_mango', name: 'มะม่วงปั่น', emoji: '🥭', prices: { blend: 45 }, price: 45, cost: 17, group: 'fruit' },
  { id: 't_pearl', name: 'ไข่มุก', price: 10, cost: 3, group: 'topping' },
  { id: 'm_off', name: 'ปิดขาย', prices: { blend: 40 }, price: 40, group: 'fruit', active: false },
];
const cfg = { ...Shop.lineSettings({}), open: true, from: '09:00', to: '20:00', prep: 10 };
const at = hm => ({ day: '2026-11-15', hm, min: Shop.toMin(hm) });

test('public menu hides cost and inactive items', () => {
  const m = Shop.publicMenu(menu);
  assert.equal(m.length, 3);
  assert.ok(m.every(i => !('cost' in i)));
  assert.deepEqual(m[0].prices, { blend: 35, iced: 30, hot: 25 });
});

test('prices come from the menu, not the client', () => {
  const r = Shop.priceCart(menu, [{ id: 'm_thaitea', style: 'iced', qty: 2, price: 1 }, { id: 't_pearl', qty: 1 }, { id: 'm_thaitea', style: 'iced', qty: 1 }]);
  assert.equal(r.total, 30 * 3 + 10);
  assert.equal(r.cups, 3);
  assert.equal(r.items[0].name, 'ชาไทย เย็น');
  assert.equal(r.items[0].qty, 3);
  assert.equal(r.items[0].cost, 12);
  assert.equal(r.items[1].style, undefined);
});

test('single-style items default to their style', () => {
  const r = Shop.priceCart(menu, [{ id: 'm_mango', qty: 1 }]);
  assert.equal(r.items[0].style, 'blend');
  assert.equal(r.items[0].name, 'มะม่วงปั่น');
});

test('bad carts are refused', () => {
  assert.throws(() => Shop.priceCart(menu, []), Shop.OrderError);
  assert.throws(() => Shop.priceCart(menu, [{ id: 'm_off', qty: 1 }]), /ปิดขาย/);
  assert.throws(() => Shop.priceCart(menu, [{ id: 'm_mango', style: 'hot', qty: 1 }]), /ไม่มีแบบนี้/);
  assert.throws(() => Shop.priceCart(menu, [{ id: 'm_mango', qty: 0 }]), /จำนวน/);
  assert.throws(() => Shop.priceCart(menu, [{ id: 'm_mango', qty: 1.5e9 }]), /จำนวน/);
  assert.throws(() => Shop.priceCart(menu, [{ id: 't_pearl', qty: 1 }]), /อย่างน้อย 1 แก้ว/);
  assert.throws(() => Shop.priceCart(menu, [{ id: 'm_mango', qty: 15 }, { id: 'm_mango', qty: 15 }]), /เยอะเกินไป/);
});

test('pickup: asap during opening hours', () => {
  assert.deepEqual(Shop.checkPickup(cfg, { mode: 'asap' }, at('10:00')), { mode: 'asap', at: '10:10' });
  assert.deepEqual(Shop.checkPickup(cfg, undefined, at('19:55')), { mode: 'asap', at: '20:00' });
});

test('pickup: scheduled time', () => {
  assert.deepEqual(Shop.checkPickup(cfg, { mode: 'later', at: '15:30' }, at('10:00')), { mode: 'later', at: '15:30' });
  assert.throws(() => Shop.checkPickup(cfg, { mode: 'later', at: '10:05' }, at('10:00')), /เร็วสุด 10:10/);
  assert.throws(() => Shop.checkPickup(cfg, { mode: 'later', at: '20:30' }, at('10:00')), /ร้านปิด 20:00/);
  assert.throws(() => Shop.checkPickup(cfg, { mode: 'later', at: 'xx' }, at('10:00')), /เวลารับ/);
});

test('pickup: before opening only scheduled orders, from opening time', () => {
  assert.throws(() => Shop.checkPickup(cfg, { mode: 'asap' }, at('07:00')), /นัดเวลารับ/);
  assert.deepEqual(Shop.checkPickup(cfg, { mode: 'later', at: '09:00' }, at('07:00')), { mode: 'later', at: '09:00' });
  assert.throws(() => Shop.checkPickup(cfg, { mode: 'later', at: '08:30' }, at('07:00')), /เร็วสุด 09:00/);
});

test('pickup: closed', () => {
  assert.throws(() => Shop.checkPickup({ ...cfg, open: false }, { mode: 'asap' }, at('10:00')), /ปิดรับ/);
  assert.throws(() => Shop.checkPickup(cfg, { mode: 'later', at: '20:00' }, at('20:00')), /ร้านปิดแล้ว/);
});

test('bangkok time and order numbers', () => {
  assert.deepEqual(Shop.bkk(new Date('2026-11-15T17:30:00Z')), { day: '2026-11-16', hm: '00:30', min: 30 });
  assert.equal(Shop.orderNo(7), 'L007');
});

test('public order hides cost and shows promptpay only while unpaid', () => {
  const o = { no: 'L001', status: 'new', items: [{ id: 'a', name: 'x', qty: 1, price: 30, cost: 9 }], total: 30, payMethod: 'promptpay', paid: false };
  const p = Shop.publicOrder('id1', o, { promptpay: '0812345678' });
  assert.equal(p.items[0].cost, undefined);
  assert.equal(p.promptpay, '0812345678');
  assert.equal(Shop.publicOrder('id1', { ...o, paid: true }, { promptpay: '0812345678' }).promptpay, undefined);
});

test('fulfilment: modes, required details, ready text', () => {
  const cfg = Shop.lineSettings({});
  assert.deepEqual(Shop.checkFulfil(cfg, undefined), { mode: 'pickup' });
  assert.throws(() => Shop.checkFulfil(cfg, { mode: 'dinein' }), /ไม่ได้เปิด/); // removed ways
  assert.deepEqual(Shop.fulfilModes({ modes: ['pickup', 'curbside'] }), ['pickup']);
  assert.throws(() => Shop.checkFulfil(cfg, { mode: 'delivery', detail: 'บ้านเลขที่ 9 ซอย 2', phone: '12' }), /เบอร์/);
  assert.deepEqual(Shop.checkFulfil(cfg, { mode: 'delivery', detail: 'บ้านเลขที่ 9 ซอย 2', phone: '081-234-5678' }), { mode: 'delivery', detail: 'บ้านเลขที่ 9 ซอย 2', phone: '0812345678' });
  assert.throws(() => Shop.checkFulfil({ ...cfg, modes: ['pickup'] }, { mode: 'delivery' }), /ไม่ได้เปิด/);
  assert.match(Shop.readyText({ no: 'L001', fulfil: { mode: 'delivery' } }), /ออกไปส่ง/);
  assert.match(Shop.readyText({ no: 'L001' }), /พร้อมรับ/);
});

test('delivery needs the minimum order (default ฿100)', () => {
  const cfg = Shop.lineSettings({});
  const f = { mode: 'delivery', detail: 'โรงพยาบาล ชั้น 2', phone: '0812345678' };
  assert.throws(() => Shop.checkFulfil(cfg, f, 95), /ครบ ฿100 \(ขาดอีก ฿5\)/);
  assert.equal(Shop.checkFulfil(cfg, f, 100).mode, 'delivery');
  assert.equal(Shop.checkFulfil(cfg, { mode: 'pickup' }, 35).mode, 'pickup');
  assert.equal(Shop.checkFulfil({ ...cfg, deliveryMin: 0 }, f, 35).mode, 'delivery');
});

test('drink options: sweetness and ice on the side', () => {
  const r = Shop.priceCart(menu, [
    { id: 'm_thaitea', style: 'iced', qty: 1, sweet: 50, ice: true },
    { id: 'm_thaitea', style: 'iced', qty: 1 },
    { id: 'm_thaitea', style: 'iced', qty: 2, sweet: 50, ice: true },
    { id: 'm_thaitea', style: 'hot', qty: 1, sweet: 0, ice: true },
    { id: 't_pearl', qty: 1, sweet: 25 }]);
  assert.equal(r.items.length, 4);
  assert.deepEqual(r.items[0], { id: 'm_thaitea', name: 'ชาไทย เย็น', qty: 3, price: 30, cost: 12, style: 'iced', sweet: 50, iceSep: true });
  assert.equal(r.items[1].sweet, 100);
  assert.equal(r.items[2].iceSep, undefined); // hot: no ice to keep apart
  assert.equal(r.items[3].sweet, undefined);  // toppings have no options
  assert.equal(Shop.itemLabel(r.items[0]), 'ชาไทย เย็น (หวาน 50% · แยกน้ำแข็ง)');
  assert.equal(Shop.itemLabel(r.items[1]), 'ชาไทย เย็น');
  assert.throws(() => Shop.priceCart(menu, [{ id: 'm_mango', qty: 1, sweet: 30 }]), /ความหวาน/);
  const noOpts = menu.map(m => m.id === 'm_mango' ? { ...m, opts: false } : m);
  assert.equal(Shop.priceCart(noOpts, [{ id: 'm_mango', qty: 1, sweet: 0, ice: true }]).items[0].sweet, undefined);
  const pm = Shop.publicMenu([{ ...menu[0], photo: 1700, desc: 'ชาแท้' }, menu[2]]);
  assert.deepEqual([pm[0].photo, pm[0].desc, pm[0].opts, pm[1].opts], [1700, 'ชาแท้', true, false]);
});
