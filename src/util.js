// Small DOM + data helpers shared by every module.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms) {
  let t, lastArgs;
  const d = (...a) => { lastArgs = a; clearTimeout(t); t = setTimeout(() => { t = null; fn(...lastArgs); }, ms); };
  d.flush = () => { if (t) { clearTimeout(t); t = null; fn(...lastArgs); } };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.pending = () => !!t;
  return d;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export function hashIdx(str, n = 8) {
  let x = 0;
  for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(x) % n;
}

// ---- dates ----
const pad = n => String(n).padStart(2, '0');
export const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => toISO(new Date());
export const isISODate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return toISO(d);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso) {
  if (!isISODate(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  const cur = new Date().getFullYear();
  return `${MONTHS[m - 1]} ${d}${y === cur ? '' : ', ' + y}`;
}
export function relDay(iso) {
  if (!isISODate(iso)) return '';
  const diff = Math.round((new Date(iso + 'T12:00:00') - new Date(todayISO() + 'T12:00:00')) / 864e5);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return '';
}

// ---- paths ----
export const baseName = p => p.split('/').pop().replace(/\.md$/i, '');
export const dirName = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// ---- misc ----
export function clone(o) { return structuredClone(o); }

export function fuzzy(query, text) {
  // returns score (higher better) or -1 when no match
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx - (t.length - q.length) * 0.1 + (idx === 0 ? 200 : 0);
  let ti = 0, score = 0, last = -2;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return -1;
    score += f === last + 1 ? 5 : 1;
    last = f; ti = f + 1;
  }
  return score;
}
