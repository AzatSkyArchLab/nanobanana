// Версия берётся из адреса самого модуля и прокидывается во все импорты.
// GitHub Pages отдаёт файлы с max-age=600: без этого браузер способен склеить
// свежий index.html со старым кодом, и получается неработающая мешанина версий.
const V = new URL(import.meta.url).search;
export const BUILD = new URLSearchParams(V).get('v') || 'dev';

const [api, db, images] = await Promise.all([
  import('./api.js' + V),
  import('./db.js' + V),
  import('./images.js' + V),
]);
const { toReference, blobToDataUrl, base64ToBlob, download, extFor, isImage, difference } = images;

const $ = (id) => document.getElementById(id);

const el = {
  model: $('model'), modelHint: $('model-hint'),
  aspect: $('aspect'), resolution: $('resolution'),
  prompt: $('prompt'), dropzone: $('dropzone'), fileInput: $('file-input'),
  refs: $('refs'), refCounter: $('ref-counter'), refHint: $('ref-hint'),
  generate: $('generate'), cancel: $('cancel'),
  estimate: $('estimate'), status: $('status'),
  openPdf: $('open-pdf'), pdfInput: $('pdf-input'), sheetList: $('sheet-list'),
  grid: $('grid'), empty: $('empty'), clearHistory: $('clear-history'),
  statSpend: $('stat-spend'), statCredits: $('stat-credits'), statBuild: $('stat-build'),
  settings: $('settings'), openSettings: $('open-settings'),
  apiKey: $('api-key'), baseUrl: $('base-url'), cancelSettings: $('cancel-settings'),
  viewer: $('viewer'), viewerImg: $('viewer-img'), viewerPrompt: $('viewer-prompt'),
  viewerMeta: $('viewer-meta'), viewerRefs: $('viewer-refs'), viewerClose: $('viewer-close'),
  viewerDownload: $('viewer-download'), viewerToRef: $('viewer-toref'),
  viewerRepeat: $('viewer-repeat'), viewerDelete: $('viewer-delete'),
  viewerBrush: $('viewer-brush'),
  editor: $('editor'),
};

// Приблизительное число выходных токенов на картинку у моделей с потокенной
// тарификацией: только для оценки «до». Фактическая цена приходит в usage.cost
// и, как только она известна, вытесняет оценку.
const TOKENS_PER_IMAGE = { '512': 560, '1K': 1120, '2K': 1120, '4K': 2000 };
// Модель по умолчанию для нового браузера: первая доступная из списка.
const PREFERRED_MODELS = ['google/gemini-nano-banana-2.1', 'google/gemini-3.1-flash-image'];
const LS_LAST_MODEL = 'nb.lastModel';
// То же для обычной генерации: насколько результат отличается от
// референсов. Настоящая генерация даёт десятки, копия единицы.
const ECHO_LIMIT = 6;

const state = {
  models: [],
  pricing: new Map(),   // id -> { unit, byVariant }
  refs: [],             // { key, blob, url, name, fromPrompt? }
  history: [],
  gridUrls: new Set(),
  viewerUrls: new Set(),
  inflight: null,       // AbortController обычной генерации; у редактора свой
  drawing: false,       // обычная генерация ждёт ответа: в истории карточка «рисуется…»
  confirmRepeat: false,
};

/* ── Утилиты ───────────────────────────────────────────── */

const money = (v) => {
  if (v == null) return '—';
  if (!v) return '$0';
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
};

/** Русское число: plural(3, ['лист', 'листа', 'листов']) -> 'листа'. */
function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const isPdf = (file) => !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));

function urlIn(set, blob) {
  const url = URL.createObjectURL(blob);
  set.add(url);
  return url;
}

function release(set) {
  for (const url of set) URL.revokeObjectURL(url);
  set.clear();
}

function say(text, kind = '') {
  el.status.textContent = text;
  el.status.className = `status ${kind}`;
}

function currentModel() {
  return state.models.find((m) => m.id === el.model.value) || null;
}

function maxRefs() {
  const cap = currentModel()?.supported_parameters?.input_references;
  return cap ? (cap.max ?? 0) : 0;
}

/* ── Модели и их параметры ─────────────────────────────── */

// Nano Banana узнаётся по имени: у новых моделей в id уже нет слова image
// (google/gemini-nano-banana-2.1), и по одному id она уезжала в «Другие».
const isBanana = (m) => /nano banana/i.test(m.name || '') || (m.id.startsWith('google/gemini') && /image/.test(m.id));

