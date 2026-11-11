// Рисование по листу: краска, штамп и заливка выделения.
//
// Мазок хранится вектором в единицах источника (пиксели картинки, пункты
// PDF), так же как пометки: путь, диаметр, жёсткость края, непрозрачность,
// у краски цвет, у штампа сдвиг до источника. Растр мазка строится в любом
// кадре: на экране в разрешении показа, при приёме в разрешении заплатки.
// Поэтому принятый мазок на листе PDF так же резок, как сам лист.
//
// Покрытие мазка равно максимуму по отрезкам пути. Отрезок покрывает
// капсулу радиуса r, край капсулы мягкий на ширину (1 − жёсткость)·r.
// С максимумом перекрытие соседних отрезков край не уплотняет,
// непрозрачность ограничивает весь мазок, и мазок строится по частям, пока
// ведут мышь (Surface).
//
// Штамп берёт пиксели из состояния листа на начало мазка: внутри одного
// мазка его собственный след не размножается. Следующий мазок уже видит
// предыдущие.
//
// Выделение лассо ограничивает мазок: покрытие умножается на маску
// выделения со сглаженным краем. Источник штампа выделением не
// ограничивается.
//
// Мазок (op):
//   type: 'paint' | 'stamp' | 'fill'
//   points: [[x, y], …]   путь; у заливки пусто
//   size: диаметр в единицах источника
//   hardness, opacity: 0…1
//   color: [r, g, b]      у краски и заливки
//   dx, dy                у штампа: источник = точка пути + (dx, dy)
//   sel: { polys: [[[x, y], …], …] } или null; у заливки обязательно
//
// Охваты (box) задаются в единицах источника как [x0, y0, x1, y1], области
// пикселей кадра как { x, y, w, h }. Кадр f: { k, x, y, w, h }, см.
// marks.frameOf.

const V = new URL(import.meta.url).search;   // см. комментарий в app.js
const { blank } = await import('./marks.js' + V);

export const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
export const unite = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const moved = (b, dx, dy) => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];

function meet(a, b) {
  const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[0] < r[2] && r[1] < r[3] ? r : null;
}

function unitePx(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Охват выделения или null. */
export function selectionBox(sel) {
  if (!sel?.polys.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of sel.polys) {
    for (const [x, y] of poly) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/**
 * Охват мазка или null. from: охват только отрезков, которые начинаются
 * с точки from − 1 (хвост, дорисованный по ходу мыши).
 */
export function opBox(op, from = 0) {
  if (op.type === 'fill') return selectionBox(op.sel);
  const r = op.size / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = Math.max(0, from - 1); i < op.points.length; i++) {
    const [x, y] = op.points[i];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < x0) return null;
  const box = [x0 - r, y0 - r, x1 + r, y1 + r];
  if (!op.sel) return box;
  const sel = selectionBox(op.sel);
  return sel ? meet(box, sel) : null;
}

/** Пиксели кадра f под охватом box, с запасом в пиксель, или null. */
export function pixelsOf(box, f) {
  if (!box) return null;
  const x0 = Math.max(0, Math.floor((box[0] - f.x) * f.k) - 1);
  const y0 = Math.max(0, Math.floor((box[1] - f.y) * f.k) - 1);
  const x1 = Math.min(f.w, Math.ceil((box[2] - f.x) * f.k) + 1);
  const y1 = Math.min(f.h, Math.ceil((box[3] - f.y) * f.k) + 1);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Покрытие мазка op в пикселях b кадра f, 0…255, максимумом в mask
 * (длина b.w·b.h, строка за строкой). from: первая точка, отрезки до
 * которой ещё не учтены; так мазок дорисовывается по частям.
 */
export function cover(op, f, b, mask, from = 0) {
  const R = Math.max(0.5, (op.size * f.k) / 2);
  const soft = Math.max(1, R * (1 - op.hardness));
  const inner = R - soft;
  const R2 = R * R;
  const pts = op.points;
  const at = (i) => [(pts[i][0] - f.x) * f.k - b.x, (pts[i][1] - f.y) * f.k - b.y];
  const segs = [];
  if (pts.length === 1) {
    if (from === 0) segs.push([at(0), at(0)]);
  } else {
    for (let i = Math.max(1, from); i < pts.length; i++) segs.push([at(i - 1), at(i)]);
  }
  for (const [[ax, ay], [bx, by]] of segs) {
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R));
    const x1 = Math.min(b.w - 1, Math.ceil(Math.max(ax, bx) + R));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R));
    const y1 = Math.min(b.h - 1, Math.ceil(Math.max(ay, by) + R));
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5 - ay;
      const row = y * b.w;
      for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5 - ax;
        let t = len2 > 0 ? (cx * vx + cy * vy) / len2 : 0;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const ex = cx - t * vx;
        const ey = cy - t * vy;
        const d2 = ex * ex + ey * ey;
        if (d2 >= R2) continue;
        let v = 255;
        const d = Math.sqrt(d2);
        if (d > inner) {
          const s = (R - d) / soft;
          v = Math.round(255 * s * s * (3 - 2 * s));
        }
        if (v > mask[row + x]) mask[row + x] = v;
      }
    }
  }
}

