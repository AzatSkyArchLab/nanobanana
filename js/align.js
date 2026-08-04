// Совмещение результата с оригиналом.
//
// Модель не возвращает попиксельно совпадающий кадр: она перерисовывает
// картинку заново, и композиция уезжает на проценты. Если вклеивать такой
// результат в маску как есть, на границе получается «задвоение» — контур
// объекта из нового кадра ложится рядом с контуром из старого.
//
// Поэтому перед склейкой ищется сдвиг и масштаб, при которых результат
// лучше всего садится на оригинал. Сравнивается только то, что ВНЕ маски:
// внутри картинка и должна отличаться, это и есть правка.

const COARSE = 64;    // грубый проход: широкий диапазон, мало пикселей
const FINE = 256;     // уточнение вокруг найденного
const SCALES = [0.94, 0.96, 0.98, 1, 1.02, 1.04, 1.06];

function renderGray(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let p = 0, i = 0; p < g.length; p++, i += 4) {
    g[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }
  return { g, w, h };
}

/** Единицы — там, где сравнивать можно: вне маски и вне её размытого края. */
function weights(maskCanvas, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.filter = 'blur(1px)';
  ctx.drawImage(maskCanvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  let free = 0;
  for (let p = 0, i = 3; p < out.length; p++, i += 4) {
    out[p] = d[i] === 0 ? 1 : 0;
    free += out[p];
  }
  return { out, free };
}

/** Средняя разница яркости при смещении результата на (dx, dy). */
function cost(A, B, wgt, dx, dy, minPixels) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < A.h; y++) {
    const by = y - dy;
    if (by < 0 || by >= B.h) continue;
    const arow = y * A.w;
    const brow = by * B.w;
    for (let x = 0; x < A.w; x++) {
      if (!wgt[arow + x]) continue;
      const bx = x - dx;
      if (bx < 0 || bx >= B.w) continue;
      sum += Math.abs(A.g[arow + x] - B.g[brow + bx]);
      n++;
    }
  }
  return n < minPixels ? Infinity : sum / n;
}

function search(A, B, wgt, centre, range, minPixels) {
  let best = { cost: Infinity, dx: centre.dx, dy: centre.dy };
  for (let dy = centre.dy - range; dy <= centre.dy + range; dy++) {
    for (let dx = centre.dx - range; dx <= centre.dx + range; dx++) {
      const c = cost(A, B, wgt, dx, dy, minPixels);
      if (c < best.cost) best = { cost: c, dx, dy };
    }
  }
  return best;
}

/**
 * Возвращает преобразование результата под оригинал:
 * рисовать его размером (W*scale, H*scale) со смещением (tx, ty).
 * gain — во сколько раз уменьшилась невязка против «как есть».
 */
export function estimateAlignment(original, result, maskCanvas, W, H) {
  const long = Math.max(W, H);

  // ── грубо: перебираем масштаб и широкий диапазон сдвигов
  const k1 = COARSE / long;
  const w1 = Math.max(8, Math.round(W * k1));
  const h1 = Math.max(8, Math.round(H * k1));
  const A1 = renderGray(original, w1, h1);
  const { out: wgt1, free: free1 } = weights(maskCanvas, w1, h1);
  const min1 = Math.max(16, free1 * 0.35);
  const range1 = Math.max(4, Math.round(Math.max(w1, h1) * 0.12));

  let best = { cost: Infinity, scale: 1, dx: 0, dy: 0 };
  for (const scale of SCALES) {
    const B = renderGray(result, Math.round(w1 * scale), Math.round(h1 * scale));
    const centre = { dx: Math.round((w1 - B.w) / 2), dy: Math.round((h1 - B.h) / 2) };
    const found = search(A1, B, wgt1, centre, range1, min1);
    if (found.cost < best.cost) best = { cost: found.cost, scale, dx: found.dx, dy: found.dy };
  }

  // ── точно: масштаб фиксируем, сдвиг уточняем на большем разрешении
  const k2 = Math.min(1, FINE / long);
  const w2 = Math.max(8, Math.round(W * k2));
  const h2 = Math.max(8, Math.round(H * k2));
  const A2 = renderGray(original, w2, h2);
  const { out: wgt2, free: free2 } = weights(maskCanvas, w2, h2);
  const min2 = Math.max(16, free2 * 0.35);

  const B2 = renderGray(result, Math.round(w2 * best.scale), Math.round(h2 * best.scale));
  const scaled = { dx: Math.round(best.dx * k2 / k1), dy: Math.round(best.dy * k2 / k1) };
  const refined = search(A2, B2, wgt2, scaled, 4, min2);

  // Невязка «как есть»: результат натянут на кадр без сдвига.
  const asIs = renderGray(result, w2, h2);
  const plain = cost(A2, asIs, wgt2, 0, 0, min2);

  const gain = Number.isFinite(plain) && refined.cost > 0 ? plain / refined.cost : 1;
  return {
    scale: best.scale,
    tx: refined.dx / k2,
    ty: refined.dy / k2,
    residual: refined.cost,
    gain,
  };
}
