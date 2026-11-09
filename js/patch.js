// Склейка ответа модели с оригиналом.
//
// Модель перерисовывает кадр целиком. Ответ совмещается с оригиналом
// (align.js), подгоняется к нему по тону и кладётся поверх по одной из трёх
// границ:
//   grow:  пометка плюс всё, что модель заметно изменила вплотную к ней.
//          Объект, нарисованный шире пометки, входит целиком;
//   mark:  строго закрашенное;
//   frame: весь ответ модели в кадре.
// За границей остаются пиксели оригинала. Шов растушёвывается.

const V = new URL(import.meta.url).search;   // см. комментарий в app.js
const { blank } = await import('./marks.js' + V);

const FEATHER_RATIO = 0.004;
const GROW_EDGE = 512;       // изменения ищутся на копии такого размера
const GROW_REACH = 0.2;      // дальше этой доли длинной стороны от пометки не растём
const GROW_MIN_DIFF = 18;    // нижний порог разницы яркости, уровни из 255
const GROW_MIN_TEXTURE = 5;  // нижний порог разницы фактуры (разброса яркости)
const GROW_CLOSE = 0.02;     // зазубрины уже этой доли длинной стороны закрываются
const TONE_EDGE = 256;

export const featherPx = (w, h) => Math.max(1, Math.round(Math.max(w, h) * FEATHER_RATIO));

/** Результат в кадре оригинала по найденному совмещению. */
export function place(result, fit, w, h) {
  const c = blank(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(result, fit.tx, fit.ty, w * fit.sx, h * fit.sy);
  return c;
}

/** RGBA уменьшенной копии на белом поле, при желании размытой. */
function pixels(source, w, h, blur = 0) {
  const c = blank(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (blur) ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** Медиана гистограммы. */
function median(hist, total) {
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc * 2 >= total) return i;
  }
  return hist.length - 1;
}

/**
 * Насколько результат отличается от оригинала ВНУТРИ маски: средняя разница
 * канала, 0…255. Нужна, чтобы отличить настоящую правку от случая, когда
 * модель вернула исходник: со склейкой такой ответ даёт кадр, побитово
 * равный входу, и без замера выглядел бы как успешная правка.
 */
export function changeInside(original, aligned, mask) {
  const k = Math.min(1, 256 / Math.max(original.width, original.height));
  const w = Math.max(8, Math.round(original.width * k));
  const h = Math.max(8, Math.round(original.height * k));
  const A = pixels(original, w, h);
  const B = pixels(aligned, w, h);
  const M = pixels(mask, w, h);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < M.length; i += 4) {
    if (M[i + 3] < 128) continue;
    sum += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    n += 3;
  }
  return n ? sum / n : 0;
}

/** Расширение на r точек во все восемь сторон (по шахматному расстоянию). */
function dilate(src, w, h, r) {
  const n = w * h;
  const out = new Uint8Array(n);
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < n; p++) if (src[p]) { out[p] = 1; dist[p] = 0; queue[tail++] = p; }
  while (head < tail) {
    const p = queue[head++];
    if (dist[p] >= r) continue;
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const q = yy * w + xx;
        if (dist[q] >= 0) continue;
        dist[q] = dist[p] + 1;
        out[q] = 1;
        queue[tail++] = q;
      }
    }
  }
  return out;
}

/** Средняя яркость и разброс яркости в окне (2r+1)² через интегральные суммы. */
function texture(Y, w, h, r) {
  const W1 = w + 1;
  const S = new Float64Array(W1 * (h + 1));
  const Q = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < w; x++) {
      const v = Y[y * w + x];
      rs += v;
      rq += v * v;
      S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + rs;
      Q[(y + 1) * W1 + x + 1] = Q[y * W1 + x + 1] + rq;
    }
  }
  const sd = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const a = (y1 - y0) * (x1 - x0);
      const sum = S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
      const sq = Q[y1 * W1 + x1] - Q[y0 * W1 + x1] - Q[y1 * W1 + x0] + Q[y0 * W1 + x0];
      sd[y * w + x] = Math.sqrt(Math.max(0, sq / a - (sum / a) ** 2));
    }
  }
  return sd;
}

