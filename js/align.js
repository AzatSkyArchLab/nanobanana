// Совмещение результата с оригиналом.
//
// Модель не возвращает попиксельно совпадающий кадр: она перерисовывает
// картинку заново, композиция уезжает на проценты, а пропорции выходного
// кадра у модели свои (3:4 у Gemini приходит как 864 × 1184). Если вклеивать
// такой результат в маску как есть, на границе получается задвоение: контур
// из нового кадра ложится рядом с контуром из старого.
//
// Поэтому перед склейкой подбирается преобразование результата: отдельный
// масштаб по x и по y и сдвиг. Сравнивается только то, что ВНЕ маски: внутри
// картинка и должна отличаться, это и есть правка.
//
// Порядок поиска:
//   1. грубый перебор масштабов и целых сдвигов на 64 px даёт стартовые точки;
//   2. каждый старт проходит метод Левенберга-Марквардта на 128, 256 и
//      1024 px, побеждает старт с меньшей невязкой на последней ступени.
//      Если последняя ступень заметно грубее кадра, добавляется ступень
//      в его родном разрешении, но не крупнее 2048 px. На грубой ступени
//      минимум невязки смещён: на проверке ошибка в углу кадра 437 px
//      (последняя ступень 256) доходила до 5 px, кадра 1384 px до 6 px,
//      со ступенью в родном разрешении около 0.6 px и меньше.
// Масштаб и сдвиг по одной оси связаны: покоординатный спуск застревает
// в долине между ними, поэтому шаг ищется сразу по всем параметрам.
//
// Невязка считается по точкам вне маски с заметным перепадом яркости, то
// есть по контурам: на однородном поле сдвиг не измерить. Обе картинки на
// каждой ступени размываются: линия тоньше пикселя даёт провал невязки
// шириной в пиксель, после размытия провал шире ошибки предыдущей ступени.
// Яркость и контраст результата подбираются вместе с геометрией: модель
// может перекрасить кадр, и без этого перекраска тянула бы совмещение.
//
// Рядом с маской сравнивать опасно: модель часто рисует объект крупнее
// области, и его край за маской перекрывает то, по чему идёт совмещение.
// Поэтому полоса вокруг маски шириной SPILL от её размера тоже не
// сравнивается, пока за ней остаётся достаточно точек.

const COARSE = 64;
const LEVELS = [
  { edge: 128, blur: 2, samples: 3000 },
  { edge: 256, blur: 2, samples: 6000 },
  { edge: 1024, blur: 2.5, samples: 12000 },
];
const SCALES = [0.94, 0.96, 0.98, 1, 1.02, 1.04, 1.06];
const HUBER = 12;   // порог робастной невязки, уровни серого
const SPILL = 0.35; // полоса вокруг маски, куда модель дорисовывает объект, в долях длинной стороны маски
const NATIVE_MAX = 2048; // последняя ступень в родном разрешении кадра, но не крупнее

function gray(source, w, h, blur = 0) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  // Поле за краем картинки при размытии должно оставаться белым:
  // прозрачный край кадра дал бы ложный перепад.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  if (blur) ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let p = 0, i = 0; p < g.length; p++, i += 4) {
    g[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }
  return { g, w, h };
}

/**
 * Единицы там, где сравнивать можно: дальше band пикселей от маски.
 * Хвост гауссова размытия тянется на три сигмы, поэтому сигма берётся
 * вдвое меньше полосы, а порог чуть выше нуля: полоса выходит той ширины,
 * какую просили, и не съедает поле при большой маске.
 */
function freeMap(maskCanvas, w, h, band) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.filter = `blur(${band / 2}px)`;
  ctx.drawImage(maskCanvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  let free = 0;
  for (let p = 0, i = 3; p < out.length; p++, i += 4) {
    out[p] = d[i] < 8 ? 1 : 0;
    free += out[p];
  }
  return { out, free };
}

/* ── Ступень 1: перебор на 64 px ───────────────────────── */

