// Проверки расчётов: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

function base() {
  const db = C.normalize(C.emptyDb());
  db.cars.push({ id: 'c1', name: 'Test', odo0: 50000 });
  db.schedule = C.scheduleFromTemplate('c1');
  return db;
}
const item = (db, key) => db.schedule.find((s) => s.key === key);
const entry = (o) => ({ id: C.uid(), carId: 'c1', cat: 'other', amount: null, odo: null, items: [], ...o });

test('пробег — максимум из начального, записей и ручных отметок', () => {
  const db = base();
  assert.equal(C.currentOdo(db, 'c1'), 50000);
  db.entries.push(entry({ date: '2026-01-01', odo: 51000 }));
  assert.equal(C.currentOdo(db, 'c1'), 51000);
  item(db, 'plugs').lastOdo = 52000;
  assert.equal(C.currentOdo(db, 'c1'), 52000);
});

test('без отметки о последней замене — состояние unknown', () => {
  const db = base();
  assert.equal(C.itemStatus(db, item(db, 'oil'), '2026-11-01').state, 'unknown');
});

test('ТО без суммы сбрасывает счётчик пункта', () => {
  const db = base();
  const oil = item(db, 'oil');
  db.entries.push(entry({ cat: 'service', date: '2026-10-01', odo: 60000, items: [oil.id] }));
  db.entries.push(entry({ date: '2026-10-20', odo: 69500 }));
  const st = C.itemStatus(db, oil, '2026-11-01');
  assert.equal(st.last.odo, 60000);
  assert.equal(st.leftKm, 500);
  assert.equal(st.state, 'soon'); // 500 км < предупреждения 1000 км
  db.entries.push(entry({ date: '2026-10-25', odo: 70100 }));
  assert.equal(C.itemStatus(db, oil, '2026-11-01').state, 'due');
});

test('срок по времени: что наступит раньше', () => {
  const db = base();
  const oil = item(db, 'oil');
  oil.lastOdo = 60000; oil.lastDate = '2025-12-15';
  db.entries.push(entry({ date: '2026-11-01', odo: 61000 }));
  const st = C.itemStatus(db, oil, '2026-11-01');
  assert.equal(st.nextDate, '2026-12-15');
  assert.equal(st.leftDays, 44);
  assert.equal(st.state, 'ok');
  assert.equal(C.itemStatus(db, oil, '2026-11-20').state, 'soon');
  assert.equal(C.itemStatus(db, oil, '2026-12-16').state, 'due');
});

test('свежая запись журнала важнее старой ручной отметки, удаление записи возвращает её', () => {
  const db = base();
  const oil = item(db, 'oil');
  oil.lastOdo = 55000; oil.lastDate = '2025-06-01';
  const e = entry({ cat: 'service', date: '2026-06-01', odo: 65000, items: [oil.id] });
  db.entries.push(e);
  assert.equal(C.lastDone(db, oil).odo, 65000);
  db.entries = [];
  assert.equal(C.lastDone(db, oil).odo, 55000);
});

test('изменённый интервал сразу меняет срок', () => {
  const db = base();
  const oil = item(db, 'oil');
  oil.lastOdo = 60000; oil.months = 0;
  db.entries.push(entry({ date: '2026-11-01', odo: 67000 }));
  assert.equal(C.itemStatus(db, oil).leftKm, 3000);
  oil.km = 7500;
  assert.equal(C.itemStatus(db, oil).leftKm, 500);
});

test('расход от полного бака до полного', () => {
  const db = base();
  db.entries.push(entry({ cat: 'fuel', date: '2026-01-01', odo: 10000, liters: 40, full: true }));
  db.entries.push(entry({ cat: 'fuel', date: '2026-01-05', odo: 10300, liters: 10, full: false }));
  db.entries.push(entry({ cat: 'fuel', date: '2026-01-10', odo: 10600, liters: 35, full: true }));
  const segs = C.fuelSegments(db, 'c1');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].km, 600);
  assert.equal(segs[0].liters, 45);
  assert.equal(segs[0].per100, 7.5);
  assert.equal(C.avgConsumption(db, 'c1'), 7.5);
});

test('итоги периода: сумма без пустых, км и ₽/км', () => {
  const db = base();
  db.entries.push(entry({ date: '2026-09-30', odo: 60000, amount: 1000 }));
  db.entries.push(entry({ date: '2026-10-05', odo: 60500, amount: 2000 }));
  db.entries.push(entry({ date: '2026-10-20', odo: 61000, amount: null }));
  const t = C.periodTotals(db, 'c1', '2026-10-01', '2026-10-31');
  assert.equal(t.spent, 2000);
  assert.equal(t.km, 1000);
  assert.equal(t.perKm, 2);
});

test('addMonths не перескакивает конец месяца', () => {
  assert.equal(C.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(C.addMonths('2026-03-15', 12), '2027-03-15');
});

test('parseNum: пусто — null, запятая и пробелы', () => {
  assert.equal(C.parseNum(''), null);
  assert.equal(C.parseNum('1 234,5'), 1234.5);
  assert.ok(Number.isNaN(C.parseNum('abc')));
});

test('normalize добавляет встроенные категории и чинит поля', () => {
  const d = C.normalize({ cars: [{ id: 'x' }], categories: [], entries: [{ id: 'e', carId: 'x', date: '2026-01-01', cat: 'fuel' }] });
  assert.ok(['fuel', 'service', 'repair'].every((id) => d.categories.some((c) => c.id === id)));
  assert.deepEqual(d.entries[0].items, []);
  assert.equal(d.settings.activeCar, 'x');
});

test('CSV: разделитель ;, экранирование', () => {
  const db = base();
  db.entries.push(entry({ cat: 'fuel', date: '2026-01-01', odo: 1, amount: 10.5, note: 'a;b' }));
  const csv = C.entriesCsv(db);
  assert.match(csv, /10,5/);
  assert.match(csv, /"a;b"/);
});
