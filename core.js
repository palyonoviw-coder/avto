'use strict';

/*
 * Данные и расчёты Автожурнала без привязки к странице — их же проверяют тесты (tests/core.test.js).
 *
 * Модель:
 *   cars       — машины: имя, год, номер, топливо, начальный пробег
 *   categories — категории записей; fuel / service / repair встроенные (у них свои поля в форме)
 *   entries    — записи журнала. Сумма и пробег необязательны. У ТО и ремонта `items` — какие пункты
 *                регламента сделаны: по ним считается, когда делать в следующий раз
 *   schedule   — регламент ТО машины: интервал в км и/или месяцах, за сколько предупреждать,
 *                и «последний раз делали» на случай, если записи об этом в журнале нет
 *   documents  — ОСАГО, диагностическая карта и т.п. со сроком действия
 */

const STORE_KEY = 'avto.v1';
const APP_NAME = 'Автожурнал';

const COLORS = ['#e08a00', '#2f6fdf', '#d64545', '#7a5cd6', '#1aa3a3', '#40c057', '#e64980', '#fab005', '#a9672f', '#6e6e69', '#15aabf', '#3a3a37'];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
/** Прибавляет месяцы, не перескакивая через конец месяца (31 января + 1 мес = 28/29 февраля). */
function addMonths(s, n) {
  const d = parseISO(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return iso(d);
}
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 864e5);
const monthOf = (s) => s.slice(0, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Число из поля ввода: пробелы и запятая допустимы. Пустое поле — null (значение не указано). */
function parseNum(v) {
  const s = String(v ?? '').replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}
const round2 = (n) => Math.round(n * 100) / 100;

/* ---------- Значения по умолчанию ---------- */

const BUILTIN = { fuel: 'fuel', service: 'service', repair: 'repair' };

function defaultCategories() {
  return [
    { id: 'fuel', name: 'Топливо', icon: 'fuel', color: '#e08a00', builtin: true },
    { id: 'service', name: 'ТО', icon: 'wrench', color: '#2f6fdf', builtin: true },
    { id: 'repair', name: 'Ремонт', icon: 'hammer', color: '#d64545', builtin: true },
    { id: 'insurance', name: 'Страховка', icon: 'shield', color: '#7a5cd6' },
    { id: 'wash', name: 'Мойка', icon: 'droplet', color: '#1aa3a3' },
    { id: 'tires', name: 'Шины', icon: 'disc', color: '#3a3a37' },
    { id: 'parking', name: 'Парковка и дороги', icon: 'square-parking', color: '#6e6e69' },
    { id: 'fines', name: 'Штрафы и налог', icon: 'siren', color: '#e64980' },
    { id: 'parts', name: 'Запчасти и аксессуары', icon: 'package', color: '#a9672f' },
    { id: 'other', name: 'Прочее', icon: 'ellipsis', color: '#868e96' },
  ];
}

/**
 * Стандартный регламент для новой машины. Интервалы средние для массовых легковых машин —
 * человек правит их под свою модель. km / months: 0 — не учитывать. warnKm / warnDays — за сколько предупредить.
 */
const SCHEDULE_TEMPLATE = [
  { key: 'oil', name: 'Моторное масло и фильтр', icon: 'droplet', km: 10000, months: 12 },
  { key: 'air', name: 'Воздушный фильтр', icon: 'wind', km: 20000, months: 24 },
  { key: 'cabin', name: 'Салонный фильтр', icon: 'wind', km: 15000, months: 12 },
  { key: 'plugs', name: 'Свечи зажигания', icon: 'sparkles', km: 40000, months: 0 },
  { key: 'pads', name: 'Тормозные колодки (проверка)', icon: 'disc', km: 30000, months: 0 },
  { key: 'brakefluid', name: 'Тормозная жидкость', icon: 'droplet', km: 0, months: 24 },
  { key: 'coolant', name: 'Антифриз', icon: 'thermometer', km: 0, months: 60 },
  { key: 'gearbox', name: 'Масло в коробке передач', icon: 'cog', km: 60000, months: 0 },
  { key: 'belt', name: 'Ремень ГРМ / навесного оборудования', icon: 'route', km: 90000, months: 0 },
  { key: 'tires', name: 'Сезонная смена шин', icon: 'disc', km: 0, months: 6 },
];
const DEFAULT_WARN_KM = 1000;
const DEFAULT_WARN_DAYS = 30;

function scheduleFromTemplate(carId) {
  return SCHEDULE_TEMPLATE.map((t) => ({
    id: uid(), carId, key: t.key, name: t.name, icon: t.icon, km: t.km, months: t.months,
    warnKm: DEFAULT_WARN_KM, warnDays: DEFAULT_WARN_DAYS, lastOdo: null, lastDate: null,
  }));
}

function emptyDb() {
  return {
    version: 1, cars: [], categories: defaultCategories(), entries: [], schedule: [], documents: [],
    settings: { theme: 'auto', activeCar: null }, notified: {}, deleted: {},
  };
}

function normalize(d) {
  const base = emptyDb();
  const out = { ...base, ...(d || {}), settings: { ...base.settings, ...((d && d.settings) || {}) } };
  for (const k of ['cars', 'categories', 'entries', 'schedule', 'documents']) if (!Array.isArray(out[k])) out[k] = [];
  // Встроенные категории должны быть всегда: на них завязаны формы заправки и ТО.
  for (const c of defaultCategories().filter((x) => x.builtin)) if (!out.categories.some((x) => x.id === c.id)) out.categories.unshift(c);
  for (const e of out.entries) if (!Array.isArray(e.items)) e.items = [];
  if (!out.notified || typeof out.notified !== 'object') out.notified = {};
  if (!out.deleted || typeof out.deleted !== 'object') out.deleted = {};
  if (!out.cars.some((c) => c.id === out.settings.activeCar)) out.settings.activeCar = out.cars[0]?.id || null;
  return out;
}

/* ---------- Пробег ---------- */

const carEntries = (db, carId) => db.entries.filter((e) => e.carId === carId);

/** Текущий пробег: наибольший из начального, записей журнала и отметок регламента. */
function currentOdo(db, carId) {
  const car = db.cars.find((c) => c.id === carId);
  let max = Number(car?.odo0) || 0;
  for (const e of carEntries(db, carId)) if (e.odo != null && e.odo > max) max = e.odo;
  for (const s of db.schedule) if (s.carId === carId && s.lastOdo != null && s.lastOdo > max) max = s.lastOdo;
  return max;
}

/** Пробег, который был на дату (по ближайшей предыдущей записи) — подсказка в форме. */
function odoAt(db, carId, date) {
  let best = null;
  for (const e of carEntries(db, carId)) {
    if (e.odo == null || e.date > date) continue;
    if (!best || e.date > best.date || (e.date === best.date && e.odo > best.odo)) best = e;
  }
  return best ? best.odo : null;
}

/** Средний пробег в день по записям за последний год — чтобы прикинуть дату, когда подойдёт срок по км. */
function kmPerDay(db, carId) {
  const pts = carEntries(db, carId).filter((e) => e.odo != null).sort((a, b) => a.date.localeCompare(b.date) || a.odo - b.odo);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const from = addDays(last.date, -365);
  const first = pts.find((p) => p.date >= from) || pts[0];
  const days = daysBetween(first.date, last.date);
  if (days < 14 || last.odo <= first.odo) return null;
  return (last.odo - first.odo) / days;
}

/* ---------- Регламент ТО ---------- */

/** Когда пункт делали последний раз: самая свежая запись журнала с этим пунктом или ручная отметка. */
function lastDone(db, item) {
  const isNewer = (a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date > b.date;
    if (a.odo != null && b.odo != null && a.odo !== b.odo) return a.odo > b.odo;
    return Boolean(a.date && !b.date);
  };
  let best = item.lastDate || item.lastOdo != null ? { date: item.lastDate || null, odo: item.lastOdo ?? null, entryId: null } : null;
  for (const e of db.entries) {
    if (e.carId !== item.carId || !e.items.includes(item.id)) continue;
    const cand = { date: e.date, odo: e.odo ?? null, entryId: e.id };
    if (!best || isNewer(cand, best)) best = cand;
  }
  return best;
}

/**
 * Состояние пункта регламента на сегодня.
 * state: 'unknown' — неизвестно, когда делали; 'ok'; 'soon' — пора готовиться; 'due' — срок вышел.
 * pct — какая часть интервала уже прошла (0..1+), по худшему из км и времени.
 */
function itemStatus(db, item, now = today()) {
  const odo = currentOdo(db, item.carId);
  const last = lastDone(db, item);
  const res = { item, last, odo, state: 'unknown', pct: 0, leftKm: null, leftDays: null, nextOdo: null, nextDate: null };
  if (!last) return res;
  let pct = 0, due = false, soon = false, measured = false;
  if (item.km && last.odo != null) {
    measured = true;
    res.nextOdo = last.odo + item.km;
    res.leftKm = res.nextOdo - odo;
    pct = Math.max(pct, (odo - last.odo) / item.km);
    if (res.leftKm <= 0) due = true; else if (res.leftKm <= (item.warnKm ?? DEFAULT_WARN_KM)) soon = true;
  }
  if (item.months && last.date) {
    measured = true;
    res.nextDate = addMonths(last.date, item.months);
    res.leftDays = daysBetween(now, res.nextDate);
    const total = daysBetween(last.date, res.nextDate) || 1;
    pct = Math.max(pct, daysBetween(last.date, now) / total);
    if (res.leftDays <= 0) due = true; else if (res.leftDays <= (item.warnDays ?? DEFAULT_WARN_DAYS)) soon = true;
  }
  if (!measured) return res;
  res.pct = Math.max(0, pct);
  res.state = due ? 'due' : soon ? 'soon' : 'ok';
  return res;
}

const STATE_ORDER = { due: 0, soon: 1, unknown: 2, ok: 3 };

function scheduleStatus(db, carId, now = today()) {
  return db.schedule.filter((s) => s.carId === carId).map((s) => itemStatus(db, s, now))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.pct - a.pct);
}

