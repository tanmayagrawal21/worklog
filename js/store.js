/**
 * store.js — event-sourced task store, persisted as plain JSON in a git repo.
 *
 * Three design choices worth explaining:
 *
 * 1. APPEND-ONLY EVENTS ARE THE SOURCE OF TRUTH; board state is fold(events).
 *    This makes concurrent edits from two machines resolvable: merging is a union
 *    of events by id, re-sorted and re-folded, so no edit is silently lost. It also
 *    means the repo literally contains the changelog of your work, which is the
 *    point of keeping this in git at all.
 *
 * 2. NOTHING IS EVER PUSHED AUTOMATICALLY. Edits accumulate locally as "pending"
 *    events (mirrored into localStorage so a closed tab loses nothing). Publishing
 *    is an explicit, reviewable step: previewCommit() shows exactly what would be
 *    written, and only push() contacts the repo.
 *
 * 3. EVERYTHING IS BOUNDED BY A MONTH. This is what makes the log survive years
 *    rather than months. Events live in data/log/<year>/<month>.json; each month
 *    also gets a rendered <month>.md, each year a README.md, and the root keeps a
 *    thin CHANGELOG.md index. A push therefore rewrites a fixed handful of files
 *    whose size depends on one month of work, never on how long you have used this.
 *    GitHub renders a README.md in whatever directory you browse and renders any .md
 *    you click, in private repos too, so browsing data/log/2026/ shows a readable
 *    year with no Action, no build step and nothing installed.
 *
 * Loading is bounded the same way. data/board.json carries a `through` marker naming
 * the last event folded into it, which makes it a checkpoint: state = snapshot +
 * events after `through`. So a boot reads the manifest, the snapshot and the last few
 * months -- not every month ever recorded. Older months load on demand (loadYear).
 */

import { ConflictError } from './github.js';

export const STATUSES = Object.freeze([
  { id: 'backlog',     label: 'Backlog' },
  { id: 'todo',        label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'blocked',     label: 'Blocked' },
  { id: 'review',      label: 'In Review' },
  { id: 'done',        label: 'Done' },
]);

export const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

const STATUS_LABEL = new Map(STATUSES.map((s) => [s.id, s.label]));
export const statusLabel = (id) => STATUS_LABEL.get(id) || id;

/**
 * Where everything lives. Year directories are not decoration: they are what keeps
 * the repo navigable by hand, and they give each year a README.md that GitHub
 * renders automatically when you click into the folder.
 */
export const PATHS = {
  manifest: 'data/manifest.json',
  board: 'data/board.json',
  boardMd: 'data/BOARD.md',
  changelog: 'CHANGELOG.md',
  logReadme: 'data/log/README.md',
  month:      (m) => `data/log/${m.slice(0, 4)}/${m.slice(5, 7)}.json`,
  monthMd:    (m) => `data/log/${m.slice(0, 4)}/${m.slice(5, 7)}.md`,
  yearReadme: (y) => `data/log/${y}/README.md`,
  // v1 wrote every month flat into data/log/. Still read, so an upgrade loses nothing.
  legacyMonth: (m) => `data/log/${m}.json`,
};

/** How many recent months a boot reads when a checkpoint lets it read fewer. */
const RECENT_MONTHS = 3;

export const SCHEMA = 2;

/* ---------- small helpers ------------------------------------------------ */

/**
 * Calendar dates are local; timestamps stay UTC.
 *
 * Every event carries a UTC instant, because that is the only thing two machines can
 * agree on and the only thing that sorts correctly. But "which day was this" is a
 * question about the person, not about UTC: in Tucson (UTC-7) an update typed at 6pm
 * is already tomorrow in UTC, which filed evening work under the wrong date
 * everywhere it mattered -- the day pages, the summaries, the month a change lands
 * in. So the instant is stored as-is and everything that groups or displays a date
 * comes through here.
 */
const p2 = (n) => String(n).padStart(2, '0');
export const localDate = (at = Date.now()) => {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
/** HH:MM in the reader's own timezone, for anything a person reads. */
export const localTime = (at) => {
  const d = at instanceof Date ? at : new Date(at);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
export const todayISO = () => localDate();

/** "UTC-07:00" — stamped onto generated pages, since the times on them are local. */
export function tzLabel(at = Date.now()) {
  const mins = -(at instanceof Date ? at : new Date(at)).getTimezoneOffset();
  const sign = mins < 0 ? '-' : '+';
  return `UTC${sign}${p2(Math.floor(Math.abs(mins) / 60))}:${p2(Math.abs(mins) % 60)}`;
}

const monthOf = (iso) => iso.slice(0, 7);
const yearOf = (iso) => iso.slice(0, 4);
/**
 * Which month file an event belongs to: the month of its local date, not of its UTC
 * timestamp. Filing by UTC would split a single evening across two month pages, which
 * is exactly the seam this change exists to remove. See touchedMonths() for what that
 * costs at a month boundary.
 */
const monthOfEvent = (e) => monthOf(localDate(e.ts));
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const monthName = (m) => MONTH_NAMES[Number(m.slice(5, 7)) - 1] || m;
/** Weekday by arithmetic, not by locale: no ICU dependency, same answer everywhere. */
const weekdayOf = (date) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];

/**
 * n uniformly-random base36 characters.
 *
 * Rejection-samples bytes below 252 (= 36 x 7) so every character is unbiased; a
 * naive `byte % 36` would skew toward the first four letters. Entropy here matters
 * more than it looks: unionEvents() de-duplicates by event id, so two events that
 * collided on an id would silently merge into one and lose a change.
 */
function rand(n) {
  let out = '';
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n + 8))) {
      if (b < 252) {
        out += ID_ALPHABET[b % 36];
        if (out.length === n) break;
      }
    }
  }
  return out;
}

