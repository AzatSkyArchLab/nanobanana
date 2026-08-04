// Кисть для локальных правок.
//
// Настоящей маски в Images API нет ни у одной модели, поэтому области
// передаются визуально: модель получает оригинал и его копию с полупрозрачной
// заливкой поверх нужных мест. Цветов несколько — на них можно ссылаться
// в промпте по отдельности («пурпурное замени на…, зелёное убери»).
//
// Цвета выбраны чистые и в фотографиях почти не встречающиеся, чтобы модель
// не путала пометку с содержимым сцены.

import { rasterize } from './images.js';
import { estimateAlignment } from './align.js';

export const PALETTE = [
  { key: 'magenta', hex: '#ff00ff', en: 'magenta', ru: 'пурпурный' },
  { key: 'cyan',    hex: '#00ffff', en: 'cyan',    ru: 'голубой' },
  { key: 'green',   hex: '#00ff00', en: 'green',   ru: 'зелёный' },
  { key: 'yellow',  hex: '#ffff00', en: 'yellow',  ru: 'жёлтый' },
  { key: 'blue',    hex: '#0000ff', en: 'blue',    ru: 'синий' },
];

const MARK_ALPHA = 0.45;
const VIEW_ALPHA = 0.55;
const MAX_EDGE = 2048;
const FEATHER_RATIO = 0.004;

const state = {
  bitmap: null,
  width: 0,
  height: 0,
  strokes: [],   // { size, erase, color, points: [[x, y], …] }
  current: null,
  size: 48,
  erase: false,
  color: PALETTE[0].key,
};

let ui = null;
let layers = new Map();   // key -> canvas с белыми штрихами этого цвета

export function init(elements) {
  ui = elements;

  const pos = (e) => {
    const r = ui.canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (state.width / r.width),
      (e.clientY - r.top) * (state.height / r.height),
    ];
  };

  ui.canvas.addEventListener('pointerdown', (e) => {
    if (!state.bitmap) return;
    ui.canvas.setPointerCapture(e.pointerId);
    state.current = { size: state.size, erase: state.erase, color: state.color, points: [pos(e)] };
    state.strokes.push(state.current);
    stampDot(state.current, state.current.points[0]);
    render();
  });

  ui.canvas.addEventListener('pointermove', (e) => {
    if (!state.current) return;
    const from = state.current.points[state.current.points.length - 1];
    const to = pos(e);
    state.current.points.push(to);
    // Дорисовываем только новый отрезок: полная перерисовка на каждое движение
    // означала бы аллокацию полноразмерного холста на кадр.
    stampSegment(state.current, from, to);
    render();
  });

  const finish = () => { state.current = null; };
  ui.canvas.addEventListener('pointerup', finish);
  ui.canvas.addEventListener('pointercancel', finish);
  ui.canvas.addEventListener('pointerleave', finish);
}

/** Готовит редактор к работе с картинкой. */
export async function load(source) {
  // SVG от векторных моделей createImageBitmap не декодирует — растеризуем.
  const blob = await rasterize(source, MAX_EDGE);
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));

  state.bitmap = bmp;
  state.width = Math.round(bmp.width * scale);
  state.height = Math.round(bmp.height * scale);
  state.strokes = [];
  state.current = null;

  layers = new Map();
  for (const c of PALETTE) {
    const canvas = document.createElement('canvas');
    canvas.width = state.width;
    canvas.height = state.height;
    layers.set(c.key, canvas);
  }

  ui.canvas.width = state.width;
  ui.canvas.height = state.height;
  ui.image.src = URL.createObjectURL(blob);

  // Кисть по умолчанию — примерно двенадцатая часть кадра: такой удобно
  // попадать по объекту, а не по пикселям.
  setSize(Math.round(Math.max(state.width, state.height) / 12));
  render();
}

export function setSize(px) {
  state.size = Math.max(4, Math.round(px));
  if (ui.sizeInput) ui.sizeInput.value = String(state.size);
  if (ui.sizeLabel) ui.sizeLabel.textContent = `${state.size} px`;
}

export function setColor(key) { state.color = key; }
export const activeColor = () => state.color;
export function setErase(on) { state.erase = on; }
export const isErasing = () => state.erase;
export const dimensions = () => ({ width: state.width, height: state.height });

export function undo() {
  state.strokes.pop();
  rebuild();
  render();
}

export function clear() {
  state.strokes = [];
  rebuild();
  render();
}

/* ── Рисование в слои ──────────────────────────────────── */

function ctxFor(canvas, stroke, erase) {
  const ctx = canvas.getContext('2d');
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke.size;
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  return ctx;
}

/**
 * Штрих ложится в слой своего цвета и одновременно вычищается из остальных:
 * пиксель принадлежит ровно одному цвету, иначе поверх старой пометки
 * получилась бы мутная смесь.
 */
function eachTarget(stroke, fn) {
  for (const [key, canvas] of layers) {
    // Ластик стирает везде; обычный штрих ложится в свой слой и вычищается
    // из чужих, чтобы поверх старой пометки не вышло смеси двух цветов.
    const erase = stroke.erase || key !== stroke.color;
    fn(ctxFor(canvas, stroke, erase));
  }
}

function stampDot(stroke, [x, y]) {
  eachTarget(stroke, (ctx) => {
    ctx.beginPath();
    ctx.arc(x, y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
  });
}

function stampSegment(stroke, from, to) {
  eachTarget(stroke, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(to[0], to[1]);
    ctx.stroke();
  });
}

