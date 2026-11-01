'use strict';

/* Интерфейс Автожурнала. Данные и расчёты — в core.js, синхронизация с Google Диском — в sync.js. */

/* ============================== Утилиты интерфейса ============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const fmt = (n) => (n == null ? '' : `${nf.format(n)} ₽`);
const fmt0 = (n) => `${nf0.format(n || 0)} ₽`;
const fmtKm = (n) => (n == null ? '' : `${nf0.format(n)} км`);
const fmtShort = (n) => (n >= 1e6 ? `${nf.format(Math.round(n / 1e5) / 10)} млн` : n >= 1e4 ? `${nf0.format(Math.round(n / 1e3))} тыс` : nf0.format(n));
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const fmtDate = (s) => { if (!s) return ''; const d = parseISO(s); const y = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`; return `${d.getDate()} ${MONTHS[d.getMonth()]}${y}`; };
const fmtDateFull = (s) => { const d = parseISO(s); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function dayLabel(s) {
  const t = today();
  if (s === t) return 'Сегодня';
  if (s === addDays(t, -1)) return 'Вчера';
  const d = parseISO(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`}`;
}

/** «через 480 км», «через 2 мес», «просрочено на 300 км» */
function leftText(st) {
  if (st.state === 'unknown') return 'нет данных';
  const parts = [];
  const worst = [];
  if (st.leftKm != null) (st.leftKm <= 0 ? worst : parts).push(['km', st.leftKm]);
  if (st.leftDays != null) (st.leftDays <= 0 ? worst : parts).push(['d', st.leftDays]);
  const fmtPart = ([k, v]) => (k === 'km' ? fmtKm(Math.abs(v)) : periodText(Math.abs(v)));
  if (worst.length) return worst[0][1] === 0 ? 'сегодня' : `просрочено на ${fmtPart(worst[0])}`;
  // Показываем то, что наступит раньше. Километры сравниваем со временем по среднему пробегу в день.
  if (parts.length === 2) {
    const kpd = kmPerDay(db, st.item.carId);
    if (kpd && parts[0][1] / kpd > parts[1][1]) return `через ${fmtPart(parts[1])}`;
  }
  return `через ${fmtPart(parts[0])}`;
}

function periodText(days) {
  if (days < 45) return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
  const m = Math.round(days / 30.4);
  if (m < 18) return `${m} ${plural(m, 'месяц', 'месяца', 'месяцев')}`;
  const y = Math.round((days / 365) * 10) / 10;
  return `${nf.format(y)} ${y % 1 === 0 ? plural(y, 'год', 'года', 'лет') : 'года'}`;
}

function intervalText(item) {
  const p = [];
  if (item.km) p.push(fmtKm(item.km));
  if (item.months) p.push(item.months % 12 === 0 ? `${item.months / 12} ${plural(item.months / 12, 'год', 'года', 'лет')}` : `${item.months} мес`);
  return p.length ? `каждые ${p.join(' / ')}` : 'без интервала';
}

function icon(name, cls = '') {
  return ICONS[name] ? `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>` : '';
}
const badge = (iconName, color, size = '') => `<span class="cico ${size}" style="background:${color}">${icon(iconName) || esc(iconName || '?')}</span>`;

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept });
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

/* ============================== Данные ============================== */

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch { /* повреждённые данные или недоступное хранилище */ }
  return normalize(emptyDb());
}

function save() {
  Sync.stamp(db);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
  catch { toast('Не удалось сохранить: хранилище браузера недоступно'); }
  Sync.schedule();
}

let db = load();
const ui = { view: 'overview', cat: '', q: '', serviceTab: 'schedule', period: 'year', swiped: null };

const car = () => db.cars.find((c) => c.id === db.settings.activeCar) || null;
const catById = (id) => (id === 'odo' ? { id: 'odo', name: 'Пробег', icon: 'gauge', color: '#495057' } : db.categories.find((c) => c.id === id) || { name: 'Без категории', icon: 'tag', color: '#adb5bd' });
const itemById = (id) => db.schedule.find((s) => s.id === id);

/** Пример данных: машина с годом истории — чтобы посмотреть, как всё выглядит. */
function demoDb() {
  const d = normalize(emptyDb());
  const carId = uid();
  d.cars.push({ id: carId, name: 'Kia Rio', year: 2019, plate: 'А123ВС 77', fuel: 'АИ-95', odo0: 60000, color: '#2f6fdf' });
  d.settings.activeCar = carId;
  d.schedule = scheduleFromTemplate(carId);
  const t = today();
  const sch = (key) => d.schedule.find((s) => s.key === key).id;
  let odo = 61200;
  const stations = ['Лукойл', 'Shell', 'Роснефть', 'Газпромнефть'];
  for (let day = -360; day <= 0; day += 9 + (day % 3)) {
    odo += 380 + ((day * 7) % 90);
    const liters = 32 + ((day * 13) % 12);
    const price = 52 + (360 + day) / 120;
    d.entries.push({ id: uid(), carId, cat: 'fuel', date: addDays(t, day), odo, amount: Math.round(liters * price), liters, price: Math.round(price * 100) / 100, fuel: 'АИ-95', full: true, place: stations[(day + 360) % 4], items: [], note: '' });
  }
  const at = (day) => d.entries.filter((e) => e.date <= addDays(t, day)).reduce((m, e) => Math.max(m, e.odo || 0), 61200);
  d.entries.push({ id: uid(), carId, cat: 'service', date: addDays(t, -300), odo: at(-300) + 50, amount: 6400, place: 'Сервис «Мотор»', items: [sch('oil'), sch('air'), sch('cabin')], note: 'ТО-5' });
  d.entries.push({ id: uid(), carId, cat: 'service', date: addDays(t, -40), odo: at(-40) + 20, amount: 5650, place: 'Сервис «Мотор»', items: [sch('oil'), sch('cabin')], note: 'ТО-6' });
  d.entries.push({ id: uid(), carId, cat: 'repair', date: addDays(t, -150), odo: at(-150) + 10, amount: 4800, place: 'Шиномонтаж', items: [sch('pads')], note: 'Передние колодки' });
  d.entries.push({ id: uid(), carId, cat: 'tires', date: addDays(t, -200), odo: at(-200), amount: 2400, place: 'Шиномонтаж', items: [sch('tires')], note: 'Летняя резина' });
  d.entries.push({ id: uid(), carId, cat: 'insurance', date: addDays(t, -12), odo: null, amount: 12300, place: 'Ингосстрах', items: [], note: 'ОСАГО' });
  for (let day = -340; day < 0; day += 45) d.entries.push({ id: uid(), carId, cat: 'wash', date: addDays(t, day), odo: null, amount: 700, place: '', items: [], note: 'Комплекс' });
  d.schedule.find((s) => s.key === 'plugs').lastOdo = 45000;
  d.schedule.find((s) => s.key === 'coolant').lastDate = addDays(t, -900);
  d.schedule.find((s) => s.key === 'brakefluid').lastDate = addDays(t, -700);
  d.documents.push({ id: uid(), carId, name: 'ОСАГО', number: 'ХХХ 0123456789', until: addDays(t, 353), warnDays: 30 });
  d.documents.push({ id: uid(), carId, name: 'Диагностическая карта', number: '', until: addDays(t, 20), warnDays: 30 });
  d.isDemo = true;
  return d;
}

/* ============================== Графики ============================== */

function donut(items, size = 150, center = '') {
  const total = items.reduce((s, i) => s + i.value, 0);
  const r = 62, c = 2 * Math.PI * r, gap = items.length > 1 ? 1.5 : 0;
  let off = 0;
  const arcs = total > 0
    ? items.map((i) => {
      const len = (i.value / total) * c;
      const el = `<circle r="${r}" cx="80" cy="80" fill="none" stroke="${i.color}" stroke-width="20"
        stroke-dasharray="${Math.max(len - gap, 0.1)} ${c - Math.max(len - gap, 0.1)}" stroke-dashoffset="${-off}"><title>${esc(i.label)}: ${esc(fmt(i.value))}</title></circle>`;
      off += len;
      return el;
    }).join('')
    : `<circle r="${r}" cx="80" cy="80" fill="none" stroke="var(--surface-2)" stroke-width="20"/>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 160 160" role="img" aria-label="Расходы по категориям">
    <g transform="rotate(-90 80 80)">${arcs}</g>
    <text x="80" y="75" text-anchor="middle" font-size="11" fill="var(--muted)">Всего</text>
    <text x="80" y="95" text-anchor="middle" font-size="16" font-weight="800" fill="var(--text)">${esc(center)}</text>
  </svg>`;
}

