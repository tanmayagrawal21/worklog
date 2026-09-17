/**
 * summary.js — the executive summary panel.
 *
 * Deliberately pointers, not prose: the whole value is being able to read the day in
 * ten seconds. Bullets carry task ids, so each one is clickable back to the card.
 *
 * A generated summary is stored as a summary.set event, which means it lands in the
 * repo next to the work it describes rather than living only in this browser.
 */
import { todayISO } from '../store.js';
import { summarise, summaryEvent, AIError } from '../ai.js';
import { endpointProblem } from '../providers.js';
import { el, clear, notice, spinner, toast, shortTime, confirm } from './dom.js';
import { confirmCloudSend } from './consent.js';

export class SummaryView {
  constructor(app) {
    this.app = app;
    this.root = el('div', { class: 'view-narrow' });
    this.busy = null;          // 'morning' | 'evening' while generating
    this.error = null;
    this.progressEl = el('div', { class: 'hint' });   // model download progress
  }

  render() {
    clear(this.root);
    const today = todayISO();
    const forToday = this.app.state.summaries[today] || {};

    this.root.append(el('div', { class: 'card' },
      el('h2', { text: `Today — ${today}` }),
      el('p', { class: 'sub' }, 'A ',
        el('strong', { text: 'morning' }), ' summary says where things stand; an ',
        el('strong', { text: 'evening' }), ' one says what moved.'),
      this.app.onRules ? notice('info', 'Written by the demo interpreter — a tally composed from the board and the day\'s events by keyword rules, not a model. A real provider says what it means rather than what it counts.') : null,
      this.error ? notice('error', this.error) : null,
      el('div', { class: 'row', style: 'margin-top:12px' },
        this.button('morning', 'Morning summary', forToday.morning),
        this.button('evening', 'Evening summary', forToday.evening)),
      this.busy ? el('div', { style: 'margin-top:12px' }, spinner('Reading your log…'), this.progressEl) : null));

    for (const kind of ['evening', 'morning']) {
      if (forToday[kind]) this.root.append(this.panel(kind, forToday[kind]));
    }

    if (!forToday.morning && !forToday.evening && !this.busy) {
      this.root.append(el('div', { class: 'card' }, el('p', { class: 'sub', text: 'No summary for today yet.' })));
    }

    const history = this.recent(today);
    if (history.length) this.root.append(el('div', { class: 'card' },
      el('h2', { text: 'Earlier days' }),
      el('div', {}, history.map(([date, kinds]) => {
        const s = kinds.evening || kinds.morning;
        return el('div', { style: 'padding:9px 0;border-top:1px solid var(--border)' },
          el('div', { class: 'section-label', style: 'margin:0', text: date }),
          el('div', { text: s.headline }));
      }))));

    return this.root;
  }