/** Полная перерисовка слоёв — нужна только после отмены и сброса. */
function rebuild() {
  for (const canvas of layers.values()) {
    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, state.width, state.height);
  }
  for (const stroke of state.strokes) {
    if (!stroke.points.length) continue;
    stampDot(stroke, stroke.points[0]);
    for (let i = 1; i < stroke.points.length; i++) {
      stampSegment(stroke, stroke.points[i - 1], stroke.points[i]);
    }
  }
}

/* ── Производные картинки ──────────────────────────────── */

function blank() {
  const c = document.createElement('canvas');
  c.width = state.width;
  c.height = state.height;
  return c;
}

/** Есть ли в слое хоть один непрозрачный пиксель (проверка по уменьшенной копии). */
function layerUsed(canvas) {
  const probe = document.createElement('canvas');
  const k = Math.min(1, 96 / Math.max(state.width, state.height));
  probe.width = Math.max(1, Math.round(state.width * k));
  probe.height = Math.max(1, Math.round(state.height * k));
  const ctx = probe.getContext('2d');
  ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
  const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
  return false;
}

/** Цвета, которыми действительно что-то закрашено. */
export function usedColors() {
  return PALETTE.filter((c) => layerUsed(layers.get(c.key)));
}

export const isEmpty = () => usedColors().length === 0;

/** Объединение всех слоёв — маска для склейки. */
function union() {
  const c = blank();
  const ctx = c.getContext('2d');
  for (const canvas of layers.values()) ctx.drawImage(canvas, 0, 0);
  return c;
}

/** Слой, залитый своим цветом. */
function tinted(colorKey, alpha) {
  const c = blank();
  const ctx = c.getContext('2d');
  ctx.drawImage(layers.get(colorKey), 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = PALETTE.find((p) => p.key === colorKey).hex;
  ctx.fillRect(0, 0, state.width, state.height);
  return c;
}

/** Показ поверх картинки в редакторе. */
function render() {
  const ctx = ui.canvas.getContext('2d');
  ctx.clearRect(0, 0, state.width, state.height);
  for (const c of PALETTE) ctx.drawImage(tinted(c.key, VIEW_ALPHA), 0, 0);
}

/** Копия картинки с пометками — второй референс для модели. */
export async function buildAnnotated() {
  const c = blank();
  const ctx = c.getContext('2d');
  ctx.drawImage(state.bitmap, 0, 0, state.width, state.height);
  ctx.globalAlpha = MARK_ALPHA;
  for (const colour of usedColors()) ctx.drawImage(tinted(colour.key, 1), 0, 0);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

/** Оригинал в рабочем разрешении — первый референс и основа для склейки. */
export async function buildOriginal() {
  const c = blank();
  c.getContext('2d').drawImage(state.bitmap, 0, 0, state.width, state.height);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

/**
 * Склейка: из результата берётся только закрашенное, остальное — из оригинала.
 * Перед этим результат совмещается с оригиналом, иначе на границе маски
 * возникает задвоение: модель перерисовывает кадр и композиция уезжает.
 */
export async function compose(resultBlob) {
  const result = await createImageBitmap(resultBlob);
  const mask = union();

  const fit = estimateAlignment(state.bitmap, result, mask, state.width, state.height);

  const base = blank();
  const ctx = base.getContext('2d');
  ctx.drawImage(state.bitmap, 0, 0, state.width, state.height);

  const patch = blank();
  patch.getContext('2d').drawImage(
    result,
    fit.tx, fit.ty,
    state.width * fit.scale, state.height * fit.scale,
  );

  const feather = Math.max(1, Math.round(Math.max(state.width, state.height) * FEATHER_RATIO));
  const soft = blank();
  const sctx = soft.getContext('2d');
  sctx.filter = `blur(${feather}px)`;
  sctx.drawImage(mask, 0, 0);

  const pctx = patch.getContext('2d');
  pctx.globalCompositeOperation = 'destination-in';
  pctx.drawImage(soft, 0, 0);

  ctx.drawImage(patch, 0, 0);
  result.close?.();

  const blob = await new Promise((res) => base.toBlob(res, 'image/png'));
  return { blob, fit };
}

/**
 * Инструкция для модели. Пользовательский текст обрамляется каркасом,
 * который объясняет, что такое цветные пятна и что снаружи трогать нельзя.
 * Цвета названы по-английски и по-русски — промпт можно писать на любом.
 */
export function buildPrompt(userText) {
  const text = userText.trim().replace(/[.!;]*$/, '.');   // иначе слипается со следующим предложением
  const colours = usedColors();
  const list = colours.map((c) => `${c.en} (${c.ru})`).join(', ');
  const areas = colours.length > 1
    ? `Image 2 marks several regions with translucent overlays in these colours: ${list}. The instructions below refer to those colours; apply each one to its own region.`
    : `Image 2 is the same picture with a translucent ${list} overlay marking one region.`;

  return [
    'You are given two images of the same picture.',
    'Image 1 is the original.',
    areas,
    `Instructions: ${text}`,
    'Everything outside the marked regions must stay exactly as in image 1 — same composition, framing, colors, lighting, textures and details.',
    'The overlays are instruction markers: they must not appear anywhere in the output.',
    'Return the full picture at the same framing and aspect ratio as image 1.',
  ].join(' ');
}