function legend(items) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  return `<div class="legend">${items.map((i) => `
    <div class="li" data-act="filter-cat" data-id="${esc(i.id)}">${badge(i.icon, i.color, 'sm')}<span>${esc(i.label)}</span>
      <span class="v num">${esc(fmt0(i.value))}</span><span class="p num">${Math.round((i.value / total) * 100)}%</span></div>`).join('')}</div>`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((x) => x >= v);
}

function barChart(data, { highlightLast = true } = {}) {
  const W = 620, H = 200, L = 48, B = 24, T = 10;
  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const gw = (W - L) / data.length, bw = Math.min(30, gw * 0.62);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let s = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    s += `<line class="grid-line" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtShort(v)}</text>`;
  }
  data.forEach((d, i) => {
    const cx = L + gw * i + gw / 2;
    const fill = highlightLast && i === data.length - 1 ? 'var(--primary)' : 'var(--bar)';
    if (d.value > 0) s += `<rect x="${cx - bw / 2}" y="${y(d.value)}" width="${bw}" height="${y(0) - y(d.value)}" rx="4" fill="${fill}"><title>${esc(d.title || d.label)}: ${esc(fmt0(d.value))}</title></rect>`;
    s += `<text x="${cx}" y="${H - 7}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Расходы по месяцам">${s}</svg></div>`;
}

function lineChart(points, unit) {
  const W = 620, H = 180, L = 48, B = 24, T = 12;
  const vals = points.map((p) => p.v);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 0.5) { hi += 0.5; lo -= 0.5; }
  const padv = (hi - lo) * 0.15;
  lo -= padv; hi += padv;
  const x = (i) => L + 8 + ((W - L - 20) * i) / Math.max(points.length - 1, 1);
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  let s = '';
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) / 3) * i;
    s += `<line class="grid-line" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${nf.format(Math.round(v * 10) / 10)}</text>`;
  }
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  s += `<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>`;
  points.forEach((p, i) => { s += `<circle cx="${x(i)}" cy="${y(p.v)}" r="3.5" fill="var(--accent)"><title>${esc(p.label)}: ${nf.format(p.v)} ${unit}</title></circle>`; });
  const step = Math.ceil(points.length / 6);
  points.forEach((p, i) => { if (i % step === 0 || i === points.length - 1) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(p.label)}</text>`; });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Расход топлива">${s}</svg></div>`;
}

/* ============================== Общие куски разметки ============================== */

function topbar(title, sub = '', right = '') {
  return `<header class="topbar"><div class="row1"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    <div class="toolbar">${right}</div></div></header>`;
}

const empty = (ic, text, extra = '') => `<div class="empty">${icon(ic)}${text}${extra}</div>`;

