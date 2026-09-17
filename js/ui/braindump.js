/**
 * braindump.js — free text in, reviewable board changes out.
 *
 * The review step is the point of this view. The AI proposes; you tick what is right
 * and only that gets staged. Nothing here applies automatically, and nothing here
 * pushes: staged changes still go through the publish gate like any manual edit.
 */
import { statusLabel } from '../store.js';
import { proposeOperations, opsToEvents, AIError } from '../ai.js';
import { el, clear, notice, spinner, toast, plural } from './dom.js';

const PLACEHOLDER = `Finished the retry logic and pushed it for review.
Started looking at the flaky integration test — it only fails on CI, still digging.
Blocked on the staging credentials from platform.
New: need to write up the migration plan before Thursday.`;

export class BraindumpView {
  constructor(app) {
    this.app = app;
    this.root = el('div', { class: 'view-narrow' });
    this.text = '';
    this.proposals = null;      // null = not asked yet, [] = asked and nothing came back
    this.busy = false;
    this.error = null;
  }

  render() {
    clear(this.root);

    const input = el('textarea', {
      placeholder: PLACEHOLDER,
      rows: '8',
      'aria-label': 'Your update',
      on: { input: (e) => { this.text = e.target.value; } },
    });
    input.value = this.text;

    const go = el('button', {
      class: 'primary',
      text: 'Interpret this',
      disabled: this.busy,
      on: { click: () => this.interpret() },
    });

    this.root.append(el('div', { class: 'card' },
      el('h2', { text: 'What did you do?' }),
      el('p', { class: 'sub' }, 'Write it however you like. The AI turns it into board changes and ',
        el('strong', { text: 'shows you each one before anything is applied' }), '.'),
      el('div', { class: 'field', style: 'margin-top:12px' }, input),
      this.error ? notice('error', this.error) : null,
      el('div', { class: 'row', style: 'justify-content:flex-end' },
        el('span', { class: 'spacer' }),
        this.busy ? spinner('Reading your update…') : go)));

    if (this.proposals) this.root.append(this.reviewCard());
    return this.root;
  }

  async interpret() {
    if (!this.text.trim()) { toast('Write an update first.'); return; }
    const token = this.app.tokens.hf;
    if (!token) { this.error = 'No Hugging Face token set. Add one in Settings.'; this.app.refresh(); return; }

    this.busy = true;
    this.error = null;
    this.proposals = null;
    this.app.refresh();

    try {
      const ops = await proposeOperations({
        token,
        model: this.app.settings.model,
        tasks: this.app.tasks,
        text: this.text,
        includeNotes: this.app.settings.sendNotes,
      });
      this.proposals = ops.map((op) => ({ op, keep: true }));
      if (!ops.length) this.error = 'The AI did not find any board changes in that. Try being more specific about what moved.';
    } catch (e) {
      this.error = e instanceof AIError ? e.message : `Unexpected failure: ${e.message}`;
    } finally {
      this.busy = false;
      this.app.refresh();
    }
  }

  reviewCard() {
    const kept = () => this.proposals.filter((p) => p.keep);

    const apply = el('button', { class: 'primary', text: '' });
    const relabel = () => {
      const n = kept().length;
      apply.textContent = n ? `Apply ${plural(n, 'change')}` : 'Nothing selected';
      apply.disabled = !n;
    };

    apply.addEventListener('click', () => {
      const ops = kept().map((p) => p.op);
      this.app.stage(...opsToEvents(ops));
      this.proposals = null;
      this.text = '';
      toast(`Staged ${plural(ops.length, 'change')}. Review and publish when ready.`);
      this.app.go('board');
    });

    return el('div', { class: 'card' },
      el('h2', { text: 'Proposed changes' }),
      el('p', { class: 'sub', text: 'Untick anything wrong. These are staged locally — publishing is still a separate, deliberate step.' }),
      el('div', { style: 'margin-top:10px' }, this.proposals.map((p, i) => this.proposalRow(p, i, relabel))),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' },
        el('button', { text: 'Discard all', on: { click: () => { this.proposals = null; this.app.refresh(); } } }),
        el('span', { class: 'spacer' }),
        (relabel(), apply)));
  }

  proposalRow(p, i, relabel) {
    const box = el('input', {
      type: 'checkbox',
      checked: p.keep,
      id: `prop-${i}`,
      on: { change: (e) => { p.keep = e.target.checked; relabel(); } },
    });
    const { op } = p;

    return el('div', { class: 'proposal' }, box,
      el('label', { class: 'body', for: `prop-${i}` },
        el('div', { class: 'what' },
          el('span', { class: `op-badge op-${op.op}`, text: op.op }),
          describe(op)),
        op.rationale ? el('div', { class: 'why', text: op.rationale }) : null));
  }
}

/** Human-readable one-liner for a proposed operation. */
function describe(op) {
  switch (op.op) {
    case 'create': return `${op.title}${op.status !== 'todo' ? ` — as ${statusLabel(op.status)}` : ''}${op.priority !== 'normal' ? `, ${op.priority} priority` : ''}`;
    case 'status': return `${op.targetTitle}: ${statusLabel(op.from)} → ${statusLabel(op.status)}`;
    case 'note': return `${op.targetTitle}: ${op.text}`;
    case 'edit': return `${op.targetTitle}: set ${Object.entries(op.fields).map(([k, v]) => `${k} to ${Array.isArray(v) ? v.join(', ') || 'none' : v}`).join('; ')}`;
    default: return op.op;
  }
}
