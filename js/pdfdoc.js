// PDF: показ листов через pdf.js и запись правок через pdf-lib.
//
// Обе библиотеки лежат в js/vendor и загружаются только при открытии PDF.
//
// Правка ложится на лист растровой заплаткой поверх исходного содержимого.
// За пределами заплатки лист остаётся векторным и побитово прежним, текст
// и линии вне правки не превращаются в картинку. Заплатка на весь лист
// (замена листа целиком) вычищает старое содержимое страницы.
//
// Фрагмент листа сохраняется отдельным PDF той же векторной страницей,
// обрезанной по выделению (fragment).
//
// Координаты заплаток хранятся в пунктах листа так, как его видно на экране:
// с учётом поворота /Rotate и смещения CropBox. Перевод в систему координат
// страницы делает pdf.js (convertToPdfPoint), тем же преобразованием, каким
// он рисует лист.

const PDFJS = new URL('./vendor/pdfjs-5.7.284/', import.meta.url);
const PDFLIB = new URL('./vendor/pdf-lib-1.17.1/pdf-lib.esm.min.js', import.meta.url);

let pdfjs = null;

async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = import(new URL('pdf.min.mjs', PDFJS).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', PDFJS).href;
      return lib;
    });
  }
  return pdfjs;
}

const bitmaps = new WeakMap();   // Blob -> Promise<ImageBitmap>
function bitmapOf(blob) {
  if (!bitmaps.has(blob)) bitmaps.set(blob, createImageBitmap(blob));
  return bitmaps.get(blob);
}

export const isPdf = (file) => !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));

/** Открывает документ. bytes остаются нетронутыми: pdf.js получает копию. */
export async function open(bytes) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({
    data: bytes.slice(),   // pdf.js передаёт буфер в воркер и отсоединяет его
    wasmUrl: new URL('wasm/', PDFJS).href,
    standardFontDataUrl: new URL('standard_fonts/', PDFJS).href,
    iccUrl: new URL('iccs/', PDFJS).href,
    isEvalSupported: false,
    enableXfa: false,
  });
  try {
    return new PdfDoc(await task.promise);
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('PDF защищён паролем: сними защиту и открой снова.');
    throw new Error(`PDF не читается: ${e?.message || e}`);
  }
}

export class PdfDoc {
  constructor(proxy) {
    this.proxy = proxy;
    this.count = proxy.numPages;
    this.pages = new Map();
  }

  page(i) {
    if (!this.pages.has(i)) this.pages.set(i, this.proxy.getPage(i + 1));
    return this.pages.get(i);
  }

  /** Размер листа в пунктах, как его видно: с учётом поворота. */
  async size(i) {
    const v = (await this.page(i)).getViewport({ scale: 1 });
    return { width: v.width, height: v.height };
  }

