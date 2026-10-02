// The page editor: a Tana-style outliner over a markdown file.
// Rows render markdown ("live preview") until you focus them, then show the raw
// source in a textarea. Structure edits rebuild the outline; typing only
// updates the model, so it stays fast on large pages.

import { h, $, $$, esc, fuzzy, todayISO, addDays, isISODate, fmtDate, hashIdx } from './util.js';
import { icon } from './icons.js';
import {
  mkNode, isRaw, findNode, parseField, renderInline, extractTags, parseBody, nodePath, nodeAtPath, freshIds,
  fmGet, fmSet, fmDelete, plain, setChecked,
} from './md.js';
import { menu, prompt, toast } from './ui.js';

const SLASH = [
  { id: 'task', label: 'Task', hint: 'Checkbox', icon: 'checkbox' },
  { id: 'h1', label: 'Heading 1', hint: '#', icon: 'text' },
  { id: 'h2', label: 'Heading 2', hint: '##', icon: 'text' },
  { id: 'h3', label: 'Heading 3', hint: '###', icon: 'text' },
  { id: 'field', label: 'Field', hint: 'name:: value', icon: 'list' },
  { id: 'code', label: 'Code block', hint: '```', icon: 'cmd' },
  { id: 'today', label: 'Today', hint: 'Insert date', icon: 'calendar' },
  { id: 'tomorrow', label: 'Tomorrow', hint: 'Insert date', icon: 'calendar' },
  { id: 'link', label: 'Link to page', hint: '[[', icon: 'link' },
  { id: 'tag', label: 'Tag', hint: '#', icon: 'tag' },
];

const isDesc = (root, id) => root.children.some(c => c.id === id || isDesc(c, id));

let mirror;
function caretLines(ta) {
  // is the caret on the first / last visual line of the textarea?
  if (!mirror) { mirror = h('div', { class: 'edit-mirror' }); document.body.append(mirror); }
  const cs = getComputedStyle(ta);
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'borderLeftWidth', 'borderRightWidth', 'boxSizing', 'textTransform']) mirror.style[p] = cs[p];
  mirror.style.width = ta.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) + 'px';
  const measure = text => {
    mirror.textContent = text;
    const s = h('span', null, '​');
    mirror.append(s);
    return s.offsetTop;
  };
  const here = measure(ta.value.slice(0, ta.selectionStart));
  const last = measure(ta.value);
  return { first: here < 4, last: here >= last - 2 };
}

export class PageView {
  constructor(app, vault, page, opts = {}) {
    this.app = app; this.vault = vault; this.page = page;
    this.zoomId = opts.zoom || null;
    this.hl = opts.hl || null;
    this.focusId = null;
    this.lastType = 0; this.lastTypeId = null;
    this.sug = null;
    this.ctx = { resolve: t => vault.resolve(t) };
    this._ftypes = null;
  }

