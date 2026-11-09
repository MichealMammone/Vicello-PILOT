// UI toolkit: element builder, formatting, dialogs, toasts.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [p, val] of Object.entries(v)) { if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val; }
      }
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

/** Replace an element's children, skipping null/false (unlike native append, which prints "null"). */
export function fill(el, ...children) { clear(el); append(el, children); return el; }

// Display only: values are never changed by formatting. Money always shows cents; quantities and hours show at least
// two decimal places (3 → 3.00, 2.755 → 2.755) so nothing looks rounded to a whole number.
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const DEC = new Intl.NumberFormat('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
export const fmt = {
  money: (n) => AUD.format(n || 0),
  money0: (n) => AUD.format(n || 0), // was whole dollars; now cents everywhere
  pct: (n, d = 1) => `${((n || 0) * 100).toFixed(d)}%`,
  qty: (n) => DEC.format(n || 0),
  hours: (n) => `${DEC.format(Math.round((n || 0) * 100) / 100)} h`,
  /** Value for a number input: keeps every digit, pads to two decimals (3 → "3.00"). */
  dec2: (n) => {
    if (n === '' || n == null || !Number.isFinite(Number(n))) return n ?? '';
    const s = String(Number(n));
    return /e/i.test(s) || /\.\d{2,}$/.test(s) ? s : Number(n).toFixed(2);
  },
  date: (iso) => (iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'),
  datetime: (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'),
  ago(iso) {
    if (!iso) return '—';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
    return fmt.date(iso);
  },
};

export const STATUS_LABELS = {
  enquiry: 'Enquiry', quoting: 'Quoting', quoted: 'Quoted', won: 'Won', in_production: 'In production', installing: 'Installing', complete: 'Complete', lost: 'Missed', // wording only; the stored status stays "lost"
};
/** The company's statuses (Settings → Job statuses): renamed main statuses and their variations, in order. */
export const STATUS_OPTIONS = [];
export const CLOSED_STATUSES = ['complete', 'lost'];
export function setStatuses(list) {
  STATUS_OPTIONS.length = 0;
  for (const s of list || []) {
    STATUS_OPTIONS.push(s);
    if (s.builtin) STATUS_LABELS[s.key] = s.label;
  }
}
/** Label for a job's status: its variation if it has one, otherwise the (company's name for the) main status. */
export const statusLabel = (s, detail) => (detail && STATUS_OPTIONS.find((o) => o.key === detail)?.label) || STATUS_LABELS[s] || s;
export const statusChip = (s, detail) => h('span', { class: `chip st-${s}` }, statusLabel(s, detail));

export function marginChip(pct, floor) {
  if (pct == null || !Number.isFinite(pct)) return h('span', { class: 'chip' }, '—');
  const cls = pct < floor ? 'chip bad' : pct < floor + 0.05 ? 'chip warn' : 'chip ok';
  return h('span', { class: cls, title: 'Margin on sell price' }, fmt.pct(pct));
}

// ---------- toasts ----------
let toastHost;
export function toast(message, kind = 'info', ms = 3500) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const t = h('div', { class: `toast ${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

export function errorText(err) {
  if (!err) return 'Something went wrong.';
  const problems = err.details && err.details.problems;
  return problems && problems.length ? `${err.message}\n• ${problems.slice(0, 8).join('\n• ')}${problems.length > 8 ? `\n…and ${problems.length - 8} more` : ''}` : err.message;
}

export function showError(err) {
  console.error(err);
  const problems = err && err.details && err.details.problems;
  if (problems && problems.length) {
    modal({ title: err.message, body: h('ul', { class: 'problem-list' }, problems.map((p) => h('li', null, p))), actions: [{ label: 'OK', kind: 'primary' }] });
  } else toast(errorText(err), 'error', 6000);
}

// ---------- modal dialogs ----------
const openModals = [];
export const modalOpen = () => openModals.length > 0;

export function modal({ title, body, actions = [{ label: 'Close' }], width = 520, onClose, dismissable = true }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const footer = h('div', { class: 'modal-actions' });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: { width: `min(${width}px, calc(100vw - 32px))` } },
    h('div', { class: 'modal-head' }, h('h2', null, title), dismissable ? h('button', { class: 'icon-btn', 'aria-label': 'Close', on: { click: () => close() } }, '×') : null),
    h('div', { class: 'modal-body' }, body),
    footer);
  const prevFocus = document.activeElement;
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    backdrop.remove();
    openModals.splice(openModals.indexOf(api), 1);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose(result);
  }
  for (const a of actions) {
    const b = h('button', { class: `btn ${a.kind || ''}`, type: a.submit ? 'submit' : 'button' }, a.label);
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!a.onClick) return close(a.value);
      b.disabled = true;
      try {
        const r = await a.onClick();
        if (r !== false) close(r);
      } catch (err) { showError(err); } finally { b.disabled = false; }
    });
    footer.append(b);
  }
  backdrop.append(box);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && dismissable) close(); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      const primary = footer.querySelector('.btn.primary');
      if (primary) { e.preventDefault(); primary.click(); }
    }
  });
  document.body.append(backdrop);
  const api = { close, el: box };
  openModals.push(api);
  setTimeout(() => (box.querySelector('[autofocus], input:not([type=checkbox]), select, textarea') || footer.querySelector('.btn.primary') || box).focus(), 0);
  return api;
}

export function confirmDialog({ title, message, confirmLabel = 'OK', danger = false, cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    modal({
      title, body: h('p', { class: 'pre' }, message), width: 460,
      actions: [{ label: cancelLabel, value: false }, { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => true }],
      onClose: (r) => resolve(!!r),
    });
  });
}

/** Three-way choice used for unsaved changes. Resolves 'save' | 'discard' | 'cancel'. */
export function unsavedDialog(name) {
  return new Promise((resolve) => {
    modal({
      title: 'Save changes?', width: 460,
      body: h('p', null, `"${name}" has unsaved changes. Save them before continuing?`),
      actions: [
        { label: 'Cancel', value: 'cancel' },
        { label: "Don't save", kind: 'danger-ghost', onClick: () => 'discard' },
        { label: 'Save', kind: 'primary', onClick: () => 'save' },
      ],
      onClose: (r) => resolve(r || 'cancel'),
    });
  });
}

/**
 * Form dialog. fields: [{ name, label, type: text|email|password|number|select|textarea|checkbox|date|checklist, value, options:[{value,label}], required, help, min, step }]
 * Resolves with the values object, or null if cancelled. `validate(values)` may return an error string.
 */
export function formDialog({ title, fields, submitLabel = 'OK', width = 520, validate, intro }) {
  return new Promise((resolve) => {
    const inputs = {};
    const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'form', on: { submit: (e) => e.preventDefault() } },
      intro ? h('p', { class: 'muted' }, intro) : null,
      fields.map((f) => fieldRow(f, inputs)), err);
    modal({
      title, body: form, width,
      actions: [{ label: 'Cancel', value: null }, {
        label: submitLabel, kind: 'primary', submit: true,
        onClick: () => {
          const values = {};
          for (const f of fields) values[f.name] = readField(f, inputs[f.name]);
          for (const f of fields) {
            if (f.required && (values[f.name] === '' || values[f.name] == null || (Array.isArray(values[f.name]) && !values[f.name].length && f.type !== 'checklist'))) {
              err.hidden = false; err.textContent = `${f.label} is required.`; inputs[f.name].focus?.(); return false;
            }
          }
          const v = validate && validate(values);
          if (v) { err.hidden = false; err.textContent = v; return false; }
          return values;
        },
      }],
      onClose: (r) => resolve(r || null),
    });
  });
}

let fieldSeq = 0;
function fieldRow(f, inputs) {
  const id = `f${++fieldSeq}-${f.name}`;
  let input;
  if (f.type === 'select') {
    input = h('select', { id, name: f.name }, (f.options || []).map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value ?? '') }, o.label)));
  } else if (f.type === 'textarea') {
    input = h('textarea', { id, name: f.name, rows: f.rows || 3 }, f.value ?? '');
  } else if (f.type === 'checkbox') {
    input = h('input', { id, name: f.name, type: 'checkbox', checked: !!f.value });
    inputs[f.name] = input;
    return h('label', { class: 'check' }, input, h('span', null, f.label), f.help ? h('small', { class: 'muted' }, f.help) : null);
  } else if (f.type === 'checklist') {
    const wrap = h('div', { class: 'checklist', id });
    for (const o of f.options || []) {
      wrap.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', value: o.value, checked: (f.value || []).includes(o.value) }), h('span', null, o.label)));
    }
    input = wrap;
  } else {
    input = h('input', { id, name: f.name, type: f.type || 'text', value: f.value ?? '', autocomplete: f.autocomplete || 'off', min: f.min, step: f.step, placeholder: f.placeholder || '' });
  }
  if (f.autofocus) input.setAttribute('autofocus', '');
  inputs[f.name] = input;
  return h('div', { class: 'field' }, h('label', { for: id }, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null), input, f.help ? h('small', { class: 'muted' }, f.help) : null);
}

function readField(f, input) {
  if (f.type === 'checkbox') return input.checked;
  if (f.type === 'checklist') return [...input.querySelectorAll('input:checked')].map((i) => i.value);
  if (f.type === 'number') return input.value === '' ? '' : Number(input.value);
  return input.value.trim();
}

/** Small popup menu anchored to an element. items: [{label, onClick, disabled, danger} | '-'] */
export function popupMenu(anchor, items) {
  document.querySelectorAll('.popup-menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'popup-menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('div', { class: 'sep' })); continue; }
    menu.append(h('button', { role: 'menuitem', class: it.danger ? 'danger' : '', disabled: !!it.disabled, on: { click: () => { menu.remove(); it.onClick(); } } }, it.label));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { menu.remove(); anchor.focus(); } });
  menu.querySelector('button:not([disabled])')?.focus();
  return menu;
}