/** Random rather than sequential, so two offline machines cannot mint the same id. */
export const newTaskId = () => `T-${rand(6)}`;                 // 36^6 ~= 2.2e9

/** Timestamp first so ids sort chronologically; 10 random chars make collisions negligible. */
const newEventId = (ts) => `${ts}-${rand(10)}`;                // 36^10 ~= 3.7e15

export function makeEvent(type, payload = {}) {
  const ts = new Date().toISOString();
  return { id: newEventId(ts), ts, type, ...payload };
}

const sortEvents = (evs) => [...evs].sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? -1 : 1) : (a.ts < b.ts ? -1 : 1)));

/** Union by event id — the merge primitive that makes concurrent edits safe. */
export function unionEvents(...lists) {
  const seen = new Map();
  for (const list of lists) for (const e of list || []) if (!seen.has(e.id)) seen.set(e.id, e);
  return sortEvents([...seen.values()]);
}

/**
 * Is this event past the checkpoint, i.e. not already folded into the snapshot?
 *
 * Compares (ts, id) — the same total order sortEvents uses — rather than ts alone,
 * because two events can share a millisecond and applying one twice would duplicate
 * a note.
 */
export const afterThrough = (e, through) => !through
  || e.ts > through.ts
  || (e.ts === through.ts && String(e.id) > String(through.id));

/* ---------- fold: events -> board state --------------------------------- */

/**
 * Replay events into task state. Unknown-task references are skipped rather than
 * thrown, because a partially-synced peer may legitimately reference a task whose
 * creation event has not arrived yet; the next merge repairs it.
 *
 * `base` is an optional array of already-folded tasks (a checkpoint from
 * data/board.json), so years of history need not be re-read to know the board.
 * Base tasks are copied, never mutated: this runs on every render.
 */
export function foldEvents(events, { base = null } = {}) {
  const tasks = new Map();
  const summaries = {};
  let skipped = 0;

  for (const t of base || []) {
    if (!t || !t.id) continue;
    tasks.set(t.id, { ...t, tags: [...(t.tags || [])], notes: (t.notes || []).map((n) => ({ ...n })) });
  }

  const noteKey = (n) => `${n.ts}|${n.text}`;
  const seenNotes = new Set();
  for (const t of tasks.values()) for (const n of t.notes) seenNotes.add(`${t.id}\u0000${noteKey(n)}`);
  const resorted = new Set();

  for (const e of sortEvents(events)) {
    if (e.type === 'summary.set') {
      (summaries[e.date] ||= {})[e.kind] = { ...e.summary, ts: e.ts, model: e.model };
      continue;
    }

    if (e.type === 'task.create') {
      if (!tasks.has(e.taskId)) {
        tasks.set(e.taskId, {
          id: e.taskId,
          title: e.title || '(untitled)',
          status: e.status || 'todo',
          priority: e.priority || 'normal',
          tags: e.tags || [],
          private: !!e.private,
          notes: [],
          created: e.ts,
          updated: e.ts,
          done: null,
          deleted: false,
        });
      }
      continue;
    }

    const t = tasks.get(e.taskId);
    if (!t) { skipped++; continue; }

    switch (e.type) {
      case 'task.status':
        t.status = e.to;
        t.done = e.to === 'done' ? e.ts : null;
        break;
      case 'task.note': {
        // Notes are a SET, not a sequence: adding one twice must be a no-op. That is
        // what lets a note be applied even when it predates the checkpoint, which is
        // in turn what lets the snapshot drop old notes and the wiki fetch them back.
        const key = `${t.id}\u0000${e.ts}|${e.text}`;
        if (seenNotes.has(key)) break;
        seenNotes.add(key);
        t.notes.push({ ts: e.ts, text: e.text });
        resorted.add(t);
        break;
      }
      case 'task.edit':
        for (const [k, v] of Object.entries(e.fields || {})) {
          if (['title', 'priority', 'tags', 'private', 'status'].includes(k)) t[k] = v;
        }
        break;
      case 'task.delete':
        t.deleted = true;
        break;
      default:
        skipped++;
        continue;
    }
    // Max, not last-applied: a note recovered from an old month must not drag the
    // task's timestamp backwards.
    if (!t.updated || e.ts > t.updated) t.updated = e.ts;
  }

  for (const t of resorted) t.notes.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  return { tasks, summaries, skipped };
}

