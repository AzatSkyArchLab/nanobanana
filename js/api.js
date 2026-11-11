// Единственный слой, который ходит в сеть.
// Когда/если появится собственный прокси (Cloudflare Worker с моим ключом
// и лимитами), меняется только BASE, остальное приложение не трогается.

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
const LS_KEY = 'nb.apiKey';
const LS_BASE = 'nb.baseUrl';

// Сколько раз генерация сама повторяется, когда резерв OpenRouter под
// запросы в полёте временно занят (см. limitText).
const IN_FLIGHT_RETRIES = 3;

export const getKey = () => localStorage.getItem(LS_KEY) || '';
export const setKey = (v) => v ? localStorage.setItem(LS_KEY, v.trim()) : localStorage.removeItem(LS_KEY);

export const getBase = () => localStorage.getItem(LS_BASE) || DEFAULT_BASE;
export const setBase = (v) => {
  const clean = (v || '').trim().replace(/\/+$/, '');
  if (!clean || clean === DEFAULT_BASE) localStorage.removeItem(LS_BASE);
  else localStorage.setItem(LS_BASE, clean);
};

function headers() {
  const h = { 'Content-Type': 'application/json' };
  const key = getKey();
  if (key) h['Authorization'] = `Bearer ${key}`;
  // Необязательные заголовки атрибуции: приложение видно в статистике OpenRouter.
  h['HTTP-Referer'] = location.origin === 'null' ? 'http://localhost' : location.origin;
  h['X-Title'] = 'nanobanana';
  return h;
}

class ApiError extends Error {
  /** extra: raw (текст OpenRouter), reason и limitSource (из metadata), retryAfter (с). */
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function humanize(status, raw) {
  switch (status) {
    case 401: return 'Ключ не принят. Проверь, что он скопирован целиком и не отозван.';
    case 403: return raw || 'Запрос отклонён модерацией провайдера.';
    case 429: return 'Слишком часто. Подожди несколько секунд и повтори.';
    case 502:
    case 503: return 'Провайдер сейчас недоступен. Попробуй ещё раз или смени модель.';
    default: return raw || `Ошибка ${status}.`;
  }
}

/** Retry-After в секундах: число или дата HTTP; null, если заголовка нет. */
function retryAfterOf(value) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : null;
}

const usd = (v) => `$${Number(v).toFixed(2)}`;

/** Баланс счёта и лимит ключа одной фразой, если их удаётся узнать. */
async function accountFacts() {
  const [key, credits] = await Promise.allSettled([
    request('/key', { explain: false }),
    request('/credits', { explain: false }),
  ]);
  const out = [];
  const c = credits.status === 'fulfilled' ? credits.value?.data : null;
  if (c && c.total_credits != null) out.push(`на счёте ${usd(c.total_credits - (c.total_usage ?? 0))}`);
  const k = key.status === 'fulfilled' ? key.value?.data : null;
  if (k && k.limit != null) {
    out.push(`лимит ключа ${usd(k.limit)}, у ключа осталось ${usd(k.limit_remaining ?? k.limit - (k.usage ?? 0))}`);
  } else if (k) {
    out.push('у ключа своего лимита нет');
  }
  return out.length ? `Сейчас ${out.join(', ')}.` : '';
}

/**
 * Текст отказа по деньгам. 402 приходит и при деньгах на счёте: перед
 * запуском OpenRouter резервирует оценку цены запроса, а весь резерв
 * ограничен долей баланса; у ключа может быть свой лимит трат. Причина
 * приходит в error.metadata (limit_source, reason), по ней и строится текст.
 */
async function limitText(status, e, explain) {
  const parts = [];
  if (e.limitSource === 'openrouter_in_flight_budget') {
    const when = e.retryAfter ? `${Math.ceil(e.retryAfter)} с` : 'несколько секунд';
    parts.push(`OpenRouter держит резерв под недавние запросы, пока их цена не пересчитана, и новый запрос в него не помещается. Деньги на счёте есть, это временно: повтори через ${when}.`);
  } else if (e.limitSource === 'openrouter_key_limit') {
    parts.push('У ключа исчерпан его собственный лимит трат: деньги на счёте есть, но этому ключу их тратить нельзя. Подними лимит ключа на openrouter.ai в разделе Keys или дождись его сброса.');
  } else if (e.reason === 'weight_exceeds_budget') {
    parts.push('Перед запуском OpenRouter резервирует наихудшую цену запроса: она растёт с ценой модели за токен и с числом и размером картинок в запросе. Резерв под один запрос ограничен долей баланса, и при текущем балансе такой резерв не помещается, хотя по факту картинка стоит в разы дешевле.');
  } else if (e.limitSource === 'openrouter_credits') {
    parts.push('Баланса на счёте OpenRouter не хватает на этот запрос: пополни его.');
  } else {
    parts.push(status === 402 ? 'OpenRouter не принял оплату запроса.' : 'OpenRouter отклонил запрос из-за лимита трат.');
  }
  if (explain && e.limitSource !== 'openrouter_in_flight_budget') {
    const facts = await accountFacts().catch(() => '');
    if (facts) parts.push(facts);
  }
  if (e.raw) parts.push(`Ответ OpenRouter: «${e.raw}».`);
  return parts.join(' ');
}