async function loadModels() {
  const { data } = await api.listImageModels();

  // Превью-дубли скрываем, когда есть стабильный близнец с тем же именем.
  const stable = new Set(data.map((m) => m.id).filter((id) => !id.endsWith('-preview')));
  const visible = data.filter((m) => !(m.id.endsWith('-preview') && stable.has(m.id.replace('-preview', ''))));

  const bananas = visible.filter(isBanana).sort((a, b) => b.created - a.created);
  const others = visible.filter((m) => !isBanana(m)).sort((a, b) => a.name.localeCompare(b.name));

  state.models = [...bananas, ...others];

  const group = (label, items) => {
    if (!items.length) return null;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const m of items) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = shortName(m.name);
      g.appendChild(o);
    }
    return g;
  };

  el.model.replaceChildren(
    ...[group('Nano Banana', bananas), group('Другие модели', others)].filter(Boolean)
  );

  const saved = localStorage.getItem(LS_LAST_MODEL);
  const pick = [saved, ...PREFERRED_MODELS, state.models[0]?.id].find((id) => id && state.models.some((m) => m.id === id));
  el.model.value = pick;
  await applyModel();
}

function fillSelect(select, values, { auto = false, preferred = [] } = {}) {
  if (!values || !values.length) {
    select.replaceChildren();
    select.disabled = true;
    return;
  }
  const prev = select.value;
  const opts = auto ? ['auto', ...values] : values;
  select.replaceChildren(...opts.map((v) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v === 'auto' ? 'авто' : v;
    return o;
  }));
  select.disabled = false;
  const pick = [prev, ...preferred].find((v) => opts.includes(v));
  select.value = pick ?? opts[0];
}

async function applyModel() {
  const model = currentModel();
  if (!model) return;
  localStorage.setItem(LS_LAST_MODEL, model.id);

  const params = model.supported_parameters || {};
  fillSelect(el.aspect, params.aspect_ratio?.values, { auto: true, preferred: ['1:1'] });
  fillSelect(el.resolution, params.resolution?.values, { preferred: ['2K', '1K'] });

  const cap = maxRefs();
  el.modelHint.textContent = cap
    ? `До ${cap} референсов на запрос.`
    : 'Модель не принимает референсы: только текст.';
  // Лишние референсы не удаляются: смена модели ради цены не должна
  // молча выбрасывать собранные картинки. Они гаснут, генерация их не примет.
  renderRefs();

  await loadPricing(model.id);
  updateEstimate();
  editorModule.loaded?.syncModels();
}

async function loadPricing(id) {
  if (state.pricing.has(id)) return;
  try {
    const { endpoints } = await api.listModelEndpoints(id);
    const lines = endpoints?.[0]?.pricing || [];
    const out = lines.filter((p) => p.billable === 'output_image');
    if (!out.length) return;
    state.pricing.set(id, {
      unit: out[0].unit,
      byVariant: Object.fromEntries(out.map((p) => [p.variant || 'default', p.cost_usd])),
    });
  } catch {
    // Прайс не критичен: точная цена всё равно придёт в ответе.
  }
}

function estimateCost(modelId, resolution) {
  // Факт всегда точнее оценки: если такие генерации уже были, берём среднее.
  const seen = state.history.filter((r) => r.model === modelId && r.resolution === resolution && r.cost > 0);
  if (seen.length) {
    return { value: seen.reduce((s, r) => s + r.cost, 0) / seen.length, actual: true };
  }
  const price = state.pricing.get(modelId);
  if (!price) return null;
  const key = (resolution || '').toLowerCase();
  const cost = price.byVariant[key] ?? price.byVariant.default ?? Object.values(price.byVariant)[0];
  if (cost == null) return null;
  if (price.unit === 'image') return { value: cost, actual: false };
  if (price.unit === 'token') {
    const tokens = TOKENS_PER_IMAGE[resolution] ?? TOKENS_PER_IMAGE['1K'];
    return { value: cost * tokens, actual: false };
  }
  return null;
}

const shortName = (name) => name.replace(/^Google:\s*/, '');
const currentResolution = () => (el.resolution.disabled ? undefined : el.resolution.value);

/**
 * Сообщение на время ожидания. Скорость у моделей разная, от секунд
 * у Riverflow Fast до минуты у Pro, поэтому время берётся из истории
 * этой же модели, как и оценка стоимости.
 */