/* ---------- the event files ---------------------------------------------- */

/**
 * Field order for a serialised event: what happened first, bookkeeping last.
 * Stable order means a git diff shows the change, not a reshuffle.
 */
const EVENT_KEYS = ['ts', 'type', 'taskId', 'date', 'kind', 'title', 'status',
  'from', 'to', 'priority', 'tags', 'private', 'text', 'fields', 'summary', 'model', 'id'];

function orderEvent(e) {
  const out = {};
  for (const k of EVENT_KEYS) if (k in e) out[k] = e[k];
  for (const k of Object.keys(e)) if (!(k in out)) out[k] = e[k];   // never drop a field
  return out;
}

/**
 * A month file, one event per line.
 *
 * Deliberately not JSON.stringify(…, null, 2): pretty-printing spreads one event over
 * a dozen lines, so `git log -p` becomes unreadable at exactly the moment you want to
 * read it. One line per event means one added line per change, and the file is still
 * ordinary JSON that JSON.parse and GitHub's viewer handle.
 */
export function serialiseMonth(month, events) {
  const lines = sortEvents(events).map((e) => `    ${JSON.stringify(orderEvent(e))}`);
  const body = lines.length ? `\n${lines.join(',\n')}\n  ` : '';
  return `{\n  "month": ${JSON.stringify(month)},\n  "count": ${lines.length},\n  "events": [${body}]\n}\n`;
}

/* ---------- human-readable rendering ------------------------------------ */

function describeEvent(e, tasks) {
  const title = tasks?.get(e.taskId)?.title;
  const ref = title ? `${e.taskId} "${title}"` : e.taskId;
  switch (e.type) {
    case 'task.create': return `added ${e.taskId} "${e.title}"`;
    case 'task.status': return `${ref}: ${statusLabel(e.from)} → ${statusLabel(e.to)}`;
    case 'task.note':   return `${ref}: note — ${e.text}`;
    case 'task.edit':   return `${ref}: edited ${Object.keys(e.fields || {}).join(', ')}`;
    case 'task.delete': return `${ref}: removed`;
    case 'summary.set': return `${e.kind} summary for ${e.date}`;
    default:            return `${e.type} ${e.taskId || ''}`.trim();
  }
}

/** One-line commit subject plus a bulleted body, so `git log` reads as a work journal. */
function buildCommitMessage(events, tasks) {
  const counts = events.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {});
  const bits = [];
  if (counts['task.create']) bits.push(`${counts['task.create']} new`);
  if (counts['task.status']) bits.push(`${counts['task.status']} moved`);
  if (counts['task.note'])   bits.push(`${counts['task.note']} note${counts['task.note'] > 1 ? 's' : ''}`);
  if (counts['task.edit'])   bits.push(`${counts['task.edit']} edited`);
  if (counts['task.delete']) bits.push(`${counts['task.delete']} removed`);
  if (counts['summary.set']) bits.push('summary');

  const subject = `worklog ${todayISO()}: ${bits.join(', ') || `${events.length} changes`}`;
  const body = events.map((e) => `- ${describeEvent(e, tasks)}`).join('\n');
  return `${subject}\n\n${body}\n`;
}

