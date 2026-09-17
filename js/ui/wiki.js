/**
 * wiki.js — the log as something you read rather than something you manage.
 *
 * The board answers "what is in flight". This answers "what happened, and what do I
 * know about this thing" — the questions you actually have when a colleague asks
 * about a task from three weeks ago, or when you write a status report.
 *
 * Three ways in, all folded from the same event log, all read-only:
 *   Tasks — one page per task: its history, its notes, its neighbours by tag.
 *   Tags  — the closest thing this app has to topics.
 *   Days  — a dated journal page: what moved that day, plus that day's summary.
 *
 * The wiki part is the cross-linking. Any task id written in a note ("blocked by
 * T-4f9a2c", or [[T-4f9a2c]]) becomes a real link, so notes accumulate into a
 * connected record instead of isolated scribbles. Nothing here writes; "Open on the
 * board" hands you back to the editable view.
 */
import { STATUSES, statusLabel, localDate } from '../store.js';
import { el, add, clear, plural, shortTime, age } from './dom.js';

const TASK_REF = /\[\[(T-[0-9a-z]{6})\]\]|\b(T-[0-9a-z]{6})\b/g;

export class WikiView {
  constructor(app) {
    this.app = app;
    this.root = el('div', { class: 'wiki' });
    this.section = 'tasks';        // tasks | tags | days
    this.selected = null;          // id, tag, or date depending on section
  }

  /** Jump straight to a page — used by cross-links and by other views. */
  openTask(id) { this.section = 'tasks'; this.selected = id; this.app.refresh(); }

  go(section, selected = null) { this.section = section; this.selected = selected; this.app.refresh(); }

  render() {
    clear(this.root);
    add(this.root,
      el('nav', { class: 'wiki-tabs' }, [['tasks', 'Tasks'], ['tags', 'Tags'], ['days', 'Days']]
        .map(([id, label]) => el('button', {
          class: this.section === id ? 'on' : '',
          text: label,
          'aria-pressed': String(this.section === id),
          on: { click: () => this.go(id) },
        }))),
      this.selected ? this.article() : this.index());
    return this.root;
  }

  /* ---------- indexes ---------------------------------------------------- */

  index() {
    if (this.section === 'tags') return this.tagIndex();
    if (this.section === 'days') return this.dayIndex();
    return this.taskIndex();
  }

  /** Matches the header search box, so searching narrows the wiki too. */
  get filtered() {
    const q = (this.app.search || '').trim().toLowerCase();
    const tasks = this.app.tasks;
    if (!q) return tasks;
    return tasks.filter((t) => `${t.id} ${t.title} ${t.tags.join(' ')} ${t.notes.map((n) => n.text).join(' ')}`.toLowerCase().includes(q));
  }

  taskIndex() {
    const byStatus = new Map(STATUSES.map((s) => [s.id, []]));
    for (const t of this.filtered) (byStatus.get(t.status) || byStatus.get('todo')).push(t);

    return el('div', { class: 'card' },
      el('h2', { text: 'Tasks' }),
      el('p', { class: 'sub', text: `${plural(this.filtered.length, 'task')}, grouped by where they stand. Click one to read its whole history.` }),
      el('div', { style: 'margin-top:10px' }, STATUSES.map(({ id, label }) => {
        const list = byStatus.get(id);
        if (!list.length) return null;
        return el('div', { class: 'wiki-group' },
          el('div', { class: 'section-label', text: `${label} (${list.length})` }),
          el('ul', { class: 'wiki-list' }, list
            .sort((a, b) => (a.updated < b.updated ? 1 : -1))
            .map((t) => el('li', {},
              el('button', { class: 'wiki-link', text: t.title, on: { click: () => this.openTask(t.id) } }),
              el('span', { class: 'wiki-meta', text: ` ${t.id} · ${age(t.updated)}` })))));
      })));
  }

