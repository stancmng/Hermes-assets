// Application shell: vault lifecycle, routing, sidebar, command palette, theme.

import { h, $, $$, append, debounce, esc, fuzzy, todayISO, baseName, dirName } from './util.js';
import { icon } from './icons.js';
import { menu, popover, closePopover, modal, prompt, confirmDialog, toast } from './ui.js';
import {
  hasPicker, openDemoVault, pickVault, reopenVault, recentVaults, forgetVault, rememberDemo,
} from './store.js';
import { PageView } from './outline.js';
import { DatabaseView } from './database.js';
import { plain } from './md.js';

const LS = {
  get: (k, d = null) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const enc = p => p.split('/').map(encodeURIComponent).join('/');
function toHash(r) {
  if (r.db) return '#/t/' + (r.tag ? encodeURIComponent(r.tag) : '_all') + (r.view ? '/' + r.view : '');
  const q = [];
  if (r.zoom) q.push('z=' + r.zoom);
  if (r.hl) q.push('h=' + r.hl);
  return '#/p/' + enc(r.path) + (q.length ? '?' + q.join('&') : '');
}
function fromHash(hash) {
  let m = /^#\/t\/([^/]+)(?:\/(.+))?$/.exec(hash);
  if (m) return { db: true, tag: m[1] === '_all' ? '' : decodeURIComponent(m[1]), view: m[2] };
  m = /^#\/p\/([^?]*)(?:\?(.*))?$/.exec(hash);
  if (m) {
    const q = new URLSearchParams(m[2] || '');
    return { path: m[1].split('/').map(decodeURIComponent).join('/'), zoom: q.get('z'), hl: q.get('h') };
  }
  return null;
}

export class App {
  constructor(root) {
    this.root = root;
    this.vault = null;
    this.view = null;
    this.route = null;
    this.offs = [];
    this.expanded = new Set(JSON.parse(LS.get('hermes-expanded', '[]')));
    this.recent = JSON.parse(LS.get('hermes-recent', '[]'));
    this.setTheme(LS.get('hermes-theme'));
    window.addEventListener('hashchange', () => this.vault && this.render(fromHash(location.hash) || this.home()));
    window.addEventListener('keydown', e => this.onGlobalKey(e));
    window.addEventListener('beforeunload', e => {
      if (this.vault && [...this.vault.pages.values()].some(p => p.dirty || p.saving)) { this.vault.flush(); e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.vault?.flush(); });
  }

  // ------------------------------------------------------------ boot + welcome

  async boot() {
    const recents = await recentVaults();
    const last = LS.get('hermes-last');
    const rec = recents.find(r => r.id === last);
    if (rec) {
      try {
        if (rec.id === 'demo') return await this.open(await openDemoVault());
        if ((await rec.handle.queryPermission({ mode: 'readwrite' })) === 'granted') return await this.open(await reopenVault(rec));
      } catch (e) { console.warn('auto-open failed', e); }
    }
    this.welcome(recents);
  }

  welcome(recents = []) {
    this.root.innerHTML = '';
    const list = recents.filter(r => r.id !== 'demo');
    const card = h('div', { class: 'welcome-card' },
      h('div', { class: 'logo', html: logoSVG(56) }),
      h('h1', null, 'Hermes'),
      h('p', { class: 'tagline' }, 'Outline like Tana. Store like Obsidian. Query like Airtable.'),
      h('div', { class: 'welcome-actions' },
        hasPicker ? h('button', { class: 'btn primary lg', onclick: () => this.pickFolder() }, h('span', { html: icon('folderOpen', 18) }), 'Open a folder') : null,
        h('button', { class: 'btn lg' + (hasPicker ? '' : ' primary'), onclick: () => this.openDemo() }, h('span', { html: icon('database', 18) }), 'Try the demo vault')),
      !hasPicker ? h('p', { class: 'notice' }, 'This browser cannot open local folders. Use Chrome, Edge or Arc to work on files in a folder on your computer. The demo vault works here and is stored in your browser.') : null,
      list.length ? h('div', { class: 'recents' }, h('h4', null, 'Recent folders'),
        list.map(r => h('div', { class: 'recent' },
          h('button', { class: 'recent-open', onclick: () => this.reopen(r) }, h('span', { html: icon('folder', 16) }), r.name),
          h('button', { class: 'icon-btn sm', title: 'Forget', html: icon('x', 14), onclick: async e => { await forgetVault(r.id); e.currentTarget.parentElement.remove(); } })))) : null,
      h('p', { class: 'fineprint' }, 'Files stay in your folder as plain markdown. Nothing is uploaded.'));
    this.root.append(h('div', { class: 'welcome' }, card));
  }

  async pickFolder() {
    try { await this.open(await pickVault()); }
    catch (e) { if (e.name !== 'AbortError') toast(e.message, 'error'); }
  }
  async openDemo() {
    try { await rememberDemo(); await this.open(await openDemoVault()); }
    catch (e) { toast('Could not open the demo vault: ' + e.message, 'error'); console.error(e); }
  }
  async reopen(rec) {
    try { await this.open(await reopenVault(rec)); }
    catch (e) { toast(e.message, 'error'); }
  }

  async open(vault) {
    if (this.vault) await this.closeVault();
    this.root.innerHTML = '';
    const bar = h('div', { class: 'progress-bar' }, h('div', { class: 'progress-fill' }));
    const msg = h('div', { class: 'muted' }, 'Indexing your notes…');
    this.root.append(h('div', { class: 'welcome' }, h('div', { class: 'welcome-card' }, h('div', { class: 'logo', html: logoSVG(48) }), h('h2', null, vault.name), msg, bar)));
    await vault.open((d, t) => { $('.progress-fill', bar).style.width = (t ? (d / t) * 100 : 100) + '%'; msg.textContent = `Indexing ${d} of ${t} notes…`; });
    this.vault = vault;
    LS.set('hermes-last', vault.id);
    this.offs = [
      vault.on('pages', () => this.onPages()),
      vault.on('external', d => this.onExternal(d)),
      vault.on('dirty', () => this.setStatus('saving')),
      vault.on('saved', () => { this.setStatus('saved'); this.refreshTagsSoon(); }),
      vault.on('error', e => { this.setStatus('error'); toast('Could not save: ' + e.message, 'error'); }),
      vault.on('config', () => this.refreshTagsSoon()),
      vault.on('conflict', d => toast(`${d.page.name} was changed by another app while you were editing. Its previous version is in ${d.backup}`)),
    ];
    this.buildShell();
    const r = fromHash(location.hash);
    if (r && (r.db || vault.pages.has(r.path))) this.render(r);
    else this.go(this.home(), true);
  }

  async closeVault() {
    this.offs.forEach(f => f());
    this.view?.destroy?.();
    await this.vault.flush();
    this.vault.close();
    this.vault = null; this.view = null;
  }

  async switchVault() {
    if (this.vault) await this.closeVault();
    this.welcome(await recentVaults());
  }

  // ------------------------------------------------------------ shell

  buildShell() {
    this.root.innerHTML = '';
    this.sidebarEl = h('aside', { class: 'sidebar' });
    this.main = h('main', { class: 'main' });
    this.topbar = h('header', { class: 'topbar' });
    this.content = h('div', { class: 'content' });
    this.main.append(this.topbar, this.content);
    const shell = h('div', { class: 'shell' + (LS.get('hermes-sidebar') === 'closed' ? ' no-sidebar' : '') }, this.sidebarEl, this.main,
      h('div', { class: 'scrim', onclick: () => this.toggleSidebar(false) }));
    this.shell = shell;
    this.root.append(shell);
    this.renderSidebar();
    this.renderTopbar();
  }

  toggleSidebar(force) {
    const closed = force === undefined ? !this.shell.classList.contains('no-sidebar') : !force;
    this.shell.classList.toggle('no-sidebar', closed);
    LS.set('hermes-sidebar', closed ? 'closed' : 'open');
  }

  home() {
    const v = this.vault;
    if (v.pages.has('Welcome.md')) return { path: 'Welcome.md' };
    const first = [...v.pages.keys()].sort()[0];
    return first ? { path: first } : { db: true, tag: '' };
  }

  go(route, replace = false) {
    const hash = toHash(route);
    if (location.hash === hash) return this.render(route);
    if (replace) { history.replaceState(null, '', hash); this.render(route); }
    else location.hash = hash;
  }

  render(route) {
    if (!this.vault) return;
    closePopover();
    this.view?.destroy?.();
    this.view = null;
    this.content.innerHTML = '';
    this.content.scrollTop = 0;
    this.route = route;
    const host = h('div', { class: 'view-host' });
    this.content.append(host);
    if (route.db) {
      this.view = new DatabaseView(this, this.vault, route).mount(host);
    } else {
      const page = this.vault.pages.get(route.path);
      if (!page) { toast('That page no longer exists'); return this.go(this.home(), true); }
      this.view = new PageView(this, this.vault, page, { zoom: route.zoom, hl: route.hl }).mount(host);
      this.trackRecent(page.path);
      if (!route.zoom && !route.hl && page.nodes.length === 1 && page.nodes[0].text === '' && !page.fm.entries.length) {
        setTimeout(() => this.view?.focusNode?.(page.nodes[0].id), 30);
      }
    }
    this.renderTopbar();
    this.markActive();
    document.title = (route.db ? (route.tag ? '#' + route.tag : 'All pages') : baseName(route.path)) + ' · Hermes';
  }

  trackRecent(path) {
    this.recent = [path, ...this.recent.filter(p => p !== path)].slice(0, 12);
    LS.set('hermes-recent', JSON.stringify(this.recent));
  }

  renderTopbar() {
    const r = this.route;
    const tb = this.topbar;
    tb.innerHTML = '';
    const crumbs = h('div', { class: 'top-crumbs' });
    if (r?.db) crumbs.append(h('span', { html: icon(r.tag ? 'hash' : 'database', 14) }), r.tag ? this.view?.tagName || r.tag : 'All pages');
    else if (r) {
      const parts = r.path.replace(/\.md$/i, '').split('/');
      parts.forEach((p, i) => { if (i) crumbs.append(h('span', { class: 'sep' }, '/')); crumbs.append(h('span', { class: i === parts.length - 1 ? 'cur' : '' }, p)); });
    }
    append(tb, [
      h('button', { class: 'icon-btn', title: 'Toggle sidebar (Ctrl/Cmd+\\)', html: icon('panel', 18), onclick: () => this.toggleSidebar() }),
      h('button', { class: 'icon-btn', title: 'Back', html: icon('arrowLeft', 18), onclick: () => history.back() }),
      h('button', { class: 'icon-btn', title: 'Forward', html: icon('arrowRight', 18), onclick: () => history.forward() }),
      crumbs, h('div', { class: 'grow' }),
      this.statusEl = h('div', { class: 'status', title: 'Edits are written to your files as you type' }),
      r && !r.db ? h('button', { class: 'icon-btn', title: 'Page actions', html: icon('more', 18), onclick: e => this.pageMenu(e.currentTarget, this.vault.pages.get(r.path), { align: 'right' }) }) : null,
      h('button', { class: 'icon-btn', title: 'Toggle theme', html: icon(this.isDark() ? 'sun' : 'moon', 18), onclick: () => this.toggleTheme() })]);
    this.setStatus(this.status || 'saved');
  }

  setStatus(s) {
    this.status = s;
    if (!this.statusEl) return;
    const label = { saved: 'Saved', saving: 'Saving…', error: 'Save failed' }[s];
    this.statusEl.className = 'status ' + s;
    this.statusEl.innerHTML = `<span class="dot"></span>${label}`;
  }

  // ------------------------------------------------------------ sidebar

  renderSidebar() {
    const v = this.vault;
    const el = this.sidebarEl;
    el.innerHTML = '';
    const head = h('button', { class: 'vault-switch', onclick: e => menu(e.currentTarget, [
      { label: 'Switch vault', icon: 'folder', onClick: () => this.switchVault() },
      hasPicker ? { label: 'Open another folder…', icon: 'folderOpen', onClick: () => this.pickFolder() } : null,
      v.demo ? { sep: true } : null,
      v.demo ? { label: 'Reset demo vault', icon: 'sync', danger: true, onClick: () => this.resetDemo() } : null,
    ]) }, h('span', { class: 'logo sm', html: logoSVG(22) }), h('span', { class: 'vname' }, v.name), h('span', { html: icon('chevronDown', 14) }));
    el.append(head);
    el.append(h('button', { class: 'side-search', onclick: () => this.palette() }, h('span', { html: icon('search', 15) }), 'Search or jump to…', h('kbd', null, isMac ? '⌘K' : 'Ctrl K')));
    el.append(h('div', { class: 'side-actions' },
      h('button', { class: 'side-btn', onclick: () => this.today() }, h('span', { html: icon('calendar', 16) }), 'Today'),
      h('button', { class: 'side-btn', onclick: () => this.newPage() }, h('span', { html: icon('plus', 16) }), 'New page')));
    const scroll = h('div', { class: 'side-scroll' });
    this.tagsEl = h('div', { class: 'side-section' });
    this.treeEl = h('div', { class: 'side-section' });
    scroll.append(this.tagsEl, this.treeEl);
    el.append(scroll);
    this.renderTags();
    this.renderTree();
  }

  refreshTagsSoon = debounce(() => { if (this.vault) this.renderTags(); }, 700);

  renderTags() {
    const v = this.vault;
    const el = this.tagsEl;
    el.innerHTML = '';
    el.append(h('div', { class: 'side-heading' }, 'Databases'));
    el.append(h('a', { class: 'side-item', dataset: { db: '' }, onclick: () => this.go({ db: true, tag: '' }) }, h('span', { class: 'si-icon', html: icon('database', 15) }), h('span', { class: 'si-name' }, 'All pages'), h('span', { class: 'si-count' }, v.pages.size)));
    const stats = v.tagStats();
    for (const t of stats.slice(0, 14)) {
      el.append(h('a', { class: 'side-item', dataset: { db: t.key }, onclick: () => this.go({ db: true, tag: t.key }) }, h('span', { class: 'si-icon', html: icon('hash', 15) }), h('span', { class: 'si-name' }, t.name), h('span', { class: 'si-count' }, t.count)));
    }
    if (stats.length > 14) el.append(h('div', { class: 'side-more muted' }, `+ ${stats.length - 14} more tags (use search)`));
    this.markActive();
  }

  renderTree() {
    const v = this.vault;
    const el = this.treeEl;
    el.innerHTML = '';
    el.append(h('div', { class: 'side-heading' }, 'Pages'));
    const root = { dirs: new Map(), files: [] };
    for (const p of v.pages.values()) {
      const parts = p.path.split('/');
      let n = root;
      for (const d of parts.slice(0, -1)) { if (!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [] }); n = n.dirs.get(d); }
      n.files.push(p);
    }
    const cur = this.route?.path;
    if (cur) { const parts = cur.split('/'); for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/')); }
    const draw = (node, prefix, depth, host) => {
      const dirs = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
      for (const d of dirs) {
        const path = prefix ? prefix + '/' + d : d;
        const open = this.expanded.has(path);
        host.append(h('a', { class: 'side-item folder', style: { paddingLeft: 8 + depth * 14 + 'px' }, onclick: () => { open ? this.expanded.delete(path) : this.expanded.add(path); LS.set('hermes-expanded', JSON.stringify([...this.expanded])); this.renderTree(); } },
          h('span', { class: 'chev-s' + (open ? '' : ' closed'), html: icon('chevronDown', 13) }), h('span', { class: 'si-icon', html: icon(open ? 'folderOpen' : 'folder', 15) }), h('span', { class: 'si-name' }, d), h('span', { class: 'si-count' }, countFiles(node.dirs.get(d)))));
        if (open) draw(node.dirs.get(d), path, depth + 1, host);
      }
      const dated = /^\d{4}-\d{2}-\d{2}/.test(node.files[0]?.name || '');
      const files = node.files.sort((a, b) => dated ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name));
      for (const p of files) {
        const item = h('a', { class: 'side-item file', dataset: { path: p.path }, style: { paddingLeft: 8 + depth * 14 + 18 + 'px' }, onclick: () => this.go({ path: p.path }), oncontextmenu: e => { e.preventDefault(); this.pageMenu({ x: e.clientX, y: e.clientY }, p); } },
          h('span', { class: 'si-icon', html: icon('file', 15) }), h('span', { class: 'si-name' }, p.name),
          h('button', { class: 'icon-btn sm si-more', html: icon('more', 14), onclick: e => { e.stopPropagation(); this.pageMenu(e.currentTarget, p); } }));
        host.append(item);
      }
    };
    draw(root, '', 0, el);
    this.markActive();
  }

  markActive() {
    const r = this.route;
    if (!r || !this.sidebarEl) return;
    $$('.side-item.active', this.sidebarEl).forEach(x => x.classList.remove('active'));
    if (r.db) $(`.side-item[data-db="${CSS.escape(r.tag || '')}"]`, this.sidebarEl)?.classList.add('active');
    else $(`.side-item[data-path="${CSS.escape(r.path)}"]`, this.sidebarEl)?.classList.add('active');
  }

  // ------------------------------------------------------------ events from the vault

  onPages = debounce(() => {
    if (!this.vault) return;
    this.renderTree(); this.renderTags();
    if (this.route && !this.route.db && !this.vault.pages.has(this.route.path)) { toast('This page was removed or renamed outside Hermes'); this.go(this.home(), true); }
  }, 150);

  onExternal({ paths }) {
    this.renderTags();
    const r = this.route;
    if (!r) return;
    if (r.db) { this.view?.refreshExternal?.(); return; }
    if (paths.includes(r.path)) { this.view?.refreshExternal?.(); toast('Updated from disk: ' + baseName(r.path)); }
    else this.view?.renderBacklinks?.();
  }

  // ------------------------------------------------------------ page actions

  async newPage(initial = '') {
    const name = await prompt({ title: 'New page', label: 'Name (use Folder/Name to file it in a folder)', value: initial, placeholder: 'Meeting notes', confirm: 'Create' });
    if (!name) return;
    try {
      const path = sanitizePath(name) + '.md';
      const p = await this.vault.createPage(path, '- \n');
      this.go({ path: p.path });
    } catch (e) { toast(e.message, 'error'); }
  }

  async ensurePage(name, { quiet = false } = {}) {
    const v = this.vault;
    let p = v.resolve(name);
    if (p) return p;
    p = await v.createPage(sanitizePath(name) + '.md', '- \n');
    if (!quiet) toast('Created ' + p.name);
    return p;
  }

  async openLink(name) {
    const p = await this.ensurePage(name);
    this.go({ path: p.path });
  }

  openTag(tag) { this.go({ db: true, tag: tag.toLowerCase() }); }

  async today() {
    const p = await this.vault.ensureDaily(todayISO());
    this.go({ path: p.path });
  }

  async renamePage(page, name) {
    name = sanitizeName(name);
    if (!name || name === page.name) { if (this.route?.path === page.path) this.render(this.route); return; }
    const oldPath = page.path;
    const dir = dirName(oldPath);
    try {
      const np = await this.vault.renamePage(oldPath, (dir ? dir + '/' : '') + name + '.md');
      if (this.route?.path === oldPath) { this.route = { ...this.route, path: np.path }; this.go({ path: np.path }, true); }
      toast(`Renamed to ${np.name}. Links were updated.`);
    } catch (e) { toast(e.message, 'error'); if (this.route) this.render(this.route); }
  }

  async deletePage(page) {
    if (!await confirmDialog({ title: `Delete "${page.name}"?`, body: `${page.path} will be removed from your vault folder.` })) return;
    await this.vault.removePage(page.path);
    toast('Deleted ' + page.name);
    if (this.route?.path === page.path) this.go(this.home(), true);
  }

  pageMenu(anchor, page, opts = {}) {
    if (!page) return;
    menu(anchor, [
      { label: 'Rename', icon: 'edit', onClick: async () => { const n = await prompt({ title: 'Rename page', value: page.name, confirm: 'Rename' }); if (n) this.renamePage(page, n); } },
      { label: 'Copy path', icon: 'copy', onClick: () => navigator.clipboard?.writeText(page.path).then(() => toast('Path copied')) },
      page.derived?.pageTags?.length ? null : null,
      { sep: true },
      { label: 'Delete page', icon: 'trash', danger: true, onClick: () => this.deletePage(page) },
    ], opts);
  }

  async resetDemo() {
    if (!await confirmDialog({ title: 'Reset the demo vault?', body: 'All changes you made to the demo notes will be replaced.', confirm: 'Reset' })) return;
    await this.closeVault();
    await this.open(await openDemoVault(true));
  }

  // ------------------------------------------------------------ command palette

  palette(initial = '') {
    const v = this.vault;
    if (!v) return;
    const input = h('input', { class: 'palette-input', placeholder: 'Search pages, bullets and tags, or run a command…', value: initial, spellcheck: false });
    const list = h('div', { class: 'palette-list' });
    let items = [], sel = 0;
    const m = modal(h('div', { class: 'palette' }, h('div', { class: 'palette-top' }, h('span', { html: icon('search', 18) }), input), list), { cls: 'top' });
    const run = it => { m.close(); it.run(); };
    const commands = () => [
      { label: 'Go to today', sub: 'Daily note', icon: 'calendar', run: () => this.today() },
      { label: 'New page…', icon: 'plus', run: () => this.newPage() },
      { label: 'Open all pages database', icon: 'database', run: () => this.go({ db: true, tag: '' }) },
      { label: 'Toggle dark mode', icon: 'moon', run: () => this.toggleTheme() },
      { label: 'Toggle sidebar', icon: 'panel', run: () => this.toggleSidebar() },
      hasPicker ? { label: 'Open a folder…', icon: 'folderOpen', run: () => this.pickFolder() } : null,
      { label: 'Switch vault', icon: 'folder', run: () => this.switchVault() },
    ].filter(Boolean);
    const build = () => {
      const q = input.value.trim();
      items = [];
      if (!q) {
        const rec = this.recent.map(p => v.pages.get(p)).filter(Boolean).slice(0, 6);
        items.push({ section: 'Recent' }, ...rec.map(p => pageItem(p)), { section: 'Commands' }, ...commands());
      } else {
        const res = v.search(q, 8);
        const pages = res.pages.map(r => pageItem(r.page));
        const tags = v.tagStats().filter(t => fuzzy(q.replace(/^#/, ''), t.name) >= 0).slice(0, 4).map(t => ({ label: '#' + t.name, sub: `${t.count} records`, icon: 'hash', run: () => this.go({ db: true, tag: t.key }) }));
        const nodes = res.nodes.slice(0, 8).map(r => ({ label: plain(r.node.text).slice(0, 90) || '(empty)', sub: r.page.name, icon: 'list', run: () => this.go({ path: r.page.path, hl: r.node.id }) }));
        const cmds = commands().filter(c => fuzzy(q, c.label) >= 0);
        if (pages.length) items.push({ section: 'Pages' }, ...pages);
        if (tags.length) items.push({ section: 'Tags' }, ...tags);
        if (nodes.length) items.push({ section: 'Bullets' }, ...nodes);
        if (cmds.length) items.push({ section: 'Commands' }, ...cmds);
        if (!v.resolve(q)) items.push({ section: 'Create' }, { label: `Create page "${q}"`, icon: 'plus', run: () => this.newPage(q) });
      }
      sel = items.findIndex(i => !i.section);
      paint();
    };
    const pageItem = p => ({ label: p.name, sub: dirName(p.path), icon: 'file', run: () => this.go({ path: p.path }) });
    const paint = () => {
      list.innerHTML = '';
      items.forEach((it, i) => {
        if (it.section) return list.append(h('div', { class: 'palette-section' }, it.section));
        const el = h('div', {
          class: 'palette-item' + (i === sel ? ' active' : ''), dataset: { i },
          onmousemove: () => { if (sel === i) return; sel = i; $$('.palette-item.active', list).forEach(x => x.classList.remove('active')); el.classList.add('active'); },
          onclick: () => run(it),
        }, h('span', { class: 'sg-icon', html: icon(it.icon, 15) }), h('span', { class: 'sg-label' }, it.label), it.sub ? h('span', { class: 'sg-sub' }, it.sub) : null);
        list.append(el);
      });
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };
    const step = d => {
      let i = sel;
      do { i += d; } while (items[i] && items[i].section);
      if (items[i]) { sel = i; paint(); }
    };
    input.addEventListener('input', build);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[sel] && !items[sel].section) run(items[sel]); }
    });
    build();
    input.focus();
  }

  // ------------------------------------------------------------ theme + keys

  isDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  setTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  toggleTheme() {
    const next = this.isDark() ? 'light' : 'dark';
    LS.set('hermes-theme', next); this.setTheme(next);
    if (this.vault) this.renderTopbar();
  }

  onGlobalKey(e) {
    if (!this.vault) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'k') { e.preventDefault(); this.palette(); }
    else if (mod && k === 's') { e.preventDefault(); this.vault.flush().then(() => toast('Saved')); }
    else if (mod && e.key === '\\') { e.preventDefault(); this.toggleSidebar(); }
    else if (e.altKey && e.code === 'KeyN') { e.preventDefault(); this.newPage(); }
    else if (e.altKey && e.code === 'KeyD') { e.preventDefault(); this.today(); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); history.back(); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); history.forward(); }
  }
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const countFiles = n => n.files.length + [...n.dirs.values()].reduce((a, d) => a + countFiles(d), 0);
const sanitizeName = s => s.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\.md$/i, '').trim();
const sanitizePath = s => s.split('/').map(sanitizeName).filter(Boolean).join('/');

export function logoSVG(size = 32) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c6cf0"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#hg)"/><g fill="#fff"><circle cx="18" cy="21" r="4"/><rect x="27" y="18" width="21" height="6" rx="3"/><circle cx="26" cy="33" r="4" opacity=".85"/><rect x="35" y="30" width="15" height="6" rx="3" opacity=".85"/><circle cx="26" cy="45" r="4" opacity=".7"/><rect x="35" y="42" width="11" height="6" rx="3" opacity=".7"/></g></svg>`;
}
