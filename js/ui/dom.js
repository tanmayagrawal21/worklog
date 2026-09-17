/**
 * dom.js — the small helpers every view needs.
 *
 * el() builds nodes from plain objects instead of HTML strings. That is not only
 * terser: text always goes through textContent, so a task title containing "<" or a
 * model-authored note can never become markup. There is no templating in this app
 * for exactly that reason.
 */

/**
 * el('div', {class: 'card'}, 'text', childNode)
 * Props: `class`, `text`, `html` (rare, trusted only), `on` for listeners,
 * `dataset`, anything else becomes an attribute (or a property when it is boolean).
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (typeof v === 'boolean') node[k] = v;
    else node.setAttribute(k, v);
  }
  add(node, ...children);
  return node;
}

/**
 * Append children, skipping null/undefined/false.
 *
 * This exists because the native Node.append() STRINGIFIES anything that is not a
 * Node, so a `cond ? node : null` child silently renders the text "null". Every
 * append in this app goes through here for that reason.
 */
export function add(parent, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export const clear = (node) => { while (node.firstChild) node.firstChild.remove(); return node; };
export const $ = (sel, root = document) => root.querySelector(sel);

/* ---------- dialogs ------------------------------------------------------- */

/**
 * Build a <dialog> with head/body/foot and show it modally.
 * Returns a promise resolving to whatever the resolving button passed, or null when
 * dismissed with Escape or the backdrop — so callers can treat "no answer" as a no.
 */
export function dialog({ title, body, buttons = [], onClose = null, dismissable = true }) {
  const dlg = el('dialog', { 'aria-label': title });
  let settle;
  const done = new Promise((res) => { settle = res; });

  const close = (value) => { dlg.close(); settle(value); };

  const foot = el('div', { class: 'dlg-foot' });
  for (const b of buttons) {
    if (b === 'spacer') { foot.append(el('span', { class: 'spacer' })); continue; }
    foot.append(el('button', {
      class: b.class || '',
      text: b.label,
      disabled: !!b.disabled,
      on: { click: async () => { const v = b.value !== undefined ? b.value : (b.onClick ? await b.onClick(dlg) : true); if (v !== undefined) close(v); } },
    }));
  }

  add(dlg,
    el('div', { class: 'dlg-head' }, el('h2', { text: title })),
    el('div', { class: 'dlg-body' }, body),
    buttons.length ? foot : null,
  );

  dlg.addEventListener('cancel', (e) => {
    if (!dismissable) { e.preventDefault(); return; }
    settle(null);
  });
  dlg.addEventListener('close', () => { settle(null); onClose?.(); dlg.remove(); });

  document.body.append(dlg);
  dlg.showModal();
  return { dlg, done, close };
}

/** Yes/no gate. Used for anything that touches the user's repo. */
export async function confirm({ title, body, confirmLabel = 'Confirm', danger = false }) {
  const { done } = dialog({
    title,
    body: typeof body === 'string' ? el('p', { text: body }) : body,
    buttons: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, class: danger ? 'danger' : 'primary', value: true },
    ],
  });
  return (await done) === true;
}

/* ---------- transient feedback ------------------------------------------- */

export function toast(message, kind = '') {
  let host = $('#toasts');
  if (!host) document.body.append(host = el('div', { id: 'toasts' }));
  const t = el('div', { class: `toast ${kind}`.trim(), text: message, role: 'status' });
  host.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3200);
}

export const notice = (kind, text) => el('div', { class: `notice ${kind}`, text });
export const spinner = (label) => el('div', { class: 'loading' }, el('span', { class: 'spinner' }), label || 'Working…');

/* ---------- formatting ---------------------------------------------------- */

/** Coarse relative age. Deliberately vague: exact minutes are noise on a task card. */
export function age(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

export const shortTime = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
