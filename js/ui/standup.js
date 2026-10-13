/**
 * standup.js — compose the report you post to your team, and keep a copy.
 *
 * Two ways to fill the box, and the first one needs no model at all: the log already
 * knows what you touched today, which removes the worst part of a daily report —
 * remembering at 6pm what you did at 10am. "Write it up" then asks a model to phrase
 * those lines the way a person does, which is a rewriting job rather than a lookup.
 *
 * Then it gets out of the way. The text is an ordinary textarea you can rewrite
 * completely before copying, because these are your words going to your colleagues
 * and a report you cannot edit is one you will stop trusting. Copying is also what
 * records it — a report you sent is a fact about the day, so it belongs in the log
 * next to the work, and tomorrow's reminder can stop nagging about it.
 */
import { todayISO, localTime } from '../store.js';
import {
  buildReport, renderReport, renderGroups, groupsOf, modelPayload, reportSize,
  standupEvent, GROUPINGS, DEFAULT_PREAMBLE,
} from '../standup.js';
import { writeStandup, AIError } from '../ai.js';
import { endpointProblem } from '../providers.js';
import { el, clear, notice, spinner, toast, copyText, shortTime, plural } from './dom.js';
import { confirmCloudSend } from './consent.js';

const KINDS = Object.freeze([
  ['evening', 'Sign-off'],
  ['morning', 'Morning'],
]);

export class StandupView {
  constructor(app) {
    this.app = app;
    this.root = el('div', { class: 'view-narrow' });

    // Which report you want is a question the clock can usually answer.
    this.kind = new Date().getHours() < 12 ? 'morning' : 'evening';
    this.group = 'project';
    this.markdown = false;
    this.preamble = null;        // null = whatever the default for this kind is
    this.note = '';
    this.includePlan = false;    // morning only

    this.draft = null;           // the text in the box; null until first built
    this.touched = false;        // you have typed in the box; never clobber it
    this.optionsStale = false;   // an option changed while your text was in the box
    this.written = null;         // model-written groups, if you asked for them
    this.busy = false;
    this.error = null;
    this.progressEl = el('div', { class: 'hint' });
  }

  /** Build from the log and put it in the box, discarding whatever was there. */
  rebuild({ keepWritten = false } = {}) {
    if (!keepWritten) this.written = null;
    this.report = buildReport({
      tasks: this.app.tasks,
      events: this.app.state.events,
      kind: this.kind,
      date: todayISO(),
      includePlan: this.includePlan,
    });
    this.draft = this.text();
    this.touched = false;
    this.optionsStale = false;
    // Which event the draft was built from, so a card moved afterwards can be noticed.
    this.builtAt = this.app.state.lastEventTs;
    return this.report;
  }

  /** The current draft text: the model's lines when it wrote some, else the log's. */
  text() {
    const opts = { markdown: this.markdown, preamble: this.preamble, note: this.note };
    return this.written
      ? renderGroups(this.written, { kind: this.kind, ...opts })
      : renderReport(this.report, { group: this.group, ...opts });
  }

  /** True when the log has moved on since the draft was built. */
  get stale() { return this.app.state.lastEventTs !== this.builtAt; }

  /**
   * An option changed. Re-render the text when the box is untouched; when it is not,
   * leave your text alone and offer the rebuild instead. Silently discarding a report
   * someone just wrote by hand because they nudged a dropdown would be unforgivable.
   */
  optionChanged() {
    if (this.touched) { this.optionsStale = true; this.app.refresh(); return; }
    this.draft = this.text();
    this.app.refresh();
  }

