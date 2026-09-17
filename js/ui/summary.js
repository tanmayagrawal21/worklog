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
import { el, clear, notice, spinner, toast, shortTime } from './dom.js';

export class SummaryView {
  constructor(app) {
    this.app = app;
    this.root = el('div', { class: 'view-narrow' });
    this.busy = null;          // 'morning' | 'evening' while generating
    this.error = null;
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
      this.error ? notice('error', this.error) : null,
      el('div', { class: 'row', style: 'margin-top:12px' },
        this.button('morning', 'Morning summary', forToday.morning),
        this.button('evening', 'Evening summary', forToday.evening)),
      this.busy ? el('div', { style: 'margin-top:12px' }, spinner('Reading your log…')) : null));

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
      disabled: !!this.busy,
      on: { click: () => this.generate(kind) },
    });
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
    const token = this.app.tokens.hf;
    if (!token) { this.error = 'No Hugging Face token set. Add one in Settings.'; this.app.refresh(); return; }

    this.busy = kind;
    this.error = null;
    this.app.refresh();

    const today = todayISO();
    try {
      const summary = await summarise({
        token,
        model: this.app.settings.model,
        tasks: this.app.tasks,
        events: this.app.state.events,
        kind,
        previous: this.app.state.summaries[today]?.[kind === 'evening' ? 'morning' : 'evening'] || null,
        includeNotes: this.app.settings.sendNotes,
      });
      this.app.stage(summaryEvent({ date: today, kind, summary, model: this.app.settings.model }));
      toast('Summary written. It publishes with your next push.');
    } catch (e) {
      this.error = e instanceof AIError ? e.message : `Unexpected failure: ${e.message}`;
    } finally {
      this.busy = null;
      this.app.refresh();
    }
  }
}
