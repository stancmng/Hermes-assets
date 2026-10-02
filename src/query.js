// Turns the parsed vault into an Airtable-style record set.
// A record is either a tagged outline node (fields = child `key:: value` bullets)
// or a page carrying that tag in its frontmatter (fields = frontmatter keys).

import { derive } from './store.js';
import { fmGet, fmSet, mkNode, parseField, stripTags, extractLinks, extractTags, setChecked } from './md.js';
import { isISODate, todayISO } from './util.js';

const HIDDEN_FM = new Set(['tags', 'tag', 'aliases', 'alias', 'cssclass', 'cssclasses']);

export const TYPES = ['text', 'number', 'date', 'select', 'checkbox', 'url', 'link'];
export const TYPE_LABEL = { text: 'Text', number: 'Number', date: 'Date', select: 'Select', checkbox: 'Checkbox', url: 'URL', link: 'Page link' };

export const isTruthy = v => /^(true|yes|y|x|1|checked|done)$/i.test(String(v ?? '').trim());
export const isNum = v => v !== '' && v != null && !isNaN(Number(v)) && isFinite(Number(v));
const isBool = v => /^(true|false|yes|no)$/i.test(v);
const isUrl = v => /^https?:\/\/\S+$/i.test(v);
const hasLink = v => /\[\[[^\]]+\]\]/.test(v);

export function inferType(values) {
  const vals = values.map(v => String(v ?? '').trim()).filter(Boolean);
  if (!vals.length) return 'text';
  if (vals.every(isNum)) return 'number';
  if (vals.every(isISODate)) return 'date';
  if (vals.every(isBool)) return 'checkbox';
  if (vals.every(isUrl)) return 'url';
  if (vals.every(hasLink)) return 'link';
  const uniq = new Set(vals);
  if (vals.every(v => v.length <= 24 && !v.includes(',')) && uniq.size <= 12 && (uniq.size < vals.length || (vals.length >= 3 && uniq.size <= 3))) return 'select';
  return 'text';
}

export const linkTargets = v => {
  const links = extractLinks(v || '');
  return links.length ? links : (v || '').split(',').map(s => s.trim()).filter(Boolean);
};

// ---------------------------------------------------------------- records

export class Rec {
  constructor(vault, page, node, tags) {
    this.vault = vault; this.page = page; this.node = node; this.tags = tags;
  }
  get id() { return this.node ? `${this.page.path}#${this.node.id}` : this.page.path; }
  get isPage() { return !this.node; }
  get title() { return this.node ? stripTags(this.node.text.split('\n')[0]) : this.page.name; }
  get isTodo() { return !!this.node && this.node.kind === 'todo'; }
  get checked() { return this.isTodo && this.node.checked; }

  setTitle(t) {
    if (!this.node) return;
    const tags = extractTags(this.node.text);
    this.node.text = (t.trim() + ' ' + tags.map(x => '#' + x).join(' ')).trim();
    this.vault.touch(this.page);
  }
  setChecked(v) {
    if (!this.isTodo) return;
    setChecked(this.node, v);
    this.vault.touch(this.page);
  }

  fieldMap() {
    const m = new Map();
    if (this.node) {
      for (const c of this.node.children) {
        const f = parseField(c);
        if (f && !m.has(f.key.toLowerCase())) m.set(f.key.toLowerCase(), { key: f.key, value: f.value.trim(), node: c });
      }
    } else {
      for (const e of this.page.fm.entries) {
        if (!e.key || e.complex || HIDDEN_FM.has(e.key.toLowerCase())) continue;
        const v = Array.isArray(e.value) ? e.value.join(', ') : (e.value ?? '');
        m.set(e.key.toLowerCase(), { key: e.key, value: String(v), entry: e });
      }
    }
    return m;
  }

  get(name) {
    switch (name) {
      case '@title': return this.title;
      case '@source': return this.node ? this.page.name : '';
      case '@done': return this.isTodo ? String(this.checked) : '';
      case '@tags': return this.tags.join(', ');
      case '@modified': return new Date(this.page.mtime).toISOString().slice(0, 10);
    }
    return this.fieldMap().get(name.toLowerCase())?.value ?? '';
  }