  render() {
    clear(this.root);

    // Rebuild on first render, and whenever the log has moved under an untouched
    // draft. That second case is not an edge case: the very first render happens
    // before the repo has finished loading, so without it the pane would sit there
    // showing the empty report it was built from while the board filled in behind it.
    if (this.draft === null || (!this.touched && this.stale)) this.rebuild({ keepWritten: true });

    const today = todayISO();
    const posted = this.app.state.standups?.[today]?.[this.kind];
    const count = reportSize(this.report);

    const box = el('textarea', {
      rows: '14',
      class: 'mono',
      'aria-label': 'Your report',
      placeholder: 'Your report — rewrite it however you like.',
      on: { input: (e) => { this.draft = e.target.value; this.touched = true; } },
    });
    box.value = this.draft;

    this.root.append(el('div', { class: 'card' },
      el('h2', { text: `${this.kind === 'morning' ? 'Morning' : 'Sign-off'} — ${today}` }),
      el('p', { class: 'sub' }, 'Built from your log, not from memory. Edit it freely, then copy it into ',
        el('strong', { text: 'Slack, Teams or wherever your team reads it' }), '.'),

      el('div', { class: 'row tight', style: 'margin-top:12px' }, this.kindButtons(), el('span', { class: 'spacer' })),

      el('div', { class: 'row', style: 'margin-top:10px' },
        el('div', { class: 'field' }, el('label', { text: 'Grouping' }), this.groupSelect()),
        el('div', { class: 'field' }, el('label', { text: 'First line' }), this.preambleInput())),

      el('div', { class: 'field' }, el('label', { text: 'A line of your own (optional)' }), this.noteInput(),
        el('div', { class: 'hint', text: 'For the things the board does not know: a half day, an early finish, a meeting that ate the afternoon.' })),

      this.markdownToggle(),
      this.kind === 'morning' ? this.planToggle() : null,

      this.error ? notice('error', this.error) : null,

      this.kind === 'evening' && this.report?.empty
        ? notice('warn', 'Nothing is logged against today yet, so there is nothing to build a report from. Move cards on the board or write an update in the brain dump — or just type the report here yourself.')
        : null,

      this.optionsStale
        ? notice('info', 'You have edited this, so the change has not been applied. Rebuild from log to take it, and lose your edits.')
        : this.touched && this.stale
          ? notice('info', 'Your log has changed since this draft was built. Rebuild from log to pick that up.')
          : null,

      el('div', { class: 'field', style: 'margin-top:12px' }, box,
        el('div', { class: 'hint' },
          count ? `${plural(count, 'item')} from today's log. ` : '',
          this.written ? 'Written up by the model from those items — check it before it goes. ' : '',
          'Copying also records this in your log, so it publishes with your next push. Tasks marked private are never included.')),

      this.busy
        ? el('div', { style: 'margin-top:4px' }, spinner('Writing it up…'), this.progressEl)
        : el('div', { class: 'row tight', style: 'margin-top:4px' },
          el('button', {
            class: 'primary',
            text: 'Copy',
            disabled: !this.draft?.trim(),
            on: { click: () => this.copy() },
          }),
          el('button', {
            text: this.written ? 'Write it up again' : 'Write it up',
            title: 'Ask the model to phrase these lines the way you would in a channel',
            disabled: !!this.report?.empty,
            on: { click: () => this.writeUp() },
          }),
          el('button', {
            text: 'Rebuild from log',
            title: this.touched ? 'Discards your edits and rebuilds from the log' : 'Rebuild from the log',
            on: { click: () => { this.rebuild(); this.app.refresh(); toast('Rebuilt from your log.'); } },
          }),
          el('span', { class: 'spacer' }),
          posted ? el('span', { class: 'hint', text: `Recorded ${shortTime(posted.ts)}` }) : null)));

    const earlier = this.earlier(today);
    if (earlier.length) this.root.append(this.earlierCard(earlier));

    return this.root;
  }

  kindButtons() {
    return KINDS.map(([id, label]) => el('button', {
      class: this.kind === id ? 'primary' : '',
      text: label,
      on: {
        click: () => {
          if (this.kind === id) return;
          // Each kind has its own default first line, so a preamble you have not
          // actually changed should follow the kind rather than carry "Signing off:"
          // into the morning. Compared against the OUTGOING kind's default, which is
          // the one still sitting in the field.
          if (this.preamble === DEFAULT_PREAMBLE[this.kind]) this.preamble = null;
          this.kind = id;
          this.rebuild();
          this.app.refresh();
        },
      },
    }));
  }

  groupSelect() {
    const sel = el('select', { 'aria-label': 'Grouping' },
      GROUPINGS.map((g) => el('option', { value: g.id, selected: g.id === this.group, text: g.label })));
    sel.addEventListener('change', () => {
      this.group = sel.value;
      // Grouping is the model's to decide once it has written the lines, so asking
      // for a different one means going back to the log.
      if (this.written) { this.written = null; this.rebuild(); this.app.refresh(); return; }
      this.optionChanged();
    });
    return sel;
  }

  /**
   * Both free-text options rebuild on `change` — that is, on blur — rather than on
   * `input`. Rebuilding per keystroke would re-render the pane and take the cursor
   * with it. Blur is not a delay in practice: clicking Copy blurs the field first, so
   * what you typed is in the report you copy.
   */
  preambleInput() {
    const input = el('input', {
      type: 'text',
      value: this.preamble === null ? DEFAULT_PREAMBLE[this.kind] : this.preamble,
      'aria-label': 'First line',
    });
    input.addEventListener('change', () => { this.preamble = input.value; this.optionChanged(); });
    return input;
  }

