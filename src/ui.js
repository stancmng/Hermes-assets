// Shared UI primitives: popovers, menus, modal prompts, toasts.
import { h, $ } from './util.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------- popover

let openPop = null;

export function closePopover() {
  if (!openPop) return;
  const p = openPop; openPop = null;
  p.el.remove();
  document.removeEventListener('mousedown', p.onDown, true);
  document.removeEventListener('keydown', p.onKey, true);
  p.onClose?.();
}

export function popover(anchor, content, { align = 'left', onClose, width, cls = '' } = {}) {
  closePopover();
  const el = h('div', { class: 'popover ' + cls }, content);
  if (width) el.style.minWidth = width + 'px';
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
    const pw = el.offsetWidth, ph = el.offsetHeight;
    let left = align === 'right' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, innerWidth - pw - 8));
    let top = r.bottom + 4;
    if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 4);
    el.style.left = left + 'px'; el.style.top = top + 'px';
  };
  place();
  const onDown = e => { if (!el.contains(e.target) && !(anchor.contains && anchor.contains(e.target))) closePopover(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  openPop = { el, onDown, onKey, onClose };
  new ResizeObserver(place).observe(el);
  return { el, close: closePopover, place };
}

// items: [{label, icon?, onClick, danger?, checked?, disabled?}] or {sep:true} or {heading:'x'}
export function menu(anchor, items, opts = {}) {
  const list = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { list.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.heading) { list.append(h('div', { class: 'menu-heading' }, it.heading)); continue; }
    list.append(h('button', {
      class: 'menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''),
      disabled: it.disabled,
      onclick: e => { e.stopPropagation(); closePopover(); it.onClick?.(); },
    }, h('span', { class: 'mi-icon', html: it.icon ? icon(it.icon, 15) : '' }), h('span', { class: 'mi-label' }, it.label),
      it.checked ? h('span', { class: 'mi-check', html: icon('check', 14) }) : null,
      it.hint ? h('span', { class: 'mi-hint' }, it.hint) : null));
  }
  return popover(anchor, list, opts);
}

// ---------------------------------------------------------------- modal / prompt

export function modal(content, { onClose, cls = '' } = {}) {
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: 'modal ' + cls, role: 'dialog' }, content);
  back.append(box);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose?.(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  return { box, close };
}

export function prompt({ title, label, value = '', placeholder = '', confirm = 'OK' }) {
  return new Promise(resolve => {
    const input = h('input', { class: 'input', value, placeholder, spellcheck: false });
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal(h('form', { class: 'dialog', onsubmit: e => { e.preventDefault(); finish(input.value.trim() || null); } },
      h('h3', null, title), label ? h('label', { class: 'muted' }, label) : null, input,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => finish(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, confirm))), { onClose: () => finish(null) });
    input.focus(); input.select();
  });
}

export function confirmDialog({ title, body, confirm = 'Delete', danger = true }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal(h('div', { class: 'dialog' },
      h('h3', null, title), h('p', { class: 'muted' }, body),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), autofocus: true, onclick: () => finish(true) }, confirm))), { onClose: () => finish(false) });
    $('.btn.danger, .btn.primary', m.box)?.focus();
  });
}

// ---------------------------------------------------------------- toast

export function toast(msg, kind = '') {
  let host = $('#toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const t = h('div', { class: 'toast ' + kind }, msg);
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, 2800);
}