  tagIndex() {
    const counts = new Map();
    for (const t of this.filtered) for (const tag of t.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    return el('div', { class: 'card' },
      el('h2', { text: 'Tags' }),
      tags.length
        ? el('div', { class: 'tag-cloud', style: 'margin-top:10px' }, tags.map(([tag, n]) => el('button', {
          class: 'tag wiki-link',
          text: `${tag} · ${n}`,
          on: { click: () => this.go('tags', tag) },
        })))
        : el('p', { class: 'sub', text: 'No tags yet. Add them to a task and they become topics here.' }));
  }

  dayIndex() {
    const days = new Map();
    for (const e of this.app.state.events) {
      // Local date, so an evening's work is filed under the evening you did it.
      const d = localDate(e.ts);
      days.set(d, (days.get(d) || 0) + 1);
    }
    const list = [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));

    return el('div', { class: 'card' },
      el('h2', { text: 'Days' }),
      el('p', { class: 'sub', text: 'Every day you logged something. This is the changelog, read forwards.' }),
      el('ul', { class: 'wiki-list', style: 'margin-top:10px' }, list.map(([d, n]) => el('li', {},
        el('button', { class: 'wiki-link', text: d, on: { click: () => this.go('days', d) } }),
        el('span', { class: 'wiki-meta', text: ` ${plural(n, 'change')}` })))),
      this.historyFooter());
  }

