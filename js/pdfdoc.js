// PDF: показ листов через pdf.js и запись правок через pdf-lib.
//
// Обе библиотеки лежат в js/vendor и загружаются только при открытии PDF.
//
// Правка ложится на лист растровой заплаткой поверх исходного содержимого.
// За пределами заплатки лист остаётся векторным и побитово прежним, текст
// и линии вне правки не превращаются в картинку. Заплатка на весь лист
// (замена листа целиком) вычищает старое содержимое страницы.
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
  const { PDFDocument, PDFName, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = lib;
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

    for (const p of list.slice(Math.max(0, last))) {
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
  }
  return out.save();
}