  noteInput() {
    const input = el('input', {
      type: 'text',
      value: this.note,
      placeholder: 'Signing off early — dentist',
      'aria-label': 'A line of your own',
    });
    input.addEventListener('change', () => { this.note = input.value; this.optionChanged(); });
    return input;
  }

  markdownToggle() {
    const box = el('input', { type: 'checkbox', checked: this.markdown });
    box.addEventListener('change', () => { this.markdown = box.checked; this.optionChanged(); });
    return el('div', { class: 'field' },
      el('label', { class: 'check' }, box,
        el('span', {}, el('strong', { text: 'Markdown headings' }),
          el('div', { class: 'hint', text: 'Turns the project words into ## headings and the lines into - bullets. Off suits Slack; on suits anywhere markdown renders.' }))));
  }

  /**
   * Off by default, because a morning message in practice is a greeting and the
   * occasional "I have a meeting at 10". The plan is here for the days you want it.
   */
  planToggle() {
    const box = el('input', { type: 'checkbox', checked: this.includePlan });
    box.addEventListener('change', () => { this.includePlan = box.checked; this.rebuild(); this.app.refresh(); });
    return el('div', { class: 'field' },
      el('label', { class: 'check' }, box,
        el('span', {}, el('strong', { text: 'List what is in flight' }),
          el('div', { class: 'hint', text: 'Adds the tasks already in progress or blocked. Most morning messages are just a greeting, so this starts off.' }))));
  }

  /** Ask a model to phrase the day's lines the way a colleague would. */
  async writeUp() {
    const endpoint = this.app.endpoint;
    const problem = endpointProblem(endpoint);
    if (problem) { this.error = problem; this.app.refresh(); return; }
    if (this.report?.empty) { toast('Nothing logged today to write up.', 'error'); return; }

    const includeNotes = this.app.settings.sendNotes !== false;
    const payload = modelPayload(this.report, { includeNotes });

    // What leaves is this day's lines, so that is what the gate shows -- not the board.
    if (!await confirmCloudSend({
      endpoint,
      tasks: [],
      includeNotes,
      text: JSON.stringify(payload, null, 1),
    })) return;

    this.busy = true;
    this.error = null;
    this.progressEl.textContent = '';
    this.app.refresh();

    try {
      const groups = await writeStandup({
        endpoint,
        payload,
        includeNotes,
        onProgress: ({ text, progress }) => {
          this.progressEl.textContent = `${text}${progress ? ` (${Math.round(progress * 100)}%)` : ''}`;
        },
      });
      this.written = groups;
      this.draft = this.text();
      this.touched = false;
      toast(this.app.onRules
        ? 'Grouped by the demo interpreter — a real provider rewrites the lines.'
        : 'Written up. Read it before you copy it.');
    } catch (e) {
      this.error = e instanceof AIError ? e.message : `Unexpected failure: ${e.message}`;
    } finally {
      this.busy = false;
      this.app.refresh();
    }
  }

  async copy() {
    const text = this.draft?.trim();
    if (!text) { toast('Nothing to copy.', 'error'); return; }

    if (!await copyText(text)) {
      toast('This browser would not let the page write to the clipboard — select the text and copy it by hand.', 'error');
      return;
    }

    // Recorded as the text you actually copied, edits and all: the point of the record
    // is what your team was told, not what the generator first proposed.
    this.app.stage(standupEvent({ date: todayISO(), kind: this.kind, text, style: this.group }));
    // Staging just moved the log, which must not auto-rebuild the box out from under
    // the text that was copied.
    this.builtAt = this.app.state.lastEventTs;
    this.optionsStale = false;
    toast('Copied, and recorded in your log. It publishes with your next push.');
    this.app.refresh();
  }

  earlier(today) {
    return Object.entries(this.app.state.standups || {})
      .filter(([d]) => d !== today)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7);
  }

  earlierCard(earlier) {
    return el('div', { class: 'card' },
      el('h2', { text: 'Reports you sent' }),
      el('p', { class: 'sub', text: 'Kept in your repo beside the work they describe.' }),
      el('div', {}, earlier.map(([date, kinds]) => {
        const r = kinds.evening || kinds.morning;
        return el('div', { style: 'padding:9px 0;border-top:1px solid var(--border)' },
          el('div', { class: 'section-label', style: 'margin:0', text: `${date} · ${localTime(r.ts)}` }),
          el('pre', { class: 'commit-preview', text: r.text }));
      })));
  }
}

/* groupsOf is re-exported for the pane's tests, which assert on grouping directly. */
export { groupsOf };