/** Порог по шуму: медиана плюс k отклонений по точкам вдали от пометки. */
function noiseLevel(values, far, farCount, floor, k = 5) {
  if (farCount < 100) return floor;
  const scale = 4;   // четверть уровня на ячейку гистограммы
  const hist = new Uint32Array(1024);
  for (let p = 0; p < values.length; p++) if (far[p]) hist[Math.min(1023, Math.round(values[p] * scale))]++;
  const med = median(hist, farCount);
  const dev = new Uint32Array(1024);
  for (let v = 0; v < 1024; v++) dev[Math.abs(v - med)] += hist[v];
  return Math.max(floor, (med + k * median(dev, farCount)) / scale);
}

/**
 * Граница «по изменениям»: пометка плюс области, где ответ заметно
 * отличается от оригинала и которые смыкаются с пометкой, не дальше
 * GROW_REACH от неё. Дыры внутри заливаются.
 *
 * Изменением считается новое по яркости или по фактуре: здание на месте
 * травы, тень, убранный объект. Смена оттенка при той же яркости и
 * фактуре изменением не считается: модель перекрашивает и нетронутые
 * места вокруг правки, и такая перекраска не должна попадать в кадр.
 * Пороги берутся по шуму ответа вдали от пометки, общий сдвиг яркости и
 * контраста снимается заранее.
 *
 * Возвращает холст размера оригинала и долю, на которую выросла площадь.
 */
export function growMask(original, aligned, mask) {
  const W = original.width;
  const H = original.height;
  const k = Math.min(1, GROW_EDGE / Math.max(W, H));
  const w = Math.max(8, Math.round(W * k));
  const h = Math.max(8, Math.round(H * k));
  const n = w * h;
  const blur = Math.max(1, Math.round(Math.max(w, h) / 256));
  const A = pixels(original, w, h, blur);
  const B = pixels(aligned, w, h, blur);
  const M = pixels(mask, w, h);
  const Near = pixels(mask, w, h, blur * 3);

  const marked = new Uint8Array(n);
  const far = new Uint8Array(n);
  let markedCount = 0;
  let farCount = 0;
  const YA = new Float32Array(n);
  const YB = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (M[i + 3] >= 128) { marked[p] = 1; markedCount++; }
    if (Near[i + 3] === 0) { far[p] = 1; farCount++; }
    YA[p] = A[i] * 0.299 + A[i + 1] * 0.587 + A[i + 2] * 0.114;
    YB[p] = B[i] * 0.299 + B[i + 1] * 0.587 + B[i + 2] * 0.114;
  }

  // Общий сдвиг яркости и контраста ответа: прямая yA = g·yB + b по точкам
  // вдали от пометки, явные правки (разница больше 40) не учитываются.
  let g = 1;
  let b0 = 0;
  {
    let m = 0, sa = 0, sb = 0, sbb = 0, sab = 0;
    for (let p = 0; p < n; p++) {
      if (!far[p] || Math.abs(YA[p] - YB[p]) > 40) continue;
      m++; sa += YA[p]; sb += YB[p]; sbb += YB[p] * YB[p]; sab += YA[p] * YB[p];
    }
    if (m > 100) {
      const vb = sbb / m - (sb / m) ** 2;
      const gg = vb > 1 ? (sab / m - (sa / m) * (sb / m)) / vb : 1;
      if (gg > 0.7 && gg < 1.4) { g = gg; b0 = sa / m - g * (sb / m); }
    }
  }

  const tr = Math.max(2, Math.round(Math.max(w, h) / 200));
  const sA = texture(YA, w, h, tr);
  const sB = texture(YB, w, h, tr);
  const dY = new Float32Array(n);
  const dS = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    dY[p] = Math.abs(g * YB[p] + b0 - YA[p]);
    dS[p] = Math.abs(g * sB[p] - sA[p]);
  }
  const tY = noiseLevel(dY, far, farCount, GROW_MIN_DIFF);
  const tS = noiseLevel(dS, far, farCount, GROW_MIN_TEXTURE);

  // Изменённые точки; одиночные отбрасываются: из девяти соседей нужно пять.
  const raw = new Uint8Array(n);
  for (let p = 0; p < n; p++) raw[p] = dY[p] > tY || dS[p] > tS ? 1 : 0;
  const changed = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const s = raw[p - w - 1] + raw[p - w] + raw[p - w + 1] + raw[p - 1] + raw[p] + raw[p + 1] + raw[p + w - 1] + raw[p + w] + raw[p + w + 1];
      changed[p] = s >= 5 ? 1 : 0;
    }
  }
  const threshold = { luminance: tY, texture: tS };

  // Рост от пометки по изменённым точкам, с ограничением расстояния.
  const reach = Math.round(GROW_REACH * Math.max(w, h));
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < n; p++) if (marked[p]) { dist[p] = 0; queue[tail++] = p; }
  while (head < tail) {
    const p = queue[head++];
    const dp = dist[p];
    if (dp >= reach) continue;
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const q = yy * w + xx;
        if (dist[q] >= 0 || !changed[q]) continue;
        dist[q] = dp + 1;
        queue[tail++] = q;
      }
    }
  }

  // Замыкание (расширение и сужение на r) закрывает зазубрины по краю
  // нового объекта там, где его цвет совпал со старым фоном.
  const grown = new Uint8Array(n);
  for (let p = 0; p < n; p++) grown[p] = dist[p] >= 0 ? 1 : 0;
  const r = Math.max(2, Math.round(Math.max(w, h) * GROW_CLOSE));
  const wide = dilate(grown, w, h, r);
  const gaps = new Uint8Array(n);
  for (let p = 0; p < n; p++) gaps[p] = wide[p] ? 0 : 1;
  const shrunk = dilate(gaps, w, h, r);
  // Плюс точка анализа по краю: размытие и отбор одиночных точек съедают
  // край нового объекта.
  const closed = new Uint8Array(n);
  for (let p = 0; p < n; p++) closed[p] = grown[p] || !shrunk[p] ? 1 : 0;
  const inside = dilate(closed, w, h, 1);

  // Дыры внутри выросшей области заливаются: снаружи то, до чего можно
  // дойти от края кадра, не пересекая её.
  const outside = new Uint8Array(n);
  head = 0;
  tail = 0;
  const seed = (p) => { if (!inside[p] && !outside[p]) { outside[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < n - w) seed(p + w);
  }

  const small = blank(w, h);
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(w, h);
  let area = 0;
  for (let p = 0; p < n; p++) {
    if (outside[p]) continue;
    img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = img.data[p * 4 + 3] = 255;
    area++;
  }
  sctx.putImageData(img, 0, 0);

  // В полный размер: копия анализа плюс чёткая исходная пометка поверх.
  const out = blank(W, H);
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, W, H);
  octx.drawImage(mask, 0, 0, W, H);
  return { canvas: out, grew: markedCount ? area / markedCount - 1 : 0, threshold };
}

