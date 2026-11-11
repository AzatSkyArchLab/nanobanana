// Склейка ответа модели с оригиналом.
//
// Модель перерисовывает кадр целиком. Ответ совмещается с оригиналом
// (align.js), подгоняется к нему по тону и кладётся поверх по одной из
// трёх границ:
//   fit:   правка остаётся внутри нарисованной области; объект, который
//          модель нарисовала крупнее области или со сдвигом, уменьшается
//          и сдвигается так, чтобы войти в неё целиком;
//   mark:  строго закрашенное, объект за краем области обрезается;
//   frame: весь ответ модели в кадре.
// За границей остаются пиксели оригинала. Шов растушёвывается внутрь
// области: за её краем альфа ровно ноль.

const V = new URL(import.meta.url).search;   // см. комментарий в app.js
const { blank } = await import('./marks.js' + V);

const FEATHER_RATIO = 0.004;
const FIT_EDGE = 512;         // объект ищется на копии такого размера
const FIT_REACH = 0.35;       // объект ищется не дальше этой доли длинной стороны кадра от области
const FIT_MIN_DIFF = 18;      // нижний порог разницы яркости, уровни из 255
const FIT_MIN_TEXTURE = 5;    // нижний порог разницы фактуры (разброса яркости)
const FIT_CLOSE = 0.02;       // зазубрины уже этой доли длинной стороны закрываются
const FIT_THIN = 0.006;       // изменения тоньше двух таких долей длинной стороны не тело объекта
const FIT_SPILL = 0.05;       // если за краем области меньшая доля объекта, вписывать незачем
const FIT_SLACK = 0.02;       // вписанный объект может задеть край области на эту долю
const FIT_MIN_SCALE = 0.3;    // уменьшение сильнее значит, что объект найден неверно
const FIT_MIN_OBJECT = 0.002; // объект меньше этой доли кадра не вписывается
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

/* ── Поиск объекта ─────────────────────────────────────── */

/**
 * Шахматное расстояние до ближайшей точки src, не дальше limit; дальше -1.
 */
function distanceFrom(src, w, h, limit) {
  const n = w * h;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < n; p++) if (src[p]) { dist[p] = 0; queue[tail++] = p; }
  while (head < tail) {
    const p = queue[head++];
    if (dist[p] >= limit) continue;
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
        queue[tail++] = q;
      }
    }
  }
  return dist;
}

/** Расширение на r точек во все восемь сторон. */
function dilate(src, w, h, r) {
  const dist = distanceFrom(src, w, h, r);
  const out = new Uint8Array(w * h);
  for (let p = 0; p < out.length; p++) out[p] = dist[p] >= 0 ? 1 : 0;
  return out;
}

/** Сужение на r точек: что остаётся, если расширить дополнение. */
function erode(src, w, h, r) {
  const inv = new Uint8Array(w * h);
  for (let p = 0; p < inv.length; p++) inv[p] = src[p] ? 0 : 1;
  const grown = dilate(inv, w, h, r);
  const out = new Uint8Array(w * h);
  for (let p = 0; p < out.length; p++) out[p] = grown[p] ? 0 : 1;
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
 * Где ответ заметно отличается от оригинала. Изменением считается новое
 * по яркости или по фактуре: здание на месте травы, тень, убранный объект.
 * Смена оттенка при той же яркости и фактуре не считается: модель
 * перекрашивает и нетронутые места вокруг правки. Общий сдвиг яркости и
 * контраста ответа снимается заранее, пороги берутся по шуму ответа вдали
 * от пометки, одиночные точки отбрасываются.
 */
function changeMap(original, aligned, mask) {
  const W = original.width;
  const H = original.height;
  const k = Math.min(1, FIT_EDGE / Math.max(W, H));
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
  let farCount = 0;
  const YA = new Float32Array(n);
  const YB = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (M[i + 3] >= 128) marked[p] = 1;
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
  const tY = noiseLevel(dY, far, farCount, FIT_MIN_DIFF);
  const tS = noiseLevel(dS, far, farCount, FIT_MIN_TEXTURE);

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
  return { w, h, kx: w / W, ky: h / H, marked, changed };
}

/** Связные части маски по восьми соседям: номер части на каждую точку, -1 вне маски. */
function labelParts(bits, w, h) {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const sizes = [];
  for (let p0 = 0; p0 < n; p0++) {
    if (!bits[p0] || label[p0] >= 0) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    label[p0] = id;
    queue[tail++] = p0;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (bits[q] && label[q] < 0) { label[q] = id; queue[tail++] = q; }
        }
      }
    }
    sizes.push(tail);
  }
  return { label, sizes };
}

