// Редактор правок по пометкам. Источник: картинка или лист PDF.
//
// Порядок работы: закрасить, что исправить; для каждой области написать,
// что там должно быть, и при желании приложить референс; отправить в модель;
// сравнить и принять результат. Для PDF принятая правка ложится заплаткой
// на лист, документ с заменёнными листами сохраняется отдельной кнопкой.
//
// Для PDF в модель по умолчанию уходит фрагмент вокруг пометок: лист
// векторный, поэтому фрагмент рисуется в полном разрешении модели и мелкие
// детали чертежа сохраняются. Кадр подгоняется под
// пропорции, которые принимает модель; поле за краем листа дополняется белым.

const V = new URL(import.meta.url).search;   // см. комментарий в app.js
const [marksLib, patchLib, alignLib, promptLib, pdfLib, images, db] = await Promise.all([
  import('./marks.js' + V),
  import('./patch.js' + V),
  import('./align.js' + V),
  import('./prompt.js' + V),
  import('./pdfdoc.js' + V),
  import('./images.js' + V),
  import('./db.js' + V),
]);
const { PALETTE, Marks, colour, blank, frameOf, paintAll, paintStroke } = marksLib;
const {
  BOUNDARIES, place, changeInside, growMask, toneOf, softEdge, softFrame, composeWith, opaqueBox, cut, toPng,
} = patchLib;
const { estimateAlignment } = alignLib;
const { buildEditPrompt, describe } = promptLib;
const { toReference, blobToDataUrl, base64ToBlob, rasterize, isImage, download } = images;

const LS_BOUNDARY = 'nb.boundary';

const SHEET_EDGE = 2048;    // экранный размер листа и слой пометок по длинной стороне
const BASE_EDGE = 3072;     // растр листа PDF для показа
const SEND_EDGE = 2048;     // кадр, который уходит в модель
const COMPOSE_MAX = 4096;   // склейка фрагмента PDF не крупнее
const IMAGE_EDGE = 4096;    // картинку крупнее ужимаем при открытии
const THUMB = 132;          // ширина миниатюры листа, CSS px
const MARK_ALPHA = 0.45;    // заливка пометок в копии для модели
const QUIET_CHANGE = 4;     // средняя разница внутри маски ниже этого: модель ничего не сделала
const CONTEXT = 0.6;        // поле вокруг пометок в долях их размера
const MIN_CONTEXT = 0.15;   // фрагмент не меньше этой доли длинной стороны листа
const MAX_PX_PER_PT = 8;    // фрагмент PDF не увеличиваем сильнее ~576 dpi
const BASE_CACHE = 4;       // сколько растров листов держать в памяти

let app = null;   // связь с остальным приложением, см. init
let ui = null;

const S = {
  src: null,        // { kind: 'image', name, image } | { kind: 'pdf', name, doc, bytes, meta, patches }
  pages: [],
  page: 0,
  visited: [],
  tool: 'brush',
  color: PALETTE[0].key,
  size: 48,         // пиксели слоя пометок
  frame: 'whole',
  boundary: 'grow', // граница склейки, см. patch.js
  view: { z: 1, x: 0, y: 0, fit: 1 },
  busy: null,       // AbortController текущего запроса
  pending: null,    // результат, ждущий решения: { base, view, record }
  compare: false,
  accepted: null,   // запись истории последней принятой правки картинки
  draw: null,
  pan: null,
  space: false,
  loading: false,
  refTarget: null,
  detail: { seq: 0, timer: 0, ctrl: null },
  thumbs: null,
};

const cards = new Map();   // цвет -> карточка области текущего листа

const cur = () => S.pages[S.page];
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const rid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function pageState(w, h) {
  return {
    w, h, k: SHEET_EDGE / Math.max(w, h),
    marks: new Marks(w, h), regions: new Map(), general: '',
    base: null, baseK: 1, baseToken: 0,
  };
}

function region(P, key) {
  if (!P.regions.has(key)) P.regions.set(key, { text: '', refs: [] });
  return P.regions.get(key);
}

const hasContent = (r) => !!r && (r.text.trim() !== '' || r.refs.length > 0);
const sheetFrame = (P) => frameOf(P.k, 0, 0, P.w * P.k, P.h * P.k);
const marksCtx = () => ui.marks.getContext('2d');
const patchesOf = (i) => (S.src?.kind === 'pdf' ? S.src.patches.filter((p) => p.page === i) : []);