function busyText(model) {
  const seen = state.history.filter((r) => r.model === model.id && r.seconds > 0);
  const name = shortName(model.name);
  if (!seen.length) return `Запрос ушёл в «${name}». Может занять до минуты.`;
  const avg = Math.round(seen.reduce((s, r) => s + r.seconds, 0) / seen.length);
  return `Запрос ушёл в «${name}», обычно ${avg} с.`;
}

function updateEstimate() {
  const est = estimateCost(el.model.value, currentResolution());
  el.estimate.textContent = est
    ? (est.actual ? `Обычно ${money(est.value)} за картинку по прошлым запускам.` : `Примерно ${money(est.value)} за картинку.`)
    : '';
}

/* ── Референсы ─────────────────────────────────────────── */

let refKey = 0;

async function addFiles(files) {
  const all = Array.from(files || []);
  const pdf = all.find(isPdf);
  if (pdf) {
    openPdfFile(pdf);
    return;
  }

  const cap = maxRefs();
  if (!cap) { say('Выбранная модель не принимает референсы.', 'error'); return; }

  const incoming = all.filter(isImage);
  if (!incoming.length) return;

  const room = cap - state.refs.length;
  if (room <= 0) { say(`Уже ${state.refs.length} референсов при лимите ${cap}: больше модель не примет.`, 'error'); return; }

  for (const file of incoming.slice(0, room)) {
    try {
      const { blob, name } = await toReference(file);
      state.refs.push({ key: ++refKey, blob, url: URL.createObjectURL(blob), name });
    } catch {
      say(`Не удалось прочитать «${file.name}».`, 'error');
    }
  }
  if (incoming.length > room) say(`Добавлено ${room} из ${incoming.length}: лимит модели ${cap}.`);
  renderRefs();
  updateEstimate();
}

function removeRef(key) {
  const i = state.refs.findIndex((r) => r.key === key);
  if (i < 0) return;
  URL.revokeObjectURL(state.refs[i].url);
  state.refs.splice(i, 1);
  renderRefs();
}

/** Подтверждение повтора действует только для той пары «промпт + референсы». */
function resetRepeat() {
  if (!state.confirmRepeat) return;
  state.confirmRepeat = false;
  el.generate.textContent = 'Сгенерировать';
}

function renderRefs() {
  const cap = maxRefs();
  el.refs.replaceChildren(...state.refs.map((ref, i) => {
    const div = document.createElement('div');
    div.className = 'ref';
    if (i >= cap) {
      div.classList.add('over');
      div.title = cap ? `Модель примет только ${cap}: этот не уйдёт` : 'Модель не принимает референсы';
    }
    const img = document.createElement('img');
    img.src = ref.url;
    img.alt = ref.name;
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.title = 'Убрать';
    btn.addEventListener('click', () => removeRef(ref.key));

    const pencil = document.createElement('button');
    pencil.className = 'edit';
    pencil.textContent = '✎';
    pencil.title = 'Исправить кистью';
    pencil.addEventListener('click', () => openEditor(ref.blob, ref.name));

    div.append(img, pencil, btn);
    return div;
  }));
  resetRepeat();
  el.refCounter.textContent = cap || state.refs.length ? `${state.refs.length} / ${cap}` : '';
  el.refCounter.classList.toggle('error', state.refs.length > cap);
  el.dropzone.hidden = cap === 0;
  el.refHint.hidden = state.refs.length === 0;
}

/* ── Генерация ─────────────────────────────────────────── */

function setBusy(busy) {
  el.generate.disabled = busy;
  el.cancel.hidden = !busy;
  el.generate.textContent = busy ? 'Генерирую…' : 'Сгенерировать';
}

function showPending(on) {
  let card = el.grid.querySelector('.card.pending');
  if (on && !card) {
    card = document.createElement('div');
    card.className = 'card pending';
    card.innerHTML = '<div class="thumb">рисуется…</div>';
    el.grid.prepend(card);
    el.empty.hidden = true;
  } else if (!on && card) {
    card.remove();
  }
}

/**
 * Запись в историю. Сначала показ, потом база: если IndexedDB откажет
 * (кончилось место), оплаченная картинка всё равно видна и скачивается.
 */
async function saveRecord(record) {
  state.history.unshift(record);
  renderHistory();
  updateEstimate();
  try {
    await db.add(record);
    return true;
  } catch (e) {
    record.unsaved = true;
    say(`Картинка получена, но в историю браузера не записалась (${e.message || e.name}). Скачай её, пока страница открыта.`, 'error');
    return false;
  }
}

