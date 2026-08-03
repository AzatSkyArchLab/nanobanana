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
export async function toReference(file) {
  const isPng = file.type === 'image/png';
  const bmp = await loadBitmap(file);
  const { width, height } = bmp;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));

  if (scale === 1 && file.size <= PASS_THROUGH_BYTES) {
    if (bmp.close) bmp.close();
    return { blob: file, width, height, name: file.name || 'reference' };
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
  return { blob: blob || file, width: w, height: h, name: file.name || 'reference' };
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
