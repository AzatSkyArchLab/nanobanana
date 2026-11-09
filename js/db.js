// Хранилища в IndexedDB. Картинки и PDF лежат как Blob, не base64:
// это втрое компактнее и переживает перезагрузку страницы.
//
// История генераций и PDF-листы живут в разных базах: так новой базе не
// нужно поднимать версию старой, а значит вкладка со старой сборкой
// не блокирует обновление.

function connect(name, version, upgrade) {
  let promise = null;
  return () => {
    if (!promise) {
      promise = new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => upgrade(req.result);
        req.onsuccess = () => {
          const db = req.result;
          // Вкладка со свежей сборкой не должна висеть на нашем соединении.
          db.onversionchange = () => db.close();
          resolve(db);
        };
        req.onerror = () => { promise = null; reject(req.error); };
      });
    }
    return promise;
  };
}

/** fn получает транзакцию; если вернула функцию, результатом станет её значение после фиксации. */
async function run(open, stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    try { result = fn(t); } catch (e) { t.abort(); reject(e); return; }
    t.oncomplete = () => resolve(
      typeof result === 'function' ? result() : result instanceof IDBRequest ? result.result : result,
    );
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* ── История генераций ─────────────────────────────────── */

const gensDb = connect('nanobanana', 1, (db) => {
  if (!db.objectStoreNames.contains('gens')) {
    db.createObjectStore('gens', { keyPath: 'id' }).createIndex('ts', 'ts');
  }
});
const gens = (mode, fn) => run(gensDb, 'gens', mode, (t) => fn(t.objectStore('gens')));

export const add = (record) => gens('readwrite', (s) => s.add(record));
export const put = (record) => gens('readwrite', (s) => s.put(record));
export const remove = (id) => gens('readwrite', (s) => s.delete(id));
export const clear = () => gens('readwrite', (s) => s.clear());
export const get = (id) => gens('readonly', (s) => s.get(id));

/** Все записи, свежие сверху. */
export async function all() {
  const rows = await gens('readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => b.ts - a.ts);
}

/* ── PDF-листы ─────────────────────────────────────────── */
// docs:    { id, name, size, pages, created, ts, lastPage, count }
// files:   { id, bytes: Blob }            исходный файл, пишется один раз
// patches: { id, doc, page, x, y, w, h, full, blob, ts, record }

const sheetsDb = connect('nanobanana-sheets', 1, (db) => {
  if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('patches')) {
    db.createObjectStore('patches', { keyPath: 'id' }).createIndex('doc', 'doc');
  }
});
const sheetsTx = (stores, mode, fn) => run(sheetsDb, stores, mode, fn);

export const sheets = {
  async list() {
    const rows = await sheetsTx('docs', 'readonly', (t) => t.objectStore('docs').getAll());
    return (rows || []).sort((a, b) => b.ts - a.ts);
  },

  create({ name, bytes, pages }) {
    const now = Date.now();
    const doc = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      name, size: bytes.size, pages, created: now, ts: now, lastPage: 0, count: 0,
    };
    return sheetsTx(['docs', 'files'], 'readwrite', (t) => {
      t.objectStore('docs').add(doc);
      t.objectStore('files').add({ id: doc.id, bytes });
      return () => doc;
    });
  },

  /** Документ, его исходный файл и принятые заплатки по порядку. */
  load(id) {
    return sheetsTx(['docs', 'files', 'patches'], 'readonly', (t) => {
      const doc = t.objectStore('docs').get(id);
      const file = t.objectStore('files').get(id);
      const patches = t.objectStore('patches').index('doc').getAll(id);
      return () => (doc.result && file.result ? {
        doc: doc.result,
        bytes: file.result.bytes,
        patches: (patches.result || []).sort((a, b) => a.ts - b.ts),
      } : null);
    });
  },

  update(doc) {
    return sheetsTx('docs', 'readwrite', (t) => t.objectStore('docs').put(doc));
  },

  addPatch(doc, patch) {
    return sheetsTx(['docs', 'patches'], 'readwrite', (t) => {
      t.objectStore('patches').add(patch);
      t.objectStore('docs').put(doc);
    });
  },

  removePatch(doc, patchId) {
    return sheetsTx(['docs', 'patches'], 'readwrite', (t) => {
      t.objectStore('patches').delete(patchId);
      t.objectStore('docs').put(doc);
    });
  },

  remove(id) {
    return sheetsTx(['docs', 'files', 'patches'], 'readwrite', (t) => {
      t.objectStore('docs').delete(id);
      t.objectStore('files').delete(id);
      const req = t.objectStore('patches').index('doc').openKeyCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        t.objectStore('patches').delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  },
};