/** Запись уже в истории, но её картинка сменилась (другая граница склейки). */
async function updateRecord(record) {
  renderHistory();
  if (!record.unsaved) await db.put(record).catch(() => {});
}

async function generate() {
  // ⌘Enter работает и при заблокированной кнопке: второй запрос сюда не пускаем.
  if (state.inflight) return;
  if (!api.getKey()) {
    say('Сначала добавь ключ OpenRouter.', 'error');
    openSettings();
    return;
  }
  const prompt = el.prompt.value.trim();
  if (!prompt) { say('Нужен промпт.', 'error'); el.prompt.focus(); return; }

  const model = currentModel();
  if (!model) {
    say('Список моделей не загрузился. Пробую ещё раз, повтори запуск через пару секунд.', 'error');
    loadModels().then(() => say('Список моделей загружен.')).catch(() => {});
    return;
  }
  const cap = maxRefs();
  if (state.refs.length > cap) {
    say(cap
      ? `«${shortName(model.name)}» принимает ${cap} реф., приложено ${state.refs.length}. Убери лишние или смени модель.`
      : `«${shortName(model.name)}» не принимает референсы: убери их или смени модель.`, 'error');
    return;
  }

  // Тем же промптом по тому же изображению модель вернёт его же. Ловим до
  // отправки: после неё деньги уже списаны.
  const repeat = state.refs.some((r) => r.fromPrompt && r.fromPrompt.trim() === prompt);
  if (repeat && !state.confirmRepeat) {
    state.confirmRepeat = true;
    el.generate.textContent = 'Всё равно отправить';
    say('Этим же промптом получен приложенный референс, модель вернёт его копию. Опиши, ЧТО ИЗМЕНИТЬ, или нажми ещё раз.', 'error');
    return;
  }
  state.confirmRepeat = false;

  const resolution = currentResolution();
  const aspectRatio = el.aspect.disabled ? undefined : el.aspect.value;
  // Референсы запоминаются на момент отправки: пока модель думает, список
  // можно менять, а в истории должно остаться то, что ушло на самом деле.
  const sent = state.refs.slice();

  const ctrl = new AbortController();
  state.inflight = ctrl;
  state.drawing = true;
  setBusy(true);
  showPending(true);
  say(busyText(model), 'busy');

  try {
    const references = await Promise.all(sent.map((r) => blobToDataUrl(r.blob)));
    const started = Date.now();
    const res = await api.generate({
      model: model.id, prompt, references, aspectRatio, resolution,
      signal: ctrl.signal,
    });

    const image = res?.data?.[0];
    if (!image?.b64_json) throw new Error('Ответ без изображения: модель отказалась генерировать.');

    const record = {
      id: `${started}-${Math.random().toString(36).slice(2, 8)}`,
      ts: started,
      model: model.id,
      modelName: model.name,
      prompt,
      aspect: aspectRatio,
      resolution,
      cost: res.usage?.cost ?? 0,
      seconds: Math.round((Date.now() - started) / 1000),
      outType: image.media_type || 'image/png',
      out: base64ToBlob(image.b64_json, image.media_type || 'image/png'),
      refs: sent.map((r) => r.blob),
    };

    state.drawing = false;
    showPending(false);
    const saved = await saveRecord(record);

    // Модель отвечает копией референса, когда промпт ОПИСЫВАЕТ приложенную
    // картинку вместо того, чтобы говорить, что с ней сделать. Сравниваем со
    // всеми референсами: копией может оказаться любой из них.
    let echo = null;
    if (record.refs.length) {
      const diffs = await Promise.all(record.refs.map((b) => difference(record.out, b).catch(() => Infinity)));
      echo = Math.min(...diffs);
    }
    const copied = echo != null && echo < ECHO_LIMIT;
    if (copied) {
      record.echo = true;
      if (saved) await db.put(record).catch(() => {});
      renderHistory();
    }
    if (saved) {
      say(copied
        ? `Модель вернула референс почти без изменений (${echo.toFixed(1)} из 255) · ${money(record.cost)}. Промпт должен говорить, ЧТО СДЕЛАТЬ с референсом: описание приложенного модель понимает как просьбу вернуть его же.`
        : `Готово за ${record.seconds} с · ${money(record.cost)}`,
        copied ? 'error' : '');
    }
    // Агрегация расхода на стороне OpenRouter отстаёт примерно на полминуты,
    // поэтому баланс перечитывается ещё раз. Счётчик «Потрачено» точен сразу:
    // он складывается из usage.cost каждого ответа.
    refreshCredits();
    setTimeout(refreshCredits, 30000);
  } catch (e) {
    if (e.name === 'AbortError') say('Отменено.');
    else say(e.message || 'Не получилось.', 'error');
  } finally {
    state.inflight = null;
    state.drawing = false;
    setBusy(false);
    showPending(false);
  }
}

