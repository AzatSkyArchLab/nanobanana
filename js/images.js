// Подготовка референсов и работа с блобами.

const MAX_EDGE = 1536;      // выше этого модель всё равно не читает — только платим за токены
const PASS_THROUGH_BYTES = 1_500_000;

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export function base64ToBlob(b64, type = 'image/png') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

const SVG_TYPE = 'image/svg+xml';

/**
 * Векторные модели (Recraft *-vector) отдают SVG. В <img> он рисуется, но
 * createImageBitmap его не декодирует — значит ни кисть, ни отправка обратно
 * референсом с ним не работают. Поэтому SVG заранее переводится в растр.
 * Растровые блобы возвращаются как есть.
 */
export async function rasterize(blob, edge = 1536) {
  if (blob.type !== SVG_TYPE) return blob;

  const doc = new DOMParser().parseFromString(await blob.text(), SVG_TYPE);
  const svg = doc.documentElement;
  const box = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);

  let w = parseFloat(svg.getAttribute('width'));
  let h = parseFloat(svg.getAttribute('height'));
  if (!(w > 0) || !(h > 0)) {
    [w, h] = box.length === 4 && box[2] > 0 ? [box[2], box[3]] : [1024, 1024];
  }

  // Без явных размеров браузер рисует SVG в 150 px — задаём рабочий кадр сами.
  const k = edge / Math.max(w, h);
  const rw = Math.max(1, Math.round(w * k));
  const rh = Math.max(1, Math.round(h * k));
  svg.setAttribute('width', String(rw));
  svg.setAttribute('height', String(rh));

  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: SVG_TYPE }));
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('SVG не отрисовался'));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = rw;
    c.height = rh;
    c.getContext('2d').drawImage(img, 0, 0, rw, rh);   // PNG сохранит прозрачность
    return await new Promise((res) => c.toBlob(res, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadBitmap(blob) {
  if (window.createImageBitmap) return createImageBitmap(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать изображение')); };
    img.src = url;
  });
}

/**
 * Файл -> референс. Большие картинки ужимаются до MAX_EDGE по длинной стороне:
 * это заметно ускоряет запрос и снижает плату за входные токены.
 * PNG остаётся PNG (важно для прозрачности), остальное уходит в JPEG.
 */
export async function toReference(source) {
  const name = source.name || 'reference';
  const file = await rasterize(source, MAX_EDGE);
  const isPng = file.type === 'image/png';
  const bmp = await loadBitmap(file);
  const { width, height } = bmp;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));

  if (scale === 1 && file.size <= PASS_THROUGH_BYTES) {
    if (bmp.close) bmp.close();
    return { blob: file, width, height, name };
  }

  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();

  const type = isPng ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((res) => canvas.toBlob(res, type, 0.92));
  return { blob: blob || file, width: w, height: h, name };
}

/**
 * Средняя разница канала между двумя картинками, 0…255. Нужна, чтобы поймать
 * случай, когда модель вернула референс вместо новой картинки: шум пережатия
 * даёт единицы, настоящая генерация — десятки.
 */
export async function difference(a, b, edge = 256) {
  const draw = async (blob) => {
    const bmp = await createImageBitmap(await rasterize(blob, edge));
    const c = document.createElement('canvas');
    c.width = edge;
    c.height = edge;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, edge, edge);   // обе к общей рамке: пропорции могут не совпадать
    bmp.close?.();
    return ctx.getImageData(0, 0, edge, edge).data;
  };
  const [A, B] = await Promise.all([draw(a), draw(b)]);
  let sum = 0;
  for (let i = 0; i < A.length; i += 4) {
    sum += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
  }
  return sum / (A.length / 4 * 3);
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function extFor(type) {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/svg+xml') return 'svg';
  return 'png';
}

export const isImage = (file) => file && file.type.startsWith('image/');
