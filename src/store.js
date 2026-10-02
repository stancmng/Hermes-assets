// The vault: a folder of markdown files held in an in-memory database (parsed
// pages + derived indexes), persisted to disk on every edit, cached in
// IndexedDB, and kept in sync with outside changes by polling.

import * as idb from './idb.js';
import { parsePage, serializePage, walkNodes, extractTags, extractLinks, parseField, fmTags, nodePath, nodeAtPath } from './md.js';
import { baseName, dirName, todayISO, uid } from './util.js';
import { seedFiles } from './seed.js';

const SKIP = new Set(['node_modules']);
const CONFIG_PATH = '.hermes/config.json';
const defaultConfig = () => ({ version: 1, schema: {}, views: [], settings: {} });
const normLink = t => t.split('/').pop().trim().toLowerCase();
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const hasPicker = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

// ---------------------------------------------------------------- derived data

export function derive(page) {
  if (page.derived && page.derivedVer === page.ver) return page.derived;
  const d = { tags: new Map(), pageTags: fmTags(page), links: new Set(), fmLinks: [], records: [], flat: [] };
  for (const t of d.pageTags) d.tags.set(t.toLowerCase(), t);
  for (const e of page.fm.entries) {
    if (e.key == null) continue;
    for (const v of Array.isArray(e.value) ? e.value : [e.value]) {
      if (typeof v !== 'string') continue;
      for (const l of extractLinks(v)) { d.links.add(normLink(l)); d.fmLinks.push({ key: e.key, target: l, value: v }); }
    }
  }
  walkNodes(page.nodes, n => {
    if (n.kind === 'code') return;
    d.flat.push({ node: n, lower: n.text.toLowerCase() });
    for (const l of extractLinks(n.text)) d.links.add(normLink(l));
    const tags = extractTags(n.text);
    for (const t of tags) if (!d.tags.has(t.toLowerCase())) d.tags.set(t.toLowerCase(), t);
    if (tags.length && !parseField(n)) d.records.push({ node: n, tags });
  });
  page.derived = d; page.derivedVer = page.ver;
  return d;
}

// ---------------------------------------------------------------- vault

export class Vault {
  constructor({ id, name, root, demo = false }) {
    this.id = id; this.name = name; this.root = root; this.demo = demo;
    this.pages = new Map();
    this.names = new Map();       // lower base name -> Set(path)
    this.lowerPaths = new Map();  // lower path -> path
    this.config = defaultConfig();
    this.listeners = {};
    this.timers = new Map();
    this.polling = false;
    this._cfgMtime = 0;
    this._cfgTimer = null;
  }