/* ── Редактор: кисть, области с референсами, листы PDF ─── */

// Модуль редактора грузится при первом открытии: если он не загрузится,
// обычная генерация продолжит работать.
let editorPromise = null;
function editorModule() {
  if (!editorPromise) {
    editorPromise = import('./editor.js' + V).then((ed) => {
      ed.init({
        api,
        modelSelect: el.model,
        resolutionSelect: el.resolution,
        currentModel,
        maxRefs,
        aspectValues: () => currentModel()?.supported_parameters?.aspect_ratio?.values || [],
        resolution: currentResolution,
        setModel: async (id) => { el.model.value = id; await applyModel(); },
        setResolution: (v) => { el.resolution.value = v; updateEstimate(); },
        estimate: () => estimateCost(el.model.value, currentResolution()),
        money,
        shortName,
        busyText,
        plural,
        saveRecord,
        updateRecord,
        refreshCredits,
        openViewer,
        onSheetsChanged: renderSheets,
      });
      editorModule.loaded = ed;
      return ed;
    }).catch((e) => {
      editorPromise = null;
      throw e;
    });
  }
  return editorPromise;
}
editorModule.loaded = null;

async function withEditor(fn) {
  try {
    await fn(await editorModule());
  } catch (e) {
    say(`Редактор не открылся: ${e.message || e}`, 'error');
  }
}

function openEditor(blob, name) {
  if (el.viewer.open) el.viewer.close();
  return withEditor((ed) => ed.openImage(blob, name));
}

function openPdfFile(file) {
  return withEditor((ed) => ed.openPdfFile(file));
}

function openSheet(id) {
  return withEditor((ed) => ed.openSheet(id));
}