function status(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`;
}

/* ── Подключение ───────────────────────────────────────── */

/**
 * context: api, modelSelect, resolutionSelect, currentModel, maxRefs,
 * aspectValues, resolution, setModel, setResolution, estimate, money,
 * shortName, busyText, plural, saveRecord, refreshCredits, openViewer,
 * onSheetsChanged.
 */
export function init(context) {
  app = context;
  const $ = (id) => document.getElementById(id);
  ui = {
    dialog: $('editor'), pages: $('ed-pages'), stage: $('ed-stage'), sheet: $('ed-sheet'),
    base: $('ed-base'), detail: $('ed-detail'), preview: $('ed-preview'), marks: $('ed-marks'),
    rect: $('ed-rect'), cursor: $('ed-cursor'), loading: $('ed-loading'),
    tools: $('ed-tools'), colors: $('ed-colors'), size: $('ed-size'), sizeVal: $('ed-size-val'),
    undo: $('ed-undo'), clear: $('ed-clear'),
    zoomIn: $('ed-zoom-in'), zoomOut: $('ed-zoom-out'), zoomVal: $('ed-zoom-val'),
    title: $('ed-title'), sub: $('ed-sub'), close: $('ed-close'),
    model: $('ed-model'), resolution: $('ed-resolution'),
    regions: $('ed-regions'), regionsHint: $('ed-regions-hint'), general: $('ed-general'),
    frame: $('ed-frame'), frameHint: $('ed-frame-hint'),
    boundary: $('ed-boundary'), boundaryHint: $('ed-boundary-hint'), count: $('ed-count'),
    run: $('ed-run'), stop: $('ed-stop'),
    result: $('ed-result'), accept: $('ed-accept'), compare: $('ed-compare'), again: $('ed-again'), reject: $('ed-reject'),
    status: $('ed-status'), doc: $('ed-doc'), docInfo: $('ed-doc-info'), save: $('ed-save'), revert: $('ed-revert'),
    refInput: $('ed-ref-input'),
  };
  buildSwatches();
  bindStage();
  bindPanel();
  setSize(S.size);
  setTool('brush');
  let saved = null;
  try { saved = localStorage.getItem(LS_BOUNDARY); } catch { /* хранилище недоступно */ }
  setBoundary(BOUNDARIES.includes(saved) ? saved : 'grow', false);
}

export const isOpen = () => !!ui?.dialog.open;

/** Список моделей и разрешений повторяет основную панель. */
export function syncModels() {
  if (!ui) return;
  ui.model.replaceChildren(...Array.from(app.modelSelect.children, (n) => n.cloneNode(true)));
  ui.model.value = app.modelSelect.value;
  ui.resolution.replaceChildren(...Array.from(app.resolutionSelect.options, (o) => o.cloneNode(true)));
  ui.resolution.value = app.resolutionSelect.value;
  ui.resolution.disabled = app.resolutionSelect.disabled;
  updateCount();
}

/* ── Открытие ──────────────────────────────────────────── */

function reset() {
  cancelDetail();
  S.thumbs?.disconnect();
  S.thumbs = null;
  S.src = null;
  S.pages = [];
  S.page = 0;
  S.visited = [];
  S.pending?.base.result.close?.();
  S.pending = null;
  S.compare = false;
  S.accepted = null;
  S.draw = null;
  S.pan = null;
  cards.clear();
  ui.regions.replaceChildren();
  ui.pages.replaceChildren();
  ui.pages.hidden = true;
  ui.doc.hidden = true;
  ui.preview.hidden = true;
  ui.detail.hidden = true;
  ui.marks.hidden = false;
  ui.result.hidden = true;
  ui.run.hidden = false;
  ui.general.value = '';
  ui.title.textContent = 'Правка';
  ui.sub.textContent = '';
  ui.count.textContent = '';
  status('');
}

function show() {
  if (!ui.dialog.open) ui.dialog.showModal();
  syncModels();
}

function setLoading(on, text = 'Загружаю…') {
  S.loading = on;
  ui.loading.textContent = text;
  ui.loading.hidden = !on;
}

/** Картинка из истории или референсов. */
export async function openImage(blob, name = 'картинка') {
  reset();
  show();
  setLoading(true);
  try {
    const raster = await rasterize(blob, IMAGE_EDGE);
    const bmp = await createImageBitmap(raster);
    const k = Math.min(1, IMAGE_EDGE / Math.max(bmp.width, bmp.height));
    const image = blank(bmp.width * k, bmp.height * k);
    const ctx = image.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, image.width, image.height);
    bmp.close?.();
    S.src = { kind: 'image', name, image };
    S.pages = [pageState(image.width, image.height)];
    setFrame('whole');
    await showPage(0);
  } catch (e) {
    status(e.message || 'Картинка не открылась.', 'error');
  } finally {
    setLoading(false);
  }
}

/** Новый PDF с диска: сохраняется в браузере и открывается. */
export async function openPdfFile(file) {
  reset();
  show();
  setLoading(true, 'Читаю PDF…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfLib.open(bytes);
    const meta = await db.sheets.create({
      name: file.name || 'документ.pdf',
      bytes: new Blob([bytes], { type: 'application/pdf' }),
      pages: doc.count,
    });
    app.onSheetsChanged();
    await openSheet(meta.id, { doc, bytes });
  } catch (e) {
    setLoading(false);
    status(e.message || 'PDF не открылся.', 'error');
  }
}

/** PDF, уже сохранённый в браузере, вместе с принятыми правками. */
export async function openSheet(id, preloaded = null) {
  if (!preloaded) {
    reset();
    show();
  }
  setLoading(true, 'Открываю PDF…');
  try {
    const saved = await db.sheets.load(id);
    if (!saved) throw new Error('Документ не найден в этом браузере.');
    const bytes = preloaded?.bytes || new Uint8Array(await saved.bytes.arrayBuffer());
    const doc = preloaded?.doc || await pdfLib.open(bytes);
    const sizes = await Promise.all(Array.from({ length: doc.count }, (_, i) => doc.size(i)));
    S.src = { kind: 'pdf', name: saved.doc.name, doc, bytes, meta: saved.doc, patches: saved.patches };
    S.pages = sizes.map(({ width, height }) => pageState(width, height));
    setFrame('around');
    buildStrip();
    renderDocInfo();
    await showPage(Math.min(saved.doc.lastPage || 0, doc.count - 1));
  } catch (e) {
    status(e.message || 'PDF не открылся.', 'error');
  } finally {
    setLoading(false);
  }
}

/* ── Лист на экране ────────────────────────────────────── */

async function ensureBase(i) {
  const P = S.pages[i];
  if (!P.base) {
    if (S.src.kind === 'image') {
      P.base = S.src.image;
    } else {
      // Пока лист рисуется, набор заплаток может смениться (откат правки).
      // Устаревший растр отбрасывается по номеру отрисовки.
      const token = ++P.baseToken;
      const k = BASE_EDGE / Math.max(P.w, P.h);
      const canvas = await S.src.doc.render(i, frameOf(k, 0, 0, P.w * k, P.h * k), patchesOf(i));
      if (token !== P.baseToken) return P.base;
      P.base = canvas;
      P.baseK = k;
    }
  }
  // Растры дальних листов отпускаем: у большого альбома иначе кончится память.
  S.visited = [i, ...S.visited.filter((v) => v !== i)];
  for (const old of S.visited.splice(BASE_CACHE)) {
    if (S.src.kind === 'pdf') S.pages[old].base = null;
  }
  return P.base;
}

function drawBase(P) {
  ui.base.width = P.base.width;
  ui.base.height = P.base.height;
  ui.base.getContext('2d').drawImage(P.base, 0, 0);
}

async function showPage(i) {
  cancelDetail();
  clearPending();
  S.page = i;
  const P = cur();
  const sw = Math.round(P.w * P.k);
  const sh = Math.round(P.h * P.k);
  ui.sheet.style.width = `${sw}px`;
  ui.sheet.style.height = `${sh}px`;
  ui.marks.width = sw;
  ui.marks.height = sh;
  ui.detail.hidden = true;
  setLoading(true, S.src.kind === 'pdf' ? `Рисую лист ${i + 1}…` : 'Загружаю…');
  try {
    await ensureBase(i);
  } finally {
    setLoading(false);
  }
  // Пока рисовали, переключились дальше или растр устарел и рисуется заново.
  if (S.page !== i || !S.src || !P.base) return;
  drawBase(P);
  paintAll(marksCtx(), P.marks, sheetFrame(P));
  ui.general.value = P.general;
  fit();
  renderTitle();
  syncRegions();
  updateCount();
  markStrip();
  ui.pages.children[i]?.scrollIntoView({ block: 'nearest' });
  renderDocInfo();
  ui.stage.focus({ preventScroll: true });
  if (S.src.kind === 'pdf' && S.src.meta.lastPage !== i) {
    S.src.meta.lastPage = i;
    db.sheets.update(S.src.meta).catch(() => {});
  }
}

function renderTitle() {
  const P = cur();
  if (S.src.kind === 'pdf') {
    const mm = (pt) => Math.round(pt * 25.4 / 72);
    ui.title.textContent = S.src.name;
    ui.sub.textContent = `Лист ${S.page + 1} из ${S.pages.length} · ${mm(P.w)} × ${mm(P.h)} мм`;
  } else {
    ui.title.textContent = 'Правка картинки';
    ui.sub.textContent = `${P.w} × ${P.h} px`;
  }
}

async function switchPage(i) {
  if (i === S.page || i < 0 || i >= S.pages.length || S.loading) return;
  if (S.busy) { status('Идёт запрос: дождись ответа или нажми «Остановить».', 'error'); return; }
  if (S.pending) { status('Сначала прими или отклони результат.', 'error'); return; }
  cur().general = ui.general.value;
  status('');
  await showPage(i);
}

/* ── Масштаб и прокрутка ───────────────────────────────── */

function applyView() {
  const { z, x, y, fit: f } = S.view;
  ui.sheet.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  ui.zoomVal.textContent = `${Math.round((z / f) * 100)}%`;
  scheduleDetail();
}

function fit() {
  const P = cur();
  if (!P) return;
  const r = ui.stage.getBoundingClientRect();
  const sw = P.w * P.k;
  const sh = P.h * P.k;
  const pad = 24;
  const z = Math.max(0.01, Math.min((r.width - pad * 2) / sw, (r.height - pad * 2) / sh));
  S.view = { z, fit: z, x: (r.width - sw * z) / 2, y: (r.height - sh * z) / 2 };
  applyView();
}

function stageCentre() {
  const r = ui.stage.getBoundingClientRect();
  return [r.width / 2, r.height / 2];
}

function zoomAt(factor, [cx, cy]) {
  const v = S.view;
  const z = Math.min(v.fit * 32, Math.max(v.fit * 0.5, v.z * factor));
  v.x = cx - (cx - v.x) * (z / v.z);
  v.y = cy - (cy - v.y) * (z / v.z);
  v.z = z;
  applyView();
}

function stagePoint(e) {
  const r = ui.stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

/** Точка сцены -> единицы источника. */
function toSource([sx, sy]) {
  const P = cur();
  return [(sx - S.view.x) / S.view.z / P.k, (sy - S.view.y) / S.view.z / P.k];
}

/* ── Рисование ─────────────────────────────────────────── */

function bindStage() {
  const st = ui.stage;
  st.addEventListener('pointerdown', onDown);
  st.addEventListener('pointermove', onMove);
  st.addEventListener('pointerup', onUp);
  st.addEventListener('pointercancel', onUp);
  st.addEventListener('pointerleave', () => { ui.cursor.hidden = true; });
  st.addEventListener('wheel', onWheel, { passive: false });
  st.addEventListener('auxclick', (e) => e.preventDefault());
  new ResizeObserver(() => {
    if (!ui.dialog.open || !cur()) return;
    const rel = S.view.z / S.view.fit;
    fit();
    if (Math.abs(rel - 1) > 1e-3) zoomAt(rel, stageCentre());
  }).observe(st);
}

function onDown(e) {
  if (!cur() || S.loading) return;
  const panning = e.button === 1 || S.tool === 'hand' || S.space;
  if (e.button !== 0 && !panning) return;
  e.preventDefault();
  // Фокус на сцену: иначе он остаётся в поле описания и клавиши инструментов
  // печатаются туда.
  ui.stage.focus({ preventScroll: true });
  ui.stage.setPointerCapture(e.pointerId);
  const p = stagePoint(e);
  if (panning) {
    S.pan = { start: p, x: S.view.x, y: S.view.y };
    ui.stage.classList.add('panning');
    return;
  }
  if (S.busy) return;
  if (S.pending) { status('Сначала прими или отклони результат.', 'error'); return; }
  const P = cur();
  const pt = toSource(p);
  if (S.tool === 'rect') {
    S.draw = { kind: 'rect', start: pt, end: pt };
    showRect();
    return;
  }
  const stroke = { kind: 'brush', color: S.color, erase: S.tool === 'erase', size: S.size / P.k, points: [pt] };
  P.marks.push(stroke);
  S.draw = { kind: 'brush', stroke };
  paintStroke(marksCtx(), stroke, sheetFrame(P));
}

function onMove(e) {
  const p = stagePoint(e);
  moveCursor(p);
  if (S.pan) {
    S.view.x = S.pan.x + p[0] - S.pan.start[0];
    S.view.y = S.pan.y + p[1] - S.pan.start[1];
    applyView();
    return;
  }
  if (!S.draw) return;
  const P = cur();
  const pt = toSource(p);
  if (S.draw.kind === 'rect') {
    S.draw.end = pt;
    showRect();
    return;
  }
  const s = S.draw.stroke;
  const last = s.points[s.points.length - 1];
  if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) * P.k < 0.75) return;
  s.points.push(pt);
  paintStroke(marksCtx(), s, sheetFrame(P), s.points.length - 1);
}

function onUp() {
  if (S.pan) {
    S.pan = null;
    ui.stage.classList.remove('panning');
    return;
  }
  if (!S.draw) return;
  const d = S.draw;
  S.draw = null;
  const P = cur();
  if (d.kind === 'rect') {
    ui.rect.hidden = true;
    const [[ax, ay], [bx, by]] = [d.start, d.end];
    if (Math.abs(bx - ax) * P.k >= 3 && Math.abs(by - ay) * P.k >= 3) {
      const stroke = { kind: 'rect', color: S.color, erase: false, size: 0, points: [d.start, d.end] };
      P.marks.push(stroke);
      paintStroke(marksCtx(), stroke, sheetFrame(P));
    }
  }
  marksChanged();
}

function onWheel(e) {
  if (!cur()) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  if (e.ctrlKey || e.metaKey) {
    // Щипок на трекпаде приходит как колесо с ctrlKey.
    const dy = Math.max(-60, Math.min(60, e.deltaY * unit));
    zoomAt(Math.exp(-dy * 0.01), stagePoint(e));
  } else {
    S.view.x -= e.deltaX * unit;
    S.view.y -= e.deltaY * unit;
    applyView();
  }
}

function showRect() {
  const P = cur();
  const [[ax, ay], [bx, by]] = [S.draw.start, S.draw.end];
  Object.assign(ui.rect.style, {
    left: `${Math.min(ax, bx) * P.k}px`,
    top: `${Math.min(ay, by) * P.k}px`,
    width: `${Math.abs(bx - ax) * P.k}px`,
    height: `${Math.abs(by - ay) * P.k}px`,
    borderColor: colour(S.color).hex,
    borderWidth: `${2 / S.view.z}px`,
  });
  ui.rect.hidden = false;
}

function moveCursor([x, y]) {
  const ring = S.tool === 'brush' || S.tool === 'erase';
  if (!ring || S.space || S.pending || !cur()) { ui.cursor.hidden = true; return; }
  const d = S.size * S.view.z;
  Object.assign(ui.cursor.style, { left: `${x}px`, top: `${y}px`, width: `${d}px`, height: `${d}px` });
  ui.cursor.hidden = false;
}

function marksChanged() {
  syncRegions();
  updateCount();
  markThumb(S.page);
}

function undo() {
  const P = cur();
  if (!P || S.pending || S.busy) return;
  P.marks.undo();
  paintAll(marksCtx(), P.marks, sheetFrame(P));
  marksChanged();
}

function clearMarks() {
  const P = cur();
  if (!P || S.pending || S.busy) return;
  P.marks.clear();
  paintAll(marksCtx(), P.marks, sheetFrame(P));
  marksChanged();
}

/* ── Инструменты ───────────────────────────────────────── */

function buildSwatches() {
  ui.colors.replaceChildren(...PALETTE.map((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = c.hex;
    b.title = `${upper(c.ru)} · ${i + 1}`;
    b.dataset.key = c.key;
    b.addEventListener('click', () => selectColour(c.key));
    return b;
  }));
}

function selectColour(key) {
  S.color = key;
  if (S.tool === 'erase' || S.tool === 'hand') setTool('brush');
  for (const b of ui.colors.children) b.classList.toggle('active', b.dataset.key === key);
  syncRegions();
}

function setTool(tool) {
  S.tool = tool;
  for (const b of ui.tools.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  ui.stage.dataset.tool = tool;
}

function setSize(px) {
  S.size = Math.max(2, Math.min(400, Math.round(px)));
  ui.size.value = String(S.size);
  ui.sizeVal.textContent = `${S.size} px`;
}

function setFrame(mode) {
  S.frame = mode;
  const pdf = S.src?.kind === 'pdf';
  for (const b of ui.frame.children) {
    b.classList.toggle('active', b.dataset.frame === mode);
    if (b.dataset.frame === 'whole') b.textContent = pdf ? 'Весь лист' : 'Вся картинка';
  }
  ui.frameHint.textContent = mode === 'around'
    ? (pdf
      ? 'В модель уйдёт фрагмент вокруг пометок в полном разрешении: мелкие детали листа сохраняются.'
      : 'В модель уйдёт фрагмент вокруг пометок.')
    : (pdf
      ? 'В модель уйдёт весь лист: годится для правок по всему листу, мелкие детали теряются. С границей «весь кадр» лист заменяется ответом модели целиком.'
      : 'В модель уйдёт вся картинка.');
  renderBoundaryHint();
}

/**
 * Граница склейки. Её можно сменить и после ответа: ответ модели хранится,
 * склейка пересчитывается без нового запроса.
 */
async function setBoundary(mode, refresh = true) {
  S.boundary = mode;
  try { localStorage.setItem(LS_BOUNDARY, mode); } catch { /* хранилище недоступно */ }
  for (const b of ui.boundary.children) b.classList.toggle('active', b.dataset.boundary === mode);
  renderBoundaryHint();
  if (refresh && S.pending && !S.busy) await recompose();
}

function renderBoundaryHint() {
  const pdf = S.src?.kind === 'pdf';
  const text = {
    grow: 'Берётся пометка и всё, что модель дорисовала вплотную к ней: объект шире пометки входит целиком. Остальное остаётся как было.',
    mark: 'Берётся строго закрашенное, за его пределами пиксели не меняются.',
    frame: S.frame === 'whole'
      ? (pdf ? 'Берётся весь ответ модели: лист заменяется целиком.' : 'Берётся весь ответ модели как есть.')
      : 'Берётся весь фрагмент, который видела модель, с растушёванными краями.',
  };
  ui.boundaryHint.textContent = `${text[S.boundary]} Границу можно сменить и после ответа, без нового запроса.`;
}

/* ── Области ───────────────────────────────────────────── */

function syncRegions() {
  const P = cur();
  if (!P) return;
  const used = new Set(P.marks.used().map((c) => c.key));
  const keys = PALETTE.map((c) => c.key).filter((k) => used.has(k) || k === S.color || hasContent(P.regions.get(k)));

  for (const [k, card] of cards) {
    if (!keys.includes(k) || card.dataset.page !== String(S.page)) {
      card.remove();
      cards.delete(k);
    }
  }
  let prev = null;
  for (const k of keys) {
    let card = cards.get(k);
    if (!card) {
      card = regionCard(P, k);
      cards.set(k, card);
    }
    const want = prev ? prev.nextSibling : ui.regions.firstChild;
    if (want !== card) ui.regions.insertBefore(card, want);
    card.classList.toggle('active', k === S.color);
    card.classList.toggle('unused', !used.has(k));
    card.querySelector('.ed-region-state').textContent = used.has(k) ? '' : 'не закрашена';
    prev = card;
  }
  ui.regionsHint.hidden = used.size > 0;
}

function regionCard(P, key) {
  const c = colour(key);
  const r = region(P, key);
  const card = document.createElement('div');
  card.className = 'ed-region';
  card.dataset.key = key;
  card.dataset.page = String(S.page);

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'ed-region-head';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = c.hex;
  const name = document.createElement('span');
  name.textContent = `${upper(c.area)} область`;
  const state = document.createElement('small');
  state.className = 'ed-region-state';
  head.append(dot, name, state);
  head.addEventListener('click', () => selectColour(key));

  const text = document.createElement('textarea');
  text.rows = 2;
  text.placeholder = 'Что здесь должно быть';
  text.value = r.text;
  text.addEventListener('input', () => { r.text = text.value; });
  text.addEventListener('focus', () => { if (S.color !== key) selectColour(key); });

  const refs = document.createElement('div');
  refs.className = 'ed-region-refs';

  card.append(head, text, refs);
  renderRegionRefs(card, P, key);

  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('over'); });
  card.addEventListener('dragleave', () => card.classList.remove('over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    card.classList.remove('over');
    addRefs(key, e.dataTransfer.files);
  });
  return card;
}

function renderRegionRefs(card, P, key) {
  const r = region(P, key);
  const box = card.querySelector('.ed-region-refs');
  const thumbs = r.refs.map((ref) => {
    const d = document.createElement('div');
    d.className = 'ref';
    const img = document.createElement('img');
    img.src = ref.url;
    img.alt = ref.name;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Убрать';
    x.addEventListener('click', () => {
      URL.revokeObjectURL(ref.url);
      r.refs.splice(r.refs.indexOf(ref), 1);
      renderRegionRefs(card, P, key);
      updateCount();
      syncRegions();
    });
    d.append(img, x);
    return d;
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'ghost small ed-add-ref';
  add.textContent = '+ референс';
  add.title = 'Файл, перетаскивание картинки на область или ⌘V';
  add.addEventListener('click', () => { S.refTarget = key; ui.refInput.click(); });
  box.replaceChildren(...thumbs, add);
}

async function addRefs(key, files) {
  const list = Array.from(files || []).filter(isImage);
  if (!list.length || !cur()) return;
  const P = cur();
  const r = region(P, key);
  for (const file of list) {
    try {
      const { blob, name } = await toReference(file);
      r.refs.push({ blob, name, url: URL.createObjectURL(blob) });
    } catch {
      status(`Не удалось прочитать «${file.name}».`, 'error');
    }
  }
  selectColour(key);
  const card = cards.get(key);
  if (card) renderRegionRefs(card, P, key);
  updateCount();
}

function clearRegions(P) {
  for (const r of P.regions.values()) for (const ref of r.refs) URL.revokeObjectURL(ref.url);
  P.regions.clear();
  for (const card of cards.values()) card.remove();
  cards.clear();
}

function updateCount() {
  const P = cur();
  if (!P || !app) return;
  const used = P.marks.used();
  if (!used.length) { ui.count.textContent = ''; return; }
  const refs = used.reduce((s, c) => s + (P.regions.get(c.key)?.refs.length || 0), 0);
  const cap = app.maxRefs();
  const est = app.estimate();
  const parts = [`В запросе ${2 + refs} изобр. из ${cap} допустимых`];
  if (est) parts.push(`${est.actual ? 'обычно' : 'примерно'} ${app.money(est.value)}`);
  ui.count.textContent = parts.join(' · ');
  ui.count.classList.toggle('error', 2 + refs > cap);
}

/* ── Кадр для модели ───────────────────────────────────── */

function ratiosOf(values) {
  return (values || [])
    .filter((v) => v !== 'auto')
    .map((v) => {
      const [a, b] = v.split(':').map(Number);
      return { v, r: a / b };
    })
    .filter((o) => o.r > 0 && Number.isFinite(o.r));
}

function nearest(ratios, aspect) {
  let best = null;
  for (const o of ratios) {
    const d = Math.abs(Math.log(o.r / aspect));
    if (!best || d < best.d) best = { ...o, d };
  }
  return best;
}

/** Отрезок [start, start + size] внутри [0, limit]; если не помещается, по центру. */
function settle(start, size, limit) {
  if (size >= limit) return [(limit - size) / 2, size];
  return [Math.min(Math.max(start, 0), limit - size), size];
}

/** Пометки плюс поле вокруг: модели нужен контекст, совмещению нужна площадь вне маски. */
function around(P, [x0, y0, x1, y1]) {
  const bw = x1 - x0;
  const bh = y1 - y0;
  const m = CONTEXT * Math.max(bw, bh);
  let box = [x0 - m, y0 - m, bw + 2 * m, bh + 2 * m];
  const long = Math.max(P.w, P.h);
  const min = S.src.kind === 'pdf'
    ? Math.max(MIN_CONTEXT * long, SEND_EDGE / MAX_PX_PER_PT)
    : Math.max(MIN_CONTEXT * long, Math.min(long, 512));
  const big = Math.max(box[2], box[3]);
  if (big < min) {
    const s = min / big;
    const cx = box[0] + box[2] / 2;
    const cy = box[1] + box[3] / 2;
    box = [cx - (box[2] * s) / 2, cy - (box[3] * s) / 2, box[2] * s, box[3] * s];
  }
  return box;
}

/**
 * Подгонка кадра под пропорции модели. Кадр только растёт, поэтому пометки
 * всегда внутри. Лист PDF дополняется белым полем, картинка нет: её кадр
 * обрезается по краю, а неточность пропорций снимает совмещение.
 */
function shape(box, P, pdf) {
  let [x, y, w, h] = box;
  const ratios = ratiosOf(app.aspectValues());
  const target = ratios.length ? nearest(ratios, w / h) : null;
  if (target) {
    if (target.r > w / h) {
      const nw = h * target.r;
      x -= (nw - w) / 2;
      w = nw;
    } else {
      const nh = w / target.r;
      y -= (nh - h) / 2;
      h = nh;
    }
  }
  if (!pdf) {
    w = Math.min(w, P.w);
    h = Math.min(h, P.h);
  }
  [x, w] = settle(x, w, P.w);
  [y, h] = settle(y, h, P.h);
  if (!pdf) {
    x = Math.round(x);
    y = Math.round(y);
    w = Math.min(P.w - x, Math.round(w));
    h = Math.min(P.h - y, Math.round(h));
  }
  return { box: [x, y, w, h], ratio: ratios.length ? nearest(ratios, w / h).v : undefined };
}

/** Растр кадра f текущего листа со всеми принятыми правками. */
function renderFrame(f, signal) {
  if (S.src.kind === 'pdf') return S.src.doc.render(S.page, f, patchesOf(S.page), signal);
  const c = blank(f.w, f.h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, f.w, f.h);
  ctx.imageSmoothingQuality = 'high';
  const img = S.src.image;
  ctx.drawImage(img, -f.x * f.k, -f.y * f.k, img.width * f.k, img.height * f.k);
  return Promise.resolve(c);
}

async function prepare(P, signal) {
  const pdf = S.src.kind === 'pdf';
  const bounds = P.marks.bounds();
  const start = S.frame === 'whole' || !bounds ? [0, 0, P.w, P.h] : around(P, bounds);
  const { box, ratio } = shape(start, P, pdf);
  const [bx, by, bw, bh] = box;
  const k = pdf ? SEND_EDGE / Math.max(bw, bh) : Math.min(1, SEND_EDGE / Math.max(bw, bh));
  const send = frameOf(k, bx, by, bw * k, bh * k);

  const original = await renderFrame(send, signal);
  const annotated = blank(send.w, send.h);
  const actx = annotated.getContext('2d');
  actx.drawImage(original, 0, 0);
  actx.drawImage(P.marks.tint(send, MARK_ALPHA), 0, 0);

  const eps = 0.5 / k;
  const wholePage = bx <= eps && by <= eps && bx + bw >= P.w - eps && by + bh >= P.h - eps;
  // Кодирование PNG идёт вне основного потока: оба кадра параллельно.
  const [originalBlob, annotatedBlob] = await Promise.all([toPng(original), toPng(annotated)]);
  return { box, ratio, send, original, wholePage, originalBlob, annotatedBlob };
}

/* ── Запрос ────────────────────────────────────────────── */

function setBusy(on) {
  ui.run.disabled = on;
  ui.run.textContent = on ? 'Исправляю…' : 'Исправить';
  ui.stop.hidden = !on;
  ui.dialog.classList.toggle('busy', on);
}

async function run() {
  if (S.busy || !cur() || S.loading) return;
  if (S.pending) clearPending();
  const P = cur();
  P.general = ui.general.value;

  const used = P.marks.used();
  if (!used.length) { status('Сначала закрась на листе, что исправить.', 'error'); return; }
  const list = used.map((c) => ({ colour: c, text: region(P, c.key).text.trim(), refs: region(P, c.key).refs.slice() }));
  const empty = list.filter((r) => !r.text && !r.refs.length);
  if (empty.length) {
    status(`Напиши, что должно быть в области: ${empty.map((r) => r.colour.area).join(', ')}. Или приложи к ней референс.`, 'error');
    return;
  }
  const orphans = PALETTE.filter((c) => !used.includes(c) && hasContent(P.regions.get(c.key)));
  if (orphans.length) {
    status(`Не закрашена область: ${orphans.map((c) => c.area).join(', ')}. Закрась её или убери описание и референсы.`, 'error');
    return;
  }
  const model = app.currentModel();
  if (!model) { status('Список моделей не загрузился: проверь сеть и обнови страницу.', 'error'); return; }
  const refs = list.reduce((s, r) => s + r.refs.length, 0);
  const cap = app.maxRefs();
  if (2 + refs > cap) {
    status(`«${app.shortName(model.name)}» принимает ${cap} изобр., а в запросе ${2 + refs}: исходник, копия с пометками и ${refs} реф. Убери лишние референсы или смени модель.`, 'error');
    return;
  }
  if (!app.api.getKey()) { status('Нет ключа OpenRouter: добавь его в «Ключ и доступ».', 'error'); return; }

  const ctrl = new AbortController();
  S.busy = ctrl;
  setBusy(true);
  try {
    status('Готовлю кадр…', 'busy');
    const job = await prepare(P, ctrl.signal);
    const regions = list.map((r) => ({ colour: r.colour, text: r.text, refs: r.refs.length }));
    const subject = S.src.kind === 'image' ? 'picture' : job.wholePage ? 'sheet' : 'fragment';
    const prompt = buildEditPrompt({ regions, general: P.general, subject });
    const refBlobs = list.flatMap((r) => r.refs.map((x) => x.blob));
    const references = await Promise.all([job.originalBlob, job.annotatedBlob, ...refBlobs].map(blobToDataUrl));
    const resolution = app.resolution();

    status(app.busyText(model), 'busy');
    const started = Date.now();
    const res = await app.api.generate({
      model: model.id, prompt, references, aspectRatio: job.ratio, resolution, signal: ctrl.signal,
    });
    const image = res?.data?.[0];
    if (!image?.b64_json) throw new Error('Ответ без изображения: модель отказалась генерировать.');
    const seconds = Math.round((Date.now() - started) / 1000);
    const cost = res.usage?.cost ?? 0;
    const rawType = image.media_type || 'image/png';
    const raw = base64ToBlob(image.b64_json, rawType);

    const record = {
      id: `${started}-${Math.random().toString(36).slice(2, 8)}`,
      ts: started,
      model: model.id,
      modelName: model.name,
      prompt: describe(regions, P.general),
      kind: S.src.kind === 'pdf' ? 'sheet' : 'brush',
      doc: S.src.kind === 'pdf' ? S.src.name : undefined,
      page: S.src.kind === 'pdf' ? S.page + 1 : undefined,
      aspect: job.ratio,
      resolution,
      cost,
      seconds,
      outType: rawType,
      out: raw,
      refs: [job.annotatedBlob, ...refBlobs],
    };

    status('Совмещаю результат с оригиналом…', 'busy');
    let base = null;
    let shown;
    try {
      base = await align(P, job, raw, ctrl.signal);
      shown = await view(P, base, S.boundary);
    } catch (e) {
      base?.result.close?.();
      // За ответ уже заплачено: он уходит в историю как есть.
      await app.saveRecord(record);
      throw new Error(`Ответ получен и сохранён в истории, но склейка не удалась: ${e.message || e}`);
    }
    record.out = shown.out;
    record.outType = shown.outType;
    record.composed = shown.boundary !== 'frame';
    await app.saveRecord(record);
    app.refreshCredits();
    setTimeout(app.refreshCredits, 30000);

    S.pending = { base, view: shown, record, busy: false };
    showPending();
    if (base.changed < QUIET_CHANGE) {
      status(`Модель почти не тронула закрашенное (${base.changed.toFixed(1)} из 255) · ${app.money(cost)}. Переформулируй или увеличь область: пометки сохранены, ответ в истории.`, 'error');
    } else {
      status(`Готово за ${seconds} с · ${app.money(cost)}${describeFit(base.fit)}${describeView(shown)}${describeSoft(base)}. Сравни до и после, затем прими или отклони.`);
    }
  } catch (e) {
    if (e.name === 'AbortError' || ctrl.signal.aborted) status('Остановлено.');
    else status(e.message || 'Не получилось.', 'error');
  } finally {
    if (S.busy === ctrl) S.busy = null;
    setBusy(false);
  }
}

const BOUNDARY_NAMES = { grow: 'по изменениям', mark: 'по пометке', frame: 'весь кадр' };

function describeFit(fit) {
  if (!fit) return '';
  const moved = Math.abs(fit.tx) > 1 || Math.abs(fit.ty) > 1 || Math.abs(fit.sx - 1) > 0.002 || Math.abs(fit.sy - 1) > 0.002;
  return moved
    ? ` · кадр совмещён (сдвиг ${Math.round(fit.tx)}/${Math.round(fit.ty)} px, масштаб ${fit.sx.toFixed(3)} × ${fit.sy.toFixed(3)})`
    : '';
}

function describeView(v) {
  const parts = [];
  if (v.boundary === 'grow' && v.grew > 0.05) parts.push(`граница по изменениям шире пометки на ${Math.round(v.grew * 100)} %`);
  if (v.tone) parts.push('тон подогнан под оригинал');
  return parts.length ? ` · ${parts.join(', ')}` : '';
}

function describeSoft(b) {
  return b.soft
    ? ` · ответ модели ${b.soft.model} px мельче кадра ${b.soft.frame} px, внутри правки будет мягче: для резкости выбери разрешение крупнее`
    : '';
}

/**
 * Совмещение ответа с оригиналом. Делается один раз на ответ: граница
 * склейки потом меняется без него.
 */
async function align(P, job, raw, signal) {
  const pdf = S.src.kind === 'pdf';
  const result = await createImageBitmap(await rasterize(raw, COMPOSE_MAX));
  try {
    const [bx, by, bw, bh] = job.box;
    let comp;
    if (pdf) {
      const long = Math.min(COMPOSE_MAX, Math.max(SEND_EDGE, result.width, result.height));
      const k = long / Math.max(bw, bh);
      comp = frameOf(k, bx, by, bw * k, bh * k);
    } else {
      comp = frameOf(1, bx, by, bw, bh);   // родные пиксели картинки
    }
    const same = comp.w === job.send.w && comp.h === job.send.h;
    const original = same ? job.original : await renderFrame(comp, signal);
    const mask = P.marks.union(comp);
    const fit = estimateAlignment(original, result, mask, comp.w, comp.h);
    const aligned = place(result, fit, comp.w, comp.h);
    const changed = changeInside(original, aligned, mask);
    const modelLong = Math.max(result.width, result.height);
    const frameLong = Math.max(comp.w, comp.h);
    return {
      pdf, job, comp, original, mask, aligned, fit, changed, raw, result, grown: null,
      soft: modelLong < frameLong * 0.8 ? { model: modelLong, frame: frameLong } : null,
    };
  } catch (e) {
    result.close?.();
    throw e;
  }
}

/**
 * Вид результата для границы склейки: заплатка для листа, превью и файл
 * для истории. Пересчитывается при смене границы без нового запроса.
 */
async function view(P, b, boundary) {
  const [bx, by] = b.job.box;

  // Картинка целиком с границей «весь кадр»: ответ модели как есть.
  if (!b.pdf && boundary === 'frame' && b.job.wholePage) {
    const canvas = blank(P.w, P.h);
    canvas.getContext('2d').drawImage(b.result, 0, 0, P.w, P.h);
    const svg = b.raw.type === 'image/svg+xml';
    return {
      boundary, grew: 0, tone: false,
      out: svg ? await toPng(canvas) : b.raw,
      outType: svg ? 'image/png' : b.raw.type,
      preview: { canvas, x: 0, y: 0, w: P.w, h: P.h },
    };
  }

  let region = b.mask;
  let grew = 0;
  if (boundary === 'grow') {
    if (!b.grown) b.grown = growMask(b.original, b.aligned, b.mask);
    region = b.grown.canvas;
    grew = b.grown.grew;
  }
  const full = boundary === 'frame' && b.job.wholePage;   // лист PDF заменяется целиком
  const alpha = boundary === 'frame' ? (full ? null : softFrame(b.comp.w, b.comp.h)) : softEdge(region);
  // Тон считается там, где модель не должна была ничего менять.
  const tone = toneOf(b.original, b.aligned, boundary === 'frame' ? b.mask : region);
  const { patch, composed } = composeWith({ original: b.original, aligned: b.aligned, alpha, tone });

  if (b.pdf) {
    const { comp } = b;
    // Часть кадра, которая приходится на лист: поле за краем не нужно.
    const px0 = Math.max(0, Math.round(-bx * comp.k));
    const py0 = Math.max(0, Math.round(-by * comp.k));
    const px1 = Math.min(comp.w, Math.round((P.w - bx) * comp.k));
    const py1 = Math.min(comp.h, Math.round((P.h - by) * comp.k));
    const pageBox = [px0, py0, px1 - px0, py1 - py0];
    let box = pageBox;
    if (!full) {
      const o = opaqueBox(patch) || pageBox;
      const x0 = Math.max(o[0], px0);
      const y0 = Math.max(o[1], py0);
      const x1 = Math.min(o[0] + o[2], px1);
      const y1 = Math.min(o[1] + o[3], py1);
      box = [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
    }
    const piece = cut(patch, box);
    const rect = full
      ? { x: 0, y: 0, w: P.w, h: P.h }
      : { x: bx + box[0] / comp.k, y: by + box[1] / comp.k, w: box[2] / comp.k, h: box[3] / comp.k };
    const [out, blob] = await Promise.all([toPng(cut(composed, pageBox)), toPng(piece)]);
    return {
      boundary, grew, tone: !!tone, full, out,
      outType: 'image/png',
      patch: { ...rect, full, blob },
      preview: { canvas: piece, ...rect },
    };
  }

  // Картинка: заплатка вклеивается в полный кадр в родном разрешении.
  const whole = blank(P.w, P.h);
  const wctx = whole.getContext('2d');
  wctx.drawImage(S.src.image, 0, 0);
  wctx.drawImage(patch, bx, by);
  const o = opaqueBox(patch) || [0, 0, patch.width, patch.height];
  return {
    boundary, grew, tone: !!tone,
    out: await toPng(whole),
    outType: 'image/png',
    preview: { canvas: cut(patch, o), x: bx + o[0], y: by + o[1], w: o[2], h: o[3] },
  };
}

/** Смена границы при показанном результате: новый вид из того же ответа. */
async function recompose() {
  const p = S.pending;
  if (!p || p.busy) return;
  p.busy = true;
  status('Пересчитываю склейку…', 'busy');
  try {
    const shown = await view(cur(), p.base, S.boundary);
    if (S.pending !== p) return;
    p.view = shown;
    p.record.out = shown.out;
    p.record.outType = shown.outType;
    p.record.composed = shown.boundary !== 'frame';
    app.updateRecord(p.record);
    showPending();
    status(`Граница склейки: ${BOUNDARY_NAMES[shown.boundary]}${describeView(shown)}. Сравни до и после, затем прими или отклони.`);
  } catch (e) {
    status(e.message || 'Склейка не пересчиталась.', 'error');
  } finally {
    p.busy = false;
  }
}

/* ── Результат ─────────────────────────────────────────── */

function showPending() {
  const { preview } = S.pending.view;
  const P = cur();
  const c = preview.canvas;
  ui.preview.width = c.width;
  ui.preview.height = c.height;
  ui.preview.getContext('2d').drawImage(c, 0, 0);
  Object.assign(ui.preview.style, {
    left: `${preview.x * P.k}px`,
    top: `${preview.y * P.k}px`,
    width: `${preview.w * P.k}px`,
    height: `${preview.h * P.k}px`,
  });
  S.compare = false;
  ui.preview.hidden = false;
  ui.marks.hidden = true;
  ui.cursor.hidden = true;
  ui.result.hidden = false;
  ui.run.hidden = true;
  ui.accept.textContent = S.src.kind === 'pdf' ? 'Принять в лист' : 'Принять';
  ui.compare.textContent = 'Показать до';
  ui.compare.classList.remove('active');
}

function clearPending() {
  S.pending?.base.result.close?.();
  S.pending = null;
  S.compare = false;
  ui.preview.hidden = true;
  ui.preview.width = ui.preview.height = 1;
  ui.marks.hidden = false;
  ui.result.hidden = true;
  ui.run.hidden = false;
}

function toggleCompare() {
  if (!S.pending) return;
  S.compare = !S.compare;
  ui.preview.hidden = S.compare;
  ui.marks.hidden = !S.compare;
  ui.compare.classList.toggle('active', S.compare);
  ui.compare.textContent = S.compare ? 'Показать после' : 'Показать до';
}

async function accept() {
  if (!S.pending || S.busy || S.pending.busy) return;
  if (S.src.kind === 'pdf') await acceptSheet();
  else await acceptImage();
}

async function acceptSheet() {
  const p = S.pending;
  const P = cur();
  const src = S.src;
  const patch = {
    id: rid(), doc: src.meta.id, page: S.page,
    x: p.view.patch.x, y: p.view.patch.y, w: p.view.patch.w, h: p.view.patch.h,
    full: p.view.patch.full, blob: p.view.patch.blob, ts: Date.now(), record: p.record.id,
  };
  src.patches.push(patch);
  src.meta.count = src.patches.length;
  src.meta.ts = Date.now();
  try {
    await db.sheets.addPatch(src.meta, patch);
  } catch (e) {
    status(`Правка применена, но в браузер не записалась (${e.message || e.name}). Сохрани PDF до закрытия страницы.`, 'error');
  }

  // Растр листа дорисовывается заплаткой: заново рисовать весь лист незачем.
  if (P.base) {
    const bmp = await createImageBitmap(patch.blob);
    P.base.getContext('2d').drawImage(bmp, patch.x * P.baseK, patch.y * P.baseK, patch.w * P.baseK, patch.h * P.baseK);
    bmp.close?.();
    drawBase(P);
  }
  cancelDetail();   // начатая раньше дорисовка не знает о новой правке
  ui.detail.hidden = true;
  scheduleDetail();

  P.marks.clear();
  clearRegions(P);
  P.general = '';
  ui.general.value = '';
  paintAll(marksCtx(), P.marks, sheetFrame(P));
  clearPending();
  syncRegions();
  updateCount();
  renderThumb(S.page);
  renderDocInfo();
  app.onSheetsChanged();
  status(`Лист ${S.page + 1} обновлён. Принятых правок в документе: ${src.patches.length}. Когда закончишь, сохрани PDF.`);
}

async function acceptImage() {
  const p = S.pending;
  const raster = await rasterize(p.record.out, IMAGE_EDGE);
  const bmp = await createImageBitmap(raster);
  const k = Math.min(1, IMAGE_EDGE / Math.max(bmp.width, bmp.height));
  const image = blank(bmp.width * k, bmp.height * k);
  image.getContext('2d').drawImage(bmp, 0, 0, image.width, image.height);
  bmp.close?.();
  clearRegions(cur());
  S.src.image = image;
  S.pages = [pageState(image.width, image.height)];
  S.accepted = p.record.id;
  clearPending();
  await showPage(0);
  status('Принято: правка стала исходником. Можно править дальше или закрыть, результат откроется в просмотре.');
}

function reject() {
  if (!S.pending) return;
  clearPending();
  status('Отклонено. Пометки на месте, ответ остался в истории.');
}

/* ── Документ ──────────────────────────────────────────── */

function renderDocInfo() {
  if (S.src?.kind !== 'pdf') { ui.doc.hidden = true; return; }
  ui.doc.hidden = false;
  const n = S.src.patches.length;
  const sheets = new Set(S.src.patches.map((p) => p.page)).size;
  ui.docInfo.textContent = n
    ? `Принято ${n} ${app.plural(n, ['правка', 'правки', 'правок'])} на ${sheets} ${app.plural(sheets, ['листе', 'листах', 'листах'])}. Сохранение собирает PDF: на изменённые листы ложатся заплатки, всё остальное остаётся как было.`
    : 'Принятые правки ложатся на листы. Сохранение соберёт PDF с заменёнными листами.';
  ui.save.disabled = n === 0;
  ui.revert.hidden = !S.src.patches.some((p) => p.page === S.page);
}

async function revert() {
  if (S.src?.kind !== 'pdf' || S.busy || S.pending || S.loading) return;
  const src = S.src;
  const mine = src.patches.filter((p) => p.page === S.page);
  if (!mine.length) return;
  const last = mine[mine.length - 1];
  if (!confirm(`Откатить последнюю принятую правку листа ${S.page + 1}?`)) return;
  src.patches = src.patches.filter((p) => p !== last);
  src.meta.count = src.patches.length;
  src.meta.ts = Date.now();
  await db.sheets.removePatch(src.meta, last.id).catch(() => {});
  const P = cur();
  P.base = null;
  setLoading(true, `Рисую лист ${S.page + 1}…`);
  try {
    await ensureBase(S.page);
  } finally {
    setLoading(false);
  }
  if (P.base) drawBase(P);
  cancelDetail();   // начатая раньше дорисовка не знает о новой правке
  ui.detail.hidden = true;
  scheduleDetail();
  renderThumb(S.page);
  renderDocInfo();
  app.onSheetsChanged();
  status(`Последняя правка листа ${S.page + 1} откачена.`);
}

function outName(name) {
  return name && /\.pdf$/i.test(name) ? name : `${name || 'документ'}.pdf`;
}

async function savePdf() {
  const src = S.src;
  if (src?.kind !== 'pdf' || !src.patches.length) return;
  const name = outName(src.name);
  // Окно выбора файла нужно открыть сразу по нажатию: после долгой сборки
  // браузер уже не считает действие пользовательским и откажет.
  let handle = null;
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') { status('Сохранение отменено.'); return; }
      handle = null;
    }
  }
  ui.save.disabled = true;
  status('Собираю PDF…', 'busy');
  try {
    const bytes = await pdfLib.build(src.bytes, src.doc, src.patches);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const size = `${(blob.size / 1048576).toFixed(1)} МБ`;
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      status(`PDF записан в «${handle.name}» · ${src.patches.length} ${app.plural(src.patches.length, ['правка', 'правки', 'правок'])}, ${size}.`);
    } else {
      const fallback = name.replace(/\.pdf$/i, '_nb.pdf');
      download(blob, fallback);
      status(`PDF скачан как «${fallback}» · ${size}.`);
    }
  } catch (e) {
    status(e.message || 'PDF не собрался.', 'error');
  } finally {
    ui.save.disabled = false;
  }
}

/* ── Миниатюры листов ──────────────────────────────────── */

function buildStrip() {
  S.thumbs?.disconnect();
  if (S.src?.kind !== 'pdf') { ui.pages.hidden = true; return; }
  ui.pages.hidden = false;
  S.thumbs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      S.thumbs.unobserve(e.target);
      renderThumb(Number(e.target.dataset.page));
    }
  }, { root: ui.pages, rootMargin: '300px' });
  ui.pages.replaceChildren(...S.pages.map((P, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ed-page';
    b.dataset.page = String(i);
    const c = document.createElement('canvas');
    c.width = THUMB;
    c.height = Math.round(THUMB * Math.min(3, P.h / P.w));
    const label = document.createElement('span');
    label.className = 'ed-page-label';
    label.textContent = `Лист ${i + 1}`;
    const badge = document.createElement('span');
    badge.className = 'ed-page-badge';
    b.append(c, label, badge);
    b.addEventListener('click', () => switchPage(i));
    S.thumbs.observe(b);
    return b;
  }));
  markStrip();
}

async function renderThumb(i) {
  const b = ui.pages.children[i];
  if (!b || S.src?.kind !== 'pdf') return;
  const src = S.src;
  const P = S.pages[i];
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const k = (THUMB * dpr) / P.w;
  const h = Math.min(P.h * k, THUMB * dpr * 3);
  const token = P.thumbToken = (P.thumbToken || 0) + 1;
  try {
    const c = await src.doc.render(i, frameOf(k, 0, 0, P.w * k, h), patchesOf(i));
    // Документ закрыт или миниатюру уже перерисовали с новыми правками.
    if (S.src !== src || token !== P.thumbToken) return;
    const cv = b.querySelector('canvas');
    cv.width = c.width;
    cv.height = c.height;
    cv.getContext('2d').drawImage(c, 0, 0);
  } catch {
    // Миниатюра не обязательна.
  }
  markThumb(i);
}

function markStrip() {
  for (let i = 0; i < ui.pages.children.length; i++) markThumb(i);
}

function markThumb(i) {
  const b = ui.pages.children[i];
  if (!b || S.src?.kind !== 'pdf') return;
  b.classList.toggle('active', i === S.page);
  const n = S.src.patches.filter((p) => p.page === i).length;
  const marked = S.pages[i].marks.strokes.length > 0;
  b.classList.toggle('edited', n > 0);
  b.querySelector('.ed-page-badge').textContent = n
    ? `${n} ${app.plural(n, ['правка', 'правки', 'правок'])}`
    : marked ? 'есть пометки' : '';
}

/* ── Чёткий растр при увеличении ───────────────────────── */
// Базовый растр листа рассчитан на показ целиком. При сильном увеличении
// видимая часть листа дорисовывается отдельно в экранном разрешении.

function scheduleDetail() {
  if (S.src?.kind !== 'pdf') return;
  clearTimeout(S.detail.timer);
  S.detail.timer = setTimeout(renderDetail, 180);
}

function cancelDetail() {
  clearTimeout(S.detail.timer);
  S.detail.ctrl?.abort();
  S.detail.ctrl = null;
  S.detail.seq++;
}

async function renderDetail() {
  const P = cur();
  if (S.src?.kind !== 'pdf' || !P?.base || S.loading) return;
  const dpr = window.devicePixelRatio || 1;
  const kScreen = S.view.z * P.k * dpr;
  if (kScreen <= P.baseK * 1.15) { ui.detail.hidden = true; return; }

  const r = ui.stage.getBoundingClientRect();
  const u = (sx) => (sx - S.view.x) / S.view.z / P.k;
  const v = (sy) => (sy - S.view.y) / S.view.z / P.k;
  let x0 = Math.max(0, u(0));
  let y0 = Math.max(0, v(0));
  let x1 = Math.min(P.w, u(r.width));
  let y1 = Math.min(P.h, v(r.height));
  if (x1 <= x0 || y1 <= y0) { ui.detail.hidden = true; return; }
  const mx = (x1 - x0) * 0.15;
  const my = (y1 - y0) * 0.15;
  x0 = Math.max(0, x0 - mx);
  y0 = Math.max(0, y0 - my);
  x1 = Math.min(P.w, x1 + mx);
  y1 = Math.min(P.h, y1 + my);
  let k = kScreen;
  const big = Math.max(x1 - x0, y1 - y0) * k;
  if (big > 4096) k *= 4096 / big;

  S.detail.ctrl?.abort();
  const ctrl = new AbortController();
  S.detail.ctrl = ctrl;
  const seq = ++S.detail.seq;
  const page = S.page;
  try {
    const c = await S.src.doc.render(page, frameOf(k, x0, y0, (x1 - x0) * k, (y1 - y0) * k), patchesOf(page), ctrl.signal);
    if (seq !== S.detail.seq || page !== S.page) return;
    ui.detail.width = c.width;
    ui.detail.height = c.height;
    ui.detail.getContext('2d').drawImage(c, 0, 0);
    Object.assign(ui.detail.style, {
      left: `${x0 * P.k}px`,
      top: `${y0 * P.k}px`,
      width: `${(x1 - x0) * P.k}px`,
      height: `${(y1 - y0) * P.k}px`,
    });
    ui.detail.hidden = false;
  } catch {
    // Отменено или не отрисовалось: остаётся базовый растр.
  }
}

/* ── Панель и клавиши ──────────────────────────────────── */

function bindPanel() {
  for (const b of ui.tools.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  for (const b of ui.frame.querySelectorAll('[data-frame]')) b.addEventListener('click', () => setFrame(b.dataset.frame));
  for (const b of ui.boundary.querySelectorAll('[data-boundary]')) b.addEventListener('click', () => setBoundary(b.dataset.boundary));
  ui.size.addEventListener('input', () => setSize(Number(ui.size.value)));
  ui.undo.addEventListener('click', undo);
  ui.clear.addEventListener('click', clearMarks);
  ui.zoomIn.addEventListener('click', () => zoomAt(1.25, stageCentre()));
  ui.zoomOut.addEventListener('click', () => zoomAt(0.8, stageCentre()));
  ui.zoomVal.addEventListener('click', fit);
  ui.general.addEventListener('input', () => { if (cur()) cur().general = ui.general.value; });

  ui.model.addEventListener('change', async () => {
    await app.setModel(ui.model.value);
    syncModels();
  });
  ui.resolution.addEventListener('change', () => {
    app.setResolution(ui.resolution.value);
    updateCount();
  });

  ui.run.addEventListener('click', run);
  ui.stop.addEventListener('click', () => S.busy?.abort());
  ui.accept.addEventListener('click', accept);
  ui.compare.addEventListener('click', toggleCompare);
  ui.again.addEventListener('click', () => { clearPending(); run(); });
  ui.reject.addEventListener('click', reject);
  ui.save.addEventListener('click', savePdf);
  ui.revert.addEventListener('click', revert);

  ui.refInput.addEventListener('change', () => {
    if (S.refTarget) addRefs(S.refTarget, ui.refInput.files);
    ui.refInput.value = '';
  });

  ui.close.addEventListener('click', () => {
    S.busy?.abort();
    ui.dialog.close();
  });
  ui.dialog.addEventListener('cancel', (e) => {
    if (!S.busy) return;
    e.preventDefault();
    status('Идёт запрос: дождись ответа или нажми «Остановить».', 'error');
  });
  ui.dialog.addEventListener('close', onClosed);

  // Картинка из буфера становится референсом выбранной области.
  document.addEventListener('paste', (e) => {
    if (!ui.dialog.open) return;
    const files = Array.from(e.clipboardData?.files || []).filter(isImage);
    if (!files.length) return;
    e.preventDefault();
    addRefs(S.color, files);
  });

  ui.dialog.addEventListener('keydown', onKey);
  ui.dialog.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !typing(e)) {
      e.preventDefault();
      releaseSpace();
    }
  });
  // Пробел отпустили в другом окне: рука не должна залипнуть.
  window.addEventListener('blur', releaseSpace);
}

function releaseSpace() {
  S.space = false;
  ui.stage.classList.remove('grab');
}

const typing = (e) => /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName);

function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); return; }
  if (typing(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // По физическим клавишам: так сочетания работают и в русской раскладке.
  const digit = /^Digit([1-5])$/.exec(e.code);
  if (digit) { selectColour(PALETTE[Number(digit[1]) - 1].key); return; }
  switch (e.code) {
    case 'KeyB': setTool('brush'); break;
    case 'KeyR': setTool('rect'); break;
    case 'KeyE': setTool('erase'); break;
    case 'KeyH': setTool('hand'); break;
    case 'BracketLeft': setSize(S.size / 1.25); break;
    case 'BracketRight': setSize(S.size * 1.25); break;
    case 'Digit0': fit(); break;
    case 'Equal': case 'NumpadAdd': zoomAt(1.25, stageCentre()); break;
    case 'Minus': case 'NumpadSubtract': zoomAt(0.8, stageCentre()); break;
    case 'KeyC': toggleCompare(); break;
    case 'PageDown': case 'ArrowRight': if (S.src?.kind === 'pdf') { e.preventDefault(); switchPage(S.page + 1); } break;
    case 'PageUp': case 'ArrowLeft': if (S.src?.kind === 'pdf') { e.preventDefault(); switchPage(S.page - 1); } break;
    case 'Space':
      e.preventDefault();
      S.space = true;
      ui.cursor.hidden = true;
      ui.stage.classList.add('grab');
      break;
    default:
  }
}

function onClosed() {
  S.busy?.abort();
  cancelDetail();
  S.thumbs?.disconnect();
  const reopen = S.src?.kind === 'image' ? S.accepted : null;
  if (S.src?.kind === 'pdf') {
    S.src.doc.destroy();
    app.onSheetsChanged();
  }
  for (const P of S.pages) clearRegions(P);
  reset();
  // Холсты держат десятки мегабайт: отпускаем сразу.
  for (const c of [ui.base, ui.detail, ui.preview, ui.marks]) { c.width = 1; c.height = 1; }
  if (reopen) app.openViewer(reopen);
}