/** Маска выделения в пикселях b кадра f: 0…255, край сглажен. */
export function selectionMask(sel, f, b) {
  const c = blank(b.w, b.h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  // Каждый многоугольник отдельно: так выделение равно их объединению,
  // встречный обход одного другого дыры не вырежет.
  for (const poly of sel.polys) {
    ctx.beginPath();
    poly.forEach(([x, y], i) => {
      const px = (x - f.x) * f.k - b.x;
      const py = (y - f.y) * f.k - b.y;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
  }
  const d = ctx.getImageData(0, 0, b.w, b.h).data;
  const m = new Uint8Array(b.w * b.h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3];
  return m;
}

/** Покрытие всего мазка в пикселях b с учётом выделения. */
function coverage(op, f, b) {
  const m = new Uint8Array(b.w * b.h);
  if (op.type === 'fill') m.fill(255);
  else cover(op, f, b, m);
  if (op.sel) {
    const s = selectionMask(op.sel, f, b);
    for (let i = 0; i < m.length; i++) if (m[i]) m[i] = (m[i] * s[i] + 127) / 255;
  }
  return m;
}

/** Сдвиг штампа в пикселях кадра: целый, источник ложится на сетку кадра. */
const offsetOf = (op, f) => [Math.round(op.dx * f.k), Math.round(op.dy * f.k)];

/**
 * Источник штампа для пикселей b: { data, ok }, где ok отмечает известные
 * пиксели. Внутри кадра источник берётся из img, то есть в состоянии до
 * этого мазка. За краем кадра пиксели рисует outside(кадр источника), если
 * он задан; без него они не известны, и мазок их не трогает.
 */
async function stampSource(img, f, op, b, outside) {
  const [ox, oy] = offsetOf(op, f);
  const src = { data: new Uint8ClampedArray(b.w * b.h * 4), ok: new Uint8Array(b.w * b.h) };
  const inside = b.x + ox >= 0 && b.y + oy >= 0 && b.x + ox + b.w <= f.w && b.y + oy + b.h <= f.h;
  if (!inside && outside) {
    const c = await outside({ k: f.k, x: f.x + (b.x + ox) / f.k, y: f.y + (b.y + oy) / f.k, w: b.w, h: b.h });
    src.data.set(c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, b.w, b.h).data);
    src.ok.fill(1);
  }
  copyInside(img, f, b, ox, oy, src);
  return src;
}

/** Часть источника штампа, которая лежит внутри кадра: из img в src. */
function copyInside(img, f, b, ox, oy, src) {
  const sx = b.x + ox;
  const fx0 = Math.max(0, sx);
  const fx1 = Math.min(f.w, sx + b.w);
  if (fx1 <= fx0) return;
  for (let y = 0; y < b.h; y++) {
    const fy = b.y + oy + y;
    if (fy < 0 || fy >= f.h) continue;
    const from = (fy * f.w + fx0) * 4;
    const to = y * b.w + fx0 - sx;
    src.data.set(img.data.subarray(from, from + (fx1 - fx0) * 4), to * 4);
    src.ok.fill(1, to, to + fx1 - fx0);
  }
}

/** Мазок в пиксели b растра img: смесь с цветом или источником по покрытию. */
function blend(img, f, op, b, mask, src, touched) {
  const d = img.data;
  const [r, g, bl] = op.color || [0, 0, 0];
  const o = op.opacity;
  for (let y = 0; y < b.h; y++) {
    const row = y * b.w;
    let c = (b.y + y) * f.w + b.x;
    for (let x = 0; x < b.w; x++, c++) {
      const m = mask[row + x];
      if (!m) continue;
      const a = (o * m) / 255;
      const p = c * 4;
      if (src) {
        const i = row + x;
        if (!src.ok[i]) continue;
        const q = i * 4;
        d[p] += a * (src.data[q] - d[p]);
        d[p + 1] += a * (src.data[q + 1] - d[p + 1]);
        d[p + 2] += a * (src.data[q + 2] - d[p + 2]);
        d[p + 3] += a * (src.data[q + 3] - d[p + 3]);
      } else {
        d[p] += a * (r - d[p]);
        d[p + 1] += a * (g - d[p + 1]);
        d[p + 2] += a * (bl - d[p + 2]);
        d[p + 3] += a * (255 - d[p + 3]);
      }
      if (touched) touched[c] = 1;
    }
  }
}

/**
 * Мазки ops по порядку в холст canvas кадра f (размер холста равен кадру).
 * outside(кадр): растр области за краем кадра в состоянии до мазков
 * кадра; нужен, когда штамп берёт источник за краем. onlyTouched: пиксели,
 * которых не задел ни один мазок, становятся прозрачными (заплатка).
 * Возвращает число мазков, задевших кадр.
 */
export async function paintFrame(canvas, f, ops, { outside = null, onlyTouched = false } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, f.w, f.h);
  const touched = onlyTouched ? new Uint8Array(f.w * f.h) : null;
  let n = 0;
  for (const op of ops) {
    const b = pixelsOf(opBox(op), f);
    if (!b) continue;
    const src = op.type === 'stamp' ? await stampSource(img, f, op, b, outside) : null;
    blend(img, f, op, b, coverage(op, f, b), src, touched);
    n++;
  }
  if (touched) {
    for (let i = 0; i < touched.length; i++) if (!touched[i]) img.data[i * 4 + 3] = 0;
  }
  if (n || touched) ctx.putImageData(img, 0, 0);
  return n;
}

/**
 * То же без растра за краем кадра и без ожидания: для кадров, в которых
 * есть всё, что читают штампы (весь лист или охват из reach).
 */
export function paintNow(canvas, f, ops) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let img = null;
  for (const op of ops) {
    const b = pixelsOf(opBox(op), f);
    if (!b) continue;
    img ??= ctx.getImageData(0, 0, f.w, f.h);
    let src = null;
    if (op.type === 'stamp') {
      src = { data: new Uint8ClampedArray(b.w * b.h * 4), ok: new Uint8Array(b.w * b.h) };
      copyInside(img, f, b, ...offsetOf(op, f), src);
    }
    blend(img, f, op, b, coverage(op, f, b), src, null);
  }
  if (img) ctx.putImageData(img, 0, 0);
}

