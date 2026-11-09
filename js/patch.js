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

export const BOUNDARIES = ['grow', 'mark', 'frame'];

const FEATHER_RATIO = 0.004;
const GROW_EDGE = 512;       // изменения ищутся на копии такого размера
const GROW_REACH = 0.3;      // дальше этой доли длинной стороны от пометки не растём
const GROW_MIN_DIFF = 16;    // нижний порог разницы канала, уровни из 255
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

/**
 * Граница «по изменениям»: пометка плюс области, где ответ заметно
 * отличается от оригинала и которые смыкаются с пометкой, не дальше
 * GROW_REACH от неё. Дыры внутри заливаются.
 *
 * Порог берётся по шуму ответа вне пометки: модель перерисовывает и
 * нетронутые места (трава, штриховка), и эта разница не должна тянуть
 * границу. Общий сдвиг цвета снимается заранее.
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
  let markedCount = 0;
  for (let p = 0; p < n; p++) {
    if (M[p * 4 + 3] >= 128) { marked[p] = 1; markedCount++; }
  }

  // Общий сдвиг цвета по точкам вдали от пометки: медиана разницы по каналу.
  const shift = [0, 0, 0];
  const hists = [new Uint32Array(511), new Uint32Array(511), new Uint32Array(511)];
  let far = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (Near[i + 3] > 0) continue;
    for (let c = 0; c < 3; c++) hists[c][B[i + c] - A[i + c] + 255]++;
    far++;
  }
  if (far > 100) for (let c = 0; c < 3; c++) shift[c] = median(hists[c], far) - 255;

  const d = new Float32Array(n);
  const noise = new Uint32Array(256);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const v = (Math.abs(B[i] - shift[0] - A[i]) + Math.abs(B[i + 1] - shift[1] - A[i + 1]) + Math.abs(B[i + 2] - shift[2] - A[i + 2])) / 3;
    d[p] = v;
    if (Near[i + 3] === 0) noise[Math.min(255, Math.round(v))]++;
  }
  let threshold = GROW_MIN_DIFF;
  if (far > 100) {
    const med = median(noise, far);
    const dev = new Uint32Array(256);
    for (let v = 0; v < 256; v++) dev[Math.abs(v - med)] += noise[v];
    threshold = Math.max(GROW_MIN_DIFF, med + 4.5 * median(dev, far));
  }

  // Изменённые точки; одиночные отбрасываются: из девяти соседей нужно пять.
  const raw = new Uint8Array(n);
  for (let p = 0; p < n; p++) raw[p] = d[p] > threshold ? 1 : 0;
  const changed = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const s = raw[p - w - 1] + raw[p - w] + raw[p - w + 1] + raw[p - 1] + raw[p] + raw[p + 1] + raw[p + w - 1] + raw[p + w] + raw[p + w + 1];
      changed[p] = s >= 5 ? 1 : 0;
    }
  }

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
  const inside = new Uint8Array(n);
  for (let p = 0; p < n; p++) inside[p] = grown[p] || !shrunk[p] ? 1 : 0;

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
 * Поправка тона ответа по каналам, c' = g·c + b, по точкам вне границы
 * правки, где ответ и оригинал должны совпадать. Модель часто чуть
 * осветляет или перекрашивает кадр, и без поправки вставка видна пятном.
 * null, если поправка не нужна или вышла неправдоподобной.
 */
export function toneOf(original, aligned, region) {
  const k = Math.min(1, TONE_EDGE / Math.max(original.width, original.height));
  const w = Math.max(8, Math.round(original.width * k));
  const h = Math.max(8, Math.round(original.height * k));
  const A = pixels(original, w, h, 1);
  const B = pixels(aligned, w, h, 1);
  const R = pixels(region, w, h, 3);
  const tone = [];
  for (let c = 0; c < 3; c++) {
    let n = 0, sa = 0, sb = 0, sbb = 0, sab = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (R[i + 3] > 0) continue;
      const a = A[i + c];
      const b = B[i + c];
      if (Math.abs(a - b) > 60) continue;   // изменённое по делу не учитываем
      n++; sa += a; sb += b; sbb += b * b; sab += a * b;
    }
    if (n < 200) return null;
    const vb = sbb / n - (sb / n) ** 2;
    const g = vb > 1 ? (sab / n - (sa / n) * (sb / n)) / vb : 1;
    const b0 = sa / n - g * (sb / n);
    if (g < 0.85 || g > 1.18 || Math.abs(b0) > 30) return null;
    tone.push([g, b0]);
  }
  const idle = tone.every(([g, b0]) => Math.abs(g - 1) < 0.01 && Math.abs(b0) < 1.5);
  return idle ? null : tone;
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