function carPicker() {
  const c = car();
  if (!c) return '';
  if (db.cars.length < 2) return '';
  return `<label class="car-pick">${icon('car')}<select id="car-select" aria-label="Машина">${db.cars.map((x) => `<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>${icon('chevron-down')}</label>`;
}

function entryTitle(e) {
  const c = catById(e.cat);
  if ((e.cat === 'service' || e.cat === 'repair') && e.items.length) {
    const names = e.items.map((id) => itemById(id)?.name).filter(Boolean);
    if (names.length) return `${c.name}: ${names.join(', ').toLowerCase()}`;
  }
  if (e.cat === 'fuel') return `Заправка${e.fuel ? ` · ${e.fuel}` : ''}`;
  if (e.cat === 'odo') return 'Пробег';
  return c.name;
}

function entrySub(e, withDate = false) {
  const p = [];
  if (withDate) p.push(dayLabel(e.date));
  if (e.cat === 'fuel' && e.liters) p.push(`${nf.format(e.liters)} л${e.price ? ` × ${nf.format(e.price)} ₽` : ''}`);
  if (e.place) p.push(e.place);
  if (e.note && !(e.cat === 'service' && e.items.length && !e.place && e.note.length > 30)) p.push(e.note);
  return p.map(esc).join(' · ');
}

function entryRow(e, { withDate = false, swipe = false } = {}) {
  const c = catById(e.cat);
  const inner = `<div class="row" data-act="edit-entry" data-id="${e.id}">${badge(c.icon, c.color)}
    <div class="mid"><div class="t">${esc(entryTitle(e))}</div><div class="s">${entrySub(e, withDate) || '&nbsp;'}</div></div>
    <div class="amt">${e.amount != null ? `<span class="neg num">−${esc(fmt(e.amount))}</span>` : ''}${e.odo != null ? `<div class="s num">${esc(fmtKm(e.odo))}</div>` : ''}</div></div>`;
  if (!swipe) return inner;
  return `<div class="sw-row" data-id="${e.id}"><div class="sw-acts">
      <button class="sw-btn" data-act="edit-entry" data-id="${e.id}">${icon('pencil')}<span>Изменить</span></button>
      <button class="sw-btn del" data-act="del-entry" data-id="${e.id}">${icon('trash-2')}<span>Удалить</span></button></div>
    <div class="sw-front">${inner}</div></div>`;
}

const STATE_COLOR = { due: 'var(--expense)', soon: 'var(--warn)', ok: 'var(--income)', unknown: 'var(--muted)' };

function scheduleRow(st) {
  const it = st.item;
  const last = st.last;
  const lastText = last ? `было ${[last.odo != null ? `на ${fmtKm(last.odo)}` : '', last.date ? fmtDateFull(last.date) : ''].filter(Boolean).join(', ')}` : 'укажите, когда делали';
  const pct = Math.min(1, st.pct) * 100;
  return `<div class="plan" data-act="edit-item" data-id="${it.id}">
    <div class="ptop"><span class="ttl">${badge(it.icon || 'wrench', STATE_COLOR[st.state], 'sm')}<span class="tt">${esc(it.name)}</span></span>
      <span class="small strong" style="color:${STATE_COLOR[st.state]}">${esc(leftText(st))}</span></div>
    <div class="psub small muted">${esc(intervalText(it))} · ${esc(lastText)}</div>
    <div class="prow"><div class="bar"><i style="width:${st.state === 'unknown' ? 0 : Math.max(pct, 2)}%;background:${STATE_COLOR[st.state]}"></i></div>
      <button class="btn sm" data-act="done-item" data-id="${it.id}" title="Отметить, что сделано">${icon('check')} Сделано</button></div>
  </div>`;
}

/** Предупреждения для «Обзора»: пункты ТО и документы, у которых подходит или вышел срок. */
function alerts(c) {
  const list = [];
  for (const st of scheduleStatus(db, c.id)) {
    if (st.state !== 'due' && st.state !== 'soon') continue;
    list.push({ state: st.state, html: `<div class="alert ${st.state}">${icon(st.state === 'due' ? 'triangle-alert' : 'bell')}
      <div class="mid"><b>${esc(st.item.name)}</b> — ${esc(leftText(st))}</div>
      <button class="btn sm" data-act="done-item" data-id="${st.item.id}">Сделано</button></div>` });
  }
  for (const d of db.documents.filter((x) => x.carId === c.id).map((x) => docStatus(x))) {
    if (d.state === 'ok') continue;
    list.push({ state: d.state, html: `<div class="alert ${d.state}">${icon('file-text')}
      <div class="mid"><b>${esc(d.doc.name)}</b> — ${d.leftDays < 0 ? `истёк ${esc(fmtDateFull(d.doc.until))}` : d.leftDays === 0 ? 'истекает сегодня' : `истекает через ${esc(periodText(d.leftDays))}`}</div>
      <button class="btn sm" data-act="edit-doc" data-id="${d.doc.id}">Продлить</button></div>` });
  }
  return list.sort((a, b) => (a.state === 'due' ? 0 : 1) - (b.state === 'due' ? 0 : 1));
}

/* ============================== Экраны ============================== */

/** Шапка карточки машины на «Обзоре». Если машин несколько — листаются свайпом. */
function carStrip() {
  const head = (x) => `<div class="carhead">${badge('car', x.color || 'var(--primary)', 'lg')}<div class="mid"><div class="cname">${esc(x.name)}</div>
    <div class="s">${esc([x.year, x.plate].filter(Boolean).join(' · '))}</div></div></div>`;
  if (db.cars.length < 2) return head(car());
  const i = db.cars.findIndex((x) => x.id === db.settings.activeCar);
  return `<div class="car-strip" data-active="${i}">${db.cars.map(head).join('')}</div>
    <div class="car-dots">${db.cars.map((x) => `<i class="${x.id === db.settings.activeCar ? 'on' : ''}"></i>`).join('')}</div>`;
}

/** После отрисовки — показать в ленте активную машину и переключать её по свайпу. */
function syncStrip(root = document) {
  root.querySelectorAll('.car-strip').forEach((strip) => {
    strip.scrollLeft = (Number(strip.dataset.active) || 0) * strip.clientWidth;
    let t;
    strip.addEventListener('scroll', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const id = db.cars[Math.round(strip.scrollLeft / strip.clientWidth)]?.id;
        if (id && id !== db.settings.activeCar) { db.settings.activeCar = id; save(); render(); }
      }, 140);
    }, { passive: true });
  });
}

function viewWelcome() {
  return topbar('Автожурнал', 'Расходы и ТО машины') + `<div class="content stack">
    <div class="card welcome">${badge('car', 'var(--primary)', 'lg')}
      <h2>Добавьте машину</h2>
      <p class="muted">Укажите марку и текущий пробег — приложение заведёт стандартный регламент ТО (масло, фильтры, колодки…), интервалы потом можно поменять.</p>
      <div class="toolbar" style="justify-content:center"><button class="btn primary" data-act="new-car">${icon('plus')} Добавить машину</button>
      <button class="btn" data-act="load-demo">Посмотреть на примере</button></div></div>
    <div class="card" data-sync-slot="card">${Sync.card()}</div></div>`;
}

function viewOverview() {
  const c = car();
  if (!c) return viewWelcome();
  const odo = currentOdo(db, c.id);
  const cons = avgConsumption(db, c.id, addDays(today(), -365));
  const year = periodTotals(db, c.id, addDays(today(), -365));
  const mk = monthOf(today());
  const month = periodTotals(db, c.id, `${mk}-01`);
  const cats = byCategory(db, month.list);
  const al = alerts(c);
  const recent = db.entries.filter((e) => e.carId === c.id).sort((a, b) => b.date.localeCompare(a.date) || (b.odo || 0) - (a.odo || 0)).slice(0, 5);
  return topbar('Обзор', `${MONTHS_FULL[new Date().getMonth()]} ${new Date().getFullYear()}`, `<span data-sync-slot="btn">${Sync.button()}</span>`) + `
  <div class="content stack">
    <div class="card">
      ${carStrip()}
      <div class="kpis">
        <button class="kpi" data-act="odo">Пробег<b class="num">${esc(fmtKm(odo))}</b><span class="kpi-link">${icon('pencil')} обновить</span></button>
        <div class="kpi">Расход<b class="num">${cons ? `${nf.format(cons)} л/100` : '—'}</b></div>
        <div class="kpi">₽ за км<b class="num">${year.perKm ? `${nf.format(year.perKm)} ₽` : '—'}</b></div>
      </div>
      <div class="quick">
        <button class="btn" data-act="new-entry" data-cat="fuel">${icon('fuel')} Заправка</button>
        <button class="btn" data-act="new-entry" data-cat="service">${icon('wrench')} ТО</button>
        <button class="btn" data-act="new-entry" data-cat="">${icon('plus')} Другое</button>
      </div>
    </div>
    ${al.length ? `<div class="stack-s">${al.slice(0, 4).map((a) => a.html).join('')}${al.length > 4 ? `<button class="btn ghost sm" data-act="go" data-view="service">Ещё ${al.length - 4} ›</button>` : ''}</div>` : ''}
    <div class="card">
      <div class="muted small">Расходы за ${MONTHS_FULL[new Date().getMonth()].toLowerCase()}</div>
      <div class="big num">${esc(fmt0(month.spent))}</div>
      ${cats.length ? `<div class="stackbar">${cats.map((x) => `<i style="flex:${x.value};background:${x.color}" title="${esc(x.label)}"></i>`).join('')}</div>
        <div class="mini-legend small muted">${cats.slice(0, 4).map((x) => `<span><span class="dot" style="background:${x.color}"></span> ${esc(x.label)} ${esc(fmtShort(x.value))}</span>`).join('')}</div>`
        : '<div class="small muted" style="margin-top:6px">В этом месяце трат пока нет</div>'}
    </div>
    <div class="card">
      <div class="section-title"><h2>Последние записи</h2><button class="btn ghost sm" data-act="go" data-view="log">Все ›</button></div>
      ${recent.length ? `<div class="list">${recent.map((e) => entryRow(e, { withDate: true })).join('')}</div>` : empty('list-ordered', 'Записей пока нет — нажмите «+»')}
    </div>
  </div>`;
}

function viewLog() {
  const c = car();
  if (!c) return viewWelcome();
  const all = db.entries.filter((e) => e.carId === c.id);
  const q = ui.q.trim().toLowerCase();
  const list = all.filter((e) => (!ui.cat || e.cat === ui.cat)
    && (!q || `${entryTitle(e)} ${e.place || ''} ${e.note || ''} ${e.fuel || ''}`.toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.odo || 0) - (a.odo || 0));
  const usedCats = db.categories.filter((x) => all.some((e) => e.cat === x.id));
  const groups = new Map();
  for (const e of list) { if (!groups.has(e.date)) groups.set(e.date, []); groups.get(e.date).push(e); }
  const shown = [...groups.entries()].slice(0, ui.logLimit || 60);
  return topbar('Журнал', `${esc(c.name)} · ${list.length} ${plural(list.length, 'запись', 'записи', 'записей')}`, carPicker()) + `
  <div class="content">
    <div class="toolbar"><input type="search" id="q" placeholder="Поиск: место, заметка…" value="${esc(ui.q)}"></div>
    <div class="chips filter-chips"><button class="chip ${!ui.cat ? 'on' : ''}" data-act="filter-cat" data-id="">Все</button>${usedCats.map((x) => `<button class="chip ${ui.cat === x.id ? 'on' : ''}" data-act="filter-cat" data-id="${x.id}">${icon(x.icon)} ${esc(x.name)}</button>`).join('')}</div>
    ${list.length ? shown.map(([date, items]) => {
      const sum = items.reduce((s, e) => s + (e.amount || 0), 0);
      return `<div class="day"><span>${esc(dayLabel(date))}</span><span class="num">${sum ? `−${esc(fmt(sum))}` : ''}</span></div>
        <div class="card list-card">${items.map((e) => entryRow(e, { swipe: true })).join('')}</div>`;
    }).join('') + (groups.size > shown.length ? `<div class="toolbar" style="justify-content:center;margin-top:14px"><button class="btn" data-act="more-log">Показать ещё</button></div>` : '')
      : `<div class="card">${empty('list-ordered', q || ui.cat ? 'Ничего не найдено' : 'Записей пока нет — нажмите «+»')}</div>`}
    ${list.length ? '<p class="small muted hint">Смахните запись влево, чтобы изменить или удалить</p>' : ''}
  </div>`;
}

function viewService() {
  const c = car();
  if (!c) return viewWelcome();
  const tab = ui.serviceTab;
  let body;
  if (tab === 'schedule') {
    const st = scheduleStatus(db, c.id);
    body = `<div class="card">${st.length ? st.map(scheduleRow).join('') : empty('wrench', 'Регламент пуст', `<div class="toolbar" style="justify-content:center;margin-top:10px"><button class="btn" data-act="restore-template">Добавить стандартный</button></div>`)}</div>
      <div class="toolbar"><button class="btn" data-act="new-item">${icon('plus')} Свой пункт</button>
      <button class="btn" data-act="restore-template">${icon('list-checks')} Добавить недостающие из шаблона</button></div>
      <p class="small muted">Нажмите на пункт, чтобы поменять интервал или указать, когда его делали в последний раз. «Сделано» — быстрая запись в журнал: достаточно даты и пробега, сумму можно не писать.</p>`;
  } else if (tab === 'history') {
    const list = db.entries.filter((e) => e.carId === c.id && (e.cat === 'service' || e.cat === 'repair' || e.items.length))
      .sort((a, b) => b.date.localeCompare(a.date) || (b.odo || 0) - (a.odo || 0));
    const total = list.reduce((s, e) => s + (e.amount || 0), 0);
    body = `<div class="card">${list.length ? `<div class="list">${list.map((e) => entryRow(e, { withDate: true })).join('')}</div>
      <div class="small muted" style="margin-top:8px">Всего на ТО и ремонт: <b class="num">${esc(fmt0(total))}</b></div>` : empty('history', 'Записей о ТО и ремонте пока нет')}</div>`;
  } else {
    const docs = db.documents.filter((d) => d.carId === c.id).map((d) => docStatus(d)).sort((a, b) => (a.doc.until || '9').localeCompare(b.doc.until || '9'));
    body = `<div class="card">${docs.length ? `<div class="list">${docs.map((d) => `<div class="row" data-act="edit-doc" data-id="${d.doc.id}">${badge('file-text', STATE_COLOR[d.state])}
        <div class="mid"><div class="t">${esc(d.doc.name)}</div><div class="s">${esc([d.doc.number, d.doc.until ? `до ${fmtDateFull(d.doc.until)}` : 'бессрочно'].filter(Boolean).join(' · '))}</div></div>
        <div class="amt small" style="color:${STATE_COLOR[d.state]}">${d.leftDays == null ? '' : d.leftDays < 0 ? 'истёк' : esc(periodText(d.leftDays))}</div></div>`).join('')}</div>`
      : empty('file-text', 'Добавьте ОСАГО, диагностическую карту — напомню, когда подойдёт срок')}</div>
      <div class="toolbar"><button class="btn" data-act="new-doc">${icon('plus')} Документ</button></div>`;
  }
  return topbar('ТО', `${esc(c.name)} · ${esc(fmtKm(currentOdo(db, c.id)))}`, `${carPicker()}<button class="btn primary" data-act="new-entry" data-cat="service">${icon('check')} Отметить ТО</button>`) + `
  <div class="content stack">
    <div class="card" style="padding:6px"><div class="seg">${[['schedule', 'Регламент'], ['history', 'История'], ['docs', 'Документы']].map(([k, v]) => `<button class="${tab === k ? 'on' : ''}" data-act="service-tab" data-t="${k}">${v}</button>`).join('')}</div></div>
    ${body}
  </div>`;
}

function viewStats() {
  const c = car();
  if (!c) return viewWelcome();
  const t = today();
  const from = { month: `${monthOf(t)}-01`, year: addDays(t, -365), all: null }[ui.period];
  const tot = periodTotals(db, c.id, from);
  const cats = byCategory(db, tot.list);
  const cons = avgConsumption(db, c.id, from);
  const segs = fuelSegments(db, c.id).filter((s) => !from || s.to.date >= from).slice(-24);
  const months = monthlySpend(db, c.id, 12).map((m) => ({ label: MONTHS[Number(m.mk.slice(5)) - 1].slice(0, 1).toUpperCase(), title: `${MONTHS_FULL[Number(m.mk.slice(5)) - 1]} ${m.mk.slice(0, 4)}`, value: m.value }));
  const fuelSum = tot.list.filter((e) => e.cat === 'fuel').reduce((s, e) => s + (e.liters || 0), 0);
  return topbar('Отчёты', `${esc(c.name)} · ${{ month: 'этот месяц', year: 'последние 12 месяцев', all: 'всё время' }[ui.period]}`, carPicker()) + `
  <div class="content stack">
    <div class="card" style="padding:6px"><div class="seg">${[['month', 'Месяц'], ['year', 'Год'], ['all', 'Всё время']].map(([k, v]) => `<button class="${ui.period === k ? 'on' : ''}" data-act="period" data-t="${k}">${v}</button>`).join('')}</div></div>
    <div class="card"><div class="kpis">
      <div class="kpi">Потрачено<b class="num">${esc(fmt0(tot.spent))}</b></div>
      <div class="kpi">Проехано<b class="num">${tot.km ? esc(fmtKm(tot.km)) : '—'}</b></div>
      <div class="kpi">₽ за км<b class="num">${tot.perKm ? `${nf.format(tot.perKm)} ₽` : '—'}</b></div>
      <div class="kpi">Расход<b class="num">${cons ? `${nf.format(cons)} л/100` : '—'}</b></div>
      <div class="kpi">Топлива<b class="num">${fuelSum ? `${nf0.format(fuelSum)} л` : '—'}</b></div>
    </div></div>
    <div class="card"><h2>По категориям</h2>${cats.length ? `<div class="donut-wrap">${donut(cats, 150, fmtShort(tot.spent))}${legend(cats)}</div>` : empty('chart-pie', 'Нет записей с суммой за этот период')}</div>
    <div class="card"><div class="section-title"><h2>По месяцам</h2><span class="small muted">₽, 12 месяцев</span></div>${barChart(months)}</div>
    <div class="card"><div class="section-title"><h2>Расход топлива</h2><span class="small muted">л/100 км</span></div>
      ${segs.length >= 2 ? lineChart(segs.map((s) => ({ label: fmtDate(s.to.date), v: s.per100 })), 'л/100 км')
        : `<p class="small muted" style="margin:0">Считается между двумя заправками «до полного бака» с указанным пробегом. ${segs.length === 1 ? `Пока один отрезок: ${nf.format(segs[0].per100)} л/100 км.` : 'Пока недостаточно данных.'}</p>`}
    </div>
  </div>`;
}

function viewMore() {
  const c = car();
  const customCats = db.categories;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return topbar('Ещё') + `<div class="content stack">
    <div class="card"><div class="section-title"><h2>Мои машины</h2><button class="btn sm" data-act="new-car">${icon('plus')} Добавить</button></div>
      ${db.cars.length ? `<div class="list">${db.cars.map((x) => `<div class="row" data-act="edit-car" data-id="${x.id}">${badge('car', x.color || 'var(--primary)')}
        <div class="mid"><div class="t">${esc(x.name)}</div><div class="s">${esc([x.year, x.plate, fmtKm(currentOdo(db, x.id))].filter(Boolean).join(' · '))}</div></div>
        ${x.id === c?.id ? '<span class="chip on">Активна</span>' : `<button class="btn sm" data-act="activate-car" data-id="${x.id}">Выбрать</button>`}</div>`).join('')}</div>` : empty('car', 'Машин пока нет')}
    </div>
    <div class="card" data-sync-slot="card">${Sync.card()}</div>
    <div class="card"><h2>Напоминания</h2>
      <p class="small muted" style="margin-top:0">Приложение напомнит о ТО и документах при открытии и, если разрешить, уведомлением на телефоне.</p>
      ${perm === 'granted' ? `<div class="small pos">${icon('check')} Уведомления включены</div>`
        : perm === 'denied' ? '<div class="small muted">Уведомления запрещены в настройках браузера</div>'
          : perm === 'unsupported' ? '<div class="small muted">Этот браузер не поддерживает уведомления. На iPhone добавьте приложение на экран «Домой».</div>'
            : `<button class="btn" data-act="ask-notify">${icon('bell')} Включить уведомления</button>`}
    </div>
    <div class="card"><div class="section-title"><h2>Категории</h2><button class="btn sm" data-act="new-cat">${icon('plus')} Добавить</button></div>
      <div class="chips">${customCats.map((x) => `<button class="chip" data-act="edit-cat" data-id="${x.id}"><span class="dot" style="background:${x.color}"></span> ${esc(x.name)}</button>`).join('')}</div></div>
    <div class="card"><h2>Данные</h2>
      <div class="toolbar">
        <button class="btn" data-act="export-csv">${icon('download')} Экспорт в CSV</button>
        <button class="btn" data-act="export-json">${icon('download')} Резервная копия</button>
        <button class="btn" data-act="import-json">${icon('upload')} Восстановить из копии</button>
      </div>
      <h2 style="margin-top:16px">Тема</h2>
      <div class="seg">${[['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([k, v]) => `<button class="${db.settings.theme === k ? 'on' : ''}" data-act="theme" data-t="${k}">${v}</button>`).join('')}</div>
      <div class="toolbar" style="margin-top:16px">
        <button class="btn ghost" data-act="load-demo">Загрузить пример</button>
        <button class="btn danger" data-act="wipe">${icon('trash-2')} Удалить все данные</button>
      </div>
    </div>
    <p class="small muted" style="text-align:center">${APP_NAME} · данные хранятся на устройстве и в вашем Google Диске</p>
  </div>`;
}

/* ============================== Навигация и свайпы ============================== */

const VIEWS = { overview: viewOverview, log: viewLog, service: viewService, stats: viewStats, more: viewMore };

/*
 * На телефоне разделы лежат рядом в ленте Swiper и листаются свайпом за пальцем (как в Монетке);
 * у каждого раздела своя вертикальная прокрутка. На ПК — один раздел в <main>.
 */
const PAGES = ['overview', 'log', 'service', 'stats', 'more'];
const phone = matchMedia('(max-width: 760px)');
const stale = new Set();
let pager = null;
const pageEl = (v) => $(`.page[data-page="${v}"]`);
const markNav = () => document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === ui.view));

function renderPage(v) {
  if (!v || !stale.has(v)) return;
  pageEl(v).innerHTML = VIEWS[v]();
  stale.delete(v);
  syncStrip(pageEl(v));
}

function render() {
  markNav();
  ui.swiped = null;
  if (!pager) {
    const y = window.scrollY;
    $('#main').innerHTML = VIEWS[ui.view]();
    window.scrollTo(0, y);
    syncStrip();
    return;
  }
  const page = pageEl(ui.view);
  const y = page.scrollTop;
  page.innerHTML = VIEWS[ui.view]();
  page.scrollTop = y;
  syncStrip(page);
  for (const v of PAGES) if (v !== ui.view) stale.add(v);
  stale.delete(ui.view);
  const i = PAGES.indexOf(ui.view);
  if (pager.activeIndex !== i) pager.slideTo(i, 0, false);
}

function go(view) {
  ui.view = view;
  if (pager) pageEl(view).scrollTop = 0;
  else window.scrollTo(0, 0);
  render();
}

function setupPager() {
  const main = $('#main');
  if (phone.matches && !pager && window.Swiper) {
    main.classList.add('paged');
    main.innerHTML = `<div class="swiper pager"><div class="swiper-wrapper">${PAGES.map((v) =>
      `<section class="swiper-slide page" data-page="${v}"></section>`).join('')}</div></div>`;
    PAGES.forEach((v) => stale.add(v));
    pager = new Swiper(main.firstElementChild, {
      initialSlide: Math.max(PAGES.indexOf(ui.view), 0),
      speed: 320,
      threshold: 6,
      touchAngle: 35,
      resistanceRatio: 0.55,
      longSwipesRatio: 0.3,
      // Строки журнала смахиваются сами по себе (изменить/удалить), поэтому раздел с них не листается.
      noSwipingSelector: 'input, select, textarea, .seg, .chips, .sw-row, .chart, .car-strip',
      on: {
        sliderFirstMove(sw) { renderPage(PAGES[sw.activeIndex - 1]); renderPage(PAGES[sw.activeIndex + 1]); },
        slideChange(sw) { ui.view = PAGES[sw.activeIndex]; renderPage(ui.view); markNav(); closeSwiped(); },
      },
    });
  } else if (!phone.matches && pager) {
    pager.destroy(true, true);
    pager = null;
    main.classList.remove('paged');
  }
  render();
}
phone.addEventListener('change', setupPager);

/* Свайп строки журнала: влево — открыть кнопки «Изменить» и «Удалить». */
const SW_OPEN = 152;
let swipe = null;

function closeSwiped(except) {
  document.querySelectorAll('.sw-row.open').forEach((r) => {
    if (r === except) return;
    r.classList.remove('open');
    $('.sw-front', r).style.transform = '';
  });
}

document.addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.sw-row');
  if (!e.target.closest('.sw-acts')) closeSwiped(row);
  if (!row || e.target.closest('.sw-acts') || (e.pointerType === 'mouse' && e.button !== 0)) return;
  swipe = { row, front: $('.sw-front', row), x0: e.clientX, y0: e.clientY, base: row.classList.contains('open') ? -SW_OPEN : 0, dx: 0, active: false, id: e.pointerId };
});

document.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x0, dy = e.clientY - swipe.y0;
  if (!swipe.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
    if (Math.abs(dx) < 8) return;
    swipe.active = true;
    swipe.front.style.transition = 'none';
  }
  swipe.dx = dx;
  const x = Math.min(0, Math.max(-SW_OPEN - 40, swipe.base + dx));
  swipe.front.style.transform = `translateX(${x}px)`;
}, { passive: true });

function endSwipe() {
  if (!swipe) return;
  const s = swipe;
  swipe = null;
  if (!s.active) return;
  s.front.style.transition = '';
  const open = s.base + s.dx < -SW_OPEN / 2;
  s.row.classList.toggle('open', open);
  s.front.style.transform = open ? `translateX(${-SW_OPEN}px)` : '';
  // Клик, который браузер пришлёт после свайпа, не должен открыть запись.
  ui.suppressClick = Date.now();
}
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', endSwipe);

function applyTheme() {
  const t = db.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

/* ============================== Формы (нижняя шторка) ============================== */

const modal = $('#modal');

function openModal(title, body, { onSubmit, onDelete, submitText = 'Сохранить', onOpen, deleteText = 'Удалить' } = {}) {
  modal.innerHTML = `<div class="grab" aria-hidden="true"></div><form novalidate>
    <div class="mh"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Закрыть">${icon('x')}</button></div>
    ${body}
    <div class="actions">${onDelete ? `<button type="button" class="btn danger" data-del>${icon('trash-2')} ${esc(deleteText)}</button>` : ''}
      <span class="spacer"></span><button type="button" class="btn" data-close>Отмена</button>
      <button type="submit" class="btn primary">${esc(submitText)}</button></div></form>`;
  const form = $('form', modal);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (onSubmit(new FormData(form), form) === false) return;
    closeModal(); save(); render();
  });
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
    if (e.target.closest('[data-del]') && onDelete() !== false) { closeModal(); save(); render(); }
  });
  modal.showModal();
  modal.scrollTop = 0;
  form.scrollTop = 0;
  onOpen?.(form);
}

function closeModal() { modal.close(); }
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

// Шторку можно смахнуть вниз за «ручку».
(() => {
  let y0 = null;
  modal.addEventListener('pointerdown', (e) => { if (e.target.closest('.grab, .mh')) { y0 = e.clientY; modal.style.transition = 'none'; } });
  modal.addEventListener('pointermove', (e) => { if (y0 != null) modal.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`; });
  const end = (e) => {
    if (y0 == null) return;
    const dy = e.clientY - y0;
    y0 = null;
    modal.style.transition = '';
    modal.style.transform = '';
    if (dy > 90) closeModal();
  };
  modal.addEventListener('pointerup', end);
  modal.addEventListener('pointercancel', end);
})();

