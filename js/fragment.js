// Фрагмент выделения в отдельный файл: растровая часть.
//
// Растр фрагмента рисует редактор: лист PDF через pdf.js в нужной
// плотности, картинку в её родных пикселях. Здесь он срезается по
// многоугольникам выделения и сжимается в PNG или JPEG. У фрагмента листа
// в файл записывается плотность: программы вёрстки и Word ставят его в
// размер, какой у него на листе. Векторный фрагмент PDF собирает
// pdfdoc.fragment.

export const JPEG_QUALITY = 0.95;

/**
 * Выделение и есть прямоугольник по осям. Его рамка на листе целиком
 * внутри него, и срезать фрагмент по нему нечего, даже если прямоугольник
 * выходит за край листа.
 */
export function isFrame(sel) {
  if (sel.polys.length !== 1 || sel.polys[0].length !== 4) return false;
  const [a, b, c, d] = sel.polys[0];
  const same = (u, v) => Math.abs(u - v) < 1e-6;
  return (same(a[1], b[1]) && same(b[0], c[0]) && same(c[1], d[1]) && same(d[0], a[0]))
    || (same(a[0], b[0]) && same(b[1], c[1]) && same(c[0], d[0]) && same(d[1], a[1]));
}

/**
 * Холст, срезанный по многоугольникам выделения: вне их прозрачно. map:
 * точка листа -> пиксель холста. Срез идёт на новый холст: pdf.js рисует
 * лист на холсте без альфа-канала, и прозрачное на нём стало бы чёрным.
 * Многоугольники идут одним путём с общим направлением обхода:
 * пересечение двух не вырезает дыру.
 */
export function clipTo(canvas, polys, map) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.beginPath();
  for (const poly of polys) {
    const pts = poly.map(map);
    if (signedArea(pts) < 0) pts.reverse();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
  ctx.fillStyle = '#fff';
  ctx.fill('nonzero');
  ctx.globalCompositeOperation = 'source-in';
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return out;
}

/**
 * Холст в файл. type: 'png' | 'jpeg'. У JPEG нет прозрачности: под
 * прозрачным лежит белое. dpi > 0 записывается в файл.
 */
export async function encode(canvas, type, dpi = 0) {
  if (type === 'jpeg') {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
  const mime = type === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('Фрагмент не сжался: браузеру не хватило памяти. Возьми плотность меньше.'))),
    mime, type === 'jpeg' ? JPEG_QUALITY : undefined));
  if (!dpi) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return type === 'jpeg' ? jpegDpi(bytes, dpi) : pngDpi(bytes, dpi);
}

/* Плотность в файле */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG с блоком pHYs: точек на метр, сразу за заголовком IHDR. Прежний pHYs уходит. */
export function pngDpi(bytes, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);   // pHYs
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1;                              // единица: метр
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  for (let at = 8; at + 12 <= bytes.length;) {
    const end = at + 12 + view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type !== 'pHYs') parts.push(bytes.subarray(at, end));
    if (type === 'IHDR') parts.push(chunk);
    at = end;
  }
  return new Blob(parts, { type: 'image/png' });
}

/** JPEG с плотностью в заголовке JFIF; если заголовка нет, он добавляется. */
export function jpegDpi(bytes, dpi) {
  const hi = (dpi >> 8) & 255;
  const lo = dpi & 255;
  const jfif = bytes[2] === 0xff && bytes[3] === 0xe0
    && String.fromCharCode(...bytes.subarray(6, 11)) === 'JFIF\0';
  if (jfif) {
    const b = bytes.slice();
    b.set([1, hi, lo, hi, lo], 13);   // единица: дюйм; плотность по x и y
    return new Blob([b], { type: 'image/jpeg' });
  }
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, hi, lo, hi, lo, 0, 0]);
  return new Blob([bytes.subarray(0, 2), app0, bytes.subarray(2)], { type: 'image/jpeg' });
}

/** Удвоенная площадь со знаком: знак задаёт направление обхода. */
function signedArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return s;
}