  mount(host) {
    this.host = host;
    if (!this.zoomId && this.page.nodes.length === 0) this.page.nodes.push(mkNode(''));
    this.render();
    if (this.hl) {
      const row = $(`.row[data-id="${this.hl}"]`, this.host);
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 2000); }
    }
    return this;
  }

  destroy() { this.closeSuggest(); this.vault.save(this.page); }

  zoomNode() { return this.zoomId ? findNode(this.page.nodes, this.zoomId)?.node : null; }
  list() { return this.zoomNode()?.children ?? this.page.nodes; }
  loc(id) { return findNode(this.page.nodes, id); }
  touch() { this.vault.touch(this.page); }

  // ------------------------------------------------------------ rendering

  render() {
    const zn = this.zoomNode();
    if (this.zoomId && !zn) this.zoomId = null;
    this.host.innerHTML = '';
    const wrap = h('div', { class: 'page' + (zn ? ' zoomed' : '') });
    this.wrap = wrap;
    if (zn) { wrap.append(this.crumbs(zn), this.rowEl(zn, true)); }
    else wrap.append(this.header(), this.propsEl());
    this.outline = h('div', { class: 'outline' });
    wrap.append(this.outline);
    wrap.append(h('button', { class: 'add-row', onclick: () => this.appendNode() }, h('span', { html: icon('plus', 14) }), 'Add a bullet'));
    if (!zn) { this.blEl = h('div', { class: 'backlinks' }); wrap.append(this.blEl); this.renderBacklinks(); }
    wrap.addEventListener('click', e => this.onClick(e));
    this.initDnD();
    this.host.append(wrap);
    this.renderOutline();
  }

  renderOutline() {
    this.outline.innerHTML = '';
    for (const n of this.list()) this.outline.append(this.nodeEl(n));
  }

  header() {
    const p = this.page;
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '';
    const title = h('input', { class: 'page-title', value: p.name, spellcheck: false, 'aria-label': 'Page title' });
    title.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); title.blur(); const f = this.list()[0]; if (f) this.focusNode(f.id, 'start'); }
      if (e.key === 'Escape') { title.value = p.name; title.blur(); }
    });
    title.addEventListener('change', () => this.app.renamePage(p, title.value));
    return h('div', { class: 'page-head' },
      dir ? h('div', { class: 'page-dir' }, h('span', { html: icon('folder', 13) }), dir.replace(/\//g, ' / ')) : null,
      title);
  }

  crumbs(zn) {
    const path = nodePath(this.page.nodes, zn.id) || [];
    const parts = [h('a', { class: 'crumb', onclick: () => this.app.go({ path: this.page.path }) }, this.page.name)];
    let list = this.page.nodes;
    for (let i = 0; i < path.length - 1; i++) {
      const a = list[path[i]];
      parts.push(h('span', { class: 'crumb-sep', html: icon('chevronRight', 12) }),
        h('a', { class: 'crumb', onclick: () => this.app.go({ path: this.page.path, zoom: a.id }) }, plain(a.text).slice(0, 40) || 'Untitled'));
      list = a.children;
    }
    return h('div', { class: 'crumbs' }, parts);
  }

  nodeEl(n) {
    const el = h('div', { class: 'node' + (n.collapsed ? ' collapsed' : ''), dataset: { id: n.id } });
    el.append(this.rowEl(n));
    if (n.children.length && !n.collapsed) {
      const k = h('div', { class: 'kids' });
      for (const c of n.children) k.append(this.nodeEl(c));
      el.append(k);
    }
    return el;
  }

  fieldType(key) {
    if (!this._ftypes || this._ftv !== this.vault.config) {
      this._ftypes = new Map(); this._ftv = this.vault.config;
      for (const s of Object.values(this.vault.config.schema || {})) for (const f of s.fields || []) this._ftypes.set(f.name.toLowerCase(), f.type);
    }
    return this._ftypes.get(key.toLowerCase());
  }

  paintView(view, n) {
    if (n.kind === 'code') {
      const lines = n.text.split('\n');
      const closed = lines.length > 1 && /^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1]);
      const body = lines.slice(1, closed ? -1 : undefined).join('\n');
      const lang = lines[0].replace(/^[`~]+/, '').trim();
      view.innerHTML = `<pre class="code">${lang ? `<span class="lang">${esc(lang)}</span>` : ''}<code>${esc(body)}</code></pre>`;
      return;
    }
    if (n.kind === 'table') { view.innerHTML = this.tableHTML(n.text); return; }
    const f = parseField(n);
    if (f) {
      const v = f.value.trim();
      let val;
      const type = this.fieldType(f.key);
      if (!v) val = '<span class="muted">empty</span>';
      else if (isISODate(v)) val = `<span class="chip date">${esc(fmtDate(v))}</span>`;
      else if (type === 'select' && !v.includes('[[')) val = `<span class="pill c${hashIdx(v)}">${esc(v)}</span>`;
      else val = renderInline(v, this.ctx);
      view.innerHTML = `<span class="fkey">${esc(f.key)}</span><span class="fval">${val}</span>`;
      return;
    }
    if (n.kind === 'para' && /^>\s?/.test(n.text)) view.innerHTML = `<blockquote class="quote">${renderInline(n.text.replace(/^>\s?/, ''), this.ctx)}</blockquote>`;
    else view.innerHTML = n.text ? renderInline(n.text, this.ctx) : '<span class="ph">&nbsp;</span>';
  }

  tableHTML(text) {
    const split = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    const lines = text.split('\n').filter(l => l.trim());
    const isSep = l => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');
    const sep = lines.findIndex(isSep);
    const head = sep > 0 ? lines.slice(0, sep) : [];
    const body = lines.filter((l, i) => !isSep(l) && !(sep > 0 && i < sep));
    const cell = (tag, c) => `<${tag}>${renderInline(c, this.ctx)}</${tag}>`;
    return `<table class="md-table">${head.length ? `<thead>${head.map(l => `<tr>${split(l).map(c => cell('th', c)).join('')}</tr>`).join('')}</thead>` : ''}<tbody>${body.map(l => `<tr>${split(l).map(c => cell('td', c)).join('')}</tr>`).join('')}</tbody></table>`;
  }

  rowEl(n, zoomRoot = false) {
    const f = parseField(n);
    const row = h('div', {
      class: `row k-${n.kind}${n.kind === 'heading' ? ' h' + Math.min(n.level, 3) : ''}${f ? ' is-field' : ''}${zoomRoot ? ' zoom-root' : ''}`,
      dataset: { id: n.id },
    });
    row.append(
      h('button', {
        class: 'chev' + (n.children.length ? '' : ' none') + (n.collapsed ? ' closed' : ''), tabIndex: -1, 'aria-label': 'Collapse',
        html: icon('chevronDown', 14), onmousedown: e => e.preventDefault(), onclick: () => this.toggle(n.id),
      }),
      h('button', {
        class: 'bullet' + (n.collapsed && n.children.length ? ' has-hidden' : ''), tabIndex: -1, draggable: !zoomRoot, title: 'Click to zoom in, drag to move',
        onclick: () => this.app.go({ path: this.page.path, zoom: n.id }),
        ondragstart: e => { this.dragId = n.id; e.dataTransfer.setData('text/plain', n.id); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => row.classList.add('dragging'), 0); },
        ondragend: () => { this.dragId = null; this.clearDrop(); row.classList.remove('dragging'); },
      }, h('span', { class: 'dot' })),
    );
    if (n.kind === 'todo') {
      row.append(h('button', {
        class: 'cb' + (n.checked ? ' on' : ''), tabIndex: -1, 'aria-label': 'Toggle task', html: icon('check', 12),
        onmousedown: e => e.preventDefault(),
        onclick: e => {
          this.pushUndo();
          setChecked(n, !n.checked);
          this.touch();
          this.renderOutline();
        },
      }));
    }
    const view = h('div', { class: 'view' + (n.kind === 'todo' && n.checked ? ' done' : '') });
    this.paintView(view, n);
    const ta = h('textarea', { class: 'edit nav' + (isRaw(n) ? ' mono' : ''), rows: 1, spellcheck: false, value: n.text, 'aria-label': 'Bullet text' });
    view.addEventListener('mousedown', e => {
      if (e.target.closest('a') || e.button !== 0) return;
      e.preventDefault();
      this.focusNode(n.id, 'end');
    });
    ta.addEventListener('focus', () => { this.focusId = n.id; this.startEdit(ta); });
    ta.addEventListener('blur', () => {
      row.classList.remove('editing');
      if (!row.isConnected) return;
      this.paintView(view, n);
      setTimeout(() => { if (this.sug && this.sug.ta === ta && document.activeElement !== ta) this.closeSuggest(); }, 0);
      this.vault.save(this.page);
    });
    ta.addEventListener('input', () => this.onInput(n, ta));
    ta.addEventListener('keydown', e => this.onKey(e, n, ta));
    ta.addEventListener('paste', e => this.onPaste(e, n, ta));
    row.append(h('div', { class: 'body' }, view, ta));
    return row;
  }

  autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

  startEdit(ta) {
    ta.closest('.row').classList.add('editing');
    this.autosize(ta);
  }

  focusNode(id, pos = 'end') {
    const ta = $(`.row[data-id="${id}"] .edit`, this.host);
    if (!ta) return;
    this.startEdit(ta);
    ta.focus();
    const len = ta.value.length;
    if (Array.isArray(pos)) ta.setSelectionRange(pos[0], pos[1]);
    else {
      const p = pos === 'end' ? len : pos === 'start' ? 0 : Math.min(pos, len);
      ta.setSelectionRange(p, p);
    }
    ta.scrollIntoView({ block: 'nearest' });
  }

  navList() { return $$('.edit.nav', this.host); }
  neighbor(id, dir) {
    const list = this.navList();
    const i = list.findIndex(t => t.closest('.row').dataset.id === id);
    const t = list[i + dir];
    return t ? t.closest('.row').dataset.id : null;
  }

  // ------------------------------------------------------------ properties + backlinks

  propsEl() {
    const page = this.page;
    const box = h('div', { class: 'props' });
    const entries = page.fm.entries.filter(e => e.key);
    for (const e of entries) {
      const row = h('div', { class: 'prop' }, h('span', { class: 'prop-key' }, e.key));
      if (e.complex) row.append(h('code', { class: 'prop-complex' }, e.raw.slice(1).join(' ').trim() || '(structured value)'));
      else {
        const arr = Array.isArray(e.value);
        const val = arr ? e.value.join(', ') : (e.value ?? '');
        const isDate = !arr && isISODate(val);
        const input = h('input', { class: 'prop-val', type: isDate ? 'date' : 'text', value: val, spellcheck: false, placeholder: 'Empty' });
        input.addEventListener('change', () => {
          const nv = input.value;
          const asList = arr || /^tags?$/i.test(e.key);
          fmSet(page, e.key, asList ? nv.split(/\s*,\s*/).map(s => s.replace(/^#/, '')).filter(Boolean) : nv);
          this.touch();
          this.renderBacklinks();
        });
        input.addEventListener('keydown', ev => { if (ev.key === 'Enter') input.blur(); });
        row.append(input);
      }
      row.append(h('button', {
        class: 'icon-btn sm prop-del', title: 'Remove property', html: icon('x', 13),
        onclick: () => { fmDelete(page, e.key); this.touch(); this.refreshProps(); },
      }));
      box.append(row);
    }
    box.append(h('button', { class: 'prop-add', onclick: async () => {
      const name = await prompt({ title: 'Add property', label: 'Property name', placeholder: 'status', confirm: 'Add' });
      if (!name) return;
      if (fmGet(page, name)) return toast('That property already exists');
      fmSet(page, name, /^tags?$/i.test(name) ? [] : '');
      this.touch(); this.refreshProps();
      setTimeout(() => $$('.prop-val', this.host).pop()?.focus(), 0);
    } }, h('span', { html: icon('plus', 13) }), entries.length ? 'Add property' : 'Add properties'));
    return box;
  }

  refreshProps() {
    const old = $('.props', this.wrap);
    if (old) old.replaceWith(this.propsEl());
  }

  renderBacklinks() {
    if (!this.blEl) return;
    const items = this.vault.backlinks(this.page);
    const count = items.reduce((a, b) => a + Math.max(1, b.hits.length + b.props.length), 0);
    this.blEl.innerHTML = '';
    if (!items.length) return;
    const open = this._blOpen !== false;
    const head = h('button', { class: 'bl-head', onclick: () => { this._blOpen = !open; this.renderBacklinks(); } },
      h('span', { class: 'chev-s' + (open ? '' : ' closed'), html: icon('chevronDown', 14) }), `Linked mentions`, h('span', { class: 'count' }, count));
    this.blEl.append(head);
    if (!open) return;
    for (const it of items) {
      const g = h('div', { class: 'bl-group' }, h('a', { class: 'bl-page', onclick: () => this.app.go({ path: it.page.path }) }, h('span', { html: icon('file', 14) }), it.page.path.replace(/\.md$/i, '')));
      for (const pr of it.props) g.append(h('div', { class: 'bl-hit', onclick: () => this.app.go({ path: it.page.path }) }, h('span', { class: 'fkey' }, pr.key), h('span', { html: renderInline(pr.value, this.ctx) })));
      for (const n of it.hits) {
        g.append(h('div', { class: 'bl-hit', onclick: e => { if (!e.target.closest('a')) this.app.go({ path: it.page.path, hl: n.id }); }, html: renderInline(n.text.split('\n')[0], this.ctx) }));
      }
      this.blEl.append(g);
    }
  }

  // ------------------------------------------------------------ external updates

  refreshExternal() {
    const ta = document.activeElement?.classList.contains('edit') && this.host.contains(document.activeElement) ? document.activeElement : null;
    let restore = null;
    if (ta) restore = { path: nodePath(this.page.nodes, ta.closest('.row').dataset.id), pos: [ta.selectionStart, ta.selectionEnd] };
    const keepScroll = this.host.parentElement?.scrollTop;
    this.render();
    if (this.host.parentElement && keepScroll != null) this.host.parentElement.scrollTop = keepScroll;
    if (restore?.path) {
      const n = nodeAtPath(this.page.nodes, restore.path);
      if (n) this.focusNode(n.id, restore.pos);
    }
  }

  // ------------------------------------------------------------ undo / redo

  snap() { return { nodes: structuredClone(this.page.nodes), focus: this.focusId }; }
  pushUndo() {
    const p = this.page;
    p.undo.push(this.snap());
    if (p.undo.length > 100) p.undo.shift();
    p.redo.length = 0;
  }
  undo() {
    const p = this.page;
    if (!p.undo.length) return;
    p.redo.push(this.snap());
    this.restore(p.undo.pop());
  }
  redo() {
    const p = this.page;
    if (!p.redo.length) return;
    p.undo.push(this.snap());
    this.restore(p.redo.pop());
  }
  restore(s) {
    this.page.nodes = s.nodes;
    this.touch();
    if (this.zoomId && !this.zoomNode()) this.zoomId = null, this.render(); else this.renderOutline();
    if (!this.zoomId) this.renderBacklinks();
    if (s.focus && this.loc(s.focus)) this.focusNode(s.focus, 'end');
    this.lastType = 0;
  }

  // ------------------------------------------------------------ structure operations

  redrawFocus(id, pos) {
    this.renderOutline();
    if (this.zoomId === id) { this.render(); }
    this.focusNode(id, pos);
  }

  toggle(id) {
    const l = this.loc(id);
    if (!l || !l.node.children.length) return;
    l.node.collapsed = !l.node.collapsed;
    this.renderOutline();
  }

  setCollapsed(id, v) {
    const l = this.loc(id);
    if (!l || !l.node.children.length || l.node.collapsed === v) return;
    l.node.collapsed = v;
    this.renderOutline();
    this.focusNode(id, 'end');
  }

  indent(id, pos) {
    const l = this.loc(id);
    if (!l || l.index === 0 || l.node.kind === 'heading') return;
    this.pushUndo();
    const prev = l.list[l.index - 1];
    l.list.splice(l.index, 1);
    prev.children.push(l.node);
    prev.collapsed = false;
    l.node.gap = prev.kind === 'heading' ? l.node.gap : 0;
    this.touch(); this.redrawFocus(id, pos);
  }

  outdent(id, pos) {
    const l = this.loc(id);
    if (!l || !l.parent || l.parent.id === this.zoomId || l.parent.kind === 'heading') return;
    this.pushUndo();
    const pl = this.loc(l.parent.id);
    l.list.splice(l.index, 1);
    pl.list.splice(pl.index + 1, 0, l.node);
    this.touch(); this.redrawFocus(id, pos);
  }

  move(id, dir, pos) {
    const l = this.loc(id);
    if (!l) return;
    const j = l.index + dir;
    if (j < 0 || j >= l.list.length) return;
    this.pushUndo();
    [l.list[l.index], l.list[j]] = [l.list[j], l.list[l.index]];
    this.touch(); this.redrawFocus(id, pos);
  }

  removeNode(id, focusPrev = true) {
    const l = this.loc(id);
    if (!l) return;
    this.pushUndo();
    const target = focusPrev ? (this.neighbor(id, -1) || this.neighbor(id, 1)) : null;
    l.list.splice(l.index, 1);
    if (!this.zoomId && !this.page.nodes.length) this.page.nodes.push(mkNode(''));
    this.touch();
    this.renderOutline();
    if (target) this.focusNode(target, 'end');
  }

  appendNode() {
    const list = this.list();
    const last = list[list.length - 1];
    if (last && last.text === '' && !isRaw(last) && !last.children.length) return this.focusNode(last.id);
    this.pushUndo();
    const n = mkNode('');
    list.push(n);
    if (this.zoomId) this.zoomNode().collapsed = false;
    this.touch();
    this.renderOutline();
    this.focusNode(n.id);
  }

  moveTo(srcId, tgtId, zone) {
    const s = this.loc(srcId);
    if (!s || srcId === tgtId || isDesc(s.node, tgtId)) return;
    this.pushUndo();
    s.list.splice(s.index, 1);
    const t = this.loc(tgtId);
    if (!t) return;
    if (zone === 'inside') { t.node.children.push(s.node); t.node.collapsed = false; }
    else t.list.splice(t.index + (zone === 'after' ? 1 : 0), 0, s.node);
    this.touch(); this.renderOutline();
  }

  cycleKind(n, ta) {
    this.pushUndo();
    if (n.kind === 'bullet' || n.kind === 'para') { n.kind = 'todo'; n.checked = false; }
    else if (n.kind === 'todo' && !n.checked) setChecked(n, true);
    else if (n.kind === 'todo') { setChecked(n, false); n.kind = 'bullet'; }
    else return;
    this.touch(); this.redrawFocus(n.id, ta.selectionStart);
  }

  // ------------------------------------------------------------ input handling

  onInput(n, ta) {
    const now = performance.now();
    if (now - this.lastType > 900 || this.lastTypeId !== n.id) this.pushUndo();
    this.lastType = now; this.lastTypeId = n.id;
    let v = ta.value, m;
    const l = this.loc(n.id);
    if ((n.kind === 'bullet' || n.kind === 'para') && (m = /^\[( |x|X)?\] /.exec(v))) {
      n.kind = 'todo'; n.checked = /x/i.test(m[1] || '');
      n.text = v.slice(m[0].length);
      this.touch(); this.redrawFocus(n.id, 0);
      return;
    }
    if (n.kind === 'bullet' && l && (!l.parent || l.parent.kind === 'heading') && (m = /^(#{1,6}) /.exec(v))) {
      n.kind = 'heading'; n.level = m[1].length; n.gap = 1;
      n.text = v.slice(m[0].length);
      this.touch(); this.redrawFocus(n.id, 0);
      return;
    }
    n.text = v;
    this.touch();
    this.autosize(ta);
    this.checkTrigger(n, ta);
  }

  wrapSel(n, ta, mark) {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    this.pushUndo();
    const sel = value.slice(a, b);
    ta.value = value.slice(0, a) + mark + sel + mark + value.slice(b);
    n.text = ta.value;
    ta.setSelectionRange(a + mark.length, b + mark.length);
    this.touch(); this.autosize(ta);
  }

  onPaste(e, n, ta) {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text.includes('\n') || isRaw(n)) return;
    e.preventDefault();
    const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
    const parsed = parseBody(lines).nodes;
    const fix = list => { for (const x of list) { if (x.kind === 'para') { x.kind = 'bullet'; x.marker = '-'; } x.gap = 0; freshIds(x); fix(x.children); } };
    fix(parsed);
    if (!parsed.length) return;
    this.pushUndo();
    const l = this.loc(n.id);
    const before = ta.value.slice(0, ta.selectionStart), after = ta.value.slice(ta.selectionEnd);
    let target;
    if (before + after === '') { l.list.splice(l.index, 1, ...parsed); target = parsed[parsed.length - 1]; }
    else {
      parsed[0].text = before + parsed[0].text; n.text = ''; // merge first line into current node
      n.text = parsed[0].text; n.children.push(...parsed[0].children);
      const rest = parsed.slice(1);
      if (after) { const last = rest.length ? rest[rest.length - 1] : n; last.text += after; }
      l.list.splice(l.index + 1, 0, ...rest);
      target = rest.length ? rest[rest.length - 1] : n;
    }
    this.touch(); this.renderOutline();
    this.focusNode(target.id, 'end');
    toast(`Pasted ${lines.length} lines as outline`);
  }

  onKey(e, n, ta) {
    if (e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (this.sug) {
      if (key === 'ArrowDown' || key === 'ArrowUp') { e.preventDefault(); this.moveSuggest(key === 'ArrowDown' ? 1 : -1); return; }
      if (key === 'Enter' || key === 'Tab') { e.preventDefault(); this.acceptSuggest(); return; }
      if (key === 'Escape') { e.preventDefault(); this.closeSuggest(); return; }
    }
    const zr = n.id === this.zoomId;
    const pos = ta.selectionStart, end = ta.selectionEnd;
    const caret = pos === end;
    const lk = key.toLowerCase();

    if (mod && lk === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && lk === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && key === 'Enter') { e.preventDefault(); this.cycleKind(n, ta); return; }
    if (mod && !e.shiftKey && (lk === 'b' || lk === 'i')) { e.preventDefault(); this.wrapSel(n, ta, lk === 'b' ? '**' : '*'); return; }
    if (mod && e.shiftKey && key === 'Backspace' && !zr) { e.preventDefault(); this.removeNode(n.id); return; }
    if (mod && !e.shiftKey && !e.altKey && (key === 'ArrowUp' || key === 'ArrowDown') && !zr) { e.preventDefault(); this.setCollapsed(n.id, key === 'ArrowUp'); return; }
    if (e.altKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown') && !zr) { e.preventDefault(); this.move(n.id, key === 'ArrowUp' ? -1 : 1, [pos, end]); return; }

    switch (key) {
      case 'Enter': return this.onEnter(e, n, ta, zr);
      case 'Tab':
        e.preventDefault();
        if (zr) return;
        if (e.shiftKey) this.outdent(n.id, [pos, end]); else this.indent(n.id, [pos, end]);
        return;
      case 'Backspace':
        if (pos !== 0 || end !== 0 || zr) return;
        e.preventDefault();
        return this.backspaceAtStart(n);
      case 'Delete':
        if (!caret || pos !== ta.value.length || zr) return;
        return this.deleteAtEnd(e, n);
      case 'ArrowUp': {
        if (e.shiftKey || mod || e.altKey) return;
        const c = caretLines(ta);
        if (!c.first) return;
        const prev = this.neighbor(n.id, -1);
        if (!prev) return;
        e.preventDefault();
        const col = pos - (ta.value.lastIndexOf('\n', pos - 1) + 1);
        this.focusNode(prev, this.colPos(prev, col, true));
        return;
      }
      case 'ArrowDown': {
        if (e.shiftKey || mod || e.altKey) return;
        const c = caretLines(ta);
        if (!c.last) return;
        const next = this.neighbor(n.id, 1);
        if (!next) return;
        e.preventDefault();
        const col = pos - (ta.value.lastIndexOf('\n', pos - 1) + 1);
        this.focusNode(next, this.colPos(next, col, false));
        return;
      }
      case 'ArrowLeft':
        if (pos === 0 && end === 0 && !e.shiftKey && !mod) { const p = this.neighbor(n.id, -1); if (p) { e.preventDefault(); this.focusNode(p, 'end'); } }
        return;
      case 'ArrowRight':
        if (pos === ta.value.length && end === pos && !e.shiftKey && !mod) { const x = this.neighbor(n.id, 1); if (x) { e.preventDefault(); this.focusNode(x, 'start'); } }
        return;
      case 'Escape':
        ta.blur();
        return;
    }
  }

  colPos(id, col, fromEnd) {
    const ta = $(`.row[data-id="${id}"] .edit`, this.host);
    if (!ta) return 'end';
    const v = ta.value;
    if (fromEnd) { const ls = v.lastIndexOf('\n') + 1; return ls + Math.min(col, v.length - ls); }
    const le = v.indexOf('\n'); return Math.min(col, le < 0 ? v.length : le);
  }

  onEnter(e, n, ta, zr) {
    if (e.shiftKey) return; // soft line break
    const v = ta.value, pos = ta.selectionStart, end = ta.selectionEnd;
    if (n.kind === 'code') {
      if (!(pos === v.length && /\n(`{3,}|~{3,})\s*$/.test(v))) return; // newline inside code
    }
    if (n.kind === 'table') {
      if (!(pos === v.length && end === pos && v.endsWith('\n'))) return; // new table row
    }
    e.preventDefault();
    if (zr) {
      const c = mkNode('');
      this.pushUndo(); n.children.unshift(c); n.collapsed = false; this.touch();
      this.renderOutline(); this.focusNode(c.id, 'start');
      return;
    }
    const l = this.loc(n.id);
    if (!l) return;
    if (!isRaw(n) && /^(`{3,}|~{3,})[\w+-]*$/.test(v.trim()) && pos === v.length) {
      this.pushUndo();
      const fence = v.trim().match(/^(`{3,}|~{3,})/)[1];
      n.kind = 'code'; n.text = v.trim() + '\n\n' + fence; n.gap = Math.max(n.gap, 0);
      this.touch(); this.renderOutline();
      this.focusNode(n.id, v.trim().length + 1);
      return;
    }
    if (v === '' && !isRaw(n)) {
      if (n.kind === 'todo' || n.kind === 'heading') { this.pushUndo(); n.kind = 'bullet'; this.touch(); return this.redrawFocus(n.id, 0); }
      if (l.parent && l.parent.id !== this.zoomId) return this.outdent(n.id, 0);
    }
    this.pushUndo();
    const before = v.slice(0, pos), after = v.slice(end);
    const field = parseField(n);
    const hasKids = n.children.length && !n.collapsed;
    if (pos === 0 && before === '' && after !== '' && !isRaw(n)) {
      const nn = mkNode('', n.kind === 'todo' ? 'todo' : n.kind === 'heading' ? 'para' : n.kind, { marker: n.marker, gap: n.kind === 'heading' ? 1 : n.gap });
      l.list.splice(l.index, 0, nn);
      this.touch(); this.renderOutline(); this.focusNode(n.id, 0);
      return;
    }
    if (n.kind === 'table') n.text = v.replace(/\n+$/, '');
    else if (n.kind !== 'code') n.text = before;
    let kind = 'bullet', extra = {};
    if (n.kind === 'todo') kind = 'todo';
    else if (n.kind === 'para') { kind = 'para'; extra.gap = 1; }
    else if (n.kind === 'heading') { kind = 'para'; extra.gap = 1; }
    else if (isRaw(n)) { kind = 'bullet'; }
    if (field) kind = 'bullet';
    let marker = n.marker || '-';
    const nm = /^(\d+)([.)])$/.exec(marker);
    if (nm) marker = `${+nm[1] + 1}${nm[2]}`;
    const nn = mkNode(isRaw(n) ? '' : after, kind, { marker: kind === 'bullet' || kind === 'todo' ? marker : '-', ...extra });
    if (n.kind === 'heading' || hasKids) { n.children.unshift(nn); n.collapsed = false; }
    else l.list.splice(l.index + 1, 0, nn);
    this.touch(); this.renderOutline();
    this.focusNode(nn.id, 'start');
  }

  backspaceAtStart(n) {
    const l = this.loc(n.id);
    if (!l) return;
    if (n.kind === 'todo') { this.pushUndo(); n.kind = 'bullet'; n.checked = false; this.touch(); return this.redrawFocus(n.id, 0); }
    if (n.kind === 'heading') { this.pushUndo(); n.kind = 'para'; n.level = 0; this.touch(); return this.redrawFocus(n.id, 0); }
    const prevId = this.neighbor(n.id, -1);
    if (n.text === '') {
      if (n.children.length) return;
      return this.removeNode(n.id, true);
    }
    if (!prevId || prevId === this.zoomId || n.children.length) return;
    const p = this.loc(prevId);
    if (!p || isRaw(p.node) || isRaw(n)) return;
    this.pushUndo();
    const at = p.node.text.length;
    p.node.text += n.text;
    l.list.splice(l.index, 1);
    this.touch(); this.renderOutline();
    this.focusNode(prevId, at);
  }

  deleteAtEnd(e, n) {
    const nextId = this.neighbor(n.id, 1);
    if (!nextId) return;
    const x = this.loc(nextId), me = this.loc(n.id);
    if (!x || !me || isRaw(x.node) || isRaw(n)) return;
    e.preventDefault();
    this.pushUndo();
    const at = n.text.length;
    n.text += x.node.text;
    x.list.splice(x.index, 1);
    n.children.push(...x.node.children);
    this.touch(); this.renderOutline();
    this.focusNode(n.id, at);
  }

  // ------------------------------------------------------------ suggestions (#, [[, /)

  checkTrigger(n, ta) {
    if (isRaw(n)) return this.closeSuggest();
    const before = ta.value.slice(0, ta.selectionStart);
    let m;
    if ((m = /\[\[([^\[\]\n]*)$/.exec(before))) return this.openSuggest('page', m[1], before.length - m[1].length, n, ta);
    if ((m = /(?:^|[\s(])#([\p{L}\p{N}_\/-]*)$/u.exec(before)) && !/^#{1,6} /.test(ta.value)) return this.openSuggest('tag', m[1], before.length - m[1].length, n, ta);
    if ((m = /^\/([\w ]*)$/.exec(before)) && ta.value === before) return this.openSuggest('slash', m[1], 1, n, ta);
    this.closeSuggest();
  }

  suggestItems(type, q, n) {
    const v = this.vault;
    if (type === 'page') {
      const items = [];
      for (const p of v.pages.values()) {
        const s = fuzzy(q, p.path.replace(/\.md$/i, ''));
        if (s >= 0) items.push({ label: p.name, sub: p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '', value: p.name, s, icon: 'file' });
      }
      items.sort((a, b) => b.s - a.s);
      const out = items.slice(0, 7);
      if (q.trim() && !v.resolve(q.trim())) out.push({ label: `Create "${q.trim()}"`, value: q.trim(), create: true, icon: 'plus' });
      return out;
    }
    if (type === 'tag') {
      const own = new Set(extractTags(n.text).map(t => t.toLowerCase()));
      const items = v.tagStats().filter(t => !(t.count === 1 && own.has(t.key))).map(t => ({ label: '#' + t.name, sub: `${t.count}`, value: t.name, s: fuzzy(q, t.name), icon: 'tag' })).filter(i => i.s >= 0);
      items.sort((a, b) => b.s - a.s);
      const out = items.slice(0, 7);
      if (q && !out.some(i => i.value.toLowerCase() === q.toLowerCase())) out.push({ label: `New tag #${q}`, value: q, icon: 'plus' });
      return out;
    }
    const ql = q.toLowerCase().trim();
    return SLASH.filter(c => !ql || c.label.toLowerCase().includes(ql) || c.id.startsWith(ql)).map(c => ({ label: c.label, sub: c.hint, value: c.id, icon: c.icon }));
  }

  openSuggest(type, q, start, n, ta) {
    const items = this.suggestItems(type, q, n);
    if (!items.length) return this.closeSuggest();
    if (!this.sug || this.sug.type !== type) { this.closeSuggest(); this.sug = { type, index: 0, el: h('div', { class: 'suggest', onmousedown: e => e.preventDefault() }) }; document.body.append(this.sug.el); }
    Object.assign(this.sug, { items, q, start, n, ta });
    this.sug.index = Math.min(this.sug.index, items.length - 1);
    this.paintSuggest();
  }

  paintSuggest() {
    const s = this.sug;
    s.el.innerHTML = '';
    s.items.forEach((it, i) => s.el.append(h('div', {
      class: 'sg-item' + (i === s.index ? ' active' : ''),
      onmousemove: () => { if (s.index !== i) { s.index = i; $$('.sg-item', s.el).forEach((x, j) => x.classList.toggle('active', j === i)); } },
      onclick: () => { s.index = i; this.acceptSuggest(); },
    }, h('span', { class: 'sg-icon', html: icon(it.icon || 'file', 14) }), h('span', { class: 'sg-label' }, it.label), it.sub ? h('span', { class: 'sg-sub' }, it.sub) : null)));
    const r = s.ta.getBoundingClientRect();
    const sr = s.el.getBoundingClientRect();
    const below = r.bottom + 4;
    s.el.style.left = Math.min(r.left, innerWidth - 280) + 'px';
    s.el.style.top = (below + sr.height > innerHeight ? Math.max(8, r.top - sr.height - 4) : below) + 'px';
  }

  moveSuggest(d) {
    const s = this.sug;
    s.index = (s.index + d + s.items.length) % s.items.length;
    this.paintSuggest();
  }

  closeSuggest() {
    if (this.sug) { this.sug.el.remove(); this.sug = null; }
  }

  async acceptSuggest() {
    const s = this.sug;
    if (!s) return;
    const it = s.items[s.index];
    const { n, ta, start, type } = s;
    this.closeSuggest();
    this.pushUndo();
    const cur = ta.selectionStart;
    const set = (text, caret, sel) => {
      ta.value = text; n.text = text;
      ta.setSelectionRange(sel ? sel[0] : caret, sel ? sel[1] : caret);
      this.touch(); this.autosize(ta); ta.focus();
    };
    if (type === 'page') {
      if (it.create) await this.app.ensurePage(it.value, { quiet: true });
      const after = ta.value.slice(cur).replace(/^\]\]/, '');
      const head = ta.value.slice(0, start - 2) + `[[${it.value}]]`;
      set(head + after, head.length);
    } else if (type === 'tag') {
      const head = ta.value.slice(0, start - 1) + '#' + it.value + ' ';
      set(head + ta.value.slice(cur), head.length);
    } else this.runSlash(it.value, n, ta);
  }

  runSlash(id, n, ta) {
    const l = this.loc(n.id);
    const top = !l.parent || l.parent.kind === 'heading';
    const set = (text, a = text.length, b = a) => { ta.value = text; n.text = text; ta.setSelectionRange(a, b); this.touch(); this.autosize(ta); };
    if (id === 'task') { n.kind = 'todo'; n.checked = false; n.text = ''; this.touch(); return this.redrawFocus(n.id, 0); }
    if (/^h[123]$/.test(id)) {
      if (!top) return set(''), toast('Headings work at the top level of a page');
      n.kind = 'heading'; n.level = +id[1]; n.gap = 1; n.text = ''; this.touch(); return this.redrawFocus(n.id, 0);
    }
    if (id === 'code') { n.kind = 'code'; n.text = '```\n\n```'; this.touch(); return this.redrawFocus(n.id, 4); }
    if (id === 'field') return set('name:: ', 0, 4);
    if (id === 'today') return set(todayISO());
    if (id === 'tomorrow') return set(addDays(todayISO(), 1));
    if (id === 'link') { set('[['); return this.checkTrigger(n, ta); }
    if (id === 'tag') { set('#'); return this.checkTrigger(n, ta); }
  }

  // ------------------------------------------------------------ clicks + drag and drop

  onClick(e) {
    const wl = e.target.closest('a.wl');
    if (wl) { e.preventDefault(); this.app.openLink(wl.dataset.page); return; }
    const tg = e.target.closest('a.tag');
    if (tg) { e.preventDefault(); this.app.openTag(tg.dataset.tag); }
  }

  clearDrop() { $$('.drop-before,.drop-after,.drop-inside', this.host).forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-inside')); }

  initDnD() {
    const w = this.wrap;
    w.addEventListener('dragover', e => {
      if (!this.dragId) return;
      const row = e.target.closest('.row');
      if (!row || row.classList.contains('zoom-root')) return;
      const id = row.dataset.id;
      const src = this.loc(this.dragId);
      if (!src || id === this.dragId || isDesc(src.node, id)) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      const zone = y < 0.32 ? 'before' : y > 0.68 ? 'after' : 'inside';
      this.clearDrop();
      row.classList.add('drop-' + zone);
      this.drop = { id, zone };
    });
    w.addEventListener('drop', e => {
      if (!this.dragId || !this.drop) return;
      e.preventDefault();
      const { id, zone } = this.drop;
      const src = this.dragId;
      this.dragId = null; this.drop = null; this.clearDrop();
      this.moveTo(src, id, zone);
    });
  }
}