  on(type, fn) { (this.listeners[type] ||= new Set()).add(fn); return () => this.listeners[type].delete(fn); }
  emit(type, data) { this.listeners[type]?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

  // ---- file system primitives
  async _dir(parts, create = false) {
    let d = this.root;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }
  async _fh(path, create = false) {
    const parts = path.split('/'); const name = parts.pop();
    return (await this._dir(parts, create)).getFileHandle(name, { create });
  }
  async _read(path) {
    const f = await (await this._fh(path)).getFile();
    return { text: await f.text(), mtime: f.lastModified, size: f.size };
  }
  async _write(path, text) {
    const fh = await this._fh(path, true);
    const w = await fh.createWritable();
    await w.write(text); await w.close();
    const f = await fh.getFile();
    return { mtime: f.lastModified, size: f.size };
  }
  async _remove(path) {
    const parts = path.split('/'); const name = parts.pop();
    await (await this._dir(parts)).removeEntry(name);
  }
  async _list() {
    const out = new Map();
    const walk = async (dir, prefix) => {
      const subs = [];
      for await (const [name, h] of dir.entries()) {
        if (name.startsWith('.') || SKIP.has(name)) continue;
        if (h.kind === 'directory') subs.push([name, h]);
        else if (/\.md$/i.test(name)) out.set(prefix + name, h);
      }
      await Promise.all(subs.map(([n, h]) => walk(h, prefix + n + '/')));
    };
    await walk(this.root, '');
    return out;
  }

  // ---- loading
  async open(onProgress) {
    const cache = await idb.cacheGetAll(this.id).catch(() => new Map());
    const files = [...(await this._list())];
    const fresh = [];
    let done = 0;
    const queue = files.slice();
    const worker = async () => {
      while (queue.length) {
        const [path, h] = queue.pop();
        try {
          const file = await h.getFile();
          const c = cache.get(path);
          let raw;
          if (c && c.mtime === file.lastModified && c.size === file.size) raw = c.raw;
          else { raw = await file.text(); fresh.push([path, { mtime: file.lastModified, size: file.size, raw }]); }
          this._addPage(path, raw, file.lastModified, file.size);
        } catch (e) { console.warn('skip', path, e); }
        if (++done % 25 === 0) onProgress?.(done, files.length);
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    onProgress?.(files.length, files.length);
    idb.cachePutMany(this.id, fresh).catch(() => {});
    for (const path of cache.keys()) if (!this.pages.has(path)) idb.cacheDel(this.id, path).catch(() => {});
    await this._loadConfig();
    this.startPolling();
  }

  _addPage(path, raw, mtime, size) {
    const p = {
      path, name: baseName(path), mtime, size, raw, ...parsePage(raw),
      dirty: false, saving: false, ver: 0, derived: null, derivedVer: -1, undo: [], redo: [],
    };
    this.pages.set(path, p);
    this._indexName(p);
    return p;
  }
  _indexName(p) {
    const k = p.name.toLowerCase();
    if (!this.names.has(k)) this.names.set(k, new Set());
    this.names.get(k).add(p.path);
    this.lowerPaths.set(p.path.toLowerCase(), p.path);
  }
  _unindexName(p) {
    this.names.get(p.name.toLowerCase())?.delete(p.path);
    this.lowerPaths.delete(p.path.toLowerCase());
  }

  resolve(target) {
    if (!target) return null;
    const t = target.trim().replace(/\.md$/i, '').toLowerCase();
    const exact = this.lowerPaths.get(t + '.md');
    if (exact) return this.pages.get(exact);
    const set = this.names.get(t.split('/').pop());
    if (!set || !set.size) return null;
    let paths = [...set];
    if (t.includes('/')) { paths = paths.filter(p => p.toLowerCase().endsWith(t + '.md')); if (!paths.length) return null; }
    paths.sort((a, b) => a.length - b.length);
    return this.pages.get(paths[0]);
  }

  // ---- saving
  touch(page) {
    page.ver++; page.dirty = true;
    this.emit('dirty', page);
    clearTimeout(this.timers.get(page.path));
    this.timers.set(page.path, setTimeout(() => this.save(page), 350));
  }

  async save(page) {
    clearTimeout(this.timers.get(page.path));
    if (page.saving) { page.resave = true; return; }
    if (!page.dirty) return; // never rewrite a file the user did not change
    const text = serializePage(page);
    if (text === page.raw) { page.dirty = false; return; }
    const v = page.ver;
    page.saving = true;
    this.emit('saving', page);
    try {
      await this._backupIfChangedOutside(page);
      const r = await this._write(page.path, text);
      page.raw = text; page.mtime = r.mtime; page.size = r.size;
      idb.cachePutMany(this.id, [[page.path, { mtime: r.mtime, size: r.size, raw: text }]]).catch(() => {});
      if (page.ver === v) page.dirty = false;
      this.emit('saved', page);
    } catch (e) {
      console.error(e);
      this.emit('error', e);
    } finally {
      page.saving = false;
      if (page.resave || page.dirty) { page.resave = false; this.timers.set(page.path, setTimeout(() => this.save(page), 150)); }
    }
  }

  // If another app rewrote the file while it had unsaved edits here, keep that
  // version in .hermes/backups before our write replaces it.
  async _backupIfChangedOutside(page) {
    try {
      const f = await (await this._fh(page.path)).getFile();
      if (f.lastModified === page.mtime && f.size === page.size) return;
      const disk = await f.text();
      if (disk === page.raw) return;
      const backup = `.hermes/backups/${page.path.replace(/\//g, '__')}.${Date.now()}.md`;
      await this._write(backup, disk);
      this.emit('conflict', { page, backup });
    } catch { /* file vanished or unreadable: nothing to back up */ }
  }

  async flush() {
    await Promise.all([...this.pages.values()].filter(p => p.dirty || p.saving).map(p => this.save(p)));
    if (this._cfgTimer) { clearTimeout(this._cfgTimer); await this._saveConfigNow(); }
  }

  // ---- page lifecycle
  uniquePath(path) {
    if (!this.lowerPaths.has(path.toLowerCase())) return path;
    const base = path.replace(/\.md$/i, '');
    for (let i = 2; ; i++) if (!this.lowerPaths.has(`${base} ${i}.md`.toLowerCase())) return `${base} ${i}.md`;
  }

  async createPage(path, raw = '') {
    path = this.uniquePath(path);
    const r = await this._write(path, raw);
    const p = this._addPage(path, raw, r.mtime, r.size);
    idb.cachePutMany(this.id, [[path, { mtime: r.mtime, size: r.size, raw }]]).catch(() => {});
    this.emit('pages', { added: [path] });
    return p;
  }

  async removePage(path) {
    const p = this.pages.get(path);
    if (!p) return;
    clearTimeout(this.timers.get(path));
    await this._remove(path);
    this._unindexName(p);
    this.pages.delete(path);
    idb.cacheDel(this.id, path).catch(() => {});
    this.emit('pages', { removed: [path] });
  }

  async renamePage(oldPath, newPath) {
    const p = this.pages.get(oldPath);
    if (!p || oldPath === newPath) return p;
    if (this.lowerPaths.has(newPath.toLowerCase()) && newPath.toLowerCase() !== oldPath.toLowerCase()) throw new Error('A page with that name already exists');
    clearTimeout(this.timers.get(oldPath));
    const text = p.dirty ? serializePage(p) : p.raw;
    const r = await this._write(newPath, text);
    p.raw = text; p.dirty = false;
    if (newPath.toLowerCase() !== oldPath.toLowerCase()) await this._remove(oldPath);
    idb.cacheDel(this.id, oldPath).catch(() => {});
    this._unindexName(p);
    this.pages.delete(oldPath);
    const oldName = p.name;
    p.path = newPath; p.name = baseName(newPath); p.mtime = r.mtime; p.size = r.size;
    this.pages.set(newPath, p);
    this._indexName(p);
    idb.cachePutMany(this.id, [[newPath, { mtime: r.mtime, size: r.size, raw: p.raw }]]).catch(() => {});
    if (oldName.toLowerCase() !== p.name.toLowerCase()) this._rewriteLinks(oldName, p.name);
    this.emit('pages', { renamed: [[oldPath, newPath]] });
    return p;
  }

  _rewriteLinks(oldName, newName) {
    const re = new RegExp('\\[\\[((?:[^\\]|#^]*/)?)' + reEsc(oldName) + '(?=[\\]|#^])', 'gi');
    for (const q of this.pages.values()) {
      let changed = false;
      walkNodes(q.nodes, n => {
        if (n.kind === 'code' || !n.text.includes('[[')) return;
        const t = n.text.replace(re, (m, pre) => `[[${pre}${newName}`);
        if (t !== n.text) { n.text = t; changed = true; }
      });
      for (const e of q.fm.entries) {
        const fix = v => typeof v === 'string' && v.includes('[[') ? v.replace(re, (m, pre) => `[[${pre}${newName}`) : v;
        const nv = Array.isArray(e.value) ? e.value.map(fix) : fix(e.value);
        if (JSON.stringify(nv) !== JSON.stringify(e.value)) { e.value = nv; e.dirty = true; changed = true; }
      }
      if (changed) this.touch(q);
    }
  }

  dailyPath(iso = todayISO()) { return `Daily/${iso}.md`; }
  async ensureDaily(iso = todayISO()) {
    const path = this.dailyPath(iso);
    return this.pages.get(path) || this.createPage(path, '- \n');
  }

  // ---- external changes (live sync)
  startPolling() {
    if (this.polling) return;
    this.polling = true;
    const tick = async () => {
      if (!this.polling) return;
      if (!document.hidden) await this.poll().catch(e => console.warn('poll', e));
      this._pollTimer = setTimeout(tick, Math.max(1500, this.pages.size * 2));
    };
    this._pollTimer = setTimeout(tick, 1500);
    this._onVis = () => { if (!document.hidden) { clearTimeout(this._pollTimer); tick(); } };
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('focus', this._onVis);
  }
  stopPolling() {
    this.polling = false;
    clearTimeout(this._pollTimer);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('focus', this._onVis);
  }

  async poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      const files = await this._list();
      const changed = [], added = [], removed = [];
      await Promise.all([...files].map(async ([path, h]) => {
        const p = this.pages.get(path);
        const f = await h.getFile();
        if (!p) {
          const raw = await f.text();
          this._addPage(path, raw, f.lastModified, f.size);
          added.push(path);
        } else if ((p.mtime !== f.lastModified || p.size !== f.size) && !p.dirty && !p.saving) {
          const raw = await f.text();
          p.mtime = f.lastModified; p.size = f.size;
          if (raw === p.raw) return;
          this._reload(p, raw);
          changed.push(path);
        }
      }));
      for (const [path, p] of this.pages) {
        if (!files.has(path) && !p.dirty && !p.saving) {
          this._unindexName(p); this.pages.delete(path); removed.push(path);
          idb.cacheDel(this.id, path).catch(() => {});
        }
      }
      if (changed.length || added.length || removed.length) {
        idb.cachePutMany(this.id, [...changed, ...added].map(p => { const q = this.pages.get(p); return [p, { mtime: q.mtime, size: q.size, raw: q.raw }]; })).catch(() => {});
        if (added.length || removed.length) this.emit('pages', { added, removed });
        if (changed.length) this.emit('external', { paths: changed });
      }
      // config edited outside
      try {
        const fh = await this._fh(CONFIG_PATH);
        const f = await fh.getFile();
        if (f.lastModified !== this._cfgMtime && !this._cfgTimer) { await this._loadConfig(); this.emit('config'); }
      } catch { /* no config yet */ }
    } finally { this._polling = false; }
  }

  _reload(p, raw) {
    const collapsed = new Set();
    walkNodes(p.nodes, n => { if (n.collapsed) collapsed.add(n.text); });
    Object.assign(p, parsePage(raw), { raw });
    walkNodes(p.nodes, n => { if (n.children.length && collapsed.has(n.text)) n.collapsed = true; });
    p.ver++; p.undo = []; p.redo = [];
  }

  // ---- config (schema + saved views), stored in .hermes/config.json
  async _loadConfig() {
    try {
      const { text, mtime } = await this._read(CONFIG_PATH);
      this.config = { ...defaultConfig(), ...JSON.parse(text) };
      this._cfgMtime = mtime;
    } catch { this.config = defaultConfig(); }
  }
  saveConfig() {
    clearTimeout(this._cfgTimer);
    this._cfgTimer = setTimeout(() => this._saveConfigNow(), 400);
    this.emit('config');
  }
  async _saveConfigNow() {
    this._cfgTimer = null;
    try {
      const r = await this._write(CONFIG_PATH, JSON.stringify(this.config, null, 2) + '\n');
      this._cfgMtime = r.mtime;
    } catch (e) { this.emit('error', e); }
  }

  // ---- queries
  backlinks(page) {
    const key = page.name.toLowerCase();
    const out = [];
    for (const q of this.pages.values()) {
      if (q === page) continue;
      const d = derive(q);
      if (!d.links.has(key)) continue;
      const hits = [];
      for (const f of d.flat) {
        if (!f.lower.includes('[[')) continue;
        if (extractLinks(f.node.text).some(l => normLink(l) === key)) hits.push(f.node);
      }
      const props = d.fmLinks.filter(l => normLink(l.target) === key);
      out.push({ page: q, hits, props });
    }
    return out.sort((a, b) => a.page.name.localeCompare(b.page.name));
  }

  tagStats() {
    const m = new Map();
    const add = (t) => {
      const k = t.toLowerCase();
      const e = m.get(k) || { key: k, name: t, count: 0 };
      e.count++; m.set(k, e);
    };
    for (const p of this.pages.values()) {
      const d = derive(p);
      for (const t of new Set(d.pageTags.map(x => x.toLowerCase()))) add(d.tags.get(t) || t);
      for (const r of d.records) for (const t of new Set(r.tags.map(x => x.toLowerCase()))) add(d.tags.get(t) || t);
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  search(query, limit = 30) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const pages = [], nodes = [];
    if (!terms.length) return { pages, nodes };
    for (const p of this.pages.values()) {
      const name = (p.path.replace(/\.md$/i, '')).toLowerCase();
      if (terms.every(t => name.includes(t))) pages.push({ page: p, score: (name.startsWith(terms[0]) ? 0 : 1) + name.length / 1000 });
      if (nodes.length >= limit * 3) continue;
      for (const f of derive(p).flat) {
        if (terms.every(t => f.lower.includes(t))) { nodes.push({ page: p, node: f.node }); if (nodes.length >= limit * 3) break; }
      }
    }
    pages.sort((a, b) => a.score - b.score);
    return { pages: pages.slice(0, limit), nodes: nodes.slice(0, limit) };
  }

  close() { this.stopPolling(); }
}

// ---------------------------------------------------------------- opening vaults

export async function openDemoVault(reset = false) {
  const root = await navigator.storage.getDirectory();
  if (reset) await root.removeEntry('hermes-demo', { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle('hermes-demo', { create: true });
  const v = new Vault({ id: 'demo', name: 'Demo vault', root: dir, demo: true });
  let empty = true;
  for await (const _ of dir.entries()) { empty = false; break; }
  if (empty || reset) {
    for (const f of seedFiles()) await v._write(f.path, f.content);
    await idb.cacheClear('demo').catch(() => {});
  }
  return v;
}

export async function pickVault() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'hermes-vault' });
  const existing = await idb.vaultsList();
  let id = null;
  for (const r of existing) if (r.handle && await r.handle.isSameEntry(handle).catch(() => false)) { id = r.id; break; }
  id ||= `fs:${uid()}`;
  await idb.vaultPut({ id, name: handle.name, handle, opened: Date.now() });
  return new Vault({ id, name: handle.name, root: handle });
}

export async function reopenVault(rec) {
  if (rec.id === 'demo') return openDemoVault();
  let perm = await rec.handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') perm = await rec.handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('Permission to the folder was denied');
  await idb.vaultPut({ ...rec, opened: Date.now() });
  return new Vault({ id: rec.id, name: rec.name, root: rec.handle });
}

export const recentVaults = async () => (await idb.vaultsList().catch(() => [])).sort((a, b) => (b.opened || 0) - (a.opened || 0));
export const forgetVault = id => idb.vaultDel(id).then(() => idb.cacheClear(id)).catch(() => {});
export const rememberDemo = () => idb.vaultPut({ id: 'demo', name: 'Demo vault', opened: Date.now() });

export { nodePath, nodeAtPath, dirName };
