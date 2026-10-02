// Tiny IndexedDB wrapper. Holds the vault list (with directory handles) and a
// content cache so re-opening a large vault only re-reads files that changed.

let dbp;
function open() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('hermes', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('vaults', { keyPath: 'id' });
      r.result.createObjectStore('cache');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    let out;
    const req = fn(t.objectStore(store));
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  }));
}

export const vaultsList = () => tx('vaults', 'readonly', s => s.getAll());
export const vaultPut = v => tx('vaults', 'readwrite', s => s.put(v));
export const vaultDel = id => tx('vaults', 'readwrite', s => s.delete(id));

const range = vid => IDBKeyRange.bound(vid + '\0', vid + '\0￿');

export async function cacheGetAll(vid) {
  const db = await open();
  return new Promise((res, rej) => {
    const out = new Map();
    const req = db.transaction('cache').objectStore('cache').openCursor(range(vid));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res(out);
      out.set(c.key.slice(vid.length + 1), c.value);
      c.continue();
    };
    req.onerror = () => rej(req.error);
  });
}

export const cachePutMany = (vid, entries) => entries.length
  ? tx('cache', 'readwrite', s => { for (const [p, v] of entries) s.put(v, vid + '\0' + p); })
  : Promise.resolve();

export const cacheDel = (vid, path) => tx('cache', 'readwrite', s => s.delete(vid + '\0' + path));
export const cacheClear = vid => tx('cache', 'readwrite', s => s.delete(range(vid)));