function docStatus(doc, now = today()) {
  if (!doc.until) return { doc, state: 'ok', leftDays: null };
  const leftDays = daysBetween(now, doc.until);
  const state = leftDays < 0 ? 'due' : leftDays <= (doc.warnDays ?? DEFAULT_WARN_DAYS) ? 'soon' : 'ok';
  return { doc, state, leftDays };
}

/* ---------- Расход топлива и стоимость ---------- */

/**
 * Расход по методу «от полного бака до полного»: литры всех заправок после предыдущего полного бака
 * (включая текущую) делятся на пройденные километры. Отрезки без пробега пропускаются.
 */
function fuelSegments(db, carId) {
  const fills = carEntries(db, carId).filter((e) => e.cat === BUILTIN.fuel && e.liters > 0 && e.odo != null)
    .sort((a, b) => a.odo - b.odo || a.date.localeCompare(b.date));
  const segs = [];
  let start = null, liters = 0;
  for (const f of fills) {
    if (start) liters += f.liters;
    if (f.full) {
      if (start && f.odo > start.odo) segs.push({ from: start, to: f, km: f.odo - start.odo, liters: round2(liters), per100: round2((liters / (f.odo - start.odo)) * 100) });
      start = f; liters = 0;
    }
  }
  return segs;
}