/**
 * Связные с частью id точки карты map, не дальше reach от неё и не
 * заходящие в другие части. Зазубрины по краю закрываются (там, где цвет
 * нового объекта совпал со старым фоном), дыры заливаются.
 */
function grownFrom(map, label, id, dist, w, h, reach) {
  const n = w * h;
  const obj = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const open = (q) => map[q] && dist[q] >= 0 && dist[q] <= reach && (label[q] < 0 || label[q] === id);
  for (let p = 0; p < n; p++) if (dist[p] >= 0 && dist[p] <= 1 && open(p)) { obj[p] = 1; queue[tail++] = p; }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const q = yy * w + xx;
        if (!obj[q] && open(q)) { obj[q] = 1; queue[tail++] = q; }
      }
    }
  }
  if (!tail) return { mask: obj, count: 0 };

  // Замыкание: расширение и сужение на r. Плюс точка анализа по краю:
  // размытие и отбор одиночных точек съедают край нового объекта.
  const r = Math.max(2, Math.round(Math.max(w, h) * FIT_CLOSE));
  const closed = erode(dilate(obj, w, h, r), w, h, r);
  for (let p = 0; p < n; p++) closed[p] = closed[p] || obj[p];
  const inside = dilate(closed, w, h, 1);

  // Дыры заливаются: снаружи то, до чего можно дойти от края кадра.
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

  const mask = new Uint8Array(n);
  let count = 0;
  for (let p = 0; p < n; p++) {
    if (outside[p] || dist[p] < 0 || (label[p] >= 0 && label[p] !== id)) continue;
    mask[p] = 1;
    count++;
  }
  return { mask, count };
}

/**
 * Объект части id в двух видах. Тело: только толстые изменения, без
 * тонких линий. Перерисованный бордюр, забор или разметка, которые
 * касаются объекта, иначе тянут его охват через весь кадр, и объект
 * уменьшается сильнее нужного. По телу считаются доля за краем и
 * вписывание. Целиком: тело плюс тонкие детали вплотную к нему (столб,
 * карниз, ограждение на крыше); целиком объект переносится в склейку.
 */
function objectOf(changed, label, id, dist, w, h, reach) {
  const r = Math.max(1, Math.round(Math.max(w, h) * FIT_THIN));
  const thick = dilate(erode(changed, w, h, r), w, h, r);
  for (let p = 0; p < thick.length; p++) thick[p] &= changed[p];
  const body = grownFrom(thick, label, id, dist, w, h, reach);
  if (!body.count) return { body, whole: body };
  const near = dilate(body.mask, w, h, 2 * r + 1);
  for (let p = 0; p < near.length; p++) near[p] &= changed[p] | body.mask[p];
  return { body, whole: grownFrom(near, label, id, dist, w, h, reach) };
}

/** Сдвиг, который кладёт отрезок [b0, b1] внутрь [a0, a1]; длинный отрезок по центру. */
function shiftInto(b0, b1, a0, a1) {
  if (b1 - b0 >= a1 - a0) return (a0 + a1) / 2 - (b0 + b1) / 2;
  if (b0 < a0) return a0 - b0;
  if (b1 > a1) return a1 - b1;
  return 0;
}

/**
 * Наибольшее уменьшение s ≤ 1 и сдвиг, при которых объект ложится в цель
 * (не больше FIT_SLACK точек снаружи). Объект уменьшается вокруг центра
 * своего охвата: x' = c + s·(x − c) + t. Сдвиг ищется между самым коротким,
 * который ставит охват объекта в охват цели, и совмещением центров тяжести,
 * затем уточняется шагами по 4, 2 и 1 точке.
 */
