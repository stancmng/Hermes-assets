// Markdown <-> outline model. Lossless for the constructs people actually use in
// Obsidian vaults: YAML frontmatter, bullets, tasks, numbered lists, headings,
// fenced code, paragraphs and tables (kept as raw lines).
//
// Node: { id, kind: bullet|todo|heading|para|code, text, level, checked, marker,
//         gap (blank lines before), collapsed, children[] }

import { esc } from './util.js';

let _id = 0;
export const nid = () => 'n' + (++_id).toString(36);

export const isRaw = n => n.kind === 'code' || n.kind === 'table';

export function mkNode(text = '', kind = 'bullet', extra = {}) {
  return { id: nid(), kind, text, level: 0, checked: false, marker: '-', gap: 0, collapsed: false, children: [], ...extra };
}

// ------------------------------------------------------------ frontmatter

const KEY_RE = /^([^\s#\-][^:]*?):(?:\s+(.*)|\s*)$/;

function unquote(s) {
  s = s.trim();
  if (/^".*"$/s.test(s)) return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (/^'.*'$/s.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function splitInline(s) {
  const out = []; let cur = '', q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; }
    else if (ch === '"' || ch === "'") { q = ch; cur += ch; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '' || out.length) out.push(cur);
  return out.map(unquote).filter(x => x !== '');
}

function parseFM(lines) {
  const entries = [];
  let cur = null;
  for (const line of lines) {
    const m = KEY_RE.exec(line);
    if (m && !/^\s/.test(line)) {
      cur = { key: m[1].trim(), raw: [line], inline: (m[2] ?? '').trim(), dirty: false };
      entries.push(cur);
    } else if (cur) cur.raw.push(line);
    else entries.push({ key: null, raw: [line], dirty: false });
  }
  for (const e of entries) {
    if (e.key == null) continue;
    const rest = e.raw.slice(1).filter(l => l.trim() !== '');
    if (e.inline === '' && rest.length && rest.every(l => /^\s*-\s+/.test(l))) {
      e.value = rest.map(l => unquote(l.replace(/^\s*-\s+/, '')));
    } else if (e.inline === '' && rest.length === 0) e.value = '';
    else if (rest.length) { e.value = null; e.complex = true; }
    else if (e.inline.startsWith('[') && e.inline.endsWith(']')) e.value = splitInline(e.inline.slice(1, -1));
    else if (/^[|>]/.test(e.inline)) { e.value = null; e.complex = true; }
    else e.value = unquote(e.inline);
  }
  return entries;
}

function fmScalar(v) {
  const s = String(v);
  if (s === '') return '';
  if (/^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(s) && !/^-?\d/.test(s) || /:\s|\s#|\s$/.test(s) || /^\s/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

function fmLines(e) {
  if (!e.dirty || e.key == null) return e.raw;
  const v = e.value;
  if (Array.isArray(v)) {
    if (!v.length) return [`${e.key}: []`];
    return [`${e.key}:`, ...v.map(x => `  - ${fmScalar(x)}`)];
  }
  const s = fmScalar(v ?? '');
  return [s === '' ? `${e.key}:` : `${e.key}: ${s}`];
}

export const fmGet = (page, key) => page.fm.entries.find(e => e.key && e.key.toLowerCase() === key.toLowerCase());

export function fmSet(page, key, value) {
  let e = fmGet(page, key);
  if (!e) { e = { key, raw: [], dirty: true }; page.fm.entries.push(e); }
  e.value = value; e.dirty = true; e.complex = false;
  page.fm.present = true;
}

export function fmDelete(page, key) {
  page.fm.entries = page.fm.entries.filter(e => !(e.key && e.key.toLowerCase() === key.toLowerCase()));
}

export function fmTags(page) {
  const e = fmGet(page, 'tags') || fmGet(page, 'tag');
  if (!e || e.value == null) return [];
  const arr = Array.isArray(e.value) ? e.value : String(e.value).split(/[,\s]+/);
  return arr.map(t => String(t).trim().replace(/^#/, '')).filter(Boolean);
}

// ------------------------------------------------------------ parsing

const cols = ws => { let n = 0; for (const c of ws) n += c === '\t' ? 4 : 1; return n; };

export function parsePage(raw) {
  const bom = raw.charCodeAt(0) === 0xFEFF;
  if (bom) raw = raw.slice(1);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const fm = { present: false, entries: [] };
  if (lines[0] === '---') {
    const end = lines.findIndex((l, i) => i > 0 && (l === '---' || l === '...'));
    if (end > 0) {
      fm.present = true;
      fm.entries = parseFM(lines.slice(1, end));
      lines = lines.slice(end + 1);
    }
  }
  const body = parseBody(lines);
  return { fm, nodes: body.nodes, unit: body.unit || '  ', eol, trailing: body.trailing, bom };
}

const BULLET_RE = /^([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/s;
const TODO_RE = /^\[( |x|X)\](?:[ \t]+(.*))?$/s;

export function parseBody(lines) {
  const root = { children: [] };
  const stack = [{ node: root, ind: -2, hl: 0 }];
  let gap = 0, unit = null, cont = null, tbl = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { gap++; cont = null; continue; }
    const ws = /^[ \t]*/.exec(line)[0];
    const ind = cols(ws);
    const rest = line.slice(ws.length);
    let node, heading = 0, isBullet = false;

    const fence = /^(`{3,}|~{3,})/.exec(rest);
    const hm = ind === 0 ? /^(#{1,6})[ \t]+(.*)$/.exec(rest) : null;
    const bm = BULLET_RE.exec(rest);
    if (fence) {
      const f = fence[1];
      const out = [rest];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        const lw = /^[ \t]*/.exec(l)[0];
        out.push(l.slice(Math.min(lw.length, ws.length)));
        if (new RegExp('^' + f[0] + '{' + f.length + ',}\\s*$').test(l.trim())) break;
      }
      i = j;
      node = mkNode(out.join('\n'), 'code', { gap });
      cont = null;
    } else if (hm) {
      heading = hm[1].length;
      node = mkNode(hm[2], 'heading', { level: heading, gap });
      cont = null;
    } else if (bm) {
      isBullet = true;
      let text = bm[2] ?? '';
      const tm = TODO_RE.exec(text);
      if (tm) node = mkNode(tm[2] ?? '', 'todo', { checked: tm[1] !== ' ', marker: bm[1], gap });
      else node = mkNode(text, 'bullet', { marker: bm[1], gap });
      if (ind > 0 && unit === null) unit = ws.includes('\t') ? '\t' : ' '.repeat(ind);
    } else if (/^\|.*\|\s*$/.test(rest)) {
      // markdown table: consecutive pipe rows become one block
      if (tbl && tbl.ind === ind && gap === 0) { tbl.node.text += '\n' + rest; continue; }
      node = mkNode(rest, 'table', { gap });
      cont = null;
    } else {
      // plain text: a continuation of the previous bullet when indented deeper
      if (cont && ind > cont.ind && gap === 0) { cont.node.text += '\n' + rest; continue; }
      node = mkNode(rest, 'para', { gap });
      cont = null;
    }
    tbl = node.kind === 'table' ? { node, ind } : null;

    if (heading) {
      while (stack.length > 1 && (stack[stack.length - 1].hl === 0 || stack[stack.length - 1].hl >= heading)) stack.pop();
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node, ind: -1, hl: heading });
    } else {
      while (stack[stack.length - 1].ind >= ind) stack.pop();
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node, ind, hl: 0 });
    }
    if (isBullet) cont = { node, ind };
    gap = 0;
  }
  return { nodes: root.children, unit, trailing: gap };
}

// ------------------------------------------------------------ serializing

export function serializeNodes(nodes, unit = '  ') {
  const out = [];
  const walk = (list, depth) => {
    for (const n of list) {
      for (let g = 0; g < n.gap; g++) out.push('');
      const ind = unit.repeat(depth);
      if (n.kind === 'heading') out.push(ind + '#'.repeat(n.level || 1) + ' ' + n.text.replace(/\n/g, ' '));
      else if (n.kind === 'code') for (const l of n.text.split('\n')) out.push(l === '' ? '' : ind + l);
      else if (n.kind === 'para' || n.kind === 'table') for (const l of n.text.split('\n')) out.push(ind + l);
      else {
        const box = n.kind === 'todo' ? (n.checked ? '[x] ' : '[ ] ') : '';
        const marker = n.marker || '-';
        const lines = n.text.split('\n');
        let head = ind + marker + ' ' + box + lines[0];
        if (lines[0] === '') head = head.trimEnd();
        out.push(head);
        const pad = ind + ' '.repeat(marker.length + 1);
        for (const l of lines.slice(1)) out.push(pad + l);
      }
      walk(n.children, n.kind === 'heading' ? depth : depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

export function serializePage(p) {
  const lines = [];
  if (p.fm.present || p.fm.entries.length) {
    lines.push('---');
    for (const e of p.fm.entries) lines.push(...fmLines(e));
    lines.push('---');
  }
  lines.push(...serializeNodes(p.nodes, p.unit));
  for (let i = 0; i < p.trailing; i++) lines.push('');
  return lines.length ? (p.bom ? '\uFEFF' : '') + lines.join(p.eol) + p.eol : '';
}

// ------------------------------------------------------------ tree helpers

export function walkNodes(nodes, fn, parent = null, depth = 0) {
  for (const n of nodes) {
    if (fn(n, parent, depth) === false) continue;
    walkNodes(n.children, fn, n, depth + 1);
  }
}

export function findNode(nodes, id, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, parent, list: nodes, index: i };
    const r = findNode(n.children, id, n);
    if (r) return r;
  }
  return null;
}

export const cloneNodes = nodes => structuredClone(nodes);

export function freshIds(node) {
  node.id = nid();
  node.children.forEach(freshIds);
  return node;
}

export function nodePath(nodes, id) {
  // index path like [2,0,1] for restoring focus after a reparse
  const walk = (list, path) => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return [...path, i];
      const r = walk(list[i].children, [...path, i]);
      if (r) return r;
    }
    return null;
  };
  return walk(nodes, []);
}

export function nodeAtPath(nodes, path) {
  let list = nodes, n = null;
  for (const i of path) { n = list?.[i]; if (!n) return null; list = n.children; }
  return n;
}

// ------------------------------------------------------------ text semantics

const TAG_RE = /(^|[\s(])#((?=[\p{L}\p{N}_\/-]*[\p{L}_-])[\p{L}\p{N}_\/-]+)/gu;
const FIELD_RE = /^([\p{L}\p{N}_][\p{L}\p{N}_ \-.]{0,48}?)::[ \t]?(.*)$/su;
const LINK_RE = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g;

const stripForTags = t => t.replace(/`[^`]*`/g, ' ').replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\]\([^)]*\)/g, ' ').replace(/https?:\/\/\S+/g, ' ');

export function extractTags(text) {
  const out = [];
  for (const m of stripForTags(text).matchAll(TAG_RE)) out.push(m[2]);
  return out;
}

export function extractLinks(text) {
  const out = [];
  for (const m of text.matchAll(LINK_RE)) out.push(m[1].trim());
  return out;
}

export function parseField(node) {
  if (node.kind !== 'bullet' && node.kind !== 'todo') return null;
  const m = FIELD_RE.exec(node.text);
  return m ? { key: m[1].trim(), value: m[2] } : null;
}

export const stripTags = text => text.replace(TAG_RE, (m, pre) => pre).replace(/[ \t]{2,}/g, ' ').trim();

// ------------------------------------------------------------ inline renderer
// Escapes first, then upgrades markdown. Output is safe to assign to innerHTML.

const SAFE_URL = /^(https?:|mailto:|tel:)/i;

export function renderInline(text, ctx = {}) {
  const holds = [];
  const hold = html => { holds.push(html); return `\u0000${holds.length - 1}\u0000`; };
  let s = text;

  // code spans
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  // wikilinks
  s = s.replace(LINK_RE, (m, target, alias) => {
    const t = target.trim();
    const label = (alias && alias.trim()) || t;
    const exists = ctx.resolve ? !!ctx.resolve(t) : true;
    return hold(`<a class="wl${exists ? '' : ' missing'}" data-page="${esc(t)}">${esc(label)}</a>`);
  });
  // images + links
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) =>
    SAFE_URL.test(url) ? hold(`<img class="inl" alt="${esc(alt)}" src="${esc(url)}" loading="lazy">`) : esc(m));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
    SAFE_URL.test(url) ? hold(`<a class="ext" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`) : esc(m));
  // bare urls
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, (m, pre, url) =>
    pre + hold(`<a class="ext" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url.replace(/^https?:\/\/(www\.)?/, ''))}</a>`));
  // tags
  s = s.replace(TAG_RE, (m, pre, tag) => pre + hold(`<a class="tag" data-tag="${esc(tag)}">#${esc(tag)}</a>`));

  s = esc(s);
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
    .replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => holds[+i]);
}

// A single-line summary used in tables / search results (no markup).
export function plain(text) {
  return text
    .replace(LINK_RE, (m, t, a) => a || t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`=]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Checking a task also finishes its `status` field (and un-finishing reopens it).
export function setChecked(node, checked) {
  node.checked = !!checked;
  for (const c of node.children) {
    const f = parseField(c);
    if (!f || f.key.toLowerCase() !== 'status') continue;
    const cur = f.value.trim().toLowerCase();
    if (checked && cur !== 'done') c.text = `${f.key}:: Done`;
    else if (!checked && cur === 'done') c.text = `${f.key}:: Todo`;
    break;
  }
}