function costShift(A, B, wgt, dx, dy, minPixels) {
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

/** Лучшая точка перебора в центрированных параметрах [sx, sy, dx, dy] (сдвиг в долях кадра). */
function coarse(original, result, maskCanvas, W, H, spill) {
  const k = COARSE / Math.max(W, H);
  const w = Math.max(8, Math.round(W * k));
  const h = Math.max(8, Math.round(H * k));
  const A = gray(original, w, h);
  let map = freeMap(maskCanvas, w, h, Math.max(1, Math.round(spill * k)));
  if (map.free < w * h * 0.1) map = freeMap(maskCanvas, w, h, 1);
  const { out: wgt, free } = map;
  const minPixels = Math.max(16, free * 0.35);
  const range = Math.max(4, Math.round(Math.max(w, h) * 0.12));

  let best = { cost: Infinity };
  for (const sx of SCALES) {
    for (const sy of SCALES) {
      const B = gray(result, Math.round(w * sx), Math.round(h * sy));
      const cx = Math.round((w - B.w) / 2);
      const cy = Math.round((h - B.h) / 2);
      for (let dy = cy - range; dy <= cy + range; dy++) {
        for (let dx = cx - range; dx <= cx + range; dx++) {
          const c = costShift(A, B, wgt, dx, dy, minPixels);
          // Масштаб берётся фактический, после округления размера.
          if (c < best.cost) best = { cost: c, sx: B.w / w, sy: B.h / h, dx, dy };
        }
      }
    }
  }
  if (!Number.isFinite(best.cost)) return null;
  // x = c + s·(u − c) + d, d в долях кадра.
  return [best.sx, best.sy, (best.dx - (w / 2) * (1 - best.sx)) / w, (best.dy - (h / 2) * (1 - best.sy)) / h];
}

/* ── Ступени 2–4: Левенберг–Марквардт ──────────────────── */

function bilinear(G, w, h, u, v) {
  if (u < 0 || v < 0 || u > w - 1 || v > h - 1) return NaN;
  const x0 = u | 0;
  const y0 = v | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = u - x0;
  const fy = v - y0;
  const a = G[y0 * w + x0];
  const b = G[y0 * w + x1];
  const c = G[y1 * w + x0];
  const d = G[y1 * w + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Точки вне маски с самым сильным перепадом яркости, плюс доля остальных. */
function samples(A, wgt, count) {
  const { g, w, h } = A;
  const grad = new Uint16Array(w * h);
  const hist = new Uint32Array(1024);
  let candidates = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const q = y * w + x;
      if (!wgt[q]) continue;
      const v = Math.min(1023, Math.round(Math.abs(g[q + 1] - g[q - 1]) + Math.abs(g[q + w] - g[q - w])));
      grad[q] = v + 1;   // 0 означает «не кандидат»
      hist[v]++;
      candidates++;
    }
  }
  if (candidates < 64) return null;

  const strong = Math.round(count * 0.8);
  let threshold = 1023;
  for (let acc = 0; threshold > 2; threshold--) {
    acc += hist[threshold];
    if (acc >= strong) break;
  }
  const picked = [];
  const rest = [];
  for (let q = 0; q < grad.length; q++) {
    if (!grad[q]) continue;
    if (grad[q] - 1 >= threshold) picked.push(q);
    else rest.push(q);
  }
  const out = [];
  const stepA = Math.max(1, picked.length / strong);
  for (let i = 0; i < picked.length && out.length < strong; i += stepA) out.push(picked[i | 0]);
  const stepB = Math.max(1, rest.length / Math.max(1, count - out.length));
  for (let i = 0; i < rest.length && out.length < count; i += stepB) out.push(rest[i | 0]);
  return Int32Array.from(out);
}

function level(original, result, maskCanvas, W, H, { edge, blur, samples: count }, spill) {
  const k = Math.min(1, edge / Math.max(W, H));
  const w = Math.max(8, Math.round(W * k));
  const h = Math.max(8, Math.round(H * k));
  const A = gray(original, w, h, blur);
  const B = gray(result, w, h, blur);
  // Вне маски, вне полосы, куда модель дорисовывает объект, и вне полосы,
  // куда размытие растаскивает правку. Если за широкой полосой точек мало,
  // берётся узкая; если маска закрывает почти весь кадр, ещё уже.
  const band = Math.max(1, Math.round(Math.max(w, h) * 0.006)) + Math.ceil(blur * 2);
  let idx = samples(A, freeMap(maskCanvas, w, h, band + Math.round(spill * k)).out, count);
  if (!idx || idx.length < count * 0.3) idx = samples(A, freeMap(maskCanvas, w, h, band).out, count);
  if (!idx) idx = samples(A, freeMap(maskCanvas, w, h, Math.max(1, Math.round(band / 3))).out, count);
  return { A, B, idx };
}

/** Длинная сторона охвата маски в пикселях кадра. */
function maskLong(maskCanvas, W, H) {
  const k = Math.min(1, 256 / Math.max(W, H));
  const w = Math.max(8, Math.round(W * k));
  const h = Math.max(8, Math.round(H * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(maskCanvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] < 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? 0 : (Math.max(x1 - x0, y1 - y0) + 1) / k;
}

/**
 * p = [sx, sy, dx, dy, gain, bias]. Точка A(x) сравнивается с
 * gain·B(u) + bias, где u = c + (x − c − dx·w) / sx (то же по y).
 * Возвращает среднюю робастную невязку или Infinity, если больше
 * 40 % точек ушло за край результата.
 */
function robustCost(L, p) {
  const { A, B, idx } = L;
  const cx = A.w / 2;
  const cy = A.h / 2;
  const ox = p[2] * A.w;
  const oy = p[3] * A.h;
  let sum = 0;
  let n = 0;
  for (let j = 0; j < idx.length; j++) {
    const q = idx[j];
    const x = q % A.w;
    const y = (q - x) / A.w;
    const b = bilinear(B.g, B.w, B.h, cx + (x - cx - ox) / p[0], cy + (y - cy - oy) / p[1]);
    if (b !== b) continue;
    const r = Math.abs(p[4] * b + p[5] - A.g[q]);
    sum += r <= HUBER ? r * r / 2 : HUBER * (r - HUBER / 2);
    n++;
  }
  return n < idx.length * 0.6 ? Infinity : sum / n;
}

/** Решение 6 × 6 методом Гаусса с выбором ведущего элемента. */
function solve(M, rhs) {
  const n = rhs.length;
  const a = Array.from({ length: n }, (_, i) => [...M.slice(i * n, i * n + n), rhs[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-12) return null;
    [a[c], a[piv]] = [a[piv], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

function lm(L, start, iterations = 15) {
  const { A, B, idx } = L;
  const cx = A.w / 2;
  const cy = A.h / 2;
  let p = start.length === 6 ? start.slice() : [...start, 1, 0];
  let cost = robustCost(L, p);
  if (!Number.isFinite(cost)) return { p, cost };
  let lambda = 1e-3;

  for (let it = 0; it < iterations; it++) {
    const H = new Float64Array(36);
    const g = new Float64Array(6);
    const J = new Float64Array(6);
    const ox = p[2] * A.w;
    const oy = p[3] * A.h;
    for (let j = 0; j < idx.length; j++) {
      const q = idx[j];
      const x = q % A.w;
      const y = (q - x) / A.w;
      const u = cx + (x - cx - ox) / p[0];
      const v = cy + (y - cy - oy) / p[1];
      const b = bilinear(B.g, B.w, B.h, u, v);
      if (b !== b) continue;
      const bu = (bilinear(B.g, B.w, B.h, Math.min(B.w - 1, u + 1), v) - bilinear(B.g, B.w, B.h, Math.max(0, u - 1), v)) / 2;
      const bv = (bilinear(B.g, B.w, B.h, u, Math.min(B.h - 1, v + 1)) - bilinear(B.g, B.w, B.h, u, Math.max(0, v - 1))) / 2;
      if (bu !== bu || bv !== bv) continue;
      const r = p[4] * b + p[5] - A.g[q];
      const wgt = Math.abs(r) <= HUBER ? 1 : HUBER / Math.abs(r);
      J[0] = p[4] * bu * (-(u - cx) / p[0]);
      J[1] = p[4] * bv * (-(v - cy) / p[1]);
      J[2] = p[4] * bu * (-A.w / p[0]);
      J[3] = p[4] * bv * (-A.h / p[1]);
      J[4] = b;
      J[5] = 1;
      for (let a = 0; a < 6; a++) {
        g[a] += wgt * J[a] * r;
        for (let c = a; c < 6; c++) H[a * 6 + c] += wgt * J[a] * J[c];
      }
    }
    for (let a = 0; a < 6; a++) for (let c = 0; c < a; c++) H[a * 6 + c] = H[c * 6 + a];

    let improved = false;
    for (let attempt = 0; attempt < 6 && !improved; attempt++) {
      const M = Float64Array.from(H);
      for (let a = 0; a < 6; a++) M[a * 6 + a] += lambda * (H[a * 6 + a] || 1e-9);
      const step = solve(M, Array.from(g, (v) => -v));
      if (!step) { lambda *= 10; continue; }
      const next = p.map((v, i) => v + step[i]);
      // Шаг за пределы правдоподобного не принимаем: такие пропорции
      // означают, что совмещение сорвалось.
      if (next[0] < 0.8 || next[0] > 1.25 || next[1] < 0.8 || next[1] > 1.25 || next[4] < 0.3 || next[4] > 3) {
        lambda *= 10;
        continue;
      }
      const c = robustCost(L, next);
      if (c < cost) {
        // На сколько пикселей ступени сдвинулся край кадра.
        const moved = Math.abs(step[2] * A.w) + Math.abs(step[3] * A.h) + (Math.abs(step[0]) * A.w + Math.abs(step[1]) * A.h) / 2;
        p = next;
        cost = c;
        lambda = Math.max(1e-7, lambda / 3);
        improved = true;
        if (moved < 0.01) return { p, cost };
      } else {
        lambda *= 5;
      }
    }
    if (!improved) break;
  }
  return { p, cost };
}

/**
 * Возвращает преобразование результата под оригинал: рисовать его размером
 * (W·sx, H·sy) со смещением (tx, ty). gain показывает, во сколько раз
 * уменьшилась невязка против «натянуть как есть».
 */
export function estimateAlignment(original, result, maskCanvas, W, H) {
  const identity = { sx: 1, sy: 1, tx: 0, ty: 0, scale: 1, residual: NaN, gain: 1 };
  const spill = SPILL * maskLong(maskCanvas, W, H);
  const long = Math.max(W, H);
  const plan = LEVELS.filter((l, i) => i === 0 || l.edge <= long * 1.5);
  const finest = Math.min(long, NATIVE_MAX);
  if (plan[plan.length - 1].edge < finest * 0.9) plan.push({ edge: finest, blur: 1.5, samples: 12000 });
  const steps = plan
    .map((l) => level(original, result, maskCanvas, W, H, l, spill))
    .filter((L) => L.idx);
  if (!steps.length) return identity;   // вне маски сравнивать нечего
  const last = steps[steps.length - 1];

  // Старты: как есть и лучшая точка перебора. Каждый проходит всю пирамиду,
  // а сравниваются они на самой подробной ступени: на регулярной сетке
  // осей грубая ступень может предпочесть соседний период.
  const starts = [[1, 1, 0, 0]];
  const c = coarse(original, result, maskCanvas, W, H, spill);
  if (c) starts.push(c);
  let best = null;
  for (const s of starts) {
    let p = s;
    for (const L of steps) {
      const r = lm(L, p);
      if (Number.isFinite(r.cost)) p = r.p;
    }
    const cost = robustCost(last, p);
    if (!best || cost < best.cost) best = { p, cost };
  }
  const p = best.p.length === 6 ? best.p : [...best.p, 1, 0];

  // Итог проверяется против «как есть» с той же поправкой яркости:
  // сравнивается только геометрия.
  const fitted = robustCost(last, p);
  const asIs = robustCost(last, [1, 1, 0, 0, p[4], p[5]]);
  if (!(fitted < asIs)) return { ...identity, residual: asIs };

  const [sx, sy, dx, dy] = p;
  return {
    sx,
    sy,
    scale: (sx + sy) / 2,
    // x = W/2 + sx·(u − W/2) + dx·W  ⇒  левый край результата на W/2·(1 − sx) + dx·W
    tx: (W / 2) * (1 - sx) + dx * W,
    ty: (H / 2) * (1 - sy) + dy * H,
    residual: fitted,
    gain: fitted > 0 ? asIs / fitted : 1,
  };
}