/**
 * Поправка яркости и контраста ответа, y' = g·y + b, одна на все каналы.
 * Модель часто чуть осветляет кадр, и без поправки вставка видна светлым
 * пятном. Оценка идёт по яркости точек вне границы правки, где ответ и
 * оригинал должны совпадать, с отбрасыванием выбросов: перекраска оттенка
 * вокруг правки и явные изменения на оценку не влияют. Оттенок не
 * правится: по каналам оценку тянет любая перекраска.
 * null, если поправка не нужна или вышла неправдоподобной.
 */
export function toneOf(original, aligned, region) {
  const k = Math.min(1, TONE_EDGE / Math.max(original.width, original.height));
  const w = Math.max(8, Math.round(original.width * k));
  const h = Math.max(8, Math.round(original.height * k));
  const A = pixels(original, w, h, 1);
  const B = pixels(aligned, w, h, 1);
  const R = pixels(region, w, h, 3);
  const ya = [];
  const yb = [];
  for (let i = 0; i < A.length; i += 4) {
    if (R[i + 3] > 0) continue;
    ya.push(A[i] * 0.299 + A[i + 1] * 0.587 + A[i + 2] * 0.114);
    yb.push(B[i] * 0.299 + B[i + 1] * 0.587 + B[i + 2] * 0.114);
  }
  if (ya.length < 200) return null;

  // Два прохода: прямая по всем точкам, затем без точек с остатком больше
  // трёх медианных отклонений.
  let g = 1;
  let b0 = 0;
  let keep = ya.map(() => true);
  for (let pass = 0; pass < 2; pass++) {
    let n = 0, sa = 0, sb = 0, sbb = 0, sab = 0;
    for (let j = 0; j < ya.length; j++) {
      if (!keep[j]) continue;
      n++; sa += ya[j]; sb += yb[j]; sbb += yb[j] * yb[j]; sab += ya[j] * yb[j];
    }
    if (n < 200) return null;
    const vb = sbb / n - (sb / n) ** 2;
    g = vb > 1 ? (sab / n - (sa / n) * (sb / n)) / vb : 1;
    b0 = sa / n - g * (sb / n);
    const res = ya.map((a, j) => Math.abs(g * yb[j] + b0 - a));
    const sorted = res.filter((_, j) => keep[j]).sort((x, y) => x - y);
    const mad = Math.max(1, sorted[sorted.length >> 1]);
    keep = res.map((r) => r <= 3 * mad);
  }
  if (g < 0.85 || g > 1.18 || Math.abs(b0) > 30) return null;
  if (Math.abs(g - 1) < 0.01 && Math.abs(b0) < 1.5) return null;
  return [[g, b0], [g, b0], [g, b0]];
}

