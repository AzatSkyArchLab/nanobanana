// Пометки поверх картинки или листа PDF.
//
// Штрихи хранятся в единицах источника (пиксели картинки, пункты PDF)
// и растеризуются по запросу в нужном кадре и разрешении. Поэтому маска
// для фрагмента получается чёткой при любом увеличении, а показ на экране
// обходится одним холстом.
//
// Пиксель принадлежит ровно одному цвету: штрих ложится в свой цвет и
// вычищается из остальных. Иначе поверх старой пометки получалась бы смесь.
//
// Цвета чистые и в фотографиях и чертежах почти не встречаются, чтобы
// модель не путала пометку с содержимым.

export const PALETTE = [
  { key: 'magenta', hex: '#ff00ff', en: 'magenta', ru: 'пурпурный', area: 'пурпурная' },
  { key: 'cyan',    hex: '#00ffff', en: 'cyan',    ru: 'голубой',   area: 'голубая' },
  { key: 'green',   hex: '#00ff00', en: 'green',   ru: 'зелёный',   area: 'зелёная' },
  { key: 'yellow',  hex: '#ffff00', en: 'yellow',  ru: 'жёлтый',    area: 'жёлтая' },
  { key: 'blue',    hex: '#0000ff', en: 'blue',    ru: 'синий',     area: 'синяя' },
];

export const colour = (key) => PALETTE.find((c) => c.key === key);

export function blank(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/**
 * Кадр растеризации: k пикселей на единицу источника, левый верхний угол
 * кадра в точке (x, y) источника, размер w × h пикселей.
 */
export const frameOf = (k, x, y, w, h) => ({ k, x, y, w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) });

/** Контур штриха в кадре f. Заливка и обводка берутся из текущего состояния ctx. */
function trace(ctx, s, f) {
  const px = (x) => (x - f.x) * f.k;
  const py = (y) => (y - f.y) * f.k;
  if (s.kind === 'rect') {
    const [[ax, ay], [bx, by]] = s.points;
    ctx.fillRect(px(Math.min(ax, bx)), py(Math.min(ay, by)), Math.abs(bx - ax) * f.k, Math.abs(by - ay) * f.k);
    return;
  }
  if (s.kind === 'poly') {
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))));
    ctx.closePath();
    ctx.fill();
    return;
  }
  const [x0, y0] = s.points[0];
  if (s.points.length === 1) {
    ctx.beginPath();
    ctx.arc(px(x0), py(y0), s.size * f.k / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.lineWidth = s.size * f.k;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(px(x0), py(y0));
  for (let i = 1; i < s.points.length; i++) ctx.lineTo(px(s.points[i][0]), py(s.points[i][1]));
  ctx.stroke();
}

function hasInk(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
  return false;
}

export class Marks {
  constructor(width, height) {
    this.width = width;     // размер источника в его единицах
    this.height = height;
    this.strokes = [];      // { kind: 'brush' | 'rect' | 'poly', color, erase, size, points: [[x, y], …] }
  }

  push(stroke) { this.strokes.push(stroke); }
  undo() { this.strokes.pop(); }
  clear() { this.strokes = []; }

  /** Кадр всего источника с длинной стороной edge пикселей. */
  whole(edge) {
    const k = edge / Math.max(this.width, this.height);
    return frameOf(k, 0, 0, this.width * k, this.height * k);
  }

  /** Маска одного цвета: белое там, где победил этот цвет. */
  layer(key, f) {
    const c = blank(f.w, f.h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = ctx.strokeStyle = '#fff';
    for (const s of this.strokes) {
      ctx.globalCompositeOperation = s.erase || s.color !== key ? 'destination-out' : 'source-over';
      trace(ctx, s, f);
    }
    return c;
  }

  /** Объединение всех цветов: маска для склейки. */
  union(f) {
    const c = blank(f.w, f.h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = ctx.strokeStyle = '#fff';
    for (const s of this.strokes) {
      ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
      trace(ctx, s, f);
    }
    return c;
  }

  /** Цветные пометки в кадре f, каждая своим цветом с прозрачностью alpha. */
  tint(f, alpha) {
    const out = blank(f.w, f.h);
    const ctx = out.getContext('2d');
    ctx.globalAlpha = alpha;
    for (const c of this.used()) {
      const layer = this.layer(c.key, f);
      const lctx = layer.getContext('2d');
      lctx.globalCompositeOperation = 'source-in';
      lctx.fillStyle = c.hex;
      lctx.fillRect(0, 0, layer.width, layer.height);
      ctx.drawImage(layer, 0, 0);   // слои не пересекаются, прозрачность не накапливается
    }
    return out;
  }

  /** Цвета, которыми действительно что-то закрашено (проверка по уменьшенной копии). */
  used() {
    const present = new Set(this.strokes.filter((s) => !s.erase).map((s) => s.color));
    if (!present.size) return [];
    const f = this.whole(128);
    return PALETTE.filter((c) => present.has(c.key) && hasInk(this.layer(c.key, f)));
  }

  isEmpty() { return this.used().length === 0; }

  /** Охват всех пометок в единицах источника: [x0, y0, x1, y1] или null. */
  bounds() {
    if (!this.strokes.length) return null;
    const f = this.whole(512);
    const c = this.union(f);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] < 8) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    // Пиксель пробы по краю добавлен с запасом: проба грубее штриха.
    return [
      Math.max(0, (x0 - 1) / f.k), Math.max(0, (y0 - 1) / f.k),
      Math.min(this.width, (x1 + 2) / f.k), Math.min(this.height, (y1 + 2) / f.k),
    ];
  }
}

/**
 * Показ на экране: все штрихи непрозрачными цветами на одном холсте, по
 * порядку. Поздний штрих перекрывает ранний, ластик вырезает. Прозрачность
 * пометок задаёт CSS холста.
 */
export function paintAll(ctx, marks, f) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const s of marks.strokes) paintStroke(ctx, s, f);
}

/** Один штрих целиком или, если задан from, только его хвост от точки from. */
export function paintStroke(ctx, s, f, from = 0) {
  ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  ctx.fillStyle = ctx.strokeStyle = s.erase ? '#000' : colour(s.color).hex;
  if (from > 0 && s.kind === 'brush') {
    trace(ctx, { ...s, points: s.points.slice(from - 1) }, f);
  } else {
    trace(ctx, s, f);
  }
}