/**
 * Охват, который нужно нарисовать, чтобы мазки в rect вышли верно: rect
 * плюс источники штампов, которые пишут в него, и так далее назад по
 * порядку мазков.
 */
export function reach(rect, ops) {
  const need = [rect];
  let out = rect;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.type !== 'stamp') continue;
    const d = opBox(op);
    if (!d || !need.some((r) => overlaps(r, d))) continue;
    const s = moved(d, op.dx, op.dy);
    need.push(s);
    out = unite(out, s);
  }
  return out;
}

/**
 * Мазки по группам для заплаток: подряд идущие мазки с общим охватом не
 * длиннее extent. Порядок мазков сохраняется, поэтому группа может читать
 * то, что нарисовали предыдущие.
 */
export function groupOps(ops, extent) {
  const groups = [];
  let g = null;
  for (const op of ops) {
    const b = opBox(op);
    if (!b) continue;
    if (g) {
      const u = unite(g.box, b);
      if (Math.max(u[2] - u[0], u[3] - u[1]) <= extent) {
        g.ops.push(op);
        g.box = u;
        continue;
      }
    }
    g = { ops: [op], box: b };
    groups.push(g);
  }
  return groups;
}

/**
 * Холст на экране, по которому мазок рисуется по ходу мыши. Держит пиксели
 * на начало мазка и маску покрытия; новый отрезок пересчитывает только
 * пиксели под собой. fallback: поверхность всего листа, из неё штамп берёт
 * источник за краем этого кадра.
 */