  /**
   * Растр кадра f (см. marks.frameOf) с наложенными заплатками. Всё, что
   * вне листа, остаётся белым: так фрагмент у края листа дополняется полем.
   */
  async render(i, f, patches = [], signal) {
    const page = await this.page(i);
    const canvas = document.createElement('canvas');
    canvas.width = f.w;
    canvas.height = f.h;
    const task = page.render({
      canvas,
      viewport: page.getViewport({ scale: f.k }),
      transform: [1, 0, 0, 1, -f.x * f.k, -f.y * f.k],
      background: '#ffffff',
    });
    const stop = () => task.cancel();
    signal?.addEventListener('abort', stop);
    try {
      await task.promise;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    if (patches.length) {
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      for (const p of patches) {
        const bmp = await bitmapOf(p.blob);
        ctx.drawImage(bmp, (p.x - f.x) * f.k, (p.y - f.y) * f.k, p.w * f.k, p.h * f.k);
      }
    }
    return canvas;
  }

  destroy() {
    this.proxy.destroy();
  }
}

/**
 * Документ с правками. bytes: исходный файл, patches: принятые заплатки
 * в порядке приёма: { page, x, y, w, h, full, blob }.
 */
export async function build(bytes, doc, patches) {
  const lib = await import(PDFLIB.href);
  const { PDFDocument, PDFName } = lib;
  const out = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  // pdf-lib не расшифровывает: новый слой лёг бы рядом с зашифрованным
  // содержимым, и программы просмотра показали бы мусор.
  if (out.isEncrypted) {
    throw new Error('PDF зашифрован (защита от изменений), пересохранить его нельзя. Сними защиту, например печатью в PDF, и открой снова.');
  }

  const byPage = new Map();
  for (const p of patches) {
    if (!byPage.has(p.page)) byPage.set(p.page, []);
    byPage.get(p.page).push(p);
  }

  for (const [index, list] of byPage) {
    const page = out.getPage(index);
    const viewport = (await doc.page(index)).getViewport({ scale: 1 });

    // Замена листа целиком перекрывает всё, что было до неё: старое
    // содержимое вычищается, иначе оно осталось бы в файле под картинкой,
    // а текст находился бы поиском.
    const last = list.findLastIndex((p) => p.full);
    if (last >= 0) page.node.set(PDFName.of('Contents'), out.context.obj([]));

    for (const p of list.slice(Math.max(0, last))) await drawPatch(lib, out, page, viewport, p);
  }
  return out.save();
}

/** Заплатка p поверх содержимого страницы page. */
async function drawPatch(lib, out, page, viewport, p) {
  const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = lib;
  const image = await out.embedPng(await p.blob.arrayBuffer());
  // Картинка в PDF рисуется в единичный квадрат: (0,0) левый нижний угол.
  // Три угла заплатки в координатах страницы задают матрицу целиком,
  // включая поворот листа.
  const [ox, oy] = viewport.convertToPdfPoint(p.x, p.y + p.h);
  const [rx, ry] = viewport.convertToPdfPoint(p.x + p.w, p.y + p.h);
  const [tx, ty] = viewport.convertToPdfPoint(p.x, p.y);
  const name = page.node.newXObject('NbPatch', image.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(rx - ox, ry - oy, tx - ox, ty - oy, ox, oy),
    drawObject(name),
    popGraphicsState(),
  );
}

/**
 * Фрагмент листа index отдельным PDF. Страница размером с рамку box
 * [x0, y0, x1, y1] в пунктах листа, как его видно: масштаб листа
 * сохраняется, линии и текст остаются векторными. Принятые заплатки
 * ложатся поверх, как при сохранении документа. polys: многоугольники
 * выделения, вне их лист срезан; null, если выделение и есть рамка box.
 *
 * Лист за краем фрагмента скрыт обрезкой и клипом и остаётся в файле:
 * векторное содержимое по рамке не разрезать.
 */
export async function fragment(bytes, doc, index, box, polys, patches, title = '') {
  const lib = await import(PDFLIB.href);
  const {
    PDFDocument, PDFName, PDFObjectCopier, PDFPage,
    pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath,
  } = lib;
  let src;
  try {
    src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    throw new Error(`Векторный фрагмент не собрался: pdf-lib не разобрал файл (${e.message || e}). PNG и JPEG этого листа сохраняются.`);
  }
  if (src.isEncrypted) {
    throw new Error('PDF зашифрован (защита от изменений): векторный фрагмент из него не собрать. Сохрани фрагмент в PNG или JPEG.');
  }
  const viewport = (await doc.page(index)).getViewport({ scale: 1 });
  const srcPage = src.getPage(index);
  detach(lib, srcPage);

  const out = await PDFDocument.create({ updateMetadata: false });
  // Один копировщик на страницу и слои: ссылки листа на слои ведут на те
  // же копии, что перечислены в каталоге. Без каталога слоёв скрытые слои
  // листа во фрагменте стали бы видны.
  const copier = PDFObjectCopier.for(src.context, out.context);
  const node = copier.copy(srcPage.node);
  const page = PDFPage.of(node, out.context.register(node), out);
  out.addPage(page);
  const layers = src.catalog.get(PDFName.of('OCProperties'));
  if (layers) out.catalog.set(PDFName.of('OCProperties'), copier.copy(layers));
  if (title) out.setTitle(title);

  const last = patches.findLastIndex((p) => p.full);
  if (last >= 0 || !node.Contents()) node.set(PDFName.of('Contents'), out.context.obj([]));
  // Содержимое листа уходит в q … Q (так делает pdf-lib): заплатки
  // встают в исходные координаты страницы, что бы лист ни менял.
  node.normalize();
  const contents = node.Contents();

  // Клип охватывает и лист, и заплатки. Обход всех многоугольников
  // приводится к одному направлению: так их пересечение не вырезает дыру.
  const toPage = ([x, y]) => viewport.convertToPdfPoint(x, y);
  const [x0, y0, x1, y1] = box;
  const frame = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const path = [];
  for (const poly of polys || [frame]) {
    const pts = poly.map(toPage);
    if (signedArea(pts) < 0) pts.reverse();
    path.push(moveTo(...pts[0]), ...pts.slice(1).map((v) => lineTo(...v)), closePath());
  }
  contents.insert(0, out.context.register(out.context.contentStream([pushGraphicsState(), ...path, clip(), endPath()])));
  for (const p of patches.slice(Math.max(0, last))) {
    const part = await cropPatch(p, box);
    if (part) await drawPatch(lib, out, page, viewport, part);
  }
  contents.push(out.context.register(out.context.contentStream([popGraphicsState()])));

  // Все рамки страницы по фрагменту: программы вёрстки берут какую-то одну.
  const corners = frame.map(toPage);
  const ux = Math.min(...corners.map((v) => v[0]));
  const uy = Math.min(...corners.map((v) => v[1]));
  const uw = Math.max(...corners.map((v) => v[0])) - ux;
  const uh = Math.max(...corners.map((v) => v[1])) - uy;
  page.setMediaBox(ux, uy, uw, uh);
  page.setCropBox(ux, uy, uw, uh);
  page.setBleedBox(ux, uy, uw, uh);
  page.setTrimBox(ux, uy, uw, uh);
  page.setArtBox(ux, uy, uw, uh);
  return out.save();
}

/**
 * Лист отвязывается от остального документа, иначе копия потянула бы за
 * собой другие листы. Ссылки уходят: переходы на другие листы во
 * фрагменте не нужны. У остальных пометок снимаются действия и ссылки на
 * страницу и поля формы, их вид остаётся. Уходят и миниатюра всего листа,
 * и данные Illustrator: по ним он открыл бы весь лист.
 */
function detach(lib, page) {
  const { PDFName, PDFArray, PDFDict } = lib;
  const N = (s) => PDFName.of(s);
  const node = page.node;
  for (const key of ['B', 'AA', 'Thumb', 'PieceInfo', 'StructParents']) node.delete(N(key));
  const annots = node.lookup(N('Annots'));
  if (!(annots instanceof PDFArray)) {
    node.delete(N('Annots'));
    return;
  }
  const kept = [];
  for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookup(i);
    if (!(a instanceof PDFDict)) continue;
    const type = a.get(N('Subtype'));
    if (type === N('Link')) continue;
    for (const key of ['P', 'A', 'AA', 'Dest']) a.delete(N(key));
    if (type === N('Widget')) a.delete(N('Parent'));
    kept.push(annots.get(i));
  }
  node.set(N('Annots'), node.context.obj(kept));
}

