'use strict';

/*
 * Синхронизация с Google Диском.
 *
 * Данные лежат одним JSON-файлом в скрытой папке приложения (appDataFolder) на Диске пользователя:
 * другие приложения и сам пользователь в интерфейсе Диска её не видят, а Автожурнал не видит остальной Диск.
 *
 * Слияние идёт по записям: у каждой записи есть отметка изменения `u`, удалённые записи
 * оставляют «надгробие» в `deleted`. Поэтому правки, сделанные на разных устройствах, не затирают друг друга.
 * Отметки ставит `Sync.stamp()` при каждом сохранении — сравнивая записи с последним известным состоянием,
 * так что остальному коду не нужно помнить про синхронизацию.
 *
 * Использует глобальные `db`, `normalize`, `render`, `toast`, `icon`, `esc`, `STORE_KEY` из app.js.
 */
const Sync = (() => {
  const CONF_KEY = 'avto.sync';
  const FILE_NAME = 'avto-data.json';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const COLLECTIONS = ['cars', 'categories', 'entries', 'schedule', 'documents'];
  const SCALARS = ['settings'];
  const TOMBSTONE_TTL = 180 * 864e5;

  // Настройки этого устройства (не синхронизируются): Client ID, факт подключения, адрес аккаунта, id файла,
  // а также последний токен доступа — чтобы после перезапуска приложения не входить заново, пока он действует (час).
  let conf = {};
  try { conf = JSON.parse(localStorage.getItem(CONF_KEY)) || {}; } catch { /* хранилище недоступно */ }
  const saveConf = () => { try { localStorage.setItem(CONF_KEY, JSON.stringify(conf)); } catch { /* ignore */ } };
  const clientId = () => conf.clientId || window.AVTO_GOOGLE_CLIENT_ID || '';

  let token = conf.token || null, tokenExp = conf.tokenExp || 0, gisPromise = null;
  let index = new Map(), scalarSig = '';
  let timer = null, busy = false, again = false;
  let status = 'idle', lastError = '';

  /* ---------- Отметки изменений ---------- */

  const strip = (it) => { const { u, ...rest } = it; return JSON.stringify(rest); };
  const scalars = (d) => JSON.stringify(SCALARS.map((k) => d[k]));

  function reindex(d) {
    index = new Map();
    for (const c of COLLECTIONS) for (const it of d[c] || []) index.set(`${c}:${it.id}`, strip(it));
    scalarSig = scalars(d);
  }

  /** Проставляет `u` изменённым записям и надгробия удалённым. Возвращает true, если что-то изменилось. */
  function stamp(d) {
    const now = Date.now();
    const seen = new Set();
    let changed = false;
    if (!d.deleted || typeof d.deleted !== 'object') d.deleted = {};
    for (const c of COLLECTIONS) {
      for (const it of d[c] || []) {
        const k = `${c}:${it.id}`;
        seen.add(k);
        const s = strip(it);
        if (index.get(k) !== s) { it.u = now; index.set(k, s); changed = true; }
      }
    }
    for (const k of [...index.keys()]) {
      if (seen.has(k)) continue;
      d.deleted[k.slice(k.indexOf(':') + 1)] = now;
      index.delete(k);
      changed = true;
    }
    if (changed) d.isDemo = false;
    const sig = scalars(d);
    if (sig !== scalarSig) { d.metaU = now; scalarSig = sig; changed = true; }
    return changed;
  }

  /** Слияние двух версий данных: по каждой записи побеждает более свежая, удаления сильнее старых правок. */
  function merge(a, b) {
    const out = { ...a };
    const del = { ...(a.deleted || {}) };
    for (const [id, t] of Object.entries(b.deleted || {})) del[id] = Math.max(del[id] || 0, t);
    for (const c of COLLECTIONS) {
      const m = new Map((a[c] || []).map((it) => [it.id, it]));
      for (const it of b[c] || []) {
        const cur = m.get(it.id);
        if (!cur || (it.u || 0) > (cur.u || 0)) m.set(it.id, it);
      }
      out[c] = [...m.values()].filter((it) => !(del[it.id] >= (it.u || 0)));
    }
    if ((b.metaU || 0) > (a.metaU || 0)) for (const k of SCALARS) out[k] = b[k];
    out.metaU = Math.max(a.metaU || 0, b.metaU || 0);
    out.notified = { ...(b.notified || {}), ...(a.notified || {}) };
    const cutoff = Date.now() - TOMBSTONE_TTL;
    for (const k of Object.keys(del)) if (del[k] < cutoff) delete del[k];
    out.deleted = del;
    out.isDemo = Boolean(a.isDemo && b.isDemo);
    return out;
  }

  /* ---------- Google: вход и Drive API ---------- */

  function loadGis() {
    gisPromise ||= new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Не удалось загрузить вход Google — проверьте интернет')); };
      document.head.append(s);
    });
    return gisPromise;
  }

  const tokenValid = () => token && Date.now() < tokenExp - 60_000;

  /** Получает токен доступа. Окно Google открывается только по действию пользователя (interactive). */
  async function getToken(interactive) {
    if (tokenValid()) return token;
    if (!interactive) throw new Error('auth');
    if (!clientId()) throw new Error('Вход через Google ещё не включён для этой копии приложения');
    await loadGis();
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId(),
        scope: SCOPE,
        callback: (r) => {
          if (r.error) { reject(new Error(r.error_description || r.error)); return; }
          token = r.access_token;
          tokenExp = Date.now() + Number(r.expires_in || 3600) * 1000;
          conf.token = token;
          conf.tokenExp = tokenExp;
          saveConf();
          resolve(token);
        },
        error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? 'Окно входа закрыто' : e?.type === 'popup_failed_to_open' ? 'Браузер заблокировал окно входа' : e?.message || 'Ошибка входа')),
      });
      const opts = { prompt: conf.connected ? '' : 'consent' };
      if (conf.email) opts.login_hint = conf.email;
      client.requestAccessToken(opts);
    });
  }

  async function api(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
    if (r.status === 401) { token = null; tokenExp = 0; delete conf.token; delete conf.tokenExp; saveConf(); throw new Error('auth'); }
    if (!r.ok) {
      const err = new Error(`Google Диск ответил ${r.status}: ${(await r.text()).slice(0, 160)}`);
      err.status = r.status;
      throw err;
    }
    return r;
  }

  async function findFile() {
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const r = await api(`${DRIVE}/files?spaces=appDataFolder&q=${q}&orderBy=modifiedTime desc&fields=files(id,modifiedTime)`);
    return (await r.json()).files?.[0]?.id || null;
  }

  async function download(id) {
    return (await api(`${DRIVE}/files/${id}?alt=media`)).json();
  }

  async function upload(data, id) {
    const body = JSON.stringify(data);
    if (id) {
      await api(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
      return id;
    }
    const boundary = `avto${Date.now()}`;
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })}\r\n`
      + `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
    const r = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
    return (await r.json()).id;
  }

  async function whoami() {
    try {
      const j = await (await api(`${DRIVE}/about?fields=user(displayName,emailAddress)`)).json();
      conf.email = j.user?.emailAddress || conf.email;
      conf.name = j.user?.displayName || conf.name;
    } catch { /* имя аккаунта не критично */ }
  }

  /* ---------- Синхронизация ---------- */

  function persistLocal() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch { /* ignore */ }
  }

  function setStatus(s) {
    status = s;
    document.querySelectorAll('[data-sync-slot="btn"]').forEach((el) => { el.innerHTML = button(); });
    document.querySelectorAll('[data-sync-slot="card"]').forEach((el) => { el.innerHTML = card(); });
  }

  async function syncNow(interactive = false, quiet = false) {
    if (busy) { again = true; return; }
    if (!conf.connected && !interactive) return;
    busy = true;
    setStatus('syncing');
    try {
      await getToken(interactive);
      if (!conf.email) await whoami();
      let fileId = conf.fileId || await findFile();
      let remote = null;
      if (fileId) {
        try { remote = await download(fileId); }
        catch (e) {
          if (e.status !== 404) throw e;
          fileId = await findFile();
          remote = fileId ? await download(fileId) : null;
        }
      }
      if (remote) {
        remote = normalize(remote);
        // Нетронутые демо-данные на новом устройстве не смешиваем с настоящими данными из облака.
        const merged = db.isDemo && !remote.isDemo ? remote : merge(db, remote);
        db = normalize(merged);
        reindex(db);
        persistLocal();
      }
      conf.fileId = await upload(db, fileId);
      conf.connected = true;
      conf.lastSync = Date.now();
      lastError = '';
      saveConf();
      status = 'ok';
      render();
      if (interactive && !quiet) toast('Данные синхронизированы с Google Диском');
    } catch (e) {
      if (e.message === 'auth') { status = 'auth'; resumeOnClick(); }
      else {
        lastError = e.message;
        status = 'error';
        if (interactive) toast(`Синхронизация: ${e.message}`);
      }
    } finally {
      busy = false;
      setStatus(status);
      if (again) { again = false; schedule(); }
    }
  }

  /** Вызывается после каждого сохранения: отправляет изменения через несколько секунд. */
  function schedule() {
    if (!conf.connected) return;
    if (!tokenValid()) { if (status !== 'syncing') setStatus('auth'); resumeOnClick(); return; }
    clearTimeout(timer);
    timer = setTimeout(() => syncNow(false), 3000);
  }

  function disconnect() {
    try { if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ }
    token = null;
    tokenExp = 0;
    conf = { clientId: conf.clientId };
    saveConf();
    status = 'idle';
    render();
    toast('Google Диск отключён. Данные на этом устройстве сохранены.');
  }

  async function deleteCloudCopy() {
    try {
      await getToken(true);
      const id = conf.fileId || await findFile();
      if (id) await api(`${DRIVE}/files/${id}`, { method: 'DELETE' });
      conf.fileId = null;
      disconnect();
      toast('Копия в Google Диске удалена');
    } catch (e) {
      toast(`Не удалось удалить: ${e.message === 'auth' ? 'нужно войти заново' : e.message}`);
    }
  }

  function setClientId(id) {
    conf.clientId = id.trim();
    saveConf();
    gisPromise = null;
    render();
  }

  /* ---------- Интерфейс ---------- */

  function ago(ts) {
    if (!ts) return 'ещё не было';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    const d = new Date(ts);
    return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /** Кнопка-индикатор для шапки «Обзора». */
  function button() {
    if (!conf.connected) return `<button class="btn" data-act="go-sync" title="Синхронизация с Google Диском">${icon('cloud-off')} Синхронизация</button>`;
    const map = {
      syncing: ['refresh-cw', 'Синхронизация…'],
      ok: ['cloud', `Синхронизировано ${ago(conf.lastSync)}`],
      error: ['triangle-alert', 'Ошибка синхронизации'],
      auth: ['log-in', 'Войти и синхронизировать'],
      idle: ['log-in', 'Войти и синхронизировать'],
    };
    const [ic, text] = map[status] || map.idle;
    return `<button class="btn" data-act="sync" title="${esc(lastError || text)}">${icon(ic)} ${esc(text)}</button>`;
  }

  /** Содержимое карточки в разделе «Ещё». */
  function card() {
    const head = `<div class="section-title"><h2>Синхронизация с Google Диском</h2></div>`;
    if (!conf.connected) {
      return `${head}
        <p class="small muted" style="margin-top:0">Войдите через Google на каждом устройстве — машины, записи и регламент ТО будут одинаковыми на телефоне и ПК. Приложение получит доступ только к своей скрытой папке на Диске, остальные файлы ей не видны.</p>
        ${status === 'error' ? `<div class="alert" style="margin-bottom:12px">${icon('triangle-alert')}<span class="mid small">${esc(lastError)}</span></div>` : ''}
        <div class="toolbar">
          <button class="btn primary" data-act="sync" ${status === 'syncing' ? 'disabled' : ''}>${icon('log-in')} ${status === 'syncing' ? 'Подключение…' : 'Войти через Google'}</button>
        </div>`;
    }
    const state = {
      syncing: 'Идёт синхронизация…',
      ok: 'Включена — изменения отправляются автоматически',
      auth: 'Сессия Google истекла — нажмите «Синхронизировать», чтобы продолжить',
      idle: 'Нажмите «Синхронизировать», чтобы продолжить в этом сеансе',
      error: `Ошибка: ${lastError}`,
    }[status];
    return `${head}
      <ul class="list"><li class="row" style="cursor:default">${badge('cloud', '#228be6')}
        <span class="mid"><div class="t">${esc(conf.name || conf.email || 'Google Диск')}</div><div class="s">${esc(conf.email || '')}</div></span></li></ul>
      <p class="small ${status === 'error' ? 'neg' : 'muted'}">${esc(state)}<br>Последняя синхронизация: ${esc(ago(conf.lastSync))}</p>
      <div class="toolbar">
        <button class="btn primary" data-act="sync" ${status === 'syncing' ? 'disabled' : ''}>${icon('refresh-cw')} Синхронизировать</button>
        <button class="btn" data-act="sync-disconnect">${icon('log-out')} Отключить</button>
        <button class="btn danger" data-act="sync-delete-cloud">${icon('trash-2')} Удалить копию в облаке</button>
      </div>`;
  }

  // Окно Google можно открыть только по действию пользователя, поэтому истёкший вход
  // восстанавливаем при первом нажатии в приложении. Google уже знает аккаунт — окно закроется само.
  let resumeArmed = false;
  function resumeOnClick() {
    if (resumeArmed) return;
    resumeArmed = true;
    const resume = (e) => {
      if (e.target.closest?.('[data-act^="sync"]')) return;
      document.removeEventListener('click', resume, true);
      resumeArmed = false;
      if (conf.connected && !tokenValid()) syncNow(true, true);
    };
    document.addEventListener('click', resume, true);
  }

  function init() {
    reindex(db);
    if (conf.connected) {
      status = 'auth';
      if (tokenValid()) syncNow(false);
      else resumeOnClick();
      if (clientId()) loadGis().catch(() => {}); // заранее, чтобы окно входа открылось сразу по нажатию
    }
    // Пока токен действует — подтягиваем изменения с других устройств.
    setInterval(() => { if (conf.connected && tokenValid()) syncNow(false); }, 120_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && conf.connected && tokenValid()) syncNow(false);
    });
  }

  return {
    init, stamp, schedule, syncNow, disconnect, deleteCloudCopy, setClientId, button, card, merge, reindex,
    get connected() { return Boolean(conf.connected); },
    get clientId() { return clientId(); },
  };
})();
