import * as api from './api.js';
import * as db from './db.js';
import * as brush from './brush.js';
import { toReference, blobToDataUrl, base64ToBlob, download, extFor, isImage } from './images.js';

const $ = (id) => document.getElementById(id);

const el = {
  model: $('model'), modelHint: $('model-hint'),
  aspect: $('aspect'), resolution: $('resolution'),
  prompt: $('prompt'), dropzone: $('dropzone'), fileInput: $('file-input'),
  refs: $('refs'), refCounter: $('ref-counter'),
  generate: $('generate'), cancel: $('cancel'),
  estimate: $('estimate'), status: $('status'),
  grid: $('grid'), empty: $('empty'), clearHistory: $('clear-history'),
  statSpend: $('stat-spend'), statCredits: $('stat-credits'),
  settings: $('settings'), openSettings: $('open-settings'),
  apiKey: $('api-key'), baseUrl: $('base-url'), saveSettings: $('save-settings'),
  viewer: $('viewer'), viewerImg: $('viewer-img'), viewerPrompt: $('viewer-prompt'),
  viewerMeta: $('viewer-meta'), viewerRefs: $('viewer-refs'), viewerClose: $('viewer-close'),
  viewerDownload: $('viewer-download'), viewerToRef: $('viewer-toref'),
  viewerRepeat: $('viewer-repeat'), viewerDelete: $('viewer-delete'),
  viewerBrush: $('viewer-brush'),
  brush: $('brush'), brushImg: $('brush-img'), brushCanvas: $('brush-canvas'),
  brushSize: $('brush-size'), brushSizeVal: $('brush-size-val'),
  brushMode: $('brush-mode'), brushUndo: $('brush-undo'), brushClear: $('brush-clear'),
  brushColors: $('brush-colors'), brushLegend: $('brush-legend'),
  brushPrompt: $('brush-prompt'), brushKeep: $('brush-keep'),
  brushRun: $('brush-run'), brushCancel: $('brush-cancel'), brushStatus: $('brush-status'),
};

// Приблизительное число выходных токенов на картинку у моделей с потокенной
// тарификацией — только для оценки «до». Фактическая цена приходит в usage.cost
// и, как только она известна, вытесняет оценку.
const TOKENS_PER_IMAGE = { '512': 560, '1K': 1120, '2K': 1120, '4K': 2000 };
const PREFERRED_MODEL = 'google/gemini-3.1-flash-image';
const LS_LAST_MODEL = 'nb.lastModel';

const state = {
  models: [],
  pricing: new Map(),   // id -> { unit, cost, variants }
  refs: [],             // { key, blob, url, name }
  history: [],
  objectUrls: new Set(),
  inflight: null,
};

/* ── Утилиты ───────────────────────────────────────────── */

const money = (v) => {
  if (v == null) return '—';
  if (!v) return '$0';
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
};

function trackUrl(blob) {
  const url = URL.createObjectURL(blob);
  state.objectUrls.add(url);
  return url;
}

function releaseUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls.clear();
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

async function loadModels() {
  const { data } = await api.listImageModels();

  // Превью-дубли скрываем, когда есть стабильный близнец с тем же именем.
  const stable = new Set(data.map((m) => m.id).filter((id) => !id.endsWith('-preview')));
  const visible = data.filter((m) => !(m.id.endsWith('-preview') && stable.has(m.id.replace('-preview', ''))));

  const isBanana = (m) => m.id.startsWith('google/gemini') && /image/.test(m.id);
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
  const pick = [saved, PREFERRED_MODEL, state.models[0]?.id].find((id) => id && state.models.some((m) => m.id === id));
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
    : 'Модель не принимает референсы — только текст.';
  if (state.refs.length > cap) {
    state.refs.splice(cap).forEach((r) => URL.revokeObjectURL(r.url));
  }
  renderRefs();

  await loadPricing(model.id);
  updateEstimate();
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
    // Прайс — не критично: точная цена всё равно придёт в ответе.
  }
}

