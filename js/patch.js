// Склейка ответа модели с оригиналом.
//
// Модель перерисовывает кадр целиком, поэтому из её ответа берётся только
// закрашенное: результат совмещается с оригиналом (см. align.js), режется
// по маске с растушёвкой шва и кладётся поверх. За пределами маски остаются
// пиксели оригинала.

const V = new URL(import.meta.url).search;   // см. комментарий в app.js
const [{ estimateAlignment }, { blank }] = await Promise.all([
  import('./align.js' + V),
  import('./marks.js' + V),
]);

const FEATHER_RATIO = 0.004;

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
  const pick = (source) => {
    const c = blank(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  };
  const A = pick(original);
  const B = pick(aligned);
  const M = pick(mask);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < M.length; i += 4) {
    if (M[i + 3] < 128) continue;
    sum += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    n += 3;
  }
  return n ? sum / n : 0;
}

/** Маска с размытым краем: шов между старым и новым не виден. */
function soften(mask, w, h, px) {
  const c = blank(w, h);
  const ctx = c.getContext('2d');
  ctx.filter = `blur(${px}px)`;
  ctx.drawImage(mask, 0, 0, w, h);
  return c;
}

/** Прямоугольник кадра с растушёванными краями: для правки без маски на фрагменте. */
function softRect(w, h, px) {
  const c = blank(w, h);
  const ctx = c.getContext('2d');
  ctx.filter = `blur(${px}px)`;
  ctx.fillStyle = '#fff';
  ctx.fillRect(px * 2, px * 2, w - px * 4, h - px * 4);
  return c;
}

/**
 * Совмещает ответ с оригиналом и строит заплатку.
 *   keep = true:  заплатка только по маске, остальное из оригинала;
 *   keep = false: весь кадр модели; edges = true растушёвывает края кадра,
 *                 когда кадр лишь фрагмент большого листа.
 * Возвращает patch: заплатку с прозрачностью, и composed: оригинал с заплаткой.
 */
export function makePatch({ original, result, mask, keep, edges = false }) {
  const w = original.width;
  const h = original.height;
  const fit = estimateAlignment(original, result, mask, w, h);
  const aligned = place(result, fit, w, h);
  const changed = changeInside(original, aligned, mask);

  const px = featherPx(w, h);
  const alpha = keep ? soften(mask, w, h, px) : edges ? softRect(w, h, px * 2) : null;

  const patch = blank(w, h);
  const pctx = patch.getContext('2d');
  pctx.drawImage(aligned, 0, 0);
  if (alpha) {
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(alpha, 0, 0);
  }

  const composed = blank(w, h);
  const cctx = composed.getContext('2d');
  cctx.drawImage(original, 0, 0);
  cctx.drawImage(patch, 0, 0);
  return { fit, changed, patch, composed };
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