async function renderSheets() {
  let docs;
  try {
    docs = await db.sheets.list();
  } catch {
    el.sheetList.textContent = 'Список недоступен: браузер не дал доступ к IndexedDB.';
    return;
  }
  el.sheetList.replaceChildren(...docs.map((d) => {
    const row = document.createElement('div');
    row.className = 'sheet-row';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'sheet-open';
    const name = document.createElement('span');
    name.textContent = d.name;
    const meta = document.createElement('small');
    const edits = d.count ? `${d.count} ${plural(d.count, ['правка', 'правки', 'правок'])}` : 'без правок';
    const when = new Date(d.ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    meta.textContent = `${d.pages} ${plural(d.pages, ['лист', 'листа', 'листов'])} · ${edits} · ${when}`;
    open.append(name, meta);
    open.addEventListener('click', () => openSheet(d.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small danger';
    del.textContent = '×';
    del.title = 'Убрать из браузера';
    del.addEventListener('click', async () => {
      if (!confirm(`Убрать «${d.name}» и принятые правки из этого браузера? Файл на диске не тронется.`)) return;
      await db.sheets.remove(d.id).catch(() => {});
      renderSheets();
    });

    row.append(open, del);
    return row;
  }));
}

/* ── История ───────────────────────────────────────────── */

function renderHistory() {
  release(state.gridUrls);
  el.grid.replaceChildren(...state.history.map((rec) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.tabIndex = 0;

    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.src = urlIn(state.gridUrls, rec.out);
    img.alt = rec.prompt.slice(0, 80);

    const cap = document.createElement('div');
    cap.className = 'caption';
    const p = document.createElement('p');
    p.textContent = rec.prompt;
    const small = document.createElement('small');
    const when = new Date(rec.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const tail = rec.echo ? ' · копия референса'
      : rec.kind === 'sheet' ? ` · лист ${rec.page}`
      : rec.kind === 'brush' ? ' · кисть'
      : rec.refs.length ? ` · ${rec.refs.length} реф.` : '';
    small.textContent = `${when} · ${money(rec.cost)}${tail}${rec.unsaved ? ' · не сохранено' : ''}`;
    cap.append(p, small);

    card.append(img, cap);
    card.addEventListener('click', () => openViewer(rec.id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openViewer(rec.id); });
    return card;
  }));

  // Правка из редактора может прийти, пока идёт обычная генерация:
  // её карточка «рисуется…» не должна пропасть.
  if (state.drawing) showPending(true);

  el.empty.hidden = state.history.length > 0 || state.drawing;
  const spent = state.history.reduce((s, r) => s + (r.cost || 0), 0);
  el.statSpend.textContent = `Потрачено ${money(spent)} · ${state.history.length} шт.`;
}

/* ── Просмотр ──────────────────────────────────────────── */

let viewing = null;

function openViewer(id) {
  const rec = state.history.find((r) => r.id === id);
  if (!rec) return;
  viewing = rec;
  // Адреса прошлого просмотра отпускаются при следующем открытии. Событие
  // close приходит позже и убило бы адреса уже открытой следующей записи.
  release(state.viewerUrls);

  el.viewerImg.src = urlIn(state.viewerUrls, rec.out);
  el.viewerPrompt.textContent = rec.prompt;

  const rows = [
    ['Модель', shortName(rec.modelName)],
    ...(rec.kind === 'sheet' ? [['PDF', `${rec.doc}, лист ${rec.page}`]] : []),
    ['Формат', [rec.resolution, rec.aspect].filter(Boolean).join(' · ') || '—'],
    ['Стоимость', money(rec.cost)],
    ['Время', `${rec.seconds} с`],
    ['Дата', new Date(rec.ts).toLocaleString('ru-RU')],
  ];
  el.viewerMeta.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));

  el.viewerRefs.replaceChildren(...rec.refs.map((blob) => {
    const img = document.createElement('img');
    img.src = urlIn(state.viewerUrls, blob);
    img.alt = 'референс';
    return img;
  }));

  if (!el.viewer.open) el.viewer.showModal();
}

async function useAsReference() {
  if (!viewing) return;
  const cap = maxRefs();
  if (state.refs.length >= cap) { say(`Лимит референсов: ${cap}.`, 'error'); return; }

  try {
    // Через toReference: у векторных моделей результат SVG,
    // его нужно растеризовать, иначе он уйдёт в запрос неподъёмным для модели.
    const { blob } = await toReference(new File([viewing.out], 'result', { type: viewing.outType }));
    // Запоминаем, каким промптом получен этот референс: повторная отправка того же
    // текста верный способ получить назад его же копию.
    state.refs.push({ key: ++refKey, blob, url: URL.createObjectURL(blob), name: 'result', fromPrompt: viewing.prompt });
  } catch {
    say('Результат не удалось прочитать как картинку.', 'error');
    return;
  }

  renderRefs();
  el.viewer.close();
  el.prompt.focus();
  say('Результат добавлен в референсы.');
}

function repeatSettings() {
  if (!viewing) return;
  const rec = viewing;
  el.prompt.value = rec.prompt;
  resetRepeat();
  if (state.models.some((m) => m.id === rec.model)) {
    el.model.value = rec.model;
    applyModel().then(() => {
      if (rec.aspect && !el.aspect.disabled) el.aspect.value = rec.aspect;
      if (rec.resolution && !el.resolution.disabled) el.resolution.value = rec.resolution;
      updateEstimate();
    });
  }
  el.viewer.close();
  el.prompt.focus();
}

async function deleteCurrent() {
  if (!viewing) return;
  await db.remove(viewing.id).catch(() => {});
  state.history = state.history.filter((r) => r.id !== viewing.id);
  renderHistory();
  el.viewer.close();
}

/* ── Настройки ─────────────────────────────────────────── */

function openSettings() {
  el.apiKey.value = api.getKey();
  el.baseUrl.value = api.getBase();
  // returnValue живёт между открытиями: без сброса Esc после прошлого
  // «Сохранить» снова сохранял бы правку поля.
  el.settings.returnValue = '';
  el.settings.showModal();
}

function saveSettings() {
  api.setKey(el.apiKey.value);
  api.setBase(el.baseUrl.value);
  refreshCredits();
  say(api.getKey() ? 'Ключ сохранён.' : 'Ключ удалён.');
  // Сменился адрес или сеть появилась: список моделей мог не загрузиться при старте.
  if (!state.models.length) {
    loadModels().catch((e) => say(`Не удалось загрузить список моделей: ${e.message}`, 'error'));
  }
}

async function refreshCredits() {
  if (!api.getKey()) { el.statCredits.textContent = 'Ключ не задан'; return; }
  try {
    const { data } = await api.getCredits();
    const total = data.total_credits ?? data.credits ?? 0;
    const used = data.total_usage ?? data.usage ?? 0;
    el.statCredits.textContent = `Остаток ${money(total - used)}`;
  } catch {
    el.statCredits.textContent = 'Баланс недоступен';
  }
}

/* ── Связывание ────────────────────────────────────────── */

function bind() {
  el.model.addEventListener('change', applyModel);
  el.resolution.addEventListener('change', updateEstimate);
  el.generate.addEventListener('click', generate);
  el.cancel.addEventListener('click', () => state.inflight?.abort());

  el.prompt.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate();
  });
  el.prompt.addEventListener('input', resetRepeat);

  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); } });
  el.fileInput.addEventListener('change', () => { addFiles(el.fileInput.files); el.fileInput.value = ''; });

  for (const type of ['dragenter', 'dragover']) {
    el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('over'));
  }
  el.dropzone.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); addFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    // PDF, брошенный куда угодно на страницу, открывается в редакторе.
    if (el.editor.open) return;
    const pdf = Array.from(e.dataTransfer?.files || []).find(isPdf);
    if (pdf) openPdfFile(pdf);
  });

  document.addEventListener('paste', (e) => {
    // В открытом редакторе вставка достаётся выбранной области редактора.
    if (el.editor.open || el.settings.open) return;
    if (e.clipboardData?.files?.length) addFiles(e.clipboardData.files);
  });

  el.openPdf.addEventListener('click', () => el.pdfInput.click());
  el.pdfInput.addEventListener('change', () => {
    const file = el.pdfInput.files?.[0];
    el.pdfInput.value = '';
    if (file) openPdfFile(file);
  });

  el.openSettings.addEventListener('click', openSettings);
  el.cancelSettings.addEventListener('click', () => el.settings.close('cancel'));
  el.settings.addEventListener('close', () => { if (el.settings.returnValue === 'save') saveSettings(); });

  el.viewerClose.addEventListener('click', () => el.viewer.close());
  el.viewerDownload.addEventListener('click', () => {
    if (viewing) download(viewing.out, `nanobanana-${viewing.ts}.${extFor(viewing.outType)}`);
  });
  el.viewerToRef.addEventListener('click', useAsReference);
  el.viewerBrush.addEventListener('click', () => { if (viewing) openEditor(viewing.out, 'результат'); });
  el.viewerRepeat.addEventListener('click', repeatSettings);
  el.viewerDelete.addEventListener('click', deleteCurrent);

  el.clearHistory.addEventListener('click', async () => {
    if (!state.history.length) return;
    if (!confirm('Удалить всю историю генераций из этого браузера?')) return;
    await db.clear();
    state.history = [];
    renderHistory();
  });
}