const groupByDay = (events) => {
  const byDay = new Map();
  for (const e of sortEvents(events)) {
    const d = localDate(e.ts);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  return byDay;
};

/**
 * One month, rendered. This is the file a human actually reads — GitHub renders it
 * on click, private repo or not, with nothing installed and no Action configured.
 * Newest day first, so the top of the file is the interesting part.
 */
export function renderMonthMd(month, events, tasks) {
  const year = month.slice(0, 4);
  const mm = month.slice(5, 7);
  const byDay = groupByDay(events);
  const days = [...byDay.keys()].sort().reverse();

  const out = [
    `# ${monthName(month)} ${year} — work log`,
    '',
    `[All years](../../../${PATHS.changelog}) · [${year}](README.md) · [Current board](../../BOARD.md) · [Raw events](${mm}.json)`,
    '',
    `_Generated from the event log. ${days.length} day${days.length === 1 ? '' : 's'} logged, `
      + `${events.length} change${events.length === 1 ? '' : 's'}. Newest first. `
      + `Dates and times are local (${tzLabel()}); ${mm}.json keeps the UTC timestamps._`,
    '',
  ];

  if (!days.length) out.push('Nothing logged this month yet.', '');

  for (const d of days) {
    const all = byDay.get(d);
    const sums = all.filter((e) => e.type === 'summary.set');
    const rest = all.filter((e) => e.type !== 'summary.set');

    out.push(`## ${d} — ${weekdayOf(d)}`, '');

    for (const s of sums) {
      if (s.summary?.headline) out.push(`**${s.kind} summary** — ${s.summary.headline}`, '');
      for (const b of s.summary?.bullets || []) out.push(`- ${b.text}`);
      if (s.summary?.bullets?.length) out.push('');
      for (const r of s.summary?.risks || []) out.push(`- ⚠️ ${r}`);
      if (s.summary?.risks?.length) out.push('');
    }

    if (rest.length) {
      out.push('| Time | Change |', '| --- | --- |');
      for (const e of rest) {
        // Escape pipes so a note containing "|" cannot break the table.
        out.push(`| ${localTime(e.ts)} | ${describeEvent(e, tasks).replace(/\|/g, '\\|')} |`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

/**
 * data/log/<year>/README.md — GitHub renders this the moment you browse into the
 * year folder, which is the whole trick behind "readable without doing anything".
 */
export function renderYearReadme(year, stats) {
  const rows = stats.filter((s) => s.month.startsWith(`${year}-`)).sort((a, b) => b.month.localeCompare(a.month));
  const total = rows.reduce((n, s) => n + (s.events || 0), 0);
  const days = rows.reduce((n, s) => n + (s.days || 0), 0);

  const out = [
    `# ${year} — work log`,
    '',
    `[All years](../../../${PATHS.changelog}) · [Current board](../../BOARD.md)`,
    '',
    `_${days} day${days === 1 ? '' : 's'} logged, ${total} change${total === 1 ? '' : 's'} this year. Newest month first._`,
    '',
    '| Month | Days logged | Changes | Read | Raw |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const s of rows) {
    const mm = s.month.slice(5, 7);
    out.push(`| ${monthName(s.month)} | ${s.days ?? '—'} | ${s.events ?? '—'} | [${mm}.md](${mm}.md) | [${mm}.json](${mm}.json) |`);
  }
  out.push('', 'Each `.json` is the append-only event log for that month — the source of truth.',
    'Each `.md` is the same month rendered for reading. Both are committed; neither needs tooling.', '');
  return out.join('\n');
}

/**
 * Root CHANGELOG.md — an index, not the history.
 *
 * v1 rendered every event ever into this one file and rewrote it on every push. That
 * does not survive years: the file grows without bound, GitHub stops rendering large
 * markdown, and the diff on every push is the size of your whole career. Now it links
 * to per-month files, so it stays a page long no matter how long you use this.
 */
export function renderChangelogIndex(stats) {
  const byYear = new Map();
  for (const s of stats) {
    const y = yearOf(s.month);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(s);
  }
  const years = [...byYear.keys()].sort().reverse();

  const out = [
    '# Work log changelog',
    '',
    `**Current board:** [${PATHS.boardMd}](${PATHS.boardMd}) · **How this is laid out:** [${PATHS.logReadme}](${PATHS.logReadme})`,
    '',
    '_An index. Every month is a rendered page you can click straight to; the JSON beside it is the source._',
    '',
  ];

  if (!years.length) out.push('Nothing logged yet.', '');

  for (const y of years) {
    const rows = byYear.get(y).sort((a, b) => b.month.localeCompare(a.month));
    const total = rows.reduce((n, s) => n + (s.events || 0), 0);
    out.push(`## ${y} — ${total} change${total === 1 ? '' : 's'} · [year index](data/log/${y}/)`, '',
      '| Month | Days | Changes | | |', '| --- | --- | --- | --- | --- |');
    for (const s of rows) {
      out.push(`| ${s.month} | ${s.days ?? '—'} | ${s.events ?? '—'} `
        + `| [read](${PATHS.monthMd(s.month)}) | [json](${PATHS.month(s.month)}) |`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** Explains the layout to whoever opens the folder, including future you. Static. */
export function renderLogReadme() {
  return `# Event log

Your work, append-only, one file per month:

\`\`\`
data/log/<year>/<month>.json    the events -- the source of truth
data/log/<year>/<month>.md      the same month, rendered to read
data/log/<year>/README.md       that year's index (this page, one level down)
\`\`\`

Nothing here is generated by CI. Both files are committed together on every push, so
browsing this repo on GitHub — public or private — shows readable history with nothing
installed and no Action to configure.

## Why monthly

One file per month keeps every diff about a month of work rather than about your whole
history, so \`git log -p\` stays readable and the files stay small however many years
accumulate. \`data/board.json\` is a snapshot of the current board and doubles as a
checkpoint, which is why the app can open your board without reading every past month.

## Reading it

\`\`\`sh
git log --oneline                                    # one entry per push
git log -p data/log/$(date +%Y)/$(date +%m).json     # this month's events, in detail
git log --follow -p -- data/log                      # everything, oldest last
\`\`\`

One event per line is on purpose: a new change shows up as one added line.
`;
}

/**
 * data/BOARD.md — the board as a page.
 *
 * Done is capped: completed work is history and history lives in the monthly files,
 * so this file stays a readable page instead of growing for years.
 */
const DONE_SHOWN = 15;

export function renderBoardMd(tasks) {
  const live = [...tasks.values()].filter((t) => !t.deleted);
  const open = live.filter((t) => t.status !== 'done');
  const out = [
    '# Board',
    '',
    // BOARD.md lives in data/, so links are relative to that: the changelog is one
    // level up, the month is a sibling subtree.
    `[Changelog](../${PATHS.changelog}) · [This month](${PATHS.monthMd(monthOf(todayISO())).replace('data/', '')})`,
    '',
    `_Generated on each push, ${todayISO()}. ${open.length} open, ${live.length - open.length} done._`,
    '',
  ];

  for (const s of STATUSES) {
    let col = live.filter((t) => t.status === s.id);
    if (!col.length) continue;
    const total = col.length;

    if (s.id === 'done') {
      col = col.sort((a, b) => String(b.done || b.updated).localeCompare(String(a.done || a.updated))).slice(0, DONE_SHOWN);
      out.push(`## ${s.label} (${total})`, '');
    } else {
      col = col.sort((a, b) => PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority));
      out.push(`## ${s.label} (${total})`, '');
    }

    for (const t of col) {
      const bits = [`\`${t.id}\``];
      if (t.priority && t.priority !== 'normal') bits.push(t.priority);
      if (t.tags?.length) bits.push(t.tags.map((g) => `#${g}`).join(' '));
      bits.push(`updated ${localDate(t.updated)}`);
      out.push(`- **${String(t.title).replace(/\n/g, ' ')}** · ${bits.join(' · ')}`);
      const last = t.notes?.[t.notes.length - 1];
      if (last) out.push(`  - _${localDate(last.ts)}_: ${String(last.text).replace(/\n/g, ' ')}`);
    }
    if (s.id === 'done' && total > DONE_SHOWN) {
      out.push('', `_…and ${total - DONE_SHOWN} more finished earlier. See [the changelog](../${PATHS.changelog})._`);
    }
    out.push('');
  }

  if (!live.length) out.push('No tasks yet.', '');
  return out.join('\n');
}

/**
 * How long a finished task keeps its notes in the snapshot. Past this the task is
 * still listed in full -- so reopening it works and it never vanishes -- but its notes
 * are left in the monthly log, which is where they are already committed.
 */
const NOTES_KEPT_DAYS = 90;

/**
 * Snapshot of live state, and the load checkpoint.
 *
 * `through` names the last event folded in here, which is what lets a boot skip
 * reading every past month: state = these tasks + events after `through`.
 *
 * Notes on long-finished tasks are trimmed rather than carried forever, because this
 * file is downloaded on every boot and rewritten on every push. Without trimming it
 * grows past GitHub's 500 KB / 20,000-line diff limit within a few years -- I measured
 * 931 KB at three years of daily use. `noteCount` records what was left behind so the
 * UI can say so and offer to fetch it, and fold() applies recovered notes idempotently.
 */
export function renderBoardSnapshot(tasks, through) {
  const cutoff = new Date(Date.now() - NOTES_KEPT_DAYS * 86400000).toISOString();
  const live = [...tasks.values()].filter((t) => !t.deleted)
    .sort((a, b) => STATUSES.findIndex((s) => s.id === a.status) - STATUSES.findIndex((s) => s.id === b.status)
      || (a.created < b.created ? -1 : 1))
    .map((t) => {
      const stale = t.status === 'done' && String(t.done || t.updated) < cutoff;
      if (!stale || !t.notes?.length) return t;
      return { ...t, notes: [], noteCount: t.notes.length };
    });

  const head = JSON.stringify({
    schema: SCHEMA,
    generated: new Date().toISOString(),
    through: through ? { ts: through.ts, id: through.id } : null,
    counts: STATUSES.reduce((m, s) => (m[s.id] = live.filter((t) => t.status === s.id).length, m), {}),
  }, null, 2);

  const lines = live.map((t) => `    ${JSON.stringify(slimTask(t))}`);
  const body = lines.length ? `\n${lines.join(',\n')}\n  ` : '';
  return `${head.slice(0, -2)},\n  "tasks": [${body}]\n}\n`;
}

/**
 * A task, ready to serialise on one line.
 *
 * One line per task is the same bargain as one line per event: a changed task is a
 * one-line diff instead of a twelve-line reshuffle, and the file stays under GitHub's
 * 20,000-line diff limit for decades rather than years. Fields that fold() defaults
 * anyway (empty tags, no notes, not private, not deleted) are left out; unrecognised
 * fields are always kept, so a future version's data survives a round trip here.
 */
const TASK_KEYS = ['id', 'title', 'status', 'priority', 'tags', 'created', 'updated',
  'done', 'private', 'deleted', 'notes', 'noteCount'];

function slimTask(t) {
  const out = {};
  for (const k of TASK_KEYS) {
    const v = t[k];
    if (v == null) continue;
    if (k === 'private' || k === 'deleted') { if (v) out[k] = true; continue; }
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  for (const k of Object.keys(t)) if (!TASK_KEYS.includes(k) && t[k] != null) out[k] = t[k];
  return out;
}

/* ---------- the manifest ------------------------------------------------- */

/**
 * The manifest is the index that makes a lazy boot possible: it lists every month
 * with its size, so the app (and the rendered pages) can describe history it has not
 * read. v1 listed bare month strings; those still load, just without counts.
 */
function readManifest(manifest) {
  const stats = new Map();
  for (const entry of manifest?.months || []) {
    const s = typeof entry === 'string' ? { month: entry } : { ...entry };
    if (!s.month) continue;
    stats.set(s.month, s);
  }
  return stats;
}

export function renderManifest(stats) {
  return `${JSON.stringify({
    schema: SCHEMA,
    app: 'worklog',
    updated: new Date().toISOString(),
    months: [...stats.values()].sort((a, b) => a.month.localeCompare(b.month)),
  }, null, 2)}\n`;
}

/* ---------- the store ---------------------------------------------------- */

export class Store {
  constructor(repo) {
    this.repo = repo;
    this.remoteEvents = [];   // months actually read, as last seen in the repo
    this.pending = [];        // staged locally, NOT yet published
    this.knownMonths = [];    // every month the manifest knows about
    this.loadedMonths = [];   // the subset we have read
    this.monthStats = new Map();
    this.checkpoint = null;   // {through:{ts,id}, tasks:[…]} from data/board.json
    this.legacyMonths = [];   // months found only at their v1 flat path
    this.manifestSchema = SCHEMA;
    this.loaded = false;
    this._pendingKey = `worklog.pending.${repo.owner}/${repo.repo}`;
    this._restorePending();
  }

  /* --- pending-change persistence (survives a closed tab) --- */

  _restorePending() {
    try {
      this.pending = JSON.parse(localStorage.getItem(this._pendingKey) || '[]');
    } catch { this.pending = []; }
  }

  _savePending() {
    localStorage.setItem(this._pendingKey, JSON.stringify(this.pending));
  }

  /** Stage events locally. Never contacts the network. */
  stage(...events) {
    this.pending.push(...events.flat());
    this._savePending();
    return this;
  }

  discardPending() {
    this.pending = [];
    this._savePending();
  }

  get hasPending() { return this.pending.length > 0; }

  /**
   * Months our staged events belong to — the only month files a push may rewrite.
   *
   * Closed over boundary events, and that closure is load-bearing. Events are filed by
   * local month, but an evening near a month boundary has a UTC timestamp in the
   * neighbouring month, and commits written before that rule filed it there. Rewriting
   * one file of such a pair without the other would either duplicate the event or --
   * worse -- write it out of the file it was in and into none at all. So if either
   * month of a boundary event is being rewritten, both are.
   */
  get touchedMonths() {
    const months = new Set(this.pending.map(monthOfEvent));
    // Only published events can be misfiled: a staged one has never been written
    // anywhere, so its UTC month has nothing in it to move and rewriting that file
    // would just create an empty one next month.
    const straddling = this.remoteEvents
      .map((e) => [monthOf(e.ts), monthOfEvent(e)])
      .filter(([utc, local]) => utc !== local);

    // A fixpoint, because pulling in one month can pull in the next: Sep–Oct then Oct–Nov.
    for (let grew = true; grew;) {
      grew = false;
      for (const [utc, local] of straddling) {
        if (months.has(utc) === months.has(local)) continue;
        months.add(utc);
        months.add(local);
        grew = true;
      }
    }
    return [...months].sort();
  }

  /**
   * Current view of the world = the checkpoint, plus every event after it that we
   * have (published or staged). Events at or before the checkpoint are dropped
   * because they are already folded into it.
   */
  get state() {
    const all = unionEvents(this.remoteEvents, this.pending);
    const through = this.checkpoint?.through || null;
    // Status and edits are order-dependent, so replaying ones the snapshot already
    // folded in would regress them. Notes are not: they de-duplicate, so an old month
    // loaded later restores notes the snapshot trimmed. Summaries are the same kind of
    // thing -- keyed by (date, kind), newest wins -- and the snapshot does not carry
    // them at all, so they must be replayed or a published summary vanishes from the
    // UI while still sitting in the log.
    return foldEvents(
      all.filter((e) => e.type === 'task.note' || e.type === 'summary.set' || afterThrough(e, through)),
      { base: this.checkpoint?.tasks },
    );
  }

  get tasks() {
    return [...this.state.tasks.values()].filter((t) => !t.deleted);
  }

  /* --- reading --- */

  /**
   * Read enough to show the board. With a checkpoint that is the manifest, the
   * snapshot and the last few months; without one it falls back to reading
   * everything, which is what a v1 repo needs on its first load.
   */
  async load({ recent = RECENT_MONTHS } = {}) {
    const manifest = await this._readJSON(PATHS.manifest);
    this.monthStats = readManifest(manifest);
    this.manifestSchema = Number(manifest?.schema) || 1;

    // Always include the current month, even on a repo that has never been written.
    const cur = monthOf(todayISO());
    if (!this.monthStats.has(cur)) this.monthStats.set(cur, { month: cur });
    this.knownMonths = [...this.monthStats.keys()].sort();

    const snap = await this._readJSON(PATHS.board);
    this.checkpoint = snap?.through?.ts && Array.isArray(snap.tasks)
      ? { through: snap.through, tasks: snap.tasks }
      : null;

    this.remoteEvents = [];
    this.loadedMonths = [];
    this.legacyMonths = [];
    await this.loadMonths(this.checkpoint ? this.knownMonths.slice(-recent) : this.knownMonths);
    this.loaded = true;
    return this;
  }

  /** Read months we have not read yet and merge them in. Safe to call repeatedly. */
  async loadMonths(months) {
    const todo = [...new Set(months)].filter((m) => m && !this.loadedMonths.includes(m));
    if (!todo.length) return this;
    const files = await Promise.all(todo.map((m) => this._readMonth(m)));
    this.remoteEvents = unionEvents(this.remoteEvents, ...files.map((f) => f?.events || []));
    this.loadedMonths = [...this.loadedMonths, ...todo].sort();
    return this;
  }

  loadYear(year) { return this.loadMonths(this.knownMonths.filter((m) => m.startsWith(`${year}-`))); }
  loadAll() { return this.loadMonths(this.knownMonths); }

  get years() { return [...new Set(this.knownMonths.map(yearOf))].sort().reverse(); }
  yearLoaded(year) { return this.knownMonths.filter((m) => m.startsWith(`${year}-`)).every((m) => this.loadedMonths.includes(m)); }
  get fullyLoaded() { return this.knownMonths.every((m) => this.loadedMonths.includes(m)); }

  /** Month files moved into year folders in v2; fall back to the flat v1 path. */
  async _readMonth(month) {
    const current = await this._readJSON(PATHS.month(month));
    if (current) return current;
    // Fall back to where v1 put it. Recording that here is what lets the UI offer an
    // upgrade: a repo written by v1 loads correctly, it just is not laid out well.
    const legacy = await this._readJSON(PATHS.legacyMonth(month));
    if (legacy && !this.legacyMonths.includes(month)) this.legacyMonths.push(month);
    return legacy;
  }

  async _readJSON(path) {
    const f = await this.repo.getFile(path);
    if (!f) return null;
    try {
      return JSON.parse(f.text);
    } catch (err) {
      throw new Error(`${path} is not valid JSON (${err.message}). Fix or delete it in the repo.`);
    }
  }

  /* --- publishing --- */

  /**
   * Describe the commit that push() would make. Purely local; safe to call freely.
   * The UI shows this for confirmation, because nothing goes to the repo unasked.
   *
   * Every file here is bounded by one month of work or by the current board, so the
   * commit is the same size in year five as in week one.
   */
  /* --- upgrading a repo written by an older version --------------------- */

  /**
   * Does this repo predate the current layout?
   *
   * A v1 repo is not broken -- v1 wrote no `through` marker, so load() reads every
   * month and the board comes out complete and correct. What it lacks is the layout:
   * months sit flat in data/log/, nothing is rendered as markdown, and CHANGELOG.md
   * holds the whole history in one file. So this is an offer, never a requirement,
   * and nothing here runs until the user asks for it.
   */
  get needsMigration() {
    return this.loaded && (this.legacyMonths.length > 0 || this.manifestSchema < SCHEMA);
  }

  /**
   * The upgrade commit: every month rewritten into its year directory with a rendered
   * page beside it, fresh indexes, and the old flat files removed in the same commit.
   *
   * Unlike previewCommit() this is deliberately proportional to the whole history --
   * it is a one-off, and it is the only way to render months written before the
   * renderers existed. It needs the full history loaded first, because rewriting a
   * month from a partial read would drop events.
   */
  migrationCommit() {
    if (!this.needsMigration) return null;
    if (!this.fullyLoaded) throw new Error('Load the full history before upgrading: this rewrites every month.');

    const merged = unionEvents(this.remoteEvents, this.pending);
    const through = merged[merged.length - 1] || null;
    const { tasks } = foldEvents(merged);

    const months = [...new Set(merged.map(monthOfEvent))].sort();
    const stats = new Map();
    const eventsIn = new Map();
    for (const m of months) {
      const evs = merged.filter((e) => monthOfEvent(e) === m);
      eventsIn.set(m, evs);
      stats.set(m, {
        month: m,
        events: evs.length,
        days: new Set(evs.map((e) => localDate(e.ts))).size,
        updated: new Date().toISOString(),
      });
    }
    const statList = [...stats.values()];
    const years = [...new Set(months.map(yearOf))];

    const files = [
      ...months.flatMap((m) => [
        { path: PATHS.month(m),   text: serialiseMonth(m, eventsIn.get(m)) },
        { path: PATHS.monthMd(m), text: renderMonthMd(m, eventsIn.get(m), tasks) },
      ]),
      ...years.map((y) => ({ path: PATHS.yearReadme(y), text: renderYearReadme(y, statList) })),
      { path: PATHS.board,     text: renderBoardSnapshot(tasks, through) },
      { path: PATHS.boardMd,   text: renderBoardMd(tasks) },
      { path: PATHS.changelog, text: renderChangelogIndex(statList) },
      { path: PATHS.logReadme, text: renderLogReadme() },
      { path: PATHS.manifest,  text: renderManifest(stats) },
    ];

    // Only ever delete a flat file whose events this same commit writes elsewhere.
    const deletions = this.legacyMonths
      .filter((m) => months.includes(m))
      .map((m) => PATHS.legacyMonth(m))
      .filter((path) => !files.some((f) => f.path === path));

    const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const message = `worklog: upgrade data layout to schema ${SCHEMA}

Months move into per-year directories with a rendered page beside each one, so this
repo reads as markdown on GitHub with nothing installed and no Action. CHANGELOG.md
becomes an index, and data/board.json becomes a checkpoint so opening the app no
longer reads every month ever written.

${s(months.length, 'month')} rewritten, ${s(deletions.length, 'old file')} removed, ${s(merged.length, 'event')} preserved unchanged.

Co-Authored-By: Claude <noreply@anthropic.com>
`;

    return { files, deletions, message, months, count: merged.length };
  }

  /**
   * Perform the upgrade. Call only after the user has seen migrationCommit().
   * No event is altered, so this is safe to retry and safe to skip.
   */
  async migrate() {
    if (!this.fullyLoaded) await this.loadAll();
    const plan = this.migrationCommit();
    if (!plan) return null;
    const res = await this.repo.commitFiles(plan.files, plan.message, { deletions: plan.deletions });
    await this.load();
    return res;
  }

  previewCommit() {
    if (!this.hasPending) return null;

    const touchedAll = this.touchedMonths;
    const unread = touchedAll.filter((m) => this.loadedMonths.length && !this.loadedMonths.includes(m));
    if (unread.length) {
      // Rewriting a month we never read would drop its events. push() loads them first.
      throw new Error(`Cannot build a commit: ${unread.join(', ')} has not been read from the repo yet.`);
    }

    const merged = unionEvents(this.remoteEvents, this.pending);
    const through = merged[merged.length - 1] || null;
    const { tasks } = foldEvents(merged.filter((e) => afterThrough(e, this.checkpoint?.through)), { base: this.checkpoint?.tasks });

    const eventsIn = new Map(touchedAll.map((m) => [m, merged.filter((e) => monthOfEvent(e) === m)]));
    // A month pulled in only to move an event out of it is written even if that leaves
    // it empty -- it already exists in the repo and would otherwise keep a stale copy.
    // A month that would be created empty is not written, and does not enter the index.
    const touched = touchedAll.filter((m) => eventsIn.get(m).length || this.monthStats.has(m));

    // Month stats, refreshed for what we touched and carried over for what we did not.
    const stats = new Map([...this.monthStats].map(([m, s]) => [m, { ...s }]));
    for (const m of touched) {
      const evs = eventsIn.get(m);
      stats.set(m, {
        month: m,
        events: evs.length,
        days: new Set(evs.map((e) => localDate(e.ts))).size,
        updated: new Date().toISOString(),
      });
    }
    const statList = [...stats.values()].sort((a, b) => a.month.localeCompare(b.month));
    const touchedYears = [...new Set(touched.map(yearOf))];

    const files = [
      ...touched.flatMap((m) => [
        { path: PATHS.month(m),   text: serialiseMonth(m, eventsIn.get(m)) },
        { path: PATHS.monthMd(m), text: renderMonthMd(m, eventsIn.get(m), tasks) },
      ]),
      ...touchedYears.map((y) => ({ path: PATHS.yearReadme(y), text: renderYearReadme(y, statList) })),
      { path: PATHS.board,     text: renderBoardSnapshot(tasks, through) },
      { path: PATHS.boardMd,   text: renderBoardMd(tasks) },
      { path: PATHS.changelog, text: renderChangelogIndex(statList) },
      { path: PATHS.logReadme, text: renderLogReadme() },
      { path: PATHS.manifest,  text: renderManifest(stats) },
    ];

    return {
      files,
      message: buildCommitMessage(this.pending, tasks),
      changes: this.pending.map((e) => describeEvent(e, tasks)),
      count: this.pending.length,
    };
  }

  /**
   * Publish staged events as a single commit. Call only after the user confirms.
   *
   * On a conflict (someone else pushed meanwhile) the remote is re-read, its events
   * unioned with ours, and the commit rebuilt — so a race merges instead of
   * clobbering. Retried a few times before giving up.
   */
  async push({ retries = 3 } = {}) {
    if (!this.hasPending) return null;

    // A month we are about to rewrite must be read first, or we would truncate it.
    if (this.loaded) await this.loadMonths(this.touchedMonths);

    for (let attempt = 0; attempt <= retries; attempt++) {
      const preview = this.previewCommit();
      try {
        const res = await this.repo.commitFiles(preview.files, preview.message);
        // Staged events are now published; fold them into the remote baseline.
        this.remoteEvents = unionEvents(this.remoteEvents, this.pending);
        for (const m of this.touchedMonths) {
          if (!this.monthStats.has(m)) this.monthStats.set(m, { month: m });
          if (!this.loadedMonths.includes(m)) this.loadedMonths = [...this.loadedMonths, m].sort();
        }
        this.knownMonths = [...new Set([...this.knownMonths, ...this.touchedMonths])].sort();
        this.discardPending();
        return res;
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt === retries) throw err;
        await this.load();               // pull peer's events, then rebuild and retry
        await this.loadMonths(this.touchedMonths);
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    return null;
  }
}
