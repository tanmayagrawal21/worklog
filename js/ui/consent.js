/**
 * consent.js — the one-time "this is about to leave your machine" gate.
 *
 * The board payload is filtered: boardPayload() drops every task flagged private, and
 * the notes toggle can withhold note text. The brain-dump box is not filtered and
 * cannot be — it is free text, and there is no honest way to guess which sentence in
 * it was the confidential one. So the mitigation is disclosure: before the first
 * request to a given cloud endpoint, show exactly what is about to be sent, verbatim,
 * and let the answer be no.
 *
 * Asked once per endpoint rather than once ever, and keyed on the URL as well as the
 * provider id, because "I trust the model I run at work" and "I trust some vendor I
 * pasted a key for" are different decisions. Changing either re-asks.
 *
 * Nothing here fires for the local tiers or the demo interpreter: no request leaves
 * the machine, so a warning would only teach people to click through warnings.
 */
import { boardPayload } from '../ai.js';
import { el, dialog, notice, plural } from './dom.js';

const STORE_KEY = 'worklog.aiconsent.v1';

/** Does using this endpoint mean sending work to someone else's computer? */
export const isCloud = (ep) => !!ep && !ep.local && !['none', 'rules', 'webgpu'].includes(ep.kind);

/** Provider *and* URL: a re-pointed endpoint is a new place, whatever it is called. */
export const consentKey = (ep) => `${ep?.id || '?'}|${ep?.baseUrl || ''}`;

const readAll = () => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
};

export function hasConsent(ep) {
  return readAll()[consentKey(ep)] === true;
}

export function rememberConsent(ep) {
  const all = readAll();
  all[consentKey(ep)] = true;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* private mode; ask again */ }
}

/** Used by Settings, so "forget my tokens" can also forget what they were trusted for. */
export function forgetConsent() {
  try { localStorage.removeItem(STORE_KEY); } catch { /* nothing to do */ }
}

/**
 * What a request would actually carry. Pure and separately testable, because the
 * numbers in the dialog are the whole point of it — a warning that overstates or
 * understates what is sent is worse than none.
 *
 * @param {{endpoint:object, tasks:object[], includeNotes:boolean, text?:string}} o
 */
export function disclosure({ endpoint, tasks = [], includeNotes = true, text = '' }) {
  const live = tasks.filter((t) => !t.deleted);
  const payload = boardPayload(live, { includeNotes });
  const noteCount = payload.reduce((n, t) => n + (t.recentNotes?.length || 0), 0);

  return {
    label: endpoint?.label || endpoint?.id || 'the configured provider',
    model: endpoint?.model || '(none set)',
    baseUrl: endpoint?.baseUrl || '',
    taskCount: payload.length,
    excludedPrivate: live.filter((t) => t.private).length,
    includeNotes: !!includeNotes,
    noteCount: includeNotes ? noteCount : 0,
    freeText: String(text || ''),
  };
}

/**
 * Ask, unless this endpoint has already been agreed to.
 * @returns {Promise<boolean>} false means do not send.
 */
export async function confirmCloudSend({ endpoint, tasks, includeNotes, text = '' }) {
  if (!isCloud(endpoint) || hasConsent(endpoint)) return true;

  const d = disclosure({ endpoint, tasks, includeNotes, text });
  const again = el('input', { type: 'checkbox', checked: true });

  const body = el('div', {},
    el('p', {}, 'This is the first request to ', el('strong', { text: d.label }),
      '. It runs on their servers, so the content below leaves your machine.'),

    el('div', { class: 'section-label', text: 'Going to' }),
    el('ul', {},
      el('li', {}, el('code', { text: d.baseUrl || '(no URL set)' })),
      el('li', {}, 'model ', el('code', { text: d.model }))),

    el('div', { class: 'section-label', text: 'Being sent' }),
    el('ul', {},
      el('li', { text: `${plural(d.taskCount, 'task')} from the board — titles, statuses, tags, priorities.` }),
      el('li', { text: d.includeNotes
        ? `${plural(d.noteCount, 'note')} of note text (the most recent few per task).`
        : 'No note text — your "titles only" setting withholds it.' }),
      d.excludedPrivate
        ? el('li', {}, el('strong', { text: `${plural(d.excludedPrivate, 'task')} marked private` }), ' — excluded, not sent.')
        : null),

    // The verbatim text, not a count of it. If someone is about to send a paragraph
    // they should not, reading it back is the thing most likely to stop them.
    d.freeText ? el('div', {},
      el('div', { class: 'section-label', text: 'And your update, exactly as typed' }),
      el('pre', { class: 'payload', text: d.freeText })) : null,

    d.freeText
      ? notice('warn', 'The private flag protects tasks, not this box. Whatever you type here is sent as written, so keep anything you cannot share out of it.')
      : null,

    el('div', { class: 'field' },
      el('label', { class: 'check' }, again,
        el('span', {}, el('strong', { text: 'Do not ask again for this provider' }),
          el('div', { class: 'hint', text: 'Asked again if you change provider or endpoint URL. The chip in the header always says where requests are going.' })))),
  );

  const { done } = dialog({
    title: 'Send this to a provider?',
    body,
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Send it', class: 'primary', value: true },
    ],
  });

  if (await done !== true) return false;
  if (again.checked) rememberConsent(endpoint);
  return true;
}

/**
 * The standing reminder, for when consent has been given and the dialog is gone.
 * Returns null on the local tiers so callers can drop it straight into a tree.
 */
export function cloudHint(endpoint) {
  if (!isCloud(endpoint)) return null;
  return el('div', { class: 'hint' }, 'Sent to ', el('strong', { text: endpoint.label }),
    '. Tasks marked private are held back; this box is not filtered, so leave out anything you cannot share.');
}