function fail(form, msg, field) {
  toast(msg);
  if (field) form.elements[field]?.focus();
  return false;
}

const numVal = (v) => (v == null ? '' : String(v).replace('.', ','));

function readNum(form, name, label, { min = 0, int = false } = {}) {
  const n = parseNum(form.elements[name]?.value);
  if (n === null) return { ok: true, v: null };
  if (Number.isNaN(n) || n < min) { fail(form, `${label}: введите число`, name); return { ok: false }; }
  return { ok: true, v: int ? Math.round(n) : Math.round(n * 100) / 100 };
}

function catGrid(selected) {
  return `<div class="cat-grid" role="radiogroup" aria-label="Категория">${db.categories.map((x) => `
    <label class="cat-pick ${x.id === selected ? 'on' : ''}"><input type="radio" name="cat" value="${x.id}" ${x.id === selected ? 'checked' : ''}>
      ${badge(x.icon, x.color)}<span>${esc(x.name)}</span></label>`).join('')}</div>`;
}

function itemChecklist(carId, checked) {
  const st = scheduleStatus(db, carId);
  if (!st.length) return '<div class="small muted">Регламент пуст — пункты можно добавить в разделе «ТО».</div>';
  return `<div class="checklist">${st.map((s) => `<label class="check"><input type="checkbox" name="items" value="${s.item.id}" ${checked.includes(s.item.id) ? 'checked' : ''}>
    <span class="mid">${esc(s.item.name)}</span><span class="small" style="color:${STATE_COLOR[s.state]}">${esc(leftText(s))}</span></label>`).join('')}</div>`;
}