  set(name, value) {
    value = String(value ?? '').trim();
    if (name === '@title') return this.setTitle(value);
    if (name === '@done') return this.setChecked(isTruthy(value));
    if (this.node) {
      const f = this.fieldMap().get(name.toLowerCase());
      if (f) f.node.text = `${f.key}:: ${value}`.trimEnd();
      if (f && this.isTodo && name.toLowerCase() === 'status') this.node.checked = value.toLowerCase() === 'done';
      else if (value !== '') {
        let idx = 0;
        this.node.children.forEach((c, i) => { if (parseField(c)) idx = i + 1; });
        this.node.children.splice(idx, 0, mkNode(`${name}:: ${value}`));
        this.node.collapsed = false;
      }
    } else {
      const e = fmGet(this.page, name);
      fmSet(this.page, e?.key || name, Array.isArray(e?.value) ? value.split(/\s*,\s*/).filter(Boolean) : value);
    }
    this.vault.touch(this.page);
  }
}

const tagMatch = (t, key) => { t = t.toLowerCase(); return t === key || t.startsWith(key + '/'); };

export function collectRecords(vault, tagKey) {
  const out = [];
  for (const page of vault.pages.values()) {
    const d = derive(page);
    if (!tagKey) { out.push(new Rec(vault, page, null, d.pageTags)); continue; }
    if (d.pageTags.some(t => tagMatch(t, tagKey))) out.push(new Rec(vault, page, null, d.pageTags));
    for (const r of d.records) if (r.tags.some(t => tagMatch(t, tagKey))) out.push(new Rec(vault, page, r.node, r.tags));
  }
  return out;
}

// ---------------------------------------------------------------- schema

