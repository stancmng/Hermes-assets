// Airtable-style views over tagged records: table (inline editing, sort, filter,
// group, field types, resizable columns) and board (drag cards between columns).

import { h, $, $$, esc, fmtDate, todayISO, isISODate, hashIdx } from './util.js';
import { icon, typeIcon } from './icons.js';
import { menu, popover, prompt, confirmDialog, toast, modal } from './ui.js';
import {
  collectRecords, getSchema, fieldMeta, fieldOptions, applyView, groupRecords, OPS, opNeedsValue,
  TYPES, TYPE_LABEL, SPECIAL, newNodeRecord, newPageRecord, newViewId, linkTargets, isTruthy, isNum,
} from './query.js';
import { renderInline, findNode } from './md.js';

const PAGE = 200;
const defaultWidth = (key, meta) => key === '@title' ? 320 : key === '@done' ? 92 : meta.type === 'number' ? 110 : meta.type === 'date' ? 140 : meta.type === 'checkbox' ? 90 : 190;

export class DatabaseView {
  constructor(app, vault, route) {
    this.app = app; this.vault = vault;
    this.tagKey = (route.tag || '').toLowerCase();
    this.viewId = route.view || null;
    this.search = '';
    this.limit = PAGE;
    this.collapsedGroups = new Set();
    this.pending = null;
    this.ctx = { resolve: t => vault.resolve(t) };
    const stat = vault.tagStats().find(t => t.key === this.tagKey);
    this.tagName = stat?.name || route.tag || '';
  }

  // ------------------------------------------------------------ data

  get views() { return this.vault.config.views.filter(v => v.tag === this.tagKey); }

  get view() {
    let v = this.views.find(x => x.id === this.viewId) || this.views[0];
    if (!v) {
      v = { id: newViewId(), name: 'Table', tag: this.tagKey, type: 'table', filters: [], sorts: [], group: '', hidden: ['@tags', '@modified'], order: [], widths: {}, boardField: '' };
      this.vault.config.views.push(v);
      this.vault.saveConfig();
    }
    this.viewId = v.id;
    return v;
  }

  load() {
    this.records = collectRecords(this.vault, this.tagKey);
    this.schema = getSchema(this.vault, this.tagKey, this.records);
    this.meta = key => {
      const m = fieldMeta(this.schema, key);
      if (m.type === 'select') m.options = fieldOptions(m, this.records);
      return m;
    };
  }

  allCols() {
    const cols = ['@title'];
    if (this.records.some(r => r.isTodo)) cols.push('@done');
    for (const f of this.schema.fields) cols.push(f.name);
    if (this.records.some(r => !r.isPage)) cols.push('@source');
    cols.push('@tags', '@modified');
    return cols;
  }

  columns() {
    const v = this.view;
    const all = this.allCols();
    const ordered = [...(v.order || []).filter(c => all.includes(c)), ...all.filter(c => !(v.order || []).includes(c))];
    const hidden = new Set(v.hidden || []);
    const cols = ordered.filter(c => c === '@title' || !hidden.has(c));
    if (cols[0] !== '@title') cols.unshift('@title');
    return [...new Set(cols)];
  }

  save() { this.vault.saveConfig(); }

  // ------------------------------------------------------------ shell

  mount(host) {
    this.host = host;
    this.render();
    return this;
  }

  destroy() {}

  render() {
    const scroll = this.scroller?.scrollTop ?? 0;
    this.load();
    const v = this.view;
    this.host.innerHTML = '';
    const wrap = h('div', { class: 'db' });
    this.wrap = wrap;
    wrap.append(this.headEl(), this.tabsEl(), this.toolbarEl());
    this.bodyHost = h('div', { class: 'db-body' });
    wrap.append(this.bodyHost);
    this.host.append(wrap);
    wrap.addEventListener('click', e => {
      const wl = e.target.closest('a.wl');
      if (wl) { e.preventDefault(); e.stopPropagation(); this.app.openLink(wl.dataset.page); return; }
      const tg = e.target.closest('a.tag');
      if (tg) { e.preventDefault(); e.stopPropagation(); this.app.openTag(tg.dataset.tag); }
    });
    this.renderBody();
    if (scroll && this.scroller) this.scroller.scrollTop = scroll;
  }

  refreshExternal() { if (!this.editing) this.renderBody(); }

  headEl() {
    const title = this.tagKey ? h('h1', { class: 'db-title' }, h('span', { class: 'db-tag', html: icon('hash', 20) }), this.tagName) : h('h1', { class: 'db-title' }, h('span', { class: 'db-tag', html: icon('database', 20) }), 'All pages');
    this.countEl = h('span', { class: 'db-count' });
    const newBtn = h('button', { class: 'btn primary split-main', onclick: () => this.createRecord() }, h('span', { html: icon('plus', 15) }), 'New');
    const caret = h('button', {
      class: 'btn primary split-caret', 'aria-label': 'More ways to add',
      html: icon('chevronDown', 14),
      onclick: e => menu(e.currentTarget, [
        this.tagKey ? { label: 'New bullet in Inbox', icon: 'list', onClick: () => this.createRecord() } : null,
        { label: 'New page', icon: 'file', onClick: () => this.createRecord({ asPage: true }) },
      ], { align: 'right' }),
    });
    return h('div', { class: 'db-head' }, h('div', null, title, this.countEl), h('div', { class: 'split' }, newBtn, caret));
  }