/**
 * Запись журнала. Обязательны только категория и дата: сумма, пробег и всё остальное — по желанию.
 * preset: { cat, items } — например, «Сделано» у пункта регламента открывает форму ТО с этим пунктом.
 */
function entryModal(entry = null, preset = {}) {
  const c = entry ? db.cars.find((x) => x.id === entry.carId) : car();
  if (!c) { carModal(); return; }
  const isNew = !entry;
  const odoNow = currentOdo(db, c.id);
  const e = entry ? { ...entry } : {
    cat: preset.cat ?? 'fuel', date: today(), odo: null, amount: null, liters: null, price: null,
    fuel: c.fuel || 'АИ-95', full: true, place: '', items: preset.items || [], note: '',
  };
  const cat = e.cat || 'fuel';
  const fuels = ['АИ-92', 'АИ-95', 'АИ-98', 'ДТ', 'Газ'];
  openModal(isNew ? 'Новая запись' : 'Запись', `
    ${catGrid(cat === 'odo' ? '' : cat)}
    <div class="two">
      <label class="f">Сумма, ₽<input type="text" inputmode="decimal" name="amount" value="${numVal(e.amount)}" placeholder="необязательно" autocomplete="off"></label>
      <label class="f">Пробег, км<input type="text" inputmode="numeric" name="odo" value="${numVal(e.odo)}" placeholder="${odoNow ? `сейчас ${nf0.format(odoNow)}` : 'необязательно'}" autocomplete="off"></label>
    </div>
    <label class="f">Дата<input type="date" name="date" value="${e.date}" max="${addDays(today(), 1)}"></label>
    <div data-for="fuel">
      <div class="two">
        <label class="f">Литры<input type="text" inputmode="decimal" name="liters" value="${numVal(e.liters)}" autocomplete="off"></label>
        <label class="f">Цена за литр, ₽<input type="text" inputmode="decimal" name="price" value="${numVal(e.price)}" placeholder="посчитаю сам" autocomplete="off"></label>
      </div>
      <div class="two">
        <label class="f">Топливо<input type="text" name="fuel" list="fuel-list" value="${esc(e.fuel || '')}"></label>
        <label class="f">АЗС<input type="text" name="place-fuel" value="${esc(cat === 'fuel' ? e.place || '' : '')}" list="station-list" autocomplete="off"></label>
      </div>
      <datalist id="fuel-list">${fuels.map((f) => `<option value="${f}">`).join('')}</datalist>
      <datalist id="station-list">${[...new Set(db.entries.filter((x) => x.cat === 'fuel' && x.place).map((x) => x.place))].slice(0, 20).map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      <label class="switch"><input type="checkbox" name="full" ${e.full !== false ? 'checked' : ''}><span>Залил до полного бака<br><span class="small muted">нужно для расчёта расхода топлива</span></span></label>
    </div>
    <div data-for="service repair tires">
      <div class="f"><span class="lbl">Что сделано по регламенту</span>${itemChecklist(c.id, e.items)}</div>
    </div>
    <label class="f" data-for="!fuel">Место<input type="text" name="place" value="${esc(cat !== 'fuel' ? e.place || '' : '')}" placeholder="сервис, мойка…" autocomplete="off"></label>
    <label class="f">Комментарий<textarea name="note" rows="2">${esc(e.note || '')}</textarea></label>`, {
    submitText: 'Сохранить',
    onOpen(form) {
      const sync = () => {
        const v = form.elements.cat.value || 'other';
        form.querySelectorAll('[data-for]').forEach((el) => {
          const f = el.dataset.for;
          el.hidden = f.startsWith('!') ? f.slice(1) === v : !f.split(' ').includes(v);
        });
        form.querySelectorAll('.cat-pick').forEach((l) => l.classList.toggle('on', $('input', l).checked));
      };
      form.addEventListener('change', (ev) => { if (ev.target.name === 'cat') sync(); });
      sync();
      if (isNew && !preset.items?.length) form.elements.amount.focus({ preventScroll: true });
      if (preset.items?.length) form.elements.odo.focus({ preventScroll: true });
    },
    onSubmit(fd, form) {
      const catV = fd.get('cat') || (entry?.cat === 'odo' ? 'odo' : null);
      if (!catV) return fail(form, 'Выберите категорию');
      if (!fd.get('date')) return fail(form, 'Укажите дату', 'date');
      const amount = readNum(form, 'amount', 'Сумма'); if (!amount.ok) return false;
      const odo = readNum(form, 'odo', 'Пробег', { int: true }); if (!odo.ok) return false;
      const out = { ...(entry || { id: uid(), carId: c.id }), cat: catV, date: fd.get('date'), amount: amount.v, odo: odo.v, note: String(fd.get('note') || '').trim(), items: [] };
      if (catV === 'fuel') {
        const liters = readNum(form, 'liters', 'Литры'); if (!liters.ok) return false;
        const price = readNum(form, 'price', 'Цена'); if (!price.ok) return false;
        out.liters = liters.v;
        out.price = price.v;
        if (out.price == null && out.amount != null && out.liters) out.price = Math.round((out.amount / out.liters) * 100) / 100;
        if (out.amount == null && out.price != null && out.liters) out.amount = Math.round(out.price * out.liters * 100) / 100;
        out.fuel = String(fd.get('fuel') || '').trim();
        out.full = fd.get('full') === 'on';
        out.place = String(fd.get('place-fuel') || '').trim();
      } else {
        delete out.liters; delete out.price; delete out.fuel; delete out.full;
        out.place = String(fd.get('place') || '').trim();
        if (['service', 'repair', 'tires'].includes(catV)) out.items = fd.getAll('items');
      }
      if (out.items.length && out.odo == null && !out.date) return fail(form, 'Укажите дату или пробег', 'odo');
      const prev = odoAt(db, c.id, out.date);
      if (out.odo != null && prev != null && out.odo < prev - 50 && !confirm(`Пробег ${nf0.format(out.odo)} км меньше, чем в записи на более раннюю дату (${nf0.format(prev)} км). Сохранить всё равно?`)) return false;
      if (entry) Object.assign(entry, out); else db.entries.push(out);
      if (out.odo != null && out.odo > odoNow) checkSoon(c.id);
      toast(out.items.length ? `Отмечено: ${out.items.length} ${plural(out.items.length, 'пункт', 'пункта', 'пунктов')} регламента` : 'Запись сохранена');
    },
    onDelete: entry ? () => deleteEntry(entry.id) : null,
  });
}

