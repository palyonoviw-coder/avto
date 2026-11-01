'use strict';

/*
 * Фото машины: своё фото или сгенерированный нейросетью вид сбоку.
 *
 * - Фон вырезает нейросеть прямо в браузере (@imgly/background-removal, лицензия AGPL-3.0, файл vendor/bg-removal.min.mjs).
 *   Модель (~45 МБ) и движок (~10 МБ) скачиваются при первом использовании, дальше берутся из кэша браузера.
 *   Фото никуда не отправляется.
 * - Картинку «вид сбоку» по марке и цвету рисует бесплатный сервис Pollinations (без ключа). Ему уходит только текст запроса.
 * - Результат обрезается по краям, уменьшается и хранится в данных машины (поэтому синхронизируется через Google Диск).
 */
const Photo = (() => {
  const DATA_PATHS = [
    'https://staticimgly.com/@imgly/background-removal-data/1.4.5/dist/',
    'https://cdn.jsdelivr.net/npm/@imgly/background-removal-data@1.4.5/dist/',
  ];
  const MAX_W = 960;
  let lib = null;

  const COLOR_EN = {
    'бел': 'white', 'черн': 'black', 'чёрн': 'black', 'сер': 'grey', 'серебр': 'silver', 'красн': 'red', 'бордов': 'burgundy',
    'син': 'blue', 'голуб': 'light blue', 'зел': 'green', 'жёлт': 'yellow', 'желт': 'yellow', 'оранж': 'orange',
    'коричн': 'brown', 'бежев': 'beige', 'фиолет': 'purple', 'вишн': 'cherry red', 'графит': 'graphite grey', 'мокр': 'wet asphalt grey',
  };
  function colorEn(s) {
    const t = String(s || '').toLowerCase();
    for (const [k, v] of Object.entries(COLOR_EN)) if (t.includes(k)) return v;
    return t;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Не удалось открыть картинку'));
      img.src = src;
    });
  }

  /** Обрезает прозрачные поля, уменьшает до MAX_W и кодирует в WebP (или PNG, если браузер не умеет WebP). */
  async function finish(blob, transparent) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      let { naturalWidth: w, naturalHeight: h } = img;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      let box = { x: 0, y: 0, w, h };
      if (transparent) {
        const d = ctx.getImageData(0, 0, w, h).data;
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        if (x1 > x0 && y1 > y0) box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      }
      const k = Math.min(1, MAX_W / box.w);
      const out = document.createElement('canvas');
      out.width = Math.round(box.w * k); out.height = Math.round(box.h * k);
      out.getContext('2d').drawImage(c, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height);
      let data = out.toDataURL('image/webp', 0.86);
      if (!data.startsWith('data:image/webp')) data = transparent ? out.toDataURL('image/png') : out.toDataURL('image/jpeg', 0.85);
      return data;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function cutout(blob, onProgress) {
    lib ||= await import('./vendor/bg-removal.min.mjs');
    let lastErr;
    for (const publicPath of DATA_PATHS) {
      try {
        return await lib.removeBackground(blob, {
          publicPath, model: 'small', output: { format: 'image/png' },
          progress: (key, cur, total) => {
            if (!total) return;
            const what = key.includes('model') ? 'нейросеть' : key.includes('wasm') ? 'движок' : 'файлы';
            onProgress?.(`Загружаю ${what}: ${Math.round((cur / total) * 100)}%`);
          },
        });
      } catch (e) { lastErr = e; }
    }
    throw new Error(`Не удалось вырезать фон${lastErr?.message ? ` (${lastErr.message})` : ''}`);
  }

  /** Если вырезать фон не вышло, сохраняем картинку как есть и сообщаем почему. */
  async function withCutout(blob, onProgress) {
    onProgress?.('Вырезаю машину из фона…');
    try {
      const png = await cutout(blob, onProgress);
      onProgress?.('Готово, сохраняю…');
      return { data: await finish(png, true), cut: true };
    } catch (e) {
      return { data: await finish(blob, false), cut: false, error: e.message };
    }
  }

  async function fromFile(file, { removeBg = true, onProgress } = {}) {
    if (!removeBg) return { data: await finish(file, false), cut: false };
    return withCutout(file, onProgress);
  }

  /** Вид сбоку по описанию машины: генерация, затем вырезание фона. */
  async function generate({ name, year, color }, { onProgress } = {}) {
    const prompt = [`${year || ''} ${name}`.trim(), colorEn(color) && `${colorEn(color)} color`,
      'car, exact side profile view facing right, whole car visible, studio product photo, plain light grey background, soft shadow, no text, no people']
      .filter(Boolean).join(', ');
    const seed = Math.floor(Math.random() * 1e6);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1280&height=640&nologo=true&seed=${seed}`;
    onProgress?.('Нейросеть рисует машину… (до минуты)');
    let r;
    try { r = await fetch(url); } catch { throw new Error('Сервис генерации недоступен — проверьте интернет или попробуйте позже'); }
    if (!r.ok) throw new Error(`Сервис генерации ответил ${r.status}, попробуйте ещё раз`);
    return withCutout(await r.blob(), onProgress);
  }

  return { fromFile, generate };
})();