export class Surface {
  constructor(canvas, f, fallback = null) {
    this.f = f;
    this.fallback = fallback;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.img = this.ctx.getImageData(0, 0, f.w, f.h);
    this.before = null;
    this.mask = null;
    this.selFor = null;
    this.selMask = null;
    this.op = null;
  }

  begin(op) {
    const { f } = this;
    const n = f.w * f.h;
    this.before ??= new Uint8ClampedArray(n * 4);
    this.before.set(this.img.data);
    this.mask ??= new Uint8Array(n);
    if (op.sel && op.sel !== this.selFor) {
      this.selMask = selectionMask(op.sel, f, { x: 0, y: 0, w: f.w, h: f.h });
      this.selFor = op.sel;
    }
    this.op = op;
    this.off = op.type === 'stamp' ? offsetOf(op, f) : null;
    this.dirty = null;
    this.extend(0);
  }

  /** Отрезки мазка от точки from: покрытие и пиксели под ними. */
  extend(from) {
    const { f, op } = this;
    const b = pixelsOf(opBox(op, from), f);
    if (!b) return;
    if (op.type === 'fill') {
      for (let y = b.y; y < b.y + b.h; y++) this.mask.fill(255, y * f.w + b.x, y * f.w + b.x + b.w);
    } else {
      cover(op, f, { x: 0, y: 0, w: f.w, h: f.h }, this.mask, from);
    }
    this.redraw(b);
    this.dirty = this.dirty ? unitePx(this.dirty, b) : b;
  }

  redraw(b) {
    const { f, op, before, mask, off, fallback: fb } = this;
    const sel = op.sel ? this.selMask : null;
    const d = this.img.data;
    const W = f.w;
    const o = op.opacity;
    const [r, g, bl] = op.color || [0, 0, 0];
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = y * W + x;
        let m = mask[i];
        if (!m) continue;
        if (sel) {
          m = (m * sel[i]) / 255;
          if (!m) continue;
        }
        const a = (o * m) / 255;
        let s0 = r, s1 = g, s2 = bl, s3 = 255;
        if (off) {
          const sx = x + off[0];
          const sy = y + off[1];
          let src = before;
          let q;
          if (sx >= 0 && sy >= 0 && sx < W && sy < f.h) {
            q = (sy * W + sx) * 4;
          } else if (fb) {
            // Источник за краем кадра: ближайший пиксель растра всего листа.
            const ux = Math.floor((f.x + (sx + 0.5) / f.k - fb.f.x) * fb.f.k);
            const uy = Math.floor((f.y + (sy + 0.5) / f.k - fb.f.y) * fb.f.k);
            if (ux < 0 || uy < 0 || ux >= fb.f.w || uy >= fb.f.h) continue;
            src = fb.before;
            q = (uy * fb.f.w + ux) * 4;
          } else {
            continue;
          }
          s0 = src[q];
          s1 = src[q + 1];
          s2 = src[q + 2];
          s3 = src[q + 3];
        }
        const p = i * 4;
        d[p] = before[p] + a * (s0 - before[p]);
        d[p + 1] = before[p + 1] + a * (s1 - before[p + 1]);
        d[p + 2] = before[p + 2] + a * (s2 - before[p + 2]);
        d[p + 3] = before[p + 3] + a * (s3 - before[p + 3]);
      }
    }
    this.ctx.putImageData(this.img, 0, 0, b.x, b.y, b.w, b.h);
  }

  /** Конец мазка: маска чистится там, где он прошёл. */
  end() {
    const b = this.dirty;
    if (b) for (let y = b.y; y < b.y + b.h; y++) this.mask.fill(0, y * this.f.w + b.x, y * this.f.w + b.x + b.w);
    this.op = null;
    this.dirty = null;
  }
}