function deleteEntry(id) {
  const e = db.entries.find((x) => x.id === id);
  if (!e) return false;
  if (!confirm(`Удалить запись «${entryTitle(e)}» от ${fmtDateFull(e.date)}?`)) return false;
  db.entries = db.entries.filter((x) => x.id !== id);
  return true;
}

/** Быстро обновить пробег без траты. */
function odoModal() {
  const c = car();
  if (!c) return;
  openModal('Текущий пробег', `<label class="f">Пробег, км<input type="text" inputmode="numeric" name="odo" placeholder="${nf0.format(currentOdo(db, c.id))}" autocomplete="off"></label>
    <label class="f">Дата<input type="date" name="date" value="${today()}"></label>
    <p class="small muted" style="margin-top:0">Нужно, чтобы правильно считались сроки ТО по километрам. Пробег из заправок и других записей учитывается сам.</p>`, {
    onOpen(form) { form.elements.odo.focus(); },
    onSubmit(fd, form) {
      const odo = readNum(form, 'odo', 'Пробег', { int: true }); if (!odo.ok) return false;
      if (odo.v == null) return fail(form, 'Введите пробег', 'odo');
      db.entries.push({ id: uid(), carId: c.id, cat: 'odo', date: fd.get('date') || today(), odo: odo.v, amount: null, place: '', items: [], note: '' });
      checkSoon(c.id);
    },
  });
}