function fitInto(object, target, w, h) {
  let count = 0;
  for (let p = 0; p < object.length; p++) count += object[p];
  if (!count) return null;
  const step = count > 20000 ? Math.ceil(Math.sqrt(count / 20000)) : 1;
  const xs = [];
  const ys = [];
  let ox0 = Infinity, oy0 = Infinity, ox1 = -Infinity, oy1 = -Infinity, gx = 0, gy = 0;
  let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, hx = 0, hy = 0, an = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (target[p]) {
        if (x < ax0) ax0 = x;
        if (x > ax1) ax1 = x;
        if (y < ay0) ay0 = y;
        if (y > ay1) ay1 = y;
        hx += x; hy += y; an++;
      }
      if (!object[p]) continue;
      if (x < ox0) ox0 = x;
      if (x > ox1) ox1 = x;
      if (y < oy0) oy0 = y;
      if (y > oy1) oy1 = y;
      gx += x; gy += y;
      if (x % step === 0 && y % step === 0) { xs.push(x + 0.5); ys.push(y + 0.5); }
    }
  }
  if (!an) return null;
  gx = gx / count + 0.5;
  gy = gy / count + 0.5;
  hx = hx / an + 0.5;
  hy = hy / an + 0.5;
  const cx = (ox0 + ox1 + 1) / 2;
  const cy = (oy0 + oy1 + 1) / 2;

  const outside = (s, tx, ty) => {
    let out = 0;
    for (let j = 0; j < xs.length; j++) {
      const x = Math.floor(cx + s * (xs[j] - cx) + tx);
      const y = Math.floor(cy + s * (ys[j] - cy) + ty);
      if (x < 0 || y < 0 || x >= w || y >= h || !target[y * w + x]) out++;
    }
    return out / xs.length;
  };

  const s0 = Math.min(1, (ax1 - ax0 + 1) / (ox1 - ox0 + 1), (ay1 - ay0 + 1) / (oy1 - oy0 + 1));
  let best = null;
  for (let s = s0; s >= FIT_MIN_SCALE - 1e-9; s *= 0.97) {
    const mx = shiftInto(cx + s * (ox0 - cx), cx + s * (ox1 + 1 - cx), ax0, ax1 + 1);
    const my = shiftInto(cy + s * (oy0 - cy), cy + s * (oy1 + 1 - cy), ay0, ay1 + 1);
    const qx = hx - (cx + s * (gx - cx));
    const qy = hy - (cy + s * (gy - cy));
    let here = null;
    for (let j = 0; j <= 4; j++) {
      const tx = mx + ((qx - mx) * j) / 4;
      const ty = my + ((qy - my) * j) / 4;
      const f = outside(s, tx, ty);
      if (!here || f < here.f) here = { s, tx, ty, f };
    }
    for (let r = 4; r >= 1 && here.f > 0; r >>= 1) {
      for (let moves = 0; moves < 12 && here.f > 0; moves++) {
        let next = null;
        for (const [ddx, ddy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
          const f = outside(s, here.tx + ddx, here.ty + ddy);
          if (f < (next ? next.f : here.f)) next = { s, tx: here.tx + ddx, ty: here.ty + ddy, f };
        }
        if (!next) break;
        here = next;
      }
    }
    if (!best || here.f < best.f) best = here;
    if (here.f <= FIT_SLACK) break;
  }
  if (!best || best.f > FIT_SLACK * 4) return null;
  return { ...best, cx, cy };
}

/**
 * План склейки по области. Для каждой связной части пометки ищется объект,
 * который модель нарисовала в ней и вплотную к ней, и доля объекта за краем
 * части. Если доля заметная, подбирается уменьшение и сдвиг, которые
 * укладывают объект в часть целиком.
 *
 * Найденный объект шире настоящего на размытие анализа и окно фактуры,
 * несколько точек копии по краю. Это поле и служит запасом на растушёвку:
 * шов ложится на землю вокруг объекта, сам объект остаётся чётким.
 *
 * Возвращает { w, h, kx, ky, parts, spill, fits, tooBig }: parts[i] это
 * { area, object, spill, fit }, area и object на копии w × h, fit:
 * { s, ex, ey } в пикселях кадра (x' = s·x + ex) или null.
 */