  /**
   * Older months are not read on boot -- that is what keeps startup the same speed in
   * year five as in week one. Say so plainly here, and offer the years rather than
   * pretending the log stops where the download did.
   */
  historyFooter() {
    const store = this.app.store;
    if (!store || store.fullyLoaded) return null;

    const missing = store.years.filter((y) => !store.yearLoaded(y));
    if (!missing.length) return null;

    return el('div', { class: 'wiki-more' },
      el('div', { class: 'sub', text: 'Earlier months are in the repo but not loaded yet — the board comes from a snapshot, so opening the app stays fast however long you have used it.' }),
      el('div', { class: 'row', style: 'margin-top:8px;flex-wrap:wrap' },
        missing.map((y) => el('button', {
          text: this.app.historyLoading === y ? `Loading ${y}…` : `Load ${y}`,
          disabled: !!this.app.historyLoading,
          on: { click: () => this.app.loadHistory(y) },
        })),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'ghost',
          text: this.app.historyLoading === 'all' ? 'Loading…' : 'Load everything',
          disabled: !!this.app.historyLoading,
          on: { click: () => this.app.loadHistory() },
        })));
  }

  /**
   * The board snapshot drops notes from work finished long ago -- they are still
   * committed in that month's log, and the snapshot is downloaded on every boot. Say
   * where they went instead of showing a task as noteless.
   */
  trimmedNotesHint(t) {
    const missing = (t.noteCount || 0) - t.notes.length;
    if (missing <= 0) return null;
    const year = String(t.done || t.updated || '').slice(0, 4);
    return el('div', { class: 'wiki-more' },
      el('div', { class: 'sub', text: `${plural(missing, 'earlier note')} on this finished task live in the monthly log rather than the board snapshot.` }),
      year ? el('button', {
        style: 'margin-top:8px',
        text: this.app.historyLoading === year ? `Loading ${year}…` : `Load ${year} to read them`,
        disabled: !!this.app.historyLoading,
        on: { click: () => this.app.loadHistory(year) },
      }) : null);
  }

  /* ---------- article pages ---------------------------------------------- */

  article() {
    const back = el('button', { class: 'ghost', text: '← Back', on: { click: () => this.go(this.section) } });
    if (this.section === 'tasks') return this.taskPage(back);
    if (this.section === 'tags') return this.tagPage(back);
    return this.dayPage(back);
  }

  taskPage(back) {
    const t = this.app.state.tasks.get(this.selected);
    if (!t) {
      return el('div', { class: 'card' }, back,
        el('p', { class: 'sub', text: `No task ${this.selected} in this log. It may have been created on another machine and not published yet.` }));
    }

    const history = this.app.state.events.filter((e) => e.taskId === t.id);
    const related = this.app.tasks.filter((o) => o.id !== t.id && o.tags.some((g) => t.tags.includes(g)));

    return el('div', { class: 'card wiki-article' },
      el('div', { class: 'row' }, back, el('span', { class: 'spacer' }),
        el('button', { text: 'Open on the board', on: { click: () => this.app.reveal(t.id) } })),
      el('h2', { text: t.title }),
      el('div', { class: 'wiki-facts' },
        fact('Status', statusLabel(t.status)),
        fact('Priority', t.priority),
        fact('Id', t.id),
        fact('Created', localDate(t.created)),
        fact('Last touched', age(t.updated)),
        t.done ? fact('Finished', localDate(t.done)) : null,
        t.private ? fact('Privacy', 'Never sent to AI') : null),
      t.tags.length ? el('div', { class: 'tag-cloud' }, t.tags.map((g) => el('button', {
        class: 'tag wiki-link', text: g, on: { click: () => this.go('tags', g) },
      }))) : null,

      el('div', { class: 'section-label', text: `Notes (${t.noteCount || t.notes.length})` }),
      t.notes.length
        ? el('div', {}, t.notes.map((n) => el('div', { class: 'wiki-note' },
          el('div', { class: 'wiki-meta', text: `${localDate(n.ts)} ${shortTime(n.ts)}` }),
          el('div', {}, this.linkify(n.text)))))
        : el('p', { class: 'sub', text: 'None yet. Notes written on the board show up here as a timeline.' }),
      this.trimmedNotesHint(t),

      el('div', { class: 'section-label', text: 'History' }),
      el('ul', { class: 'wiki-list' }, history.map((e) => el('li', {},
        el('span', { class: 'wiki-meta', text: `${localDate(e.ts)} ` }), describeForWiki(e)))),

      related.length ? el('div', {},
        el('div', { class: 'section-label', text: 'Related by tag' }),
        el('ul', { class: 'wiki-list' }, related.map((o) => el('li', {},
          el('button', { class: 'wiki-link', text: o.title, on: { click: () => this.openTask(o.id) } }))))) : null);
  }

  tagPage(back) {
    const tag = this.selected;
    const tasks = this.app.tasks.filter((t) => t.tags.includes(tag));
    return el('div', { class: 'card wiki-article' },
      back,
      el('h2', { text: `#${tag}` }),
      el('p', { class: 'sub', text: plural(tasks.length, 'task') }),
      el('ul', { class: 'wiki-list' }, tasks.map((t) => el('li', {},
        el('button', { class: 'wiki-link', text: t.title, on: { click: () => this.openTask(t.id) } }),
        el('span', { class: 'wiki-meta', text: ` ${statusLabel(t.status)}` })))));
  }

  dayPage(back) {
    const date = this.selected;
    const events = this.app.state.events.filter((e) => localDate(e.ts) === date);
    const summaries = this.app.state.summaries[date] || {};

    return el('div', { class: 'card wiki-article' },
      back,
      el('h2', { text: date }),
      ['morning', 'evening'].map((kind) => (summaries[kind] ? el('div', {},
        el('div', { class: 'section-label', text: `${kind} summary` }),
        el('div', { class: 'headline', text: summaries[kind].headline }),
        el('ul', {}, (summaries[kind].bullets || []).map((b) => el('li', { text: b.text })))) : null)),
      el('div', { class: 'section-label', text: plural(events.length, 'change') }),
      el('ul', { class: 'wiki-list' }, events.filter((e) => e.type !== 'summary.set').map((e) => el('li', {},
        el('span', { class: 'wiki-meta', text: `${shortTime(e.ts)} ` }),
        e.taskId ? el('button', {
          class: 'wiki-link',
          text: this.app.state.tasks.get(e.taskId)?.title || e.taskId,
          on: { click: () => this.openTask(e.taskId) },
        }) : null,
        ' ', describeForWiki(e)))));
  }

  /**
   * Turn task ids inside free text into links. Built by splitting on the pattern and
   * appending nodes — never by assembling HTML, so a note containing markup stays
   * text rather than becoming markup.
   */
  linkify(text) {
    const out = [];
    let last = 0;
    for (const m of String(text || '').matchAll(TASK_REF)) {
      const id = m[1] || m[2];
      if (m.index > last) out.push(String(text).slice(last, m.index));
      out.push(this.app.state.tasks.has(id)
        ? el('button', { class: 'wiki-link inline', text: id, title: 'Open this task', on: { click: () => this.openTask(id) } })
        : id);
      last = m.index + m[0].length;
    }
    if (last < String(text || '').length) out.push(String(text).slice(last));
    return out;
  }
}

const fact = (label, value) => el('div', { class: 'wiki-fact' },
  el('span', { class: 'wiki-meta', text: label }), el('span', { text: String(value) }));

/** Like store.describeEvent, but without repeating the task title the page already shows. */
function describeForWiki(e) {
  switch (e.type) {
    case 'task.create': return 'created';
    case 'task.status': return `${statusLabel(e.from)} → ${statusLabel(e.to)}`;
    case 'task.note': return `note: ${e.text}`;
    case 'task.edit': return `edited ${Object.keys(e.fields || {}).join(', ')}`;
    case 'task.delete': return 'removed';
    case 'summary.set': return `${e.kind} summary`;
    default: return e.type;
  }
}