function applyTone(canvas, tone) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const lut = tone.map(([g, b0]) => Uint8ClampedArray.from({ length: 256 }, (_, v) => g * v + b0));
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[0][d[i]];
    d[i + 1] = lut[1][d[i + 1]];
    d[i + 2] = lut[2][d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
}

/** Граница с растушёвкой: шов между старым и новым не виден. */
export function softEdge(region) {
  const w = region.width;
  const h = region.height;
  const c = blank(w, h);
  const ctx = c.getContext('2d');
  ctx.filter = `blur(${featherPx(w, h)}px)`;
  ctx.drawImage(region, 0, 0);
  return c;
}

/** Прямоугольник кадра с растушёванными краями: весь ответ на фрагменте листа. */
export function softFrame(w, h) {
  const px = featherPx(w, h) * 2;
  const c = blank(w, h);
  const ctx = c.getContext('2d');
  ctx.filter = `blur(${px}px)`;
  ctx.fillStyle = '#fff';
  ctx.fillRect(px * 2, px * 2, w - px * 4, h - px * 4);
  return c;
}

/**
 * Заплатка: выровненный ответ с поправкой тона, обрезанный по alpha
 * (null: без обрезки). composed: оригинал с заплаткой.
 */
export function composeWith({ original, aligned, alpha, tone }) {
  const w = original.width;
  const h = original.height;
  const patch = blank(w, h);
  const pctx = patch.getContext('2d');
  pctx.drawImage(aligned, 0, 0);
  if (tone) applyTone(patch, tone);
  if (alpha) {
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(alpha, 0, 0);
  }
  const composed = blank(w, h);
  const cctx = composed.getContext('2d');
  cctx.drawImage(original, 0, 0);
  cctx.drawImage(patch, 0, 0);
  return { patch, composed };
}

/**
 * Охват непрозрачной части холста в пикселях: [x, y, w, h] или null.
 * Ищется по уменьшенной копии и расширяется на её пиксель.
 */
export function opaqueBox(canvas) {
  const k = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * k));
  const h = Math.max(1, Math.round(canvas.height * k));
  const probe = blank(w, h);
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!d[(y * w + x) * 4 + 3]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const left = Math.max(0, Math.floor((x0 - 1) / k));
  const top = Math.max(0, Math.floor((y0 - 1) / k));
  const right = Math.min(canvas.width, Math.ceil((x1 + 2) / k));
  const bottom = Math.min(canvas.height, Math.ceil((y1 + 2) / k));
  return [left, top, right - left, bottom - top];
}

/** Вырезка из холста. */
export function cut(canvas, [x, y, w, h]) {
  const c = blank(w, h);
  c.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return c;
}

export const toPng = (canvas) => new Promise((res, rej) => canvas.toBlob(
  (b) => (b ? res(b) : rej(new Error('Холст не кодируется в PNG: слишком большой кадр.'))), 'image/png',
));
