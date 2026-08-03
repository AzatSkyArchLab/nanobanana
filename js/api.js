// Единственный слой, который ходит в сеть.
// Когда/если появится собственный прокси (Cloudflare Worker с моим ключом
// и лимитами), меняется только BASE — остальное приложение не трогается.

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
const LS_KEY = 'nb.apiKey';
const LS_BASE = 'nb.baseUrl';

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
  // Необязательные заголовки атрибуции — приложение видно в статистике OpenRouter.
  h['HTTP-Referer'] = location.origin === 'null' ? 'http://localhost' : location.origin;
  h['X-Title'] = 'nanobanana';
  return h;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function humanize(status, raw) {
  switch (status) {
    case 401: return 'Ключ не принят. Проверь, что он скопирован целиком и не отозван.';
    case 402: return 'Кончились кредиты на OpenRouter — пополни баланс.';
    case 403: return raw || 'Запрос отклонён модерацией провайдера.';
    case 429: return 'Слишком часто. Подожди несколько секунд и повтори.';
    case 502:
    case 503: return 'Провайдер сейчас недоступен. Попробуй ещё раз или смени модель.';
    default: return raw || `Ошибка ${status}.`;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(`${getBase()}${path}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Сеть недоступна или запрос заблокирован браузером.');
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* не JSON — оставляем null */ }

  if (!res.ok) {
    const raw = data?.error?.message || data?.message || text.slice(0, 300);
    throw new ApiError(res.status, humanize(res.status, raw));
  }
  return data;
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
 * Генерация. references — массив data-URL строк.
 * У Gemini n всегда 1, поэтому несколько вариантов = несколько вызовов.
 */
export function generate({ model, prompt, references = [], aspectRatio, resolution, signal }) {
  const body = { model, prompt };
  if (references.length) {
    body.input_references = references.map((url) => ({ type: 'image_url', image_url: { url } }));
  }
  if (aspectRatio && aspectRatio !== 'auto') body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  return request('/images', { method: 'POST', body, signal });
}