function estimateCost(modelId, resolution) {
  // Факт всегда точнее оценки: если такие генерации уже были — берём среднее.
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

/**
 * Сообщение на время ожидания. Скорость у моделей разная — от секунд
 * у Riverflow Fast до минуты у Pro, — поэтому время берётся из истории
 * этой же модели, как и оценка стоимости.
 */
function busyText(model) {
  const seen = state.history.filter((r) => r.model === model.id && r.seconds > 0);
  const name = shortName(model.name);
  if (!seen.length) return `Запрос ушёл в «${name}». Может занять до минуты.`;
  const avg = Math.round(seen.reduce((s, r) => s + r.seconds, 0) / seen.length);
  return `Запрос ушёл в «${name}» — обычно ${avg} с.`;
}

function updateEstimate() {
  const est = estimateCost(el.model.value, el.resolution.disabled ? undefined : el.resolution.value);
  el.estimate.textContent = est
    ? (est.actual ? `Обычно ${money(est.value)} за картинку — по прошлым запускам.` : `Примерно ${money(est.value)} за картинку.`)
    : '';
}

/* ── Референсы ─────────────────────────────────────────── */

let refKey = 0;

async function addFiles(files) {
  const cap = maxRefs();
  if (!cap) { say('Выбранная модель не принимает референсы.', 'error'); return; }

  const incoming = Array.from(files).filter(isImage);
  if (!incoming.length) return;

  const room = cap - state.refs.length;
  if (room <= 0) { say(`Уже ${cap} референсов — больше модель не примет.`, 'error'); return; }

  for (const file of incoming.slice(0, room)) {
    try {
      const { blob, name } = await toReference(file);
      state.refs.push({ key: ++refKey, blob, url: URL.createObjectURL(blob), name });
    } catch {
      say(`Не удалось прочитать «${file.name}».`, 'error');
    }
  }
  if (incoming.length > room) say(`Добавлено ${room} из ${incoming.length}: лимит модели — ${cap}.`);
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

function renderRefs() {
  el.refs.replaceChildren(...state.refs.map((ref) => {
    const div = document.createElement('div');
    div.className = 'ref';
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
    pencil.addEventListener('click', () => openBrush(ref.blob));

    div.append(img, pencil, btn);
    return div;
  }));
  const cap = maxRefs();
  el.refCounter.textContent = cap ? `${state.refs.length} / ${cap}` : '';
  el.dropzone.hidden = cap === 0;
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

async function generate() {
  if (!api.getKey()) {
    say('Сначала добавь ключ OpenRouter.', 'error');
    openSettings();
    return;
  }
  const prompt = el.prompt.value.trim();
  if (!prompt) { say('Нужен промпт.', 'error'); el.prompt.focus(); return; }

  const model = currentModel();
  const resolution = el.resolution.disabled ? undefined : el.resolution.value;
  const aspectRatio = el.aspect.disabled ? undefined : el.aspect.value;

  state.inflight = new AbortController();
  setBusy(true);
  showPending(true);
  say(busyText(model), 'busy');

  try {
    const references = await Promise.all(state.refs.map((r) => blobToDataUrl(r.blob)));
    const started = Date.now();
    const res = await api.generate({
      model: model.id, prompt, references, aspectRatio, resolution,
      signal: state.inflight.signal,
    });

    const image = res?.data?.[0];
    if (!image?.b64_json) throw new Error('Ответ без изображения — модель отказалась генерировать.');

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
      refs: state.refs.map((r) => r.blob),
    };

    await db.add(record);
    state.history.unshift(record);
    renderHistory();
    updateEstimate();
    say(`Готово за ${record.seconds} с · ${money(record.cost)}`);
    // Агрегация расхода на стороне OpenRouter отстаёт примерно на полминуты,
    // поэтому баланс перечитывается ещё раз. Счётчик «Потрачено» точен сразу —
    // он складывается из usage.cost каждого ответа.
    refreshCredits();
    setTimeout(refreshCredits, 30000);
  } catch (e) {
    if (e.name === 'AbortError') say('Отменено.');
    else say(e.message || 'Не получилось.', 'error');
  } finally {
    state.inflight = null;
    setBusy(false);
    showPending(false);
  }
}

/* ── Кисть: локальная правка ───────────────────────────── */

/** Ближайшая к картинке пропорция из тех, что принимает модель. */
function closestAspect(width, height) {
  if (el.aspect.disabled) return undefined;
  const target = Math.log(width / height);
  let best = null;
  for (const o of el.aspect.options) {
    if (o.value === 'auto') continue;
    const [w, h] = o.value.split(':').map(Number);
    const d = Math.abs(Math.log(w / h) - target);
    if (!best || d < best.d) best = { value: o.value, d };
  }
  return best?.value;
}

function buildSwatches() {
  el.brushColors.replaceChildren(...brush.PALETTE.map((colour) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = colour.hex;
    b.title = colour.ru;
    b.dataset.key = colour.key;
    b.addEventListener('click', () => selectColour(colour.key));
    return b;
  }));
}

function selectColour(key) {
  brush.setColor(key);
  brush.setErase(false);
  el.brushMode.textContent = 'Ластик';
  el.brushMode.classList.remove('active');
  for (const b of el.brushColors.children) b.classList.toggle('active', b.dataset.key === key);
}

/** Подсказка, какими словами ссылаться на закрашенное. */
function updateLegend() {
  const used = brush.usedColors();
  el.brushLegend.textContent = used.length
    ? `Закрашено: ${used.map((c) => c.ru).join(', ')}. Ссылайся на цвета в тексте.`
    : '';
}

async function openBrush(blob) {
  // Кисть шлёт две картинки: оригинал и его размеченную копию.
  if (maxRefs() < 2) {
    const model = currentModel();
    const fits = state.models.filter((m) => (m.supported_parameters?.input_references?.max ?? 0) >= 2);
    const hint = fits.slice(0, 2).map((m) => `«${shortName(m.name)}»`).join(' или ');
    say(`Кисти нужны два референса, а «${shortName(model.name)}» принимает ${maxRefs()}. Подойдёт ${hint}.`, 'error');
    return;
  }
  el.brushStatus.textContent = '';
  el.brushStatus.className = 'status';
  el.brushPrompt.value = '';
  el.viewer.close();
  el.brush.showModal();
  await brush.load(blob);
  selectColour(brush.PALETTE[0].key);
  updateLegend();
}

async function runBrush() {
  const text = el.brushPrompt.value.trim();
  if (brush.isEmpty()) { el.brushStatus.textContent = 'Сначала закрась область.'; el.brushStatus.className = 'status error'; return; }
  if (!text) { el.brushStatus.textContent = 'Опиши, что должно быть в этой области.'; el.brushStatus.className = 'status error'; el.brushPrompt.focus(); return; }
  if (!api.getKey()) { el.brushStatus.textContent = 'Нет ключа OpenRouter.'; el.brushStatus.className = 'status error'; return; }

  const model = currentModel();
  const { width, height } = brush.dimensions();
  const resolution = el.resolution.disabled ? undefined : el.resolution.value;

  state.inflight = new AbortController();
  el.brushRun.disabled = true;
  el.brushStatus.textContent = 'Исправляю…';
  el.brushStatus.className = 'status busy';

  try {
    const [original, annotated] = await Promise.all([brush.buildOriginal(), brush.buildAnnotated()]);
    const references = await Promise.all([original, annotated].map(blobToDataUrl));
    const started = Date.now();

    const res = await api.generate({
      model: model.id,
      prompt: brush.buildPrompt(text),
      references,
      aspectRatio: closestAspect(width, height),
      resolution,
      signal: state.inflight.signal,
    });

    const image = res?.data?.[0];
    if (!image?.b64_json) throw new Error('Ответ без изображения.');

    let out = base64ToBlob(image.b64_json, image.media_type || 'image/png');
    let outType = image.media_type || 'image/png';
    let fit = null;
    if (el.brushKeep.checked) {
      ({ blob: out, fit } = await brush.compose(out));   // снаружи маски остаётся оригинал
      outType = 'image/png';
    }

    const record = {
      id: `${started}-${Math.random().toString(36).slice(2, 8)}`,
      ts: started,
      model: model.id,
      modelName: model.name,
      prompt: text,
      kind: 'brush',
      composed: el.brushKeep.checked,
      aspect: closestAspect(width, height),
      resolution,
      cost: res.usage?.cost ?? 0,
      seconds: Math.round((Date.now() - started) / 1000),
      outType,
      out,
      refs: [annotated],
    };

    await db.add(record);
    state.history.unshift(record);
    renderHistory();
    updateEstimate();
    el.brushStatus.textContent = '';
    el.brushStatus.className = 'status';
    el.brush.close();
    const drift = fit && (Math.abs(fit.tx) > 1 || Math.abs(fit.ty) > 1 || fit.scale !== 1)
      ? ` · кадр совмещён (сдвиг ${Math.round(fit.tx)}/${Math.round(fit.ty)} px, масштаб ${fit.scale.toFixed(2)})`
      : '';
    say(`Правка готова за ${record.seconds} с · ${money(record.cost)}${drift}`);
    openViewer(record.id);
    refreshCredits();
    setTimeout(refreshCredits, 30000);
  } catch (e) {
    el.brushStatus.textContent = e.name === 'AbortError' ? 'Отменено.' : (e.message || 'Не получилось.');
    el.brushStatus.className = 'status error';
  } finally {
    state.inflight = null;
    el.brushRun.disabled = false;
  }
}

/* ── История ───────────────────────────────────────────── */

function renderHistory() {
  releaseUrls();
  el.grid.replaceChildren(...state.history.map((rec) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.tabIndex = 0;

    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.src = trackUrl(rec.out);
    img.alt = rec.prompt.slice(0, 80);

    const cap = document.createElement('div');
    cap.className = 'caption';
    const p = document.createElement('p');
    p.textContent = rec.prompt;
    const small = document.createElement('small');
    const when = new Date(rec.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const tail = rec.kind === 'brush' ? ' · кисть' : (rec.refs.length ? ` · ${rec.refs.length} реф.` : '');
    small.textContent = `${when} · ${money(rec.cost)}${tail}`;
    cap.append(p, small);

    card.append(img, cap);
    card.addEventListener('click', () => openViewer(rec.id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openViewer(rec.id); });
    return card;
  }));

  el.empty.hidden = state.history.length > 0;
  const spent = state.history.reduce((s, r) => s + (r.cost || 0), 0);
  el.statSpend.textContent = `Потрачено ${money(spent)} · ${state.history.length} шт.`;
}

/* ── Просмотр ──────────────────────────────────────────── */

let viewing = null;

function openViewer(id) {
  const rec = state.history.find((r) => r.id === id);
  if (!rec) return;
  viewing = rec;

  el.viewerImg.src = trackUrl(rec.out);
  el.viewerPrompt.textContent = rec.prompt;

  const rows = [
    ['Модель', shortName(rec.modelName)],
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
    img.src = trackUrl(blob);
    img.alt = 'референс';
    return img;
  }));

  el.viewer.showModal();
}