function carModal(x = null) {
  const isNew = !x;
  const v = x || { name: '', year: '', plate: '', fuel: 'АИ-95', odo0: '', color: COLORS[1] };
  openModal(isNew ? 'Новая машина' : 'Машина', `
    <label class="f">Марка и модель<input type="text" name="name" value="${esc(v.name)}" placeholder="Например, Kia Rio" required></label>
    <div class="two">
      <label class="f">Год<input type="text" inputmode="numeric" name="year" value="${esc(v.year || '')}"></label>
      <label class="f">Госномер<input type="text" name="plate" value="${esc(v.plate || '')}"></label>
    </div>
    <div class="two">
      <label class="f">${isNew ? 'Пробег сейчас, км' : 'Начальный пробег, км'}<input type="text" inputmode="numeric" name="odo0" value="${numVal(v.odo0)}"></label>
      <label class="f">Топливо<input type="text" name="fuel" value="${esc(v.fuel || '')}" list="fuel-list2"></label>
    </div>
    <datalist id="fuel-list2">${['АИ-92', 'АИ-95', 'АИ-98', 'ДТ', 'Газ'].map((f) => `<option value="${f}">`).join('')}</datalist>
    <div class="f"><span class="lbl">Цвет</span><div class="swatches">${COLORS.map((col) => `<label class="swatch ${col === v.color ? 'on' : ''}" style="background:${col}"><input type="radio" name="color" value="${col}" ${col === v.color ? 'checked' : ''}></label>`).join('')}</div></div>
    ${isNew ? '<label class="switch"><input type="checkbox" name="template" checked> Завести стандартный регламент ТО</label>' : ''}`, {
    onOpen(form) {
      form.addEventListener('change', (e) => { if (e.target.name === 'color') form.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', $('input', s).checked)); });
      if (isNew) form.elements.name.focus();
    },
    onSubmit(fd, form) {
      const name = String(fd.get('name') || '').trim();
      if (!name) return fail(form, 'Введите название машины', 'name');
      const odo0 = readNum(form, 'odo0', 'Пробег', { int: true }); if (!odo0.ok) return false;
      const out = { name, year: String(fd.get('year') || '').trim(), plate: String(fd.get('plate') || '').trim(), fuel: String(fd.get('fuel') || '').trim(), odo0: odo0.v ?? 0, color: fd.get('color') || COLORS[1] };
      if (x) { Object.assign(x, out); return; }
      const nc = { id: uid(), ...out };
      db.cars.push(nc);
      if (db.isDemo) db.isDemo = false;
      db.settings.activeCar = nc.id;
      if (fd.get('template') === 'on') db.schedule.push(...scheduleFromTemplate(nc.id));
      toast('Машина добавлена. Отметьте в «ТО», когда что меняли — и сроки посчитаются.');
    },
    onDelete: x ? () => {
      if (!confirm(`Удалить «${x.name}» вместе со всеми записями, регламентом и документами? Это нельзя отменить.`)) return false;
      db.cars = db.cars.filter((c) => c.id !== x.id);
      db.entries = db.entries.filter((e) => e.carId !== x.id);
      db.schedule = db.schedule.filter((s) => s.carId !== x.id);
      db.documents = db.documents.filter((d) => d.carId !== x.id);
      if (db.settings.activeCar === x.id) db.settings.activeCar = db.cars[0]?.id || null;
      return true;
    } : null,
  });
}

const ITEM_ICONS = ['droplet', 'wind', 'sparkles', 'disc', 'thermometer', 'cog', 'route', 'battery', 'wrench', 'hammer', 'gauge', 'shield', 'lightbulb', 'calendar'];

/** Пункт регламента: название, интервалы, предупреждение и «когда делали в последний раз». */
function itemModal(item = null) {
  const c = car();
  if (!c) return;
  const isNew = !item;
  const v = item || { name: '', icon: 'wrench', km: 10000, months: 12, warnKm: 1000, warnDays: 30, lastOdo: null, lastDate: null };
  const st = item ? itemStatus(db, item) : null;
  const fromLog = st?.last?.entryId ? db.entries.find((e) => e.id === st.last.entryId) : null;
  openModal(isNew ? 'Новый пункт регламента' : 'Пункт регламента', `
    <label class="f">Название<input type="text" name="name" value="${esc(v.name)}" placeholder="Например, Масло в вариаторе" required></label>
    <div class="f"><span class="lbl">Значок</span><div class="icon-grid">${ITEM_ICONS.map((ic) => `<label class="icon-pick ${ic === v.icon ? 'on' : ''}"><input type="radio" name="icon" value="${ic}" ${ic === v.icon ? 'checked' : ''}>${icon(ic)}</label>`).join('')}</div></div>
    <div class="f"><span class="lbl">Менять каждые… (что наступит раньше; пусто — не учитывать)</span>
      <div class="two" style="margin-top:4px"><label class="f sub">км<input type="text" inputmode="numeric" name="km" value="${v.km || ''}" placeholder="—"></label>
      <label class="f sub">месяцев<input type="text" inputmode="numeric" name="months" value="${v.months || ''}" placeholder="—"></label></div></div>
    <div class="f"><span class="lbl">Предупредить заранее за…</span>
      <div class="two" style="margin-top:4px"><label class="f sub">км<input type="text" inputmode="numeric" name="warnKm" value="${v.warnKm ?? 1000}"></label>
      <label class="f sub">дней<input type="text" inputmode="numeric" name="warnDays" value="${v.warnDays ?? 30}"></label></div></div>
    <div class="f"><span class="lbl">Последний раз делали</span>
      ${fromLog ? `<div class="small note">По журналу: ${esc(fmtDateFull(fromLog.date))}${fromLog.odo != null ? `, ${esc(fmtKm(fromLog.odo))}` : ''}. Поля ниже нужны, только если этого не было в журнале.</div>` : ''}
      <div class="two" style="margin-top:4px"><label class="f sub">на пробеге, км<input type="text" inputmode="numeric" name="lastOdo" value="${numVal(v.lastOdo)}" placeholder="—"></label>
      <label class="f sub">дата<input type="date" name="lastDate" value="${v.lastDate || ''}" max="${today()}"></label></div></div>`, {
    onOpen(form) {
      form.addEventListener('change', (e) => { if (e.target.name === 'icon') form.querySelectorAll('.icon-pick').forEach((s) => s.classList.toggle('on', $('input', s).checked)); });
      if (isNew) form.elements.name.focus();
    },
    onSubmit(fd, form) {
      const name = String(fd.get('name') || '').trim();
      if (!name) return fail(form, 'Введите название', 'name');
      const r = {};
      for (const [k, label] of [['km', 'Интервал, км'], ['months', 'Интервал, месяцев'], ['warnKm', 'Предупреждение, км'], ['warnDays', 'Предупреждение, дней'], ['lastOdo', 'Пробег']]) {
        const n = readNum(form, k, label, { int: true });
        if (!n.ok) return false;
        r[k] = n.v;
      }
      if (!r.km && !r.months) return fail(form, 'Укажите интервал в км или в месяцах', 'km');
      const out = { name, icon: fd.get('icon') || 'wrench', km: r.km || 0, months: r.months || 0, warnKm: r.warnKm ?? 0, warnDays: r.warnDays ?? 0, lastOdo: r.lastOdo, lastDate: fd.get('lastDate') || null };
      if (item) Object.assign(item, out); else db.schedule.push({ id: uid(), carId: c.id, ...out });
    },
    onDelete: item ? () => {
      if (!confirm(`Удалить пункт «${item.name}» из регламента? Записи в журнале останутся.`)) return false;
      db.schedule = db.schedule.filter((s) => s.id !== item.id);
      for (const e of db.entries) if (e.items.includes(item.id)) e.items = e.items.filter((i) => i !== item.id);
      return true;
    } : null,
  });
}

const DOC_NAMES = ['ОСАГО', 'КАСКО', 'Диагностическая карта', 'Водительское удостоверение', 'Медсправка', 'Аптечка', 'Огнетушитель'];

function docModal(doc = null) {
  const c = car();
  if (!c) return;
  const v = doc || { name: 'ОСАГО', number: '', until: addMonths(today(), 12), warnDays: 30 };
  openModal(doc ? 'Документ' : 'Новый документ', `
    <label class="f">Название<input type="text" name="name" value="${esc(v.name)}" list="doc-list"></label>
    <datalist id="doc-list">${DOC_NAMES.map((n) => `<option value="${n}">`).join('')}</datalist>
    <label class="f">Номер<input type="text" name="number" value="${esc(v.number || '')}" placeholder="необязательно"></label>
    <div class="two"><label class="f">Действует до<input type="date" name="until" value="${v.until || ''}"></label>
    <label class="f">Напомнить за, дней<input type="text" inputmode="numeric" name="warnDays" value="${v.warnDays ?? 30}"></label></div>
    ${doc ? '<p class="small muted" style="margin-top:0">Продлили? Поменяйте дату «Действует до». Саму оплату можно записать в журнал как «Страховка».</p>' : ''}`, {
    onSubmit(fd, form) {
      const name = String(fd.get('name') || '').trim();
      if (!name) return fail(form, 'Введите название', 'name');
      const w = readNum(form, 'warnDays', 'Напомнить за', { int: true }); if (!w.ok) return false;
      const out = { name, number: String(fd.get('number') || '').trim(), until: fd.get('until') || null, warnDays: w.v ?? 30 };
      if (doc) Object.assign(doc, out); else db.documents.push({ id: uid(), carId: c.id, ...out });
    },
    onDelete: doc ? () => { if (!confirm(`Удалить «${doc.name}»?`)) return false; db.documents = db.documents.filter((d) => d.id !== doc.id); return true; } : null,
  });
}

const CAT_ICONS = ['fuel', 'wrench', 'hammer', 'shield', 'droplet', 'disc', 'square-parking', 'siren', 'package', 'ellipsis', 'sparkles', 'battery', 'receipt', 'tag', 'route', 'shopping-bag', 'gift', 'gauge'];

function catModal(x = null) {
  const v = x || { name: '', icon: 'tag', color: COLORS[9] };
  openModal(x ? 'Категория' : 'Новая категория', `
    <label class="f">Название<input type="text" name="name" value="${esc(v.name)}" required></label>
    <div class="f"><span class="lbl">Цвет</span><div class="swatches">${COLORS.map((col) => `<label class="swatch ${col === v.color ? 'on' : ''}" style="background:${col}"><input type="radio" name="color" value="${col}" ${col === v.color ? 'checked' : ''}></label>`).join('')}</div></div>
    <div class="f"><span class="lbl">Значок</span><div class="icon-grid">${CAT_ICONS.map((ic) => `<label class="icon-pick ${ic === v.icon ? 'on' : ''}"><input type="radio" name="icon" value="${ic}" ${ic === v.icon ? 'checked' : ''}>${icon(ic)}</label>`).join('')}</div></div>
    ${x?.builtin ? '<p class="small muted" style="margin-top:0">Встроенную категорию можно переименовать, но не удалить.</p>' : ''}`, {
    onOpen(form) {
      form.addEventListener('change', (e) => {
        if (e.target.name === 'color') form.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', $('input', s).checked));
        if (e.target.name === 'icon') form.querySelectorAll('.icon-pick').forEach((s) => s.classList.toggle('on', $('input', s).checked));
      });
    },
    onSubmit(fd, form) {
      const name = String(fd.get('name') || '').trim();
      if (!name) return fail(form, 'Введите название', 'name');
      const out = { name, icon: fd.get('icon') || 'tag', color: fd.get('color') || COLORS[9] };
      if (x) Object.assign(x, out); else db.categories.push({ id: uid(), ...out });
    },
    onDelete: x && !x.builtin ? () => {
      const n = db.entries.filter((e) => e.cat === x.id).length;
      if (!confirm(n ? `Удалить категорию «${x.name}»? ${n} ${plural(n, 'запись', 'записи', 'записей')} перейдут в «Прочее».` : `Удалить категорию «${x.name}»?`)) return false;
      const fallback = db.categories.find((c) => c.id === 'other' && c.id !== x.id) ? 'other' : 'repair';
      for (const e of db.entries) if (e.cat === x.id) e.cat = fallback;
      db.categories = db.categories.filter((c) => c.id !== x.id);
      return true;
    } : null,
  });
}

/* ============================== Напоминания ============================== */

async function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, tag, icon: 'icon-192.png', badge: 'icon-192.png' });
    else new Notification(title, { body, tag, icon: 'icon-192.png' });
  } catch { /* уведомления недоступны */ }
}

