// Кисть для локальных правок.
//
// Настоящей маски в Images API нет ни у одной модели, поэтому область
// передаётся визуально: модель получает оригинал и его копию с пурпурной
// заливкой поверх нужного места. Пурпур выбран потому, что в фотографиях
// почти не встречается — модель не путает его с содержимым сцены.
//
// Модель всё равно перерисовывает кадр целиком, поэтому итог склеивается
// с оригиналом по той же маске: снаружи закраски пиксели остаются прежними.

import { rasterize } from './images.js';

const MARK_COLOR = '#ff00ff';
const MARK_ALPHA = 0.45;
const MAX_EDGE = 2048;        // потолок рабочего разрешения маски
const FEATHER_RATIO = 0.004;  // растушёвка шва, доля от длинной стороны

const state = {
  bitmap: null,
  width: 0,
  height: 0,
  strokes: [],   // { size, erase, points: [[x, y], …] } в координатах картинки
  current: null,
  size: 48,
  erase: false,
};

let ui = null;
let maskC = null;   // постоянный холст маски: белое — то, что правим
let maskCtx = null;

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
    state.current = { size: state.size, erase: state.erase, points: [pos(e)] };
    state.strokes.push(state.current);
    // Одиночный тап тоже должен оставлять след, поэтому ставим точку сразу.
    stampDot(state.current, state.current.points[0]);
    render();
  });

  ui.canvas.addEventListener('pointermove', (e) => {
    if (!state.current) return;
    const from = state.current.points[state.current.points.length - 1];
    const to = pos(e);
    state.current.points.push(to);
    // Дорисовываем только новый отрезок: перерисовка всей маски на каждом
    // движении упиралась бы в аллокацию полноразмерного холста на кадр.
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

  maskC = document.createElement('canvas');
  maskC.width = state.width;
  maskC.height = state.height;
  maskCtx = maskC.getContext('2d');

  ui.canvas.width = state.width;
  ui.canvas.height = state.height;
  ui.image.src = URL.createObjectURL(blob);

  // Кисть по умолчанию — примерно двенадцатая часть кадра: с такой удобно
  // попадать по объекту, а не по пикселям.
  setSize(Math.round(Math.max(state.width, state.height) / 12));
  render();
}

export function setSize(px) {
  state.size = Math.max(4, Math.round(px));
  if (ui.sizeInput) ui.sizeInput.value = String(state.size);
  if (ui.sizeLabel) ui.sizeLabel.textContent = `${state.size} px`;
}

export function setErase(on) { state.erase = on; }
export const isErasing = () => state.erase;
export const isEmpty = () => !state.strokes.some((s) => !s.erase && s.points.length);
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

function prepare(stroke) {
  maskCtx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  maskCtx.lineCap = 'round';
  maskCtx.lineJoin = 'round';
  maskCtx.lineWidth = stroke.size;
  maskCtx.strokeStyle = '#fff';
  maskCtx.fillStyle = '#fff';
}

function stampDot(stroke, [x, y]) {
  prepare(stroke);
  maskCtx.beginPath();
  maskCtx.arc(x, y, stroke.size / 2, 0, Math.PI * 2);
  maskCtx.fill();
}

function stampSegment(stroke, from, to) {
  prepare(stroke);
  maskCtx.beginPath();
  maskCtx.moveTo(from[0], from[1]);
  maskCtx.lineTo(to[0], to[1]);
  maskCtx.stroke();
}

/** Полная перерисовка маски — нужна только после отмены и сброса. */
function rebuild() {
  maskCtx.globalCompositeOperation = 'source-over';
  maskCtx.clearRect(0, 0, state.width, state.height);
  for (const stroke of state.strokes) {
    if (!stroke.points.length) continue;
    stampDot(stroke, stroke.points[0]);
    for (let i = 1; i < stroke.points.length; i++) {
      stampSegment(stroke, stroke.points[i - 1], stroke.points[i]);
    }
  }
  maskCtx.globalCompositeOperation = 'source-over';
}

/** Пурпурная заливка маски: и для показа в редакторе, и для пометки модели. */
function tinted(alpha) {
  const c = document.createElement('canvas');
  c.width = state.width;
  c.height = state.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(maskC, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = MARK_COLOR;
  ctx.fillRect(0, 0, state.width, state.height);
  return c;
}

/** Показ поверх картинки в редакторе. */
function render() {
  const ctx = ui.canvas.getContext('2d');
  ctx.clearRect(0, 0, state.width, state.height);
  ctx.drawImage(tinted(0.55), 0, 0);
}

/** Копия картинки с пурпурной пометкой — второй референс для модели. */
export async function buildAnnotated() {
  const c = document.createElement('canvas');
  c.width = state.width;
  c.height = state.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(state.bitmap, 0, 0, state.width, state.height);
  ctx.globalAlpha = MARK_ALPHA;
  ctx.drawImage(tinted(1), 0, 0);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

/** Оригинал в рабочем разрешении — первый референс и основа для склейки. */
export async function buildOriginal() {
  const c = document.createElement('canvas');
  c.width = state.width;
  c.height = state.height;
  c.getContext('2d').drawImage(state.bitmap, 0, 0, state.width, state.height);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

/**
 * Склейка: из результата берётся только закрашенное, остальное — из оригинала.
 * Шов растушёвывается, иначе видна граница кисти.
 */
export async function compose(resultBlob) {
  const result = await createImageBitmap(resultBlob);

  const base = document.createElement('canvas');
  base.width = state.width;
  base.height = state.height;
  const ctx = base.getContext('2d');
  ctx.drawImage(state.bitmap, 0, 0, state.width, state.height);

  // Результат может прийти другого размера — подгоняем под оригинал.
  const patch = document.createElement('canvas');
  patch.width = state.width;
  patch.height = state.height;
  const pctx = patch.getContext('2d');
  pctx.drawImage(result, 0, 0, state.width, state.height);

  const feather = Math.max(1, Math.round(Math.max(state.width, state.height) * FEATHER_RATIO));
  const soft = document.createElement('canvas');
  soft.width = state.width;
  soft.height = state.height;
  const sctx = soft.getContext('2d');
  sctx.filter = `blur(${feather}px)`;
  sctx.drawImage(maskC, 0, 0);

  pctx.globalCompositeOperation = 'destination-in';
  pctx.drawImage(soft, 0, 0);

  ctx.drawImage(patch, 0, 0);
  result.close?.();
  return new Promise((res) => base.toBlob(res, 'image/png'));
}

/**
 * Инструкция для модели. Пользовательский текст обрамляется каркасом,
 * который объясняет, что такое пурпур и что снаружи трогать нельзя.
 */
export function buildPrompt(userText) {
  return [
    'You are given two images of the same picture.',
    'Image 1 is the original. Image 2 is the same picture with a magenta overlay marking one region.',
    `Change ONLY the region covered by the magenta overlay: ${userText.trim()}`,
    'Everything outside the marked region must stay exactly as in image 1 — same composition, colors, lighting, textures and details.',
    'The magenta overlay is an instruction marker: it must not appear anywhere in the output.',
    'Return the full picture at the same framing and aspect ratio.',
  ].join(' ');
}
