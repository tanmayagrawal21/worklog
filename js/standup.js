/**
 * standup.js — the morning and sign-off reports you post to your team.
 *
 * Distinct from summary.js on purpose, because the audience is different and that
 * changes everything about the document. A summary is written FOR YOU: a headline, a
 * reading of where things stand, risks, a suggested focus, with task ids you can click
 * back to the board. A sign-off is written FOR THE BROADER TEAM. Same event log, two
 * different documents.
 *
 * The format is transcribed from what people actually post, and what they post is
 * remarkably plain: a project word, then one short line per thing, and nothing else.
 * So that is all this generates.
 *
 * Three things it deliberately does NOT do:
 *   - No status vocabulary. No "Blocked", no "In review", no "Done" — not as headings
 *     and not as markers on a line. Nobody writes their day that way; a channel wants
 *     the work, and anything worth flagging you will say in your own words.
 *   - No note text by default. Your working notes are detail for you and noise for
 *     everyone else. Available behind a switch for the days you want the long form.
 *   - No internal task ids. "T-a1b2c3" means nothing to anyone else in the channel.
 *
 * Mechanical by design. The draft is built from the log by these functions with no
 * model involved, because what you did today is a matter of record rather than a
 * matter of interpretation, and a report you have to fact-check is worse than no
 * report. The deterministic version is what a day with AI switched off produces.
 *
 * Pure: no DOM, no network, no clock beyond the date handed in.
 */
import { makeEvent, localDate, todayISO } from './store.js';

/** How lines are grouped. A project word is the dominant shape; flat is for a short day. */
export const GROUPINGS = Object.freeze([
  { id: 'project', label: 'Under a project word', blurb: 'Your first tag becomes the heading.' },
  { id: 'none', label: 'One flat list', blurb: 'No headings. Good for a short day or a single project.' },
]);

/** What people actually type on the line above the list. Editable in the pane. */
export const DEFAULT_PREAMBLE = Object.freeze({
  evening: 'Signing off:',
  morning: 'Morning',
});

/** Where work with no tag goes. "Misc" because that is what people write. */
export const UNGROUPED = 'Misc';

/** Event types that say something happened; the rest is bookkeeping nobody reports. */
const REPORTABLE = new Set(['task.create', 'task.status', 'task.note']);

/** Chat is one line per thought, so a multi-line note is flattened to one. */
const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/**
 * A note as a pointer rather than a sentence: one line, and without the full stop
 * that makes a fragment read as prose. Only a lone trailing period goes — an
 * ellipsis is doing something deliberate, and the rest of your punctuation is yours.
 */
function fragment(text) {
  const s = oneLine(text);
  return s.endsWith('.') && !s.endsWith('..') ? s.slice(0, -1) : s;
}

/** First tag is the project. Tags are the user's own words, so they are used verbatim. */
const projectOf = (task) => oneLine((task.tags || [])[0]) || UNGROUPED;

/**
 * Build the day's report from the log.
 *
 * One item per TASK, not per event: a task you moved twice and annotated twice is one
 * thing you did, and three lines about it reads like padding. The line is the task's
 * own title, which is already how you described the work when you wrote it down.
 *
 * @param {object}  o
 * @param {Array}   o.tasks   folded tasks, as app.tasks gives them
 * @param {Array}   o.events  the whole event stream; filtered to `date` here
 * @param {'morning'|'evening'} o.kind
 * @param {string}  o.date    local ISO date the report is about
 * @param {boolean} o.includePlan  morning only: list what is in flight
 */
export function buildReport({ tasks = [], events = [], kind = 'evening', date = todayISO(), includePlan = false } = {}) {
  // Private tasks never reach a report, the same rule the AI payload follows. A
  // deleted task is not news either -- it is a correction to the board.
  const live = tasks.filter((t) => t && !t.private && !t.deleted);
  const items = kind === 'morning'
    ? (includePlan ? planItems(live) : [])
    : dayItems(live, events, date);

  items.sort((a, b) => String(a.firstTs).localeCompare(String(b.firstTs)));
  return { kind, date, items, empty: !items.length };
}

/** What you touched on `date`. */
function dayItems(live, events, date) {
  const byId = new Map(live.map((t) => [t.id, t]));
  const touched = new Map();

  for (const e of [...events].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
    if (!REPORTABLE.has(e.type) || localDate(e.ts) !== date) continue;
    const task = byId.get(e.taskId);
    if (!task) continue;

    const entry = touched.get(task.id) || { task, firstTs: e.ts, notes: [] };
    if (e.type === 'task.note' && fragment(e.text)) entry.notes.push(fragment(e.text));
    touched.set(task.id, entry);
  }

  return [...touched.values()].map(({ task, firstTs, notes }) => ({
    // Your note in preference to the task title, because the note is already the
    // sentence these reports are made of -- "Injected the clock instead of sleeping
    // on it" is what you did; "Flaky test in the scheduler suite" is a backlog entry.
    // The title is the fallback for work you moved without writing anything down.
    text: notes.join('; ') || oneLine(task.title),
    title: oneLine(task.title),
    project: projectOf(task),
    taskId: task.id,
    firstTs,
  }));
}