async function request(path, { method = 'GET', body, signal, explain = true } = {}) {
  let res;
  const json = body ? JSON.stringify(body) : undefined;
  const started = Date.now();
  try {
    res = await fetch(`${getBase()}${path}`, { method, headers: headers(), body: json, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Размер и время отличают обрыв тяжёлого запроса на слабом канале от
    // отсутствия сети.
    const mb = json ? json.length / 1048576 : 0;
    const secs = Math.round((Date.now() - started) / 1000);
    throw new ApiError(0, mb >= 1
      ? `Соединение с OpenRouter оборвалось через ${secs} с, запрос весил ${mb.toFixed(1)} МБ. Тяжёлый запрос по медленному каналу уходит долго и может оборваться: повтори; если повторяется, уменьши число референсов.`
      : 'Сеть недоступна или запрос заблокирован браузером.');
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* не JSON: оставляем null */ }

  if (!res.ok) {
    const meta = data?.error?.metadata || {};
    const extra = {
      raw: data?.error?.message || data?.message || text.slice(0, 300),
      reason: meta.reason || '',
      limitSource: meta.limit_source || '',
      retryAfter: retryAfterOf(res.headers.get('Retry-After')),
    };
    const limited = res.status === 402 || (res.status === 403 && extra.limitSource);
    const message = limited ? await limitText(res.status, extra, explain) : humanize(res.status, extra.raw);
    throw new ApiError(res.status, message, extra);
  }
  return data;
}

/** Статус на время паузы перед повтором генерации. */
export const waitText = (s) => `OpenRouter просит подождать ${s} с: резерв под недавние запросы ещё не пересчитан. Повторю запрос сам, отклонённый запрос не оплачивается.`;

/** Пауза, которую прерывает signal. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException('Остановлено.', 'AbortError'));
    if (signal?.aborted) { aborted(); return; }
    const stop = () => { clearTimeout(timer); aborted(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Каталог моделей с картинками на выходе: их параметры и лимиты. Ключ не нужен. */
export function listImageModels(signal) {
  return request('/images/models', { signal });
}

/**
 * Прайс и возможности конкретной модели по провайдерам.
 * Здесь единица измерения указана явно (token / image / megapixel),
 * поэтому оценка стоимости строится по этим данным, а не по догадке.
 */
export function listModelEndpoints(id, signal) {
  return request(`/images/models/${id}/endpoints`, { signal });
}

/** Остаток на балансе. Требует ключ. */
export function getCredits(signal) {
  return request('/credits', { signal });
}

/**
 * Генерация. references: массив data-URL строк.
 * У Gemini n всегда 1, поэтому несколько вариантов = несколько вызовов.
 *
 * Если резерв OpenRouter под запросы в полёте временно занят, запрос до
 * модели не доходит и не оплачивается, а OpenRouter просит подождать
 * (Retry-After). Тогда генерация повторяется сама, onWait(секунды)
 * сообщает о паузе.
 */
export async function generate({ model, prompt, references = [], aspectRatio, resolution, signal, onWait }) {
  const body = { model, prompt };
  if (references.length) {
    body.input_references = references.map((url) => ({ type: 'image_url', image_url: { url } }));
  }
  if (aspectRatio && aspectRatio !== 'auto') body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  for (let attempt = 0; ; attempt++) {
    try {
      return await request('/images', { method: 'POST', body, signal });
    } catch (e) {
      const transient = e.status === 402 && e.limitSource === 'openrouter_in_flight_budget';
      if (!transient || attempt >= IN_FLIGHT_RETRIES) throw e;
      const wait = Math.min(60, Math.max(2, Math.ceil(e.retryAfter || 5)));
      onWait?.(wait);
      await sleep(wait * 1000, signal);
    }
  }
}