  tabsEl() {
    const tabs = h('div', { class: 'tabs' });
    for (const v of this.views) {
      tabs.append(h('button', {
        class: 'tab' + (v.id === this.view.id ? ' active' : ''),
        onclick: () => this.app.go({ tag: this.tagKey, view: v.id, db: true }),
        oncontextmenu: e => { e.preventDefault(); this.tabMenu(e.currentTarget, v); },
        ondblclick: () => this.renameView(v),
      }, h('span', { html: icon(v.type === 'board' ? 'board' : 'table', 14) }), v.name,
      v.id === this.view.id ? h('span', { class: 'tab-more', html: icon('more', 14), onclick: e => { e.stopPropagation(); this.tabMenu(e.currentTarget, v); } }) : null));
    }
    tabs.append(h('button', {
      class: 'tab add', title: 'Add view', html: icon('plus', 14),
      onclick: e => menu(e.currentTarget, [
        { label: 'Table', icon: 'table', onClick: () => this.addView('table') },
        { label: 'Board', icon: 'board', onClick: () => this.addView('board') },
      ]),
    }));
    return tabs;
  }

  tabMenu(anchor, v) {
    menu(anchor, [
      { label: 'Rename', icon: 'edit', onClick: () => this.renameView(v) },
      { label: 'Duplicate', icon: 'copy', onClick: () => this.addView(v.type, structuredClone({ ...v, id: undefined, name: v.name + ' copy' })) },
      this.views.length > 1 ? { label: 'Delete view', icon: 'trash', danger: true, onClick: () => this.deleteView(v) } : null,
    ]);
  }

  addView(type, base) {
    const v = base ? { ...base, id: newViewId() } : {
      id: newViewId(), name: type === 'board' ? 'Board' : 'Table', tag: this.tagKey, type, filters: [], sorts: [], group: '',
      hidden: ['@tags', '@modified'], order: [], widths: {}, boardField: '',
    };
    if (type === 'board' && !v.boardField) v.boardField = this.schema.fields.find(f => f.type === 'select')?.name || '';
    this.vault.config.views.push(v);
    this.save();
    this.app.go({ tag: this.tagKey, view: v.id, db: true });
  }

  async renameView(v) {
    const name = await prompt({ title: 'Rename view', value: v.name, confirm: 'Rename' });
    if (!name) return;
    v.name = name; this.save(); this.render();
  }

  async deleteView(v) {
    if (!await confirmDialog({ title: `Delete view "${v.name}"?`, body: 'Your records are not affected, only this saved view.' })) return;
    this.vault.config.views = this.vault.config.views.filter(x => x !== v);
    this.save();
    this.app.go({ tag: this.tagKey, db: true });
  }

  toolbarEl() {
    const v = this.view;
    const btn = (key, ic, label, fn) => {
      const b = h('button', { class: 'tool', onclick: fn }, h('span', { html: icon(ic, 15) }), label, h('span', { class: 'badge', dataset: { badge: key } }));
      return b;
    };
    this.badgeBtns = {
      filter: btn('filter', 'filter', 'Filter', e => this.filterPop(e.currentTarget)),
      sort: btn('sort', 'sort', 'Sort', e => this.sortPop(e.currentTarget)),
      group: btn('group', 'group', 'Group', e => this.groupPop(e.currentTarget)),
      fields: btn('fields', 'eye', 'Fields', e => this.fieldsPop(e.currentTarget)),
    };
    const items = v.type === 'board'
      ? [this.badgeBtns.filter, this.badgeBtns.sort, this.boardFieldBtn(), this.badgeBtns.fields]
      : [this.badgeBtns.filter, this.badgeBtns.sort, this.badgeBtns.group, this.badgeBtns.fields];
    const search = h('input', { class: 'tool-search', placeholder: 'Search records', value: this.search, spellcheck: false });
    search.addEventListener('input', () => { this.search = search.value; this.limit = PAGE; this.renderBody(); });
    return h('div', { class: 'toolbar' }, items, h('div', { class: 'grow' }), h('div', { class: 'search-box' }, h('span', { html: icon('search', 14) }), search));
  }

  boardFieldBtn() {
    const v = this.view;
    return h('button', {
      class: 'tool', onclick: e => {
        const fields = this.schema.fields.map(f => ({
          label: f.name, icon: { select: 'select' }[f.type] || 'text', checked: v.boardField === f.name,
          onClick: () => { v.boardField = f.name; this.save(); this.render(); },
        }));
        menu(e.currentTarget, fields.length ? [{ heading: 'Group cards by' }, ...fields] : [{ heading: 'Add a field first' }]);
      },
    }, h('span', { html: icon('columns', 15) }), v.boardField ? `Columns: ${v.boardField}` : 'Choose columns');
  }