  recent(today) {
    return Object.entries(this.app.state.summaries)
      .filter(([d]) => d !== today)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7);
  }

  button(kind, label, existing) {
    return el('button', {
      class: existing ? '' : 'primary',
      text: existing ? `Regenerate ${kind}` : label,
      title: existing ? `Already written ${shortTime(existing.ts)}. Regenerating replaces it.` : '',
      disabled: !!this.busy,
      on: { click: () => this.generate(kind) },
    });
  }

  /**
   * Regenerating is not free — it is a request, and for the morning summary it is a
   * request that overwrites the reading you already read. So an existing summary asks
   * first, and says the two things that decide the answer: when it was written, and
   * whether anything has happened since.
   */
  async confirmReplace(kind, existing) {
    const fresh = !this.isStale(existing);
    const body = el('div', {},
      el('p', {}, `There is already a ${kind} summary for today, written `,
        el('strong', { text: shortTime(existing.ts) }),
        existing.model ? ` by ${existing.model}` : '', '. Regenerating replaces it.'),
      kind === 'morning'
        ? el('p', { class: 'sub', text: 'The morning summary reads the seven days before today, not today — so today\'s work will not change it. It is meant to be written once, at the start of the day.' })
        : null,
      fresh
        ? notice('info', 'Nothing on the board has changed since it was written, so the new one will likely say the same thing.')
        : notice('info', 'The board has changed since it was written, so this should pick up something new.'),
    );
    return confirm({ title: `Replace the ${kind} summary?`, body, confirmLabel: 'Regenerate' });
  }

  /**
   * Context for the next summary: for an evening, this morning's reading. For a
   * morning there is no earlier summary today by definition, so reach back to the last
   * one written — passing today's non-existent evening meant the morning summary was
   * generated with no continuity at all.
   */
  previousSummary(kind, today) {
    const forToday = this.app.state.summaries[today] || {};
    if (kind === 'evening') return forToday.morning || null;
    const [, kinds] = Object.entries(this.app.state.summaries)
      .filter(([d]) => d < today)
      .sort((a, b) => b[0].localeCompare(a[0]))[0] || [];
    return kinds ? (kinds.evening || kinds.morning || null) : null;
  }

  /**
   * A summary describes a moment. Once the board moves past it, say so rather than
   * quietly showing a stale reading — that is how the summary and board stay in sync.
   */
  isStale(summary) {
    const latest = this.app.state.lastEventTs;
    return latest && summary.ts && latest > summary.ts;
  }

  panel(kind, s) {
    const stale = this.isStale(s);
    return el('div', { class: 'card summary' },
      el('div', { class: 'section-label', style: 'margin-top:0' }, `${kind} · ${shortTime(s.ts)}${s.model ? ` · ${s.model}` : ''}`),
      stale ? el('div', { class: 'stale', text: 'The board has changed since this was written. Regenerate to bring it up to date.' }) : null,
      el('div', { class: 'headline', text: s.headline }),
      s.bullets?.length ? el('ul', {}, s.bullets.map((b) => el('li', {}, b.text,
        (b.taskIds || []).map((id) => el('button', {
          class: 'taskref',
          text: id,
          title: 'Show this task on the board',
          on: { click: () => this.app.reveal(id) },
        }))))) : null,
      s.risks?.length ? el('div', {}, el('div', { class: 'section-label', text: 'Risks' }),
        el('ul', { class: 'risks' }, s.risks.map((r) => el('li', { text: r })))) : null,
      s.next?.length ? el('div', {}, el('div', { class: 'section-label', text: 'Next' }),
        el('ul', {}, s.next.map((r) => el('li', { text: r })))) : null);
  }

  async generate(kind) {
    const endpoint = this.app.endpoint;
    const problem = endpointProblem(endpoint);
    if (problem) { this.error = problem; this.app.refresh(); return; }

    const today = todayISO();
    const existing = this.app.state.summaries[today]?.[kind];
    if (existing && !await this.confirmReplace(kind, existing)) return;

    // No free text here, so this only discloses the board payload -- but it is still
    // the first thing that leaves, and the count of what leaves is worth seeing once.
    if (!await confirmCloudSend({
      endpoint,
      tasks: this.app.tasks,
      includeNotes: this.app.settings.sendNotes,
    })) return;

    this.busy = kind;
    this.error = null;
    this.progressEl.textContent = '';
    this.app.refresh();

    try {
      const summary = await summarise({
        endpoint,
        tasks: this.app.tasks,
        events: this.app.state.events,
        kind,
        previous: this.previousSummary(kind, today),
        includeNotes: this.app.settings.sendNotes,
        onProgress: ({ text, progress }) => {
          this.progressEl.textContent = `${text}${progress ? ` (${Math.round(progress * 100)}%)` : ''}`;
        },
      });
      this.app.stage(summaryEvent({ date: today, kind, summary, model: endpoint.model }));
      toast('Summary written. It publishes with your next push.');
    } catch (e) {
      this.error = e instanceof AIError ? e.message : `Unexpected failure: ${e.message}`;
    } finally {
      this.busy = null;
      this.app.refresh();
    }
  }
}
