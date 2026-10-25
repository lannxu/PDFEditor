// IndexedDB：最近文件与自动保存（文件字节 + 编辑数据分开存，列表轻量）
// stores: meta {id, name, updatedAt, elements, pageCount, size}
//         files {id, bytes: ArrayBuffer}

const DB_NAME = 'pdfeditor';
const DB_VER = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const out = fn(s);
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error);
      })
  );
}

export const store = {
  async putMeta(meta) { await tx('meta', 'readwrite', (s) => s.put(meta)); },
  async putFile(id, bytes) { await tx('files', 'readwrite', (s) => s.put({ id, bytes })); },
  async getMeta(id) { return tx('meta', 'readonly', (s) => s.get(id)); },
  async getFile(id) { return tx('files', 'readonly', (s) => s.get(id)); },
  async listMeta() {
    const all = await tx('meta', 'readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async remove(id) {
    await tx('meta', 'readwrite', (s) => s.delete(id));
    await tx('files', 'readwrite', (s) => s.delete(id));
  },
};