async function useAsReference() {
  if (!viewing) return;
  const cap = maxRefs();
  if (state.refs.length >= cap) { say(`Лимит референсов — ${cap}.`, 'error'); return; }

  // Через toReference, а не напрямую: у векторных моделей результат — SVG,
  // его нужно растеризовать, иначе он уйдёт в запрос неподъёмным для модели.
  const { blob } = await toReference(new File([viewing.out], 'result', { type: viewing.outType }));
  state.refs.push({ key: ++refKey, blob, url: URL.createObjectURL(blob), name: 'result' });

  renderRefs();
  el.viewer.close();
  el.prompt.focus();
  say('Результат добавлен в референсы.');
}

function repeatSettings() {
  if (!viewing) return;
  el.prompt.value = viewing.prompt;
  if (state.models.some((m) => m.id === viewing.model)) {
    el.model.value = viewing.model;
    applyModel().then(() => {
      if (viewing.aspect && !el.aspect.disabled) el.aspect.value = viewing.aspect;
      if (viewing.resolution && !el.resolution.disabled) el.resolution.value = viewing.resolution;
      updateEstimate();
    });
  }
  el.viewer.close();
  el.prompt.focus();
}

async function deleteCurrent() {
  if (!viewing) return;
  await db.remove(viewing.id);
  state.history = state.history.filter((r) => r.id !== viewing.id);
  renderHistory();
  el.viewer.close();
}