/** Уведомляет один раз о каждом пункте, у которого подошёл или вышел срок. */
function checkReminders() {
  let changed = false;
  for (const c of db.cars) {
    for (const st of scheduleStatus(db, c.id)) {
      if (st.state !== 'due' && st.state !== 'soon') continue;
      const key = `${st.item.id}:${st.state}:${st.last?.date || ''}:${st.last?.odo ?? ''}`;
      if (db.notified[key]) continue;
      db.notified[key] = Date.now();
      changed = true;
      notify(`${c.name}: ${st.item.name}`, st.state === 'due' ? `Пора делать — ${leftText(st)}` : `Скоро — ${leftText(st)}`, st.item.id);
    }
    for (const d of db.documents.filter((x) => x.carId === c.id).map((x) => docStatus(x))) {
      if (d.state === 'ok') continue;
      const key = `${d.doc.id}:${d.state}:${d.doc.until}`;
      if (db.notified[key]) continue;
      db.notified[key] = Date.now();
      changed = true;
      notify(`${c.name}: ${d.doc.name}`, d.leftDays < 0 ? 'Срок действия истёк' : `Истекает ${fmtDateFull(d.doc.until)}`, d.doc.id);
    }
  }
  if (changed) { try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch { /* ignore */ } }
  return changed;
}

/** После ввода пробега — подсказка, если по нему подошёл срок какого-то пункта. */
function checkSoon(carId) {
  setTimeout(() => {
    const due = scheduleStatus(db, carId).filter((s) => s.state === 'due' || s.state === 'soon');
    if (due.length) toast(`${due[0].item.name}: ${leftText(due[0])}`);
  }, 2700);
}

/* ============================== Экспорт и импорт ============================== */

async function importJson() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.cars) || !Array.isArray(data.entries)) throw new Error('format');
    if (!confirm('Заменить текущие данные данными из файла?')) return;
    db = normalize(data);
    db.isDemo = false;
    save(); applyTheme(); render();
    toast('Данные восстановлены');
  } catch {
    toast('Файл не похож на резервную копию Автожурнала');
  }
}

/* ============================== События ============================== */

document.addEventListener('click', (e) => {
  if (ui.suppressClick && Date.now() - ui.suppressClick < 350) { e.preventDefault(); e.stopPropagation(); return; }
  const nav = e.target.closest('.nav-item');
  if (nav) { go(nav.dataset.view); return; }
  const el = e.target.closest('[data-act]');
  if (!el || modal.contains(el)) return;
  const id = el.dataset.id;
  switch (el.dataset.act) {
    case 'go': go(el.dataset.view); break;
    case 'new-entry': entryModal(null, { cat: el.dataset.cat || 'other' }); break;
    case 'edit-entry': { const x = db.entries.find((t) => t.id === id); if (x) entryModal(x); break; }
    case 'del-entry': if (deleteEntry(id)) { save(); render(); toast('Запись удалена'); } break;
    case 'odo': odoModal(); break;
    case 'filter-cat': ui.cat = ui.cat === id ? '' : id; ui.logLimit = 0; go('log'); break;
    case 'more-log': ui.logLimit = (ui.logLimit || 60) + 60; render(); break;
    case 'service-tab': ui.serviceTab = el.dataset.t; render(); break;
    case 'period': ui.period = el.dataset.t; render(); break;
    case 'new-item': itemModal(); break;
    case 'edit-item': itemModal(itemById(id)); break;
    case 'done-item': e.stopPropagation(); entryModal(null, { cat: 'service', items: [id] }); break;
    case 'restore-template': {
      const c = car();
      const have = new Set(db.schedule.filter((s) => s.carId === c.id).map((s) => s.key).filter(Boolean));
      const add = scheduleFromTemplate(c.id).filter((s) => !have.has(s.key));
      if (!add.length) { toast('Все пункты шаблона уже есть'); break; }
      db.schedule.push(...add); save(); render();
      toast(`Добавлено ${add.length} ${plural(add.length, 'пункт', 'пункта', 'пунктов')}`);
      break;
    }
    case 'new-doc': docModal(); break;
    case 'edit-doc': docModal(db.documents.find((d) => d.id === id)); break;
    case 'new-car': carModal(); break;
    case 'edit-car': carModal(db.cars.find((c) => c.id === id)); break;
    case 'activate-car': e.stopPropagation(); db.settings.activeCar = id; save(); render(); break;
    case 'new-cat': catModal(); break;
    case 'edit-cat': catModal(db.categories.find((c) => c.id === id)); break;
    case 'ask-notify':
      Notification.requestPermission().then((p) => { toast(p === 'granted' ? 'Уведомления включены' : 'Уведомления не разрешены'); if (p === 'granted') checkReminders(); render(); });
      break;
    case 'theme': db.settings.theme = el.dataset.t; save(); applyTheme(); render(); break;
    case 'go-sync': go('more'); break;
    case 'sync': Sync.syncNow(true); break;
    case 'sync-disconnect':
      if (confirm('Отключить синхронизацию на этом устройстве? Данные здесь и в облаке сохранятся.')) Sync.disconnect();
      break;
    case 'sync-delete-cloud':
      if (confirm('Удалить копию данных из Google Диска? На этом устройстве данные останутся.')) Sync.deleteCloudCopy();
      break;
    case 'export-csv': download(`avto-${today()}.csv`, entriesCsv(db), 'text/csv;charset=utf-8'); break;
    case 'export-json': download(`avto-backup-${today()}.json`, JSON.stringify(db, null, 2), 'application/json'); break;
    case 'import-json': importJson(); break;
    case 'load-demo':
      if (!db.cars.length || confirm(Sync.connected ? 'Заменить данные примером? Синхронизация включена — данные заменятся и на других устройствах.' : 'Заменить текущие данные примером?')) {
        db = demoDb(); save(); applyTheme(); go('overview'); toast('Загружен пример — удалить его можно в «Ещё»');
      }
      break;
    case 'wipe':
      if (confirm(Sync.connected ? 'Удалить все данные? Синхронизация включена — данные удалятся и на других устройствах. Это нельзя отменить.' : 'Удалить все машины и записи? Это нельзя отменить.')) {
        db = normalize({ ...emptyDb(), settings: { ...db.settings, activeCar: null } }); save(); go('overview'); toast('Все данные удалены');
      }
      break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'q') {
    ui.q = e.target.value;
    clearTimeout(ui.qt);
    ui.qt = setTimeout(() => {
      const pos = e.target.selectionStart;
      render();
      const q = (pager ? pageEl(ui.view) : document).querySelector('#q');
      if (q) { q.focus(); q.setSelectionRange(pos, pos); }
    }, 250);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'car-select') { db.settings.activeCar = e.target.value; save(); render(); }
});

$('#fab').addEventListener('click', () => (car() ? entryModal() : carModal()));
$('#nav-add').addEventListener('click', () => (car() ? entryModal() : carModal()));

/* ============================== Старт ============================== */

document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
$('#fab').innerHTML = icon('plus');

Sync.init();
applyTheme();
checkReminders();
setupPager();

setInterval(() => { if (checkReminders() && !modal.open && ui.view === 'overview') render(); }, 30 * 60 * 1000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