/** Часть заплатки p внутри рамки box в её же пикселях; null, если не задевает. */
async function cropPatch(p, [x0, y0, x1, y1]) {
  if (p.x >= x1 || p.y >= y1 || p.x + p.w <= x0 || p.y + p.h <= y0) return null;
  const bmp = await bitmapOf(p.blob);
  const sx = bmp.width / p.w;
  const sy = bmp.height / p.h;
  const a = Math.max(0, Math.floor((x0 - p.x) * sx));
  const b = Math.max(0, Math.floor((y0 - p.y) * sy));
  const c = Math.min(bmp.width, Math.ceil((x1 - p.x) * sx));
  const d = Math.min(bmp.height, Math.ceil((y1 - p.y) * sy));
  if (c <= a || d <= b) return null;
  if (a === 0 && b === 0 && c === bmp.width && d === bmp.height) return p;
  const canvas = document.createElement('canvas');
  canvas.width = c - a;
  canvas.height = d - b;
  canvas.getContext('2d').drawImage(bmp, a, b, c - a, d - b, 0, 0, c - a, d - b);
  const blob = await new Promise((resolve, reject) => canvas.toBlob(
    (v) => (v ? resolve(v) : reject(new Error('Заплатка фрагмента не сжалась в PNG.'))), 'image/png'));
  return { ...p, x: p.x + a / sx, y: p.y + b / sy, w: (c - a) / sx, h: (d - b) / sy, blob };
}

/** Удвоенная площадь со знаком: знак задаёт направление обхода. */
function signedArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return s;
}