/** Morning, when asked for it: what is already in flight. */
function planItems(live) {
  return live
    .filter((t) => t.status === 'in_progress' || t.status === 'blocked')
    .map((t) => ({
      text: oneLine(t.title),
      title: oneLine(t.title),
      project: projectOf(t),
      taskId: t.id,
      // In-flight work has no event today to order by, so order by when it last moved.
      firstTs: t.updated || t.created || '',
    }));
}

/**
 * Render a report as the text you paste into a chat window.
 *
 * @param {object} report       from buildReport()
 * @param {object} o
 * @param {string} o.group      one of GROUPINGS
 * @param {boolean} o.markdown  '## ' headings and '- ' bullets
 * @param {string} o.preamble   the line above the list; '' to omit it
 * @param {string} o.note       a free line of your own ("back at 2", "half day")
 */
export function renderReport(report, { group = 'project', ...opts } = {}) {
  return renderGroups(groupsOf(report, group), { kind: report?.kind, ...opts });
}

/**
 * Lay out `[{ project, lines }]` as the text you paste into a chat window.
 *
 * Split from renderReport so the model path and the mechanical path share it: a model
 * is asked for grouped lines and nothing else, and every decision about headings,
 * markdown, the first line and your own note stays here where it is testable.
 *
 * @param {Array<{project?: string, lines: string[]}>} groups
 */
export function renderGroups(groups, { kind = 'evening', markdown = false, preamble = null, note = '' } = {}) {
  const head = preamble === null ? DEFAULT_PREAMBLE[kind] || '' : oneLine(preamble);
  const out = [];

  // Blank lines separate blocks, so they are only emitted BETWEEN them. Pushing one
  // unconditionally meant clearing the first line left the text starting on line two.
  const gap = () => { if (out.length) out.push(''); };

  if (head) out.push(head);
  if (oneLine(note)) { gap(); out.push(oneLine(note)); }

  for (const g of groups || []) {
    const lines = (g.lines || []).filter((l) => oneLine(l));
    if (!lines.length) continue;
    gap();
    if (g.project) {
      out.push(markdown ? `## ${g.project}` : g.project);
      if (markdown) out.push('');
    }
    for (const l of lines) out.push(markdown ? `- ${oneLine(l)}` : oneLine(l));
  }

  return out.join('\n');
}

/** The report's items as `[{ project, lines }]` for the chosen grouping. */
export function groupsOf(report, group = 'project') {
  const items = report?.items || [];
  if (!items.length) return [];
  if (group !== 'project') return [{ project: '', lines: items.map((i) => i.text) }];

  const byProject = new Map();
  for (const it of items) {
    if (!byProject.has(it.project)) byProject.set(it.project, []);
    byProject.get(it.project).push(it);
  }

  // Busiest project first — that is the day's headline; ties broken by name so the
  // same day always renders identically. Chronological within a project.
  return [...byProject.entries()]
    .map(([project, list]) => ({
      project,
      lines: [...list]
        .sort((a, b) => String(a.firstTs).localeCompare(String(b.firstTs)))
        .map((i) => i.text),
    }))
    .sort((a, b) => b.lines.length - a.lines.length || a.project.localeCompare(b.project));
}

/**
 * What a model is shown: the day, structured, with nothing in it that should not
 * leave. Task ids are deliberately absent — the model has no use for them and they
 * must not come back out in the text — and note text is droppable, since Settings has
 * a switch for keeping notes out of AI requests.
 */
export function modelPayload(report, { includeNotes = true } = {}) {
  return (report?.items || []).map((i) => ({
    project: i.project,
    task: i.title,
    ...(includeNotes && i.text !== i.title ? { didToday: i.text } : {}),
  }));
}

/** How many things the report mentions — the pane shows this before you copy. */
export const reportSize = (report) => (report?.items || []).length;

/**
 * Record a posted report in the log, so it lands in the repo beside the work it
 * describes — and so tomorrow's reminder knows today's sign-off went out.
 *
 * Field names are deliberately `date`, `kind` and `text`: all three are already in
 * store.EVENT_KEYS for summary.set and task.note, so this adds a type to the log
 * without changing how an event serialises or what the repo layout looks like.
 */
export function standupEvent({ date, kind, text, style = 'project' }) {
  return makeEvent('standup.set', { date, kind, text: String(text || ''), style });
}