function avgConsumption(db, carId, fromDate = null) {
  const segs = fuelSegments(db, carId).filter((s) => !fromDate || s.to.date >= fromDate);
  const km = segs.reduce((s, x) => s + x.km, 0);
  const l = segs.reduce((s, x) => s + x.liters, 0);
  return km > 0 ? round2((l / km) * 100) : null;
}

/** Расходы, пробег и стоимость километра за период [from, to] (даты включительно, null — без границы). */
function periodTotals(db, carId, from = null, to = null) {
  const list = carEntries(db, carId).filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
  const spent = round2(list.reduce((s, e) => s + (e.amount || 0), 0));
  const odos = list.filter((e) => e.odo != null).map((e) => e.odo);
  // Пробег за период: от последней отметки до начала периода (если есть) до последней отметки в периоде.
  let startOdo = null;
  if (from) startOdo = odoAt(db, carId, addDays(from, -1));
  if (startOdo == null) {
    const car = db.cars.find((c) => c.id === carId);
    startOdo = odos.length ? Math.min(...odos) : null;
    if (!from && car?.odo0 != null && (startOdo == null || car.odo0 < startOdo)) startOdo = Number(car.odo0);
  }
  const endOdo = odos.length ? Math.max(...odos) : null;
  const km = startOdo != null && endOdo != null && endOdo > startOdo ? endOdo - startOdo : 0;
  return { list, spent, km, perKm: km > 0 ? round2(spent / km) : null };
}

function byCategory(db, list) {
  const m = new Map();
  for (const e of list) if (e.amount) m.set(e.cat, (m.get(e.cat) || 0) + e.amount);
  return [...m.entries()].map(([id, value]) => {
    const c = db.categories.find((x) => x.id === id) || { name: 'Без категории', color: '#adb5bd', icon: 'tag' };
    return { id, label: c.name, color: c.color, icon: c.icon, value: round2(value) };
  }).sort((a, b) => b.value - a.value);
}

function monthlySpend(db, carId, months = 12, now = today()) {
  const out = [];
  const cur = monthOf(now);
  for (let i = months - 1; i >= 0; i--) {
    const mk = monthOf(addMonths(`${cur}-01`, -i));
    const v = carEntries(db, carId).filter((e) => monthOf(e.date) === mk).reduce((s, e) => s + (e.amount || 0), 0);
    out.push({ mk, value: round2(v) });
  }
  return out;
}

/* ---------- Слияние для синхронизации живёт в sync.js; здесь — экспорт CSV ---------- */

function csvCell(v) {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function entriesCsv(db) {
  const head = ['Дата', 'Машина', 'Категория', 'Сумма', 'Пробег', 'Литры', 'Цена за литр', 'Топливо', 'Полный бак', 'Место', 'Работы по регламенту', 'Комментарий'];
  const rows = [...db.entries].sort((a, b) => a.date.localeCompare(b.date)).map((e) => {
    const car = db.cars.find((c) => c.id === e.carId);
    const cat = db.categories.find((c) => c.id === e.cat);
    const items = e.items.map((id) => db.schedule.find((s) => s.id === id)?.name).filter(Boolean).join(', ');
    const num = (n) => (n == null ? '' : String(n).replace('.', ','));
    return [e.date, car?.name, cat?.name, num(e.amount), num(e.odo), num(e.liters), num(e.price), e.fuel, e.full ? 'да' : '', e.place, items, e.note];
  });
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
}

if (typeof module !== 'undefined') {
  module.exports = {
    uid, iso, today, parseISO, addDays, addMonths, daysBetween, parseNum, esc, defaultCategories, SCHEDULE_TEMPLATE,
    scheduleFromTemplate, emptyDb, normalize, currentOdo, odoAt, kmPerDay, lastDone, itemStatus, scheduleStatus, docStatus,
    fuelSegments, avgConsumption, periodTotals, byCategory, monthlySpend, entriesCsv,
  };
}