export function discoverFields(records) {
  const m = new Map();
  for (const r of records) {
    for (const [k, f] of r.fieldMap()) {
      const e = m.get(k) || { key: k, name: f.key, count: 0, values: [] };
      e.count++; e.values.push(f.value);
      m.set(k, e);
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

// Returns the persisted field list for a tag, adding newly discovered fields.
export function getSchema(vault, tagKey, records) {
  const id = tagKey || '*';
  const sch = (vault.config.schema[id] ||= { fields: [] });
  let changed = false;
  for (const f of discoverFields(records)) {
    if (!sch.fields.some(x => x.name.toLowerCase() === f.key)) {
      sch.fields.push({ name: f.name, type: inferType(f.values) });
      changed = true;
    }
  }
  if (changed) vault.saveConfig();
  return sch;
}

export function fieldOptions(field, records) {
  const opts = [...(field.options || [])];
  const seen = new Set(opts);
  for (const r of records) {
    const v = r.get(field.name);
    if (v && !seen.has(v)) { seen.add(v); opts.push(v); }
  }
  return opts;
}

export const SPECIAL = {
  '@title': { name: 'Name', type: 'text' },
  '@source': { name: 'Source', type: 'link' },
  '@done': { name: 'Done', type: 'checkbox' },
  '@tags': { name: 'Tags', type: 'text' },
  '@modified': { name: 'Modified', type: 'date' },
};

export function fieldMeta(schema, name) {
  if (SPECIAL[name]) return { ...SPECIAL[name], key: name };
  const f = schema.fields.find(x => x.name.toLowerCase() === name.toLowerCase());
  return f ? { ...f, key: f.name } : { name, type: 'text', key: name };
}

// ---------------------------------------------------------------- filter / sort / group

export const OPS = {
  text: [['contains', 'contains'], ['ncontains', 'does not contain'], ['is', 'is'], ['isnt', 'is not'], ['empty', 'is empty'], ['nempty', 'is not empty']],
  number: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['lt', '<'], ['gte', '≥'], ['lte', '≤'], ['empty', 'is empty'], ['nempty', 'is not empty']],
  date: [['is', 'is'], ['before', 'is before'], ['after', 'is after'], ['empty', 'is empty'], ['nempty', 'is not empty']],
  select: [['is', 'is'], ['isnt', 'is not'], ['empty', 'is empty'], ['nempty', 'is not empty']],
  checkbox: [['checked', 'is checked'], ['unchecked', 'is unchecked']],
};
OPS.url = OPS.text; OPS.link = OPS.text;
export const opNeedsValue = op => !['empty', 'nempty', 'checked', 'unchecked'].includes(op);

const dateVal = v => (String(v).trim().toLowerCase() === 'today' ? todayISO() : v);

export function matchFilter(rec, flt, meta) {
  const raw = rec.get(flt.field);
  const v = String(raw ?? '');
  const w = String(flt.value ?? '');
  switch (flt.op) {
    case 'empty': return v === '';
    case 'nempty': return v !== '';
    case 'checked': return isTruthy(v);
    case 'unchecked': return !isTruthy(v);
    case 'contains': return v.toLowerCase().includes(w.toLowerCase());
    case 'ncontains': return !v.toLowerCase().includes(w.toLowerCase());
    case 'is': return meta.type === 'date' ? v === dateVal(w) : v.toLowerCase() === w.toLowerCase();
    case 'isnt': return v.toLowerCase() !== w.toLowerCase();
    case 'eq': return isNum(v) && Number(v) === Number(w);
    case 'neq': return !(isNum(v) && Number(v) === Number(w));
    case 'gt': return isNum(v) && Number(v) > Number(w);
    case 'lt': return isNum(v) && Number(v) < Number(w);
    case 'gte': return isNum(v) && Number(v) >= Number(w);
    case 'lte': return isNum(v) && Number(v) <= Number(w);
    case 'before': return v !== '' && v < dateVal(w);
    case 'after': return v !== '' && v > dateVal(w);
  }
  return true;
}

function compare(a, b, meta, opts) {
  const ea = a === '' || a == null, eb = b === '' || b == null;
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1; // empties always last
  switch (meta.type) {
    case 'number': return Number(a) - Number(b);
    case 'checkbox': return Number(isTruthy(a)) - Number(isTruthy(b));
    case 'select': {
      const ia = opts.indexOf(a), ib = opts.indexOf(b);
      if (ia !== ib) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    }
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function applyView(records, view, schema) {
  let rows = records;
  const filters = (view.filters || []).filter(f => f.field);
  if (filters.length) {
    const metas = filters.map(f => fieldMeta(schema, f.field));
    rows = rows.filter(r => filters.every((f, i) => matchFilter(r, f, metas[i])));
  }
  if (view.search) {
    const q = view.search.toLowerCase();
    rows = rows.filter(r => r.title.toLowerCase().includes(q) || [...r.fieldMap().values()].some(f => f.value.toLowerCase().includes(q)));
  }
  const sorts = (view.sorts || []).filter(s => s.field);
  if (sorts.length) {
    const info = sorts.map(s => {
      const meta = fieldMeta(schema, s.field);
      return { s, meta, opts: meta.type === 'select' ? fieldOptions(meta, records) : [] };
    });
    rows = [...rows].sort((a, b) => {
      for (const { s, meta, opts } of info) {
        const c = compare(a.get(s.field), b.get(s.field), meta, opts);
        if (c) return s.dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }
  return rows;
}

export function groupRecords(rows, field, meta, allRecords) {
  const map = new Map();
  for (const r of rows) {
    const v = r.get(field);
    const vals = meta.type === 'link' ? (linkTargets(v).length ? linkTargets(v) : ['']) : [v];
    for (const x of vals) { if (!map.has(x)) map.set(x, []); map.get(x).push(r); }
  }
  let keys = [...map.keys()];
  if (meta.type === 'select') {
    const opts = fieldOptions(meta, allRecords);
    keys.sort((a, b) => (a === '' ? 1e9 : opts.indexOf(a)) - (b === '' ? 1e9 : opts.indexOf(b)));
  } else keys.sort((a, b) => (a === '' ? 1 : b === '' ? -1 : String(a).localeCompare(String(b), undefined, { numeric: true })));
  return keys.map(k => ({ key: k, rows: map.get(k) }));
}

// ---------------------------------------------------------------- creating records

export async function newNodeRecord(vault, tagName, values = {}, title = '') {
  const page = vault.pages.get('Inbox.md') || await vault.createPage('Inbox.md', '- Captured items land here\n');
  const n = mkNode(`${title || 'Untitled'} #${tagName}`);
  for (const [k, v] of Object.entries(values)) if (v !== '' && v != null) n.children.push(mkNode(`${k}:: ${v}`));
  page.nodes.push(n);
  vault.touch(page);
  return new Rec(vault, page, n, [tagName]);
}

export async function newPageRecord(vault, tagName, values = {}, title = 'Untitled') {
  const lines = ['---', 'tags:', `  - ${tagName}`];
  for (const [k, v] of Object.entries(values)) if (v !== '' && v != null) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  const page = await vault.createPage(`${tagName}/${title}.md`, lines.join('\n'));
  return new Rec(vault, page, null, [tagName]);
}

export const newViewId = () => 'v' + Math.random().toString(36).slice(2, 8);