/* ── Настройки ─────────────────────────────────────────── */

function openSettings() {
  el.apiKey.value = api.getKey();
  el.baseUrl.value = api.getBase();
  el.settings.showModal();
}

function saveSettings() {
  api.setKey(el.apiKey.value);
  api.setBase(el.baseUrl.value);
  refreshCredits();
  say(api.getKey() ? 'Ключ сохранён.' : 'Ключ удалён.');
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

  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); } });
  el.fileInput.addEventListener('change', () => { addFiles(el.fileInput.files); el.fileInput.value = ''; });

  for (const type of ['dragenter', 'dragover']) {
    el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('over'));
  }
  el.dropzone.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('paste', (e) => {
    if (e.clipboardData?.files?.length) addFiles(e.clipboardData.files);
  });

  el.openSettings.addEventListener('click', openSettings);
  el.settings.addEventListener('close', () => { if (el.settings.returnValue === 'save') saveSettings(); });

  el.viewerClose.addEventListener('click', () => el.viewer.close());
  el.viewerDownload.addEventListener('click', () => {
    if (viewing) download(viewing.out, `nanobanana-${viewing.ts}.${extFor(viewing.outType)}`);
  });
  el.viewerToRef.addEventListener('click', useAsReference);
  el.viewerBrush.addEventListener('click', () => { if (viewing) openBrush(viewing.out); });

  brush.init({
    canvas: el.brushCanvas,
    image: el.brushImg,
    sizeInput: el.brushSize,
    sizeLabel: el.brushSizeVal,
  });
  buildSwatches();
  el.brushSize.addEventListener('input', () => brush.setSize(Number(el.brushSize.value)));
  el.brushUndo.addEventListener('click', () => { brush.undo(); updateLegend(); });
  el.brushClear.addEventListener('click', () => { brush.clear(); updateLegend(); });
  el.brushCanvas.addEventListener('pointerup', updateLegend);
  el.brushMode.addEventListener('click', () => {
    brush.setErase(!brush.isErasing());
    el.brushMode.classList.toggle('active', brush.isErasing());
    el.brushMode.textContent = brush.isErasing() ? 'Кисть' : 'Ластик';
  });
  el.brushRun.addEventListener('click', runBrush);
  el.brushCancel.addEventListener('click', () => el.brush.close());
  el.brush.addEventListener('close', () => state.inflight?.abort());
  el.brushPrompt.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runBrush();
  });
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

async function init() {
  bind();
  renderRefs();
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