  updateBadges() {
    const v = this.view;
    const set = (k, n) => { const b = $(`[data-badge="${k}"]`, this.wrap); if (b) { b.textContent = n || ''; b.parentElement.classList.toggle('on', !!n); } };
    set('filter', (v.filters || []).filter(f => f.field).length);
    set('sort', (v.sorts || []).filter(f => f.field).length);
    set('group', v.group ? 1 : 0);
    set('fields', (v.hidden || []).filter(c => this.allCols().includes(c) && c !== '@tags' && c !== '@modified').length);
  }

  changed() { this.save(); this.renderBody(); }

  // ------------------------------------------------------------ popovers

  fieldSelect(value, onChange, { allowNone = false } = {}) {
    const sel = h('select', { class: 'input sm' });
    if (allowNone) sel.append(h('option', { value: '' }, 'None'));
    for (const c of this.allCols()) sel.append(h('option', { value: c, selected: c === value }, this.meta(c).name));
    sel.value = value || '';
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  filterPop(anchor) {
    const v = this.view;
    const body = h('div', { class: 'form-pop' });
    const draw = () => {
      body.innerHTML = '';
      if (!(v.filters || []).length) body.append(h('div', { class: 'muted pad' }, 'No filters. Records matching every filter are shown.'));
      v.filters.forEach((f, i) => {
        const meta = this.meta(f.field);
        const ops = OPS[meta.type] || OPS.text;
        const opSel = h('select', { class: 'input sm' }, ops.map(([id, label]) => h('option', { value: id, selected: id === f.op }, label)));
        opSel.addEventListener('change', () => { f.op = opSel.value; this.changed(); draw(); });
        let valEl = null;
        if (opNeedsValue(f.op)) {
          if (meta.type === 'select') {
            valEl = h('select', { class: 'input sm' }, ['', ...(meta.options || [])].map(o => h('option', { value: o, selected: o === f.value }, o || 'Choose…')));
            valEl.addEventListener('change', () => { f.value = valEl.value; this.changed(); });
          } else {
            valEl = h('input', { class: 'input sm', value: f.value || '', placeholder: meta.type === 'date' ? 'YYYY-MM-DD or today' : 'Value', spellcheck: false });
            valEl.addEventListener('input', () => { f.value = valEl.value; this.changed(); });
          }
        }
        body.append(h('div', { class: 'frow' },
          this.fieldSelect(f.field, val => { f.field = val; const m = this.meta(val); f.op = (OPS[m.type] || OPS.text)[0][0]; f.value = ''; this.changed(); draw(); }),
          opSel, valEl,
          h('button', { class: 'icon-btn sm', html: icon('x', 14), 'aria-label': 'Remove filter', onclick: () => { v.filters.splice(i, 1); this.changed(); draw(); } })));
      });
      body.append(h('button', { class: 'btn ghost sm', onclick: () => {
        const field = this.schema.fields.find(f => f.type === 'select')?.name || '@title';
        const m = this.meta(field);
        v.filters.push({ field, op: (OPS[m.type] || OPS.text)[0][0], value: '' });
        this.changed(); draw();
      } }, h('span', { html: icon('plus', 14) }), 'Add filter'));
    };
    v.filters ||= [];
    draw();
    popover(anchor, body, { width: 360 });
  }

  sortPop(anchor) {
    const v = this.view;
    v.sorts ||= [];
    const body = h('div', { class: 'form-pop' });
    const draw = () => {
      body.innerHTML = '';
      if (!v.sorts.length) body.append(h('div', { class: 'muted pad' }, 'No sorting. Records appear in file order.'));
      v.sorts.forEach((s, i) => {
        const dir = h('select', { class: 'input sm' }, h('option', { value: 'asc', selected: s.dir !== 'desc' }, 'A → Z / low → high'), h('option', { value: 'desc', selected: s.dir === 'desc' }, 'Z → A / high → low'));
        dir.addEventListener('change', () => { s.dir = dir.value; this.changed(); });
        body.append(h('div', { class: 'frow' }, this.fieldSelect(s.field, val => { s.field = val; this.changed(); }), dir,
          h('button', { class: 'icon-btn sm', html: icon('x', 14), 'aria-label': 'Remove sort', onclick: () => { v.sorts.splice(i, 1); this.changed(); draw(); } })));
      });
      body.append(h('button', { class: 'btn ghost sm', onclick: () => { v.sorts.push({ field: '@title', dir: 'asc' }); this.changed(); draw(); } }, h('span', { html: icon('plus', 14) }), 'Add sort'));
    };
    draw();
    popover(anchor, body, { width: 360 });
  }

  groupPop(anchor) {
    const v = this.view;
    menu(anchor, [
      { label: 'No grouping', checked: !v.group, onClick: () => { v.group = ''; this.changed(); this.updateBadges(); } },
      { sep: true },
      ...this.allCols().filter(c => c !== '@title' && c !== '@modified').map(c => ({
        label: this.meta(c).name, checked: v.group === c, onClick: () => { v.group = c; this.changed(); this.updateBadges(); },
      })),
    ]);
  }

  fieldsPop(anchor) {
    const v = this.view;
    v.hidden ||= [];
    const body = h('div', { class: 'form-pop fields-pop' });
    const draw = () => {
      body.innerHTML = '';
      for (const c of this.allCols()) {
        if (c === '@title') continue;
        const m = this.meta(c);
        const on = !v.hidden.includes(c);
        body.append(h('button', {
          class: 'field-toggle' + (on ? ' on' : ''),
          onclick: () => { v.hidden = on ? [...v.hidden, c] : v.hidden.filter(x => x !== c); this.render(); this.fieldsPop(anchor); },
        }, h('span', { html: icon(on ? 'eye' : 'eyeOff', 15) }), h('span', { html: typeIcon(m.type) }), m.name));
      }
      body.append(h('button', { class: 'btn ghost sm', onclick: () => { this.addField(); } }, h('span', { html: icon('plus', 14) }), 'New field'));
    };
    draw();
    popover(anchor, body, { width: 240 });
  }

  // ------------------------------------------------------------ fields

  async addField() {
    const name = await prompt({ title: 'New field', label: 'Field name', placeholder: 'e.g. owner', confirm: 'Create' });
    if (!name) return;
    if (this.schema.fields.some(f => f.name.toLowerCase() === name.toLowerCase())) return toast('A field with that name already exists');
    this.schema.fields.push({ name, type: 'text' });
    this.view.hidden = (this.view.hidden || []).filter(c => c !== name);
    this.save(); this.render();
  }

  async renameField(name) {
    const nn = await prompt({ title: 'Rename field', value: name, confirm: 'Rename' });
    if (!nn || nn === name) return;
    if (this.schema.fields.some(f => f.name.toLowerCase() === nn.toLowerCase() && f.name.toLowerCase() !== name.toLowerCase())) return toast('A field with that name already exists');
    for (const r of this.records) {
      const f = r.fieldMap().get(name.toLowerCase());
      if (!f) continue;
      if (f.node) f.node.text = `${nn}:: ${f.value}`.trimEnd();
      else { f.entry.key = nn; f.entry.dirty = true; if (f.entry.value == null) f.entry.value = f.value; }
      this.vault.touch(r.page);
    }
    const fld = this.schema.fields.find(f => f.name === name);
    if (fld) fld.name = nn;
    const sw = x => (x === name ? nn : x);
    for (const v of this.views) {
      v.filters?.forEach(f => { f.field = sw(f.field); });
      v.sorts?.forEach(f => { f.field = sw(f.field); });
      v.group = sw(v.group); v.boardField = sw(v.boardField);
      v.order = (v.order || []).map(sw); v.hidden = (v.hidden || []).map(sw);
      if (v.widths?.[name]) { v.widths[nn] = v.widths[name]; delete v.widths[name]; }
    }
    this.save(); this.render();
  }

  setType(name, type) {
    const fld = this.schema.fields.find(f => f.name === name);
    if (fld) { fld.type = type; this.save(); this.render(); }
  }

  headerMenu(anchor, key) {
    const m = this.meta(key);
    const v = this.view;
    const custom = !key.startsWith('@');
    const cols = this.columns();
    const i = cols.indexOf(key);
    menu(anchor, [
      { label: 'Sort A → Z', icon: 'sort', onClick: () => { v.sorts = [{ field: key, dir: 'asc' }]; this.changed(); this.updateBadges(); } },
      { label: 'Sort Z → A', icon: 'sort', onClick: () => { v.sorts = [{ field: key, dir: 'desc' }]; this.changed(); this.updateBadges(); } },
      { label: 'Filter by this field', icon: 'filter', onClick: () => { (v.filters ||= []).push({ field: key, op: (OPS[m.type] || OPS.text)[0][0], value: '' }); this.save(); this.updateBadges(); this.filterPop($('[data-badge="filter"]', this.wrap).parentElement); } },
      key !== '@title' ? { label: 'Group by this field', icon: 'group', onClick: () => { v.group = key; this.changed(); this.updateBadges(); } } : null,
      custom ? { sep: true } : null,
      custom ? { label: 'Rename field', icon: 'edit', onClick: () => this.renameField(key) } : null,
      custom ? { heading: 'Field type' } : null,
      ...(custom ? TYPES.map(t => ({ label: TYPE_LABEL[t], checked: m.type === t, icon: { text: 'text', number: 'number', date: 'calendar', select: 'select', checkbox: 'checkbox', url: 'url', link: 'link' }[t], onClick: () => this.setType(key, t) })) : []),
      { sep: true },
      i > 1 ? { label: 'Move left', icon: 'arrowLeft', onClick: () => this.moveCol(key, -1) } : null,
      i >= 1 && i < cols.length - 1 ? { label: 'Move right', icon: 'arrowRight', onClick: () => this.moveCol(key, 1) } : null,
      key !== '@title' ? { label: 'Hide field', icon: 'eyeOff', onClick: () => { v.hidden = [...(v.hidden || []), key]; this.render(); this.save(); } } : null,
    ]);
  }

  moveCol(key, d) {
    const cols = this.columns();
    const i = cols.indexOf(key), j = i + d;
    if (j < 1 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    this.view.order = [...cols, ...this.allCols().filter(c => !cols.includes(c))];
    this.save(); this.render();
  }

  // ------------------------------------------------------------ records

  async createRecord({ asPage = false, values = {} } = {}) {
    try {
      let rec;
      if (!this.tagKey) {
        const p = await this.vault.createPage('Untitled.md', '- \n');
        this.app.go({ path: p.path });
        return;
      }
      rec = asPage ? await newPageRecord(this.vault, this.tagName, values) : await newNodeRecord(this.vault, this.tagName, values);
      this.pending = { id: rec.id, key: '@title' };
      this.render();
      toast(asPage ? `Created page ${rec.page.path}` : 'Added to Inbox');
    } catch (e) { toast(e.message, 'error'); }
  }

  async deleteRecord(rec) {
    if (rec.isPage) {
      if (!await confirmDialog({ title: `Delete page "${rec.page.name}"?`, body: 'The markdown file is removed from your vault folder.' })) return;
      await this.vault.removePage(rec.page.path);
    } else {
      const l = findNode(rec.page.nodes, rec.node.id);
      if (!l) return;
      l.list.splice(l.index, 1);
      this.vault.touch(rec.page);
    }
    this.render();
  }

  openRecord(rec) {
    if (rec.isPage) this.app.go({ path: rec.page.path });
    else this.app.go({ path: rec.page.path, hl: rec.node.id });
  }

  // ------------------------------------------------------------ cell rendering

  cellHTML(rec, key, meta) {
    const v = rec.get(key);
    if (key === '@title') return rec.title ? `<span class="cell-title">${renderInline(rec.title, this.ctx)}</span>` : '<span class="muted">Untitled</span>';
    if (key === '@source') return v ? `<a class="wl" data-page="${esc(rec.page.path.replace(/\.md$/, ''))}">${esc(v)}</a>` : '<span class="muted">page</span>';
    if (key === '@tags') return rec.tags.map(t => `<a class="tag" data-tag="${esc(t)}">#${esc(t)}</a>`).join(' ');
    if (key === '@done') return rec.isTodo ? `<span class="cbx${rec.checked ? ' on' : ''}">${icon('check', 12)}</span>` : '';
    switch (meta.type) {
      case 'checkbox': return `<span class="cbx${isTruthy(v) ? ' on' : ''}">${icon('check', 12)}</span>`;
      case 'select': return v ? `<span class="pill c${hashIdx(v)}">${esc(v)}</span>` : '';
      case 'date': {
        if (!v) return '';
        const done = rec.checked || /^done$/i.test(rec.get('status'));
        const t = todayISO();
        const cls = isISODate(v) && !done ? (v < t ? ' overdue' : v === t ? ' today' : '') : '';
        return `<span class="chip date${cls}">${esc(fmtDate(v))}</span>`;
      }
      case 'number': return `<span class="num">${esc(v)}</span>`;
      case 'url': return v ? `<a class="ext" href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v.replace(/^https?:\/\/(www\.)?/, ''))}</a>` : '';
      case 'link': return linkTargets(v).map(t => `<a class="wl chip-link" data-page="${esc(t)}">${esc(t)}</a>`).join('');
    }
    return renderInline(v, this.ctx);
  }

  // ------------------------------------------------------------ table

  renderBody() {
    this.load();
    const v = this.view;
    const rows = applyView(this.records, { ...v, search: this.search }, this.schema);
    this.rows = rows;
    this.countEl.textContent = rows.length === this.records.length ? `${rows.length} records` : `${rows.length} of ${this.records.length} records`;
    this.updateBadges();
    this.bodyHost.innerHTML = '';
    if (v.type === 'board') this.renderBoard(rows);
    else this.renderTable(rows);
    if (this.pending) {
      const { id, key } = this.pending; this.pending = null;
      const td = $(`tr[data-rec="${CSS.escape(id)}"] td[data-key="${CSS.escape(key)}"]`, this.bodyHost);
      if (td) { td.scrollIntoView({ block: 'nearest' }); this.editCell(td, this.records.find(r => r.id === id), key); }
      else { const rec = this.records.find(r => r.id === id); if (rec) this.openRecordModal(rec); }
    }
  }

  renderTable(rows) {
    const v = this.view;
    const cols = this.columns();
    const metas = cols.map(c => this.meta(c));
    const widths = cols.map((c, i) => v.widths?.[c] || defaultWidth(c, metas[i]));
    const total = 56 + widths.reduce((a, b) => a + b, 0) + 48;
    const table = h('table', { class: 'grid', style: { width: total + 'px' } });
    const colgroup = h('colgroup', null, h('col', { style: { width: '56px' } }), widths.map((w, i) => h('col', { style: { width: w + 'px' }, dataset: { key: cols[i] } })), h('col', { style: { width: '48px' } }));
    table.append(colgroup);

    const hr = h('tr', null, h('th', { class: 'gutter' }));
    cols.forEach((c, i) => {
      const m = metas[i];
      const th = h('th', { class: 'colhead' + (i === 0 ? ' sticky' : ''), dataset: { key: c } },
        h('button', { class: 'th-btn', onclick: e => this.headerMenu(e.currentTarget, c) },
          h('span', { class: 'th-icon', html: c === '@title' ? icon('text', 14) : c === '@source' ? icon('file', 14) : c === '@tags' ? icon('tag', 14) : c === '@done' ? icon('checkbox', 14) : c === '@modified' ? icon('calendar', 14) : typeIcon(m.type) }),
          h('span', { class: 'th-name' }, m.name),
          (v.sorts || []).find(s => s.field === c) ? h('span', { class: 'th-sort', html: icon('sort', 12) }) : null),
        h('span', { class: 'resizer', onmousedown: e => this.startResize(e, c, i, table, colgroup) }));
      hr.append(th);
    });
    hr.append(h('th', { class: 'addcol' }, h('button', { class: 'icon-btn sm', title: 'Add field', html: icon('plus', 15), onclick: () => this.addField() })));
    table.append(h('thead', null, hr));

    const tbody = h('tbody');
    const shown = rows.slice(0, this.limit);
    const mkRow = (rec, idx) => {
      const tr = h('tr', { class: 'rec', dataset: { rec: rec.id } },
        h('td', { class: 'gutter' },
          h('span', { class: 'rownum' }, idx + 1),
          h('button', { class: 'row-open', title: 'Expand record', html: icon('arrowRight', 14), onclick: () => this.openRecordModal(rec) }),
          h('button', { class: 'row-menu', title: 'Record actions', html: icon('more', 14), onclick: e => menu(e.currentTarget, [
            { label: 'Expand record', icon: 'arrowRight', onClick: () => this.openRecordModal(rec) },
            { label: rec.isPage ? 'Open page' : 'Go to bullet', icon: 'file', onClick: () => this.openRecord(rec) },
            { sep: true },
            { label: 'Delete record', icon: 'trash', danger: true, onClick: () => this.deleteRecord(rec) },
          ]) })));
      cols.forEach((c, i) => {
        const td = h('td', { class: 'cell t-' + metas[i].type + (i === 0 ? ' sticky' : ''), dataset: { key: c }, html: this.cellHTML(rec, c, metas[i]) });
        if (i === 0) td.prepend(h('button', { class: 'open-link', title: 'Open', html: icon('arrowRight', 12), onclick: e => { e.stopPropagation(); this.openRecord(rec); } }));
        td.addEventListener('click', e => {
          if (e.target.closest('a, .open-link')) return;
          this.editCell(td, rec, c);
        });
        tr.append(td);
      });
      tr.append(h('td'));
      return tr;
    };
    let idx = 0;
    if (v.group) {
      const gm = this.meta(v.group);
      for (const g of groupRecords(shown, v.group, gm, this.records)) {
        const key = String(g.key);
        const closed = this.collapsedGroups.has(key);
        const label = g.key === '' ? '<span class="muted">No value</span>' : gm.type === 'select' ? `<span class="pill c${hashIdx(key)}">${esc(key)}</span>` : gm.type === 'link' ? `<a class="wl" data-page="${esc(key)}">${esc(key)}</a>` : esc(gm.type === 'date' && isISODate(key) ? fmtDate(key) : key);
        tbody.append(h('tr', { class: 'group-row' }, h('td', { colSpan: cols.length + 2, onclick: () => { closed ? this.collapsedGroups.delete(key) : this.collapsedGroups.add(key); this.renderBody(); } },
          h('span', { class: 'chev-s' + (closed ? ' closed' : ''), html: icon('chevronDown', 14) }), h('span', { class: 'group-label', html: label }), h('span', { class: 'count' }, g.rows.length))));
        if (!closed) for (const r of g.rows) tbody.append(mkRow(r, idx++));
      }
    } else shown.forEach((r, i) => tbody.append(mkRow(r, i)));
    if (!rows.length) tbody.append(h('tr', null, h('td', { colSpan: cols.length + 2, class: 'empty-row' }, this.records.length ? 'No records match your filters.' : !this.tagKey ? 'This vault has no notes yet. Press New to create your first page.' : 'No records yet. Tag a bullet with #' + (this.tagName || 'tag') + ' or press New.')));
    table.append(tbody);

    // summary row
    const foot = h('tr', { class: 'sumrow' }, h('td', { class: 'gutter' }));
    cols.forEach((c, i) => {
      const td = h('td', { class: i === 0 ? 'sticky' : '' });
      if (i === 0) td.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
      else if (metas[i].type === 'number') {
        const nums = rows.map(r => r.get(c)).filter(isNum).map(Number);
        if (nums.length) td.innerHTML = `<span class="muted">Sum</span> ${+nums.reduce((a, b) => a + b, 0).toFixed(2)}`;
      }
      foot.append(td);
    });
    foot.append(h('td'));
    table.append(h('tfoot', null, foot));

    this.scroller = h('div', { class: 'grid-scroll' }, table);
    if (rows.length > this.limit) this.scroller.append(h('button', { class: 'btn ghost more', onclick: () => { this.limit += PAGE; this.renderBody(); } }, `Show ${Math.min(PAGE, rows.length - this.limit)} more`));
    this.bodyHost.append(this.scroller);
  }

  startResize(e, key, i, table, colgroup) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const col = colgroup.children[i + 1];
    const w0 = col.offsetWidth;
    const t0 = parseFloat(table.style.width);
    const move = ev => {
      const w = Math.max(70, w0 + ev.clientX - startX);
      col.style.width = w + 'px';
      table.style.width = t0 + (w - w0) + 'px';
      (this.view.widths ||= {})[key] = w;
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); this.save(); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  // ------------------------------------------------------------ cell editing

  editCell(td, rec, key, move) {
    if (!rec || key === '@source' || key === '@tags') return;
    const meta = this.meta(key);
    if (key === '@done') { if (rec.isTodo) { rec.setChecked(!rec.checked); this.renderBody(); } return; }
    if (meta.type === 'checkbox') { rec.set(key, isTruthy(rec.get(key)) ? 'false' : 'true'); this.renderBody(); return; }
    if (meta.type === 'select') return this.selectPop(td, rec, key, meta);
    if (td.querySelector('input')) return;
    const old = key === '@title' ? rec.title : rec.get(key);
    const input = h('input', { class: 'cell-input', type: meta.type === 'date' ? 'date' : 'text', value: old, spellcheck: false });
    td.innerHTML = '';
    td.append(input);
    if (meta.type === 'link') {
      const id = 'dl-' + Math.random().toString(36).slice(2, 7);
      input.setAttribute('list', id);
      td.append(h('datalist', { id }, [...this.vault.pages.values()].slice(0, 400).map(p => h('option', { value: p.name }))));
    }
    this.editing = true;
    input.focus();
    if (meta.type !== 'date') input.select();
    let done = false;
    const finish = (commit, next) => {
      if (done) return; done = true; this.editing = false;
      let val = input.value.trim();
      if (commit && val !== old && key === '@title' && rec.isPage) {
        this.app.renamePage(rec.page, val).then(() => this.renderBody());
        return;
      }
      if (commit && val !== old) {
        if (meta.type === 'number' && val !== '' && !isNum(val)) toast('Enter a number', 'error');
        else {
          if (meta.type === 'link' && val) val = val.split(',').map(s => s.trim()).filter(Boolean).map(s => /^\[\[.*\]\]$/.test(s) ? s : `[[${s}]]`).join(', ');
          rec.set(key, val);
        }
      }
      if (next) { const cols = this.columns(); const j = cols.indexOf(key) + 1; if (j < cols.length) this.pending = { id: rec.id, key: cols[j] }; }
      this.renderBody();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); finish(true, true); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  selectPop(anchor, rec, key, meta) {
    const cur = rec.get(key);
    const fld = this.schema.fields.find(f => f.name.toLowerCase() === key.toLowerCase());
    const items = (meta.options || []).map(o => ({ label: o, checked: o === cur, onClick: () => { rec.set(key, o); this.renderBody(); } }));
    menu(anchor, [
      ...items,
      items.length ? { sep: true } : null,
      { label: 'New option…', icon: 'plus', onClick: async () => {
        const o = await prompt({ title: `New ${meta.name} option`, confirm: 'Add' });
        if (!o) return;
        if (fld) { fld.options = [...new Set([...(fld.options || []), ...(meta.options || []), o])]; this.save(); }
        rec.set(key, o); this.renderBody();
      } },
      cur ? { label: 'Clear', icon: 'x', onClick: () => { rec.set(key, ''); this.renderBody(); } } : null,
    ], { width: 180 });
  }

  // ------------------------------------------------------------ record modal

  openRecordModal(rec) {
    const cols = this.allCols().filter(c => !['@title', '@tags', '@modified'].includes(c));
    const title = h('input', { class: 'rec-title', value: rec.title, placeholder: 'Untitled', spellcheck: false });
    title.addEventListener('change', () => (rec.isPage ? this.app.renamePage(rec.page, title.value) : rec.set('@title', title.value)));
    const body = h('div', { class: 'rec-fields' });
    for (const c of cols) {
      const m = this.meta(c);
      let ed;
      const cur = rec.get(c);
      if (c === '@source') { ed = h('a', { class: 'wl', onclick: () => { m2.close(); this.openRecord(rec); } }, rec.isPage ? rec.page.path : rec.page.name); }
      else if (c === '@done') { if (!rec.isTodo) continue; ed = h('input', { type: 'checkbox', checked: rec.checked, onchange: e => rec.setChecked(e.target.checked) }); }
      else if (m.type === 'checkbox') ed = h('input', { type: 'checkbox', checked: isTruthy(cur), onchange: e => rec.set(c, e.target.checked ? 'true' : 'false') });
      else if (m.type === 'select') {
        ed = h('select', { class: 'input' }, h('option', { value: '' }, '—'), (m.options || []).map(o => h('option', { value: o, selected: o === cur }, o)));
        ed.addEventListener('change', () => rec.set(c, ed.value));
      } else {
        ed = h('input', { class: 'input', type: m.type === 'date' ? 'date' : 'text', value: cur, spellcheck: false });
        ed.addEventListener('change', () => {
          let val = ed.value.trim();
          if (m.type === 'link' && val) val = val.split(',').map(s => s.trim()).filter(Boolean).map(s => /^\[\[.*\]\]$/.test(s) ? s : `[[${s}]]`).join(', ');
          if (m.type === 'number' && val && !isNum(val)) return toast('Enter a number', 'error');
          rec.set(c, val);
        });
      }
      body.append(h('div', { class: 'rec-row' }, h('div', { class: 'rec-label' }, h('span', { html: c === '@source' ? icon('file', 14) : c === '@done' ? icon('checkbox', 14) : typeIcon(m.type) }), m.name), h('div', { class: 'rec-val' }, ed)));
    }
    const m2 = modal(h('div', { class: 'rec-modal' },
      h('div', { class: 'rec-head' }, h('span', { class: 'chip tagchip' }, '#' + (this.tagName || 'page')), h('button', { class: 'icon-btn', html: icon('x', 16), onclick: () => m2.close() })),
      title, body,
      h('div', { class: 'dialog-actions between' },
        h('button', { class: 'btn danger-ghost', onclick: async () => { m2.close(); await this.deleteRecord(rec); } }, h('span', { html: icon('trash', 14) }), 'Delete'),
        h('button', { class: 'btn', onclick: () => { m2.close(); this.openRecord(rec); } }, rec.isPage ? 'Open page' : 'Go to bullet'))),
    { onClose: () => this.renderBody() });
    if (!rec.title) title.focus();
  }

  // ------------------------------------------------------------ board

  renderBoard(rows) {
    const v = this.view;
    const field = v.boardField;
    const meta = field ? this.meta(field) : null;
    if (!field || !this.schema.fields.some(f => f.name === field)) {
      this.bodyHost.append(h('div', { class: 'empty-state' },
        h('h3', null, 'Choose a field to build columns from'),
        h('p', { class: 'muted' }, 'Cards are grouped by the values of a field such as status.'),
        h('div', { class: 'row-wrap' }, this.schema.fields.map(f => h('button', { class: 'btn', onclick: () => { v.boardField = f.name; this.save(); this.render(); } }, f.name)),
          h('button', { class: 'btn primary', onclick: async () => { await this.addField(); } }, 'New field'))));
      return;
    }
    const groups = groupRecords(rows, field, meta, this.records);
    const byKey = new Map(groups.map(g => [g.key, g.rows]));
    let keys = [];
    if (meta.type === 'select') { keys = [...(meta.options || [])]; for (const g of groups) if (!keys.includes(g.key) && g.key !== '') keys.push(g.key); }
    else keys = groups.map(g => g.key).filter(k => k !== '');
    if (byKey.has('') ) keys.push('');
    const cols = h('div', { class: 'board' });
    const shownFields = this.columns().filter(c => c !== '@title' && c !== field && c !== '@done');
    for (const k of keys) {
      const list = byKey.get(k) || [];
      const col = h('div', { class: 'bcol', dataset: { key: k } });
      col.append(h('div', { class: 'bcol-head' },
        k === '' ? h('span', { class: 'muted' }, 'No value') : h('span', { class: 'pill c' + hashIdx(k) }, k),
        h('span', { class: 'count' }, list.length),
        h('button', { class: 'icon-btn sm', title: 'Add card', html: icon('plus', 14), onclick: () => this.createRecord({ values: k ? { [field]: k } : {} }) })));
      const cards = h('div', { class: 'bcards' });
      for (const rec of list) cards.append(this.cardEl(rec, shownFields, field));
      col.append(cards);
      col.addEventListener('dragover', e => { if (this.dragRec) { e.preventDefault(); col.classList.add('over'); } });
      col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
      col.addEventListener('drop', e => {
        e.preventDefault(); col.classList.remove('over');
        const rec = this.records.find(r => r.id === this.dragRec);
        this.dragRec = null;
        if (rec && rec.get(field) !== k) { rec.set(field, k); this.renderBody(); }
      });
      cols.append(col);
    }
    this.scroller = h('div', { class: 'board-scroll' }, cols);
    this.bodyHost.append(this.scroller);
  }

  cardEl(rec, fields, boardField) {
    const chips = [];
    for (const c of fields) {
      if (c === '@source') continue;
      const m = this.meta(c);
      const html = this.cellHTML(rec, c, m);
      if (rec.get(c) !== '' || (c === '@tags' && rec.tags.length)) if (html) chips.push(h('div', { class: 'card-field', title: m.name, html }));
    }
    const card = h('div', { class: 'card', draggable: true, dataset: { rec: rec.id },
      ondragstart: e => { this.dragRec = rec.id; e.dataTransfer.setData('text/plain', rec.id); setTimeout(() => card.classList.add('dragging'), 0); },
      ondragend: () => { this.dragRec = null; card.classList.remove('dragging'); },
      onclick: e => { if (!e.target.closest('a')) this.openRecordModal(rec); },
    },
    h('div', { class: 'card-title' + (rec.checked ? ' done' : ''), html: rec.title ? renderInline(rec.title, this.ctx) : '<span class="muted">Untitled</span>' }),
    chips.length ? h('div', { class: 'card-fields' }, chips) : null,
    !rec.isPage ? h('div', { class: 'card-src' }, h('span', { html: icon('file', 12) }), rec.page.name) : null);
    return card;
  }
}
