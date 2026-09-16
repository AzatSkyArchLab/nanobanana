// История генераций в IndexedDB. Картинки лежат как Blob (не base64) —
// это втрое компактнее и переживает перезагрузку страницы.

const DB_NAME = 'nanobanana';
const DB_VERSION = 1;
const STORE = 'gens';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const add = (record) => tx('readwrite', (s) => s.add(record));
export const put = (record) => tx('readwrite', (s) => s.put(record));
export const remove = (id) => tx('readwrite', (s) => s.delete(id));
export const clear = () => tx('readwrite', (s) => s.clear());

/** Все записи, свежие сверху. */
export async function all() {
  const rows = await tx('readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => b.ts - a.ts);
}

export function get(id) {
  return tx('readonly', (s) => s.get(id));
}