/**
 * GitHub Pages кеширует и сам index.html на 10 минут, поэтому свежая версия
 * может не доехать до браузера. Сверяемся с version.json (мимо кеша) и один
 * раз перезагружаемся: обычная перезагрузка перепрашивает документ у сервера.
 */
async function checkBuild() {
  if (BUILD === 'dev') return;
  try {
    const res = await fetch(`version.json?t=${BUILD}`, { cache: 'no-store' });
    const { build } = await res.json();
    if (!build || build === BUILD) return;
    if (sessionStorage.getItem('nb.reloadedFor') === build) {
      say(`Загружена сборка ${BUILD}, на сервере ${build}. Обнови страницу с ⇧⌘R.`, 'error');
      return;
    }
    sessionStorage.setItem('nb.reloadedFor', build);
    location.reload();
  } catch {
    // Нет сети или файла: не повод мешать работе.
  }
}

async function init() {
  $('build-id').textContent = BUILD;
  el.statBuild.textContent = `сборка ${BUILD}`;
  checkBuild();
  bind();
  renderRefs();
  renderSheets();
  try {
    state.history = await db.all();
    renderHistory();
  } catch {
    say('История недоступна: браузер не дал доступ к IndexedDB.', 'error');
  }
  try {
    await loadModels();
  } catch (e) {
    say(`Не удалось загрузить список моделей: ${e.message}`, 'error');
  }
  refreshCredits();
  if (!api.getKey()) openSettings();
}

init();