export function fitPlan(original, aligned, mask) {
  const { w, h, kx, ky, marked, changed } = changeMap(original, aligned, mask);
  const n = w * h;
  const { label, sizes } = labelParts(marked, w, h);
  const long = Math.max(w, h);
  const parts = sizes.map((_, id) => {
    const area = new Uint8Array(n);
    let ax0 = w, ay0 = h, ax1 = -1, ay1 = -1;
    for (let p = 0; p < n; p++) {
      if (label[p] !== id) continue;
      area[p] = 1;
      const x = p % w;
      const y = (p - x) / w;
      if (x < ax0) ax0 = x;
      if (x > ax1) ax1 = x;
      if (y < ay0) ay0 = y;
      if (y > ay1) ay1 = y;
    }
    const reach = Math.max(8, Math.round(Math.min(FIT_REACH * long, Math.max(ax1 - ax0, ay1 - ay0) + 1)));
    const dist = distanceFrom(area, w, h, reach);
    const { body, whole } = objectOf(changed, label, id, dist, w, h, reach);
    const count = body.count;
    let spilled = 0;
    for (let p = 0; p < n; p++) if (body.mask[p] && dist[p] > 1) spilled++;
    const spill = count ? spilled / count : 0;
    let fit = null;
    let tooBig = false;
    if (count >= FIT_MIN_OBJECT * n && spill >= FIT_SPILL) {
      const f = fitInto(body.mask, area, w, h);
      if (f) fit = { s: f.s, ex: (f.cx * (1 - f.s) + f.tx) / kx, ey: (f.cy * (1 - f.s) + f.ty) / ky };
      else tooBig = true;
    }
    return { area, object: whole.mask, count, spill, fit, tooBig };
  });
  const big = parts.filter((p) => p.count >= FIT_MIN_OBJECT * n);
  return {
    w, h, kx, ky, parts,
    spill: big.reduce((m, p) => Math.max(m, p.spill), 0),
    fits: parts.filter((p) => p.fit).length,
    tooBig: parts.some((p) => p.tooBig),
  };
}

/** Маска с копии анализа в кадр W × H, края сглаживаются при увеличении. */
function bitsCanvas(bits, w, h) {
  const c = blank(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let p = 0; p < bits.length; p++) {
    if (!bits[p]) continue;
    img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = img.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Слои заплатки для границ «fit» и «mark». Вписанная часть пометки берёт
 * из ответа только объект, уменьшенный и сдвинутый внутрь части; вокруг
 * него в части остаётся оригинал. Землю вокруг объекта из ответа брать
 * нельзя: после уменьшения она сдвинута против оригинала, и дороги, бордюры
 * и заборы на шве разъезжаются. Остальная пометка берёт ответ как есть.
 * Для «mark» остаётся один слой: вся пометка.
 * busy: пометка вместе с объектами на копии анализа, там тон не оценивается.
 */
export function layersFor(mask, plan, fit) {
  const W = mask.width;
  const H = mask.height;
  const sigma = Math.max(1, featherPx(W, H) / 2);
  const draw = (ctx, small) => ctx.drawImage(small, 0, 0, W, H);
  const fitted = fit ? plan.parts.filter((p) => p.fit) : [];

  const rest = blank(W, H);
  const rctx = rest.getContext('2d');
  rctx.imageSmoothingQuality = 'high';
  rctx.drawImage(mask, 0, 0);
  const layers = [];
  for (const part of fitted) {
    const zone = bitsCanvas(dilate(part.area, plan.w, plan.h, 2), plan.w, plan.h);
    rctx.globalCompositeOperation = 'destination-out';
    draw(rctx, zone);

    const { s, ex, ey } = part.fit;
    const T = [s, 0, 0, s, ex, ey];
    const object = bitsCanvas(part.object, plan.w, plan.h);
    const M = blank(W, H);
    const m = M.getContext('2d');
    m.imageSmoothingQuality = 'high';
    m.setTransform(...T);
    draw(m, object);                 // куда лёг объект
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'destination-in';
    m.drawImage(mask, 0, 0);         // только внутри пометки
    draw(m, zone);                   // и только этой её части
    m.setTransform(...T);
    m.fillStyle = '#fff';
    m.fillRect(0, 0, W, H);          // и там, куда дотянулся уменьшенный ответ
    m.setTransform(1, 0, 0, 1, 0, 0);
    // Шов шире обычного: он идёт по земле вокруг объекта, а она в ответе
    // сдвинута против оригинала.
    layers.push({ alpha: softInside(M, sigma * 2), transform: T });
  }
  layers.unshift({ alpha: softInside(rest, sigma) });

  let busy = mask;
  if (plan.parts.length) {
    const bits = new Uint8Array(plan.w * plan.h);
    for (const part of plan.parts) {
      for (let p = 0; p < bits.length; p++) if (part.area[p] || part.object[p]) bits[p] = 1;
    }
    busy = bitsCanvas(bits, plan.w, plan.h);
  }
  return {
    layers,
    busy,
    fitted: fitted.map((p) => ({ s: p.fit.s })),
  };
}

/**
 * Поправка яркости и контраста ответа, y' = g·y + b, одна на все каналы.
 * Модель часто чуть осветляет кадр, и без поправки вставка видна светлым
 * пятном. Оценка идёт по яркости точек вне области правки, где ответ и
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

/** Копия холста с поправкой тона. */
function toned(source, tone) {
  const c = blank(source.width, source.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const lut = tone.map(([g, b0]) => Uint8ClampedArray.from({ length: 256 }, (_, v) => g * v + b0));
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[0][d[i]];
    d[i + 1] = lut[1][d[i + 1]];
    d[i + 2] = lut[2][d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Растушёвка внутрь области: альфа 2·blur − 1, срезанная по самой области.
 * За краем области альфа ровно ноль, переход ложится внутрь. Край кадра
 * продолжается наружу перед размытием, иначе у края кадра правка бледнела бы.
 */
export function softInside(region, sigma) {
  const w = region.width;
  const h = region.height;
  const m = Math.ceil(sigma * 3);
  const pad = blank(w + 2 * m, h + 2 * m);
  const p = pad.getContext('2d');
  p.drawImage(region, m, m);
  p.drawImage(region, 0, 0, 1, h, 0, m, m, h);
  p.drawImage(region, w - 1, 0, 1, h, w + m, m, m, h);
  p.drawImage(region, 0, 0, w, 1, m, 0, w, m);
  p.drawImage(region, 0, h - 1, w, 1, m, h + m, w, m);
  p.drawImage(region, 0, 0, 1, 1, 0, 0, m, m);
  p.drawImage(region, w - 1, 0, 1, 1, w + m, 0, m, m);
  p.drawImage(region, 0, h - 1, 1, 1, 0, h + m, m, m);
  p.drawImage(region, w - 1, h - 1, 1, 1, w + m, h + m, m, m);

  const soft = blank(w + 2 * m, h + 2 * m);
  const s = soft.getContext('2d', { willReadFrequently: true });
  s.filter = `blur(${sigma}px)`;
  s.drawImage(pad, 0, 0);
  const img = s.getImageData(m, m, w, h);
  const hard = region.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = Math.min(hard[i + 3], Math.max(0, 2 * d[i + 3] - 255));
  }
  const out = blank(w, h);
  out.getContext('2d').putImageData(img, 0, 0);
  return out;
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
 * Заплатка: выровненный ответ с поправкой тона по слоям { alpha, transform }.
 * Слой рисует ответ со своим преобразованием (или как есть) и обрезает его
 * по alpha (null: без обрезки). composed: оригинал с заплаткой.
 */
export function composeLayers({ original, aligned, tone, layers }) {
  const w = original.width;
  const h = original.height;
  const source = tone ? toned(aligned, tone) : aligned;
  const patch = blank(w, h);
  const pctx = patch.getContext('2d');
  let tmp = null;
  for (const L of layers) {
    if (!L.alpha && !L.transform) { pctx.drawImage(source, 0, 0); continue; }
    if (!tmp) tmp = blank(w, h);
    const t = tmp.getContext('2d');
    t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, w, h);
    t.imageSmoothingQuality = 'high';
    if (L.transform) t.setTransform(...L.transform);
    t.drawImage(source, 0, 0);
    t.setTransform(1, 0, 0, 1, 0, 0);
    if (L.alpha) {
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(L.alpha, 0, 0);
    }
    pctx.drawImage(tmp, 0, 0);
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
