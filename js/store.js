/**
 * store.js — event-sourced task store, persisted as plain JSON in a git repo.
 *
 * Two design choices worth explaining:
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
 * Events are grouped into monthly files rather than daily ones so that a year of
 * history loads in ~12 requests instead of ~365, while diffs stay small enough to
 * read in a pull request.
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

const PATHS = {
  manifest: 'data/manifest.json',
  board: 'data/board.json',
  changelog: 'CHANGELOG.md',
  month: (m) => `data/log/${m}.json`,
};

/* ---------- small helpers ------------------------------------------------ */

export const todayISO = () => new Date().toISOString().slice(0, 10);
const monthOf = (iso) => iso.slice(0, 7);
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

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

/* ---------- fold: events -> board state --------------------------------- */

/**
 * Replay events into task state. Unknown-task references are skipped rather than
 * thrown, because a partially-synced peer may legitimately reference a task whose
 * creation event has not arrived yet; the next merge repairs it.
 */
export function foldEvents(events) {
  const tasks = new Map();
  const summaries = {};
  let skipped = 0;

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
      case 'task.note':
        t.notes.push({ ts: e.ts, text: e.text });
        break;
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
    t.updated = e.ts;
  }

  return { tasks, summaries, skipped };
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

function renderChangelog(events, tasks) {
  const byDay = new Map();
  for (const e of sortEvents(events)) {
    const d = e.ts.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  const days = [...byDay.keys()].sort().reverse(); // newest first: diffs append at top
  const out = [
    '# Work log changelog',
    '',
    '_Generated from the event log. Newest first._',
    '',
  ];
  for (const d of days) {
    out.push(`## ${d}`, '');
    const sums = [];
    for (const e of byDay.get(d)) {
      if (e.type === 'summary.set') { sums.push(e); continue; }
      out.push(`- ${describeEvent(e, tasks)}`);
    }
    for (const s of sums) {
      if (s.summary?.headline) out.push('', `**${s.kind} summary:** ${s.summary.headline}`);
      for (const b of s.summary?.bullets || []) out.push(`  - ${b.text}`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** Snapshot of live state. Pretty-printed and key-sorted so diffs stay legible. */
function renderBoard(tasks) {
  const live = [...tasks.values()].filter((t) => !t.deleted)
    .sort((a, b) => STATUSES.findIndex((s) => s.id === a.status) - STATUSES.findIndex((s) => s.id === b.status)
      || (a.created < b.created ? -1 : 1));
  return `${JSON.stringify({
    generated: new Date().toISOString(),
    counts: STATUSES.reduce((m, s) => (m[s.id] = live.filter((t) => t.status === s.id).length, m), {}),
    tasks: live,
  }, null, 2)}\n`;
}

/* ---------- the store ---------------------------------------------------- */

export class Store {
  constructor(repo) {
    this.repo = repo;
    this.remoteEvents = [];   // as last read from the repo
    this.pending = [];        // staged locally, NOT yet published
    this.months = [];
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

  /** Current view of the world = published events plus anything staged locally. */
  get state() {
    return foldEvents(unionEvents(this.remoteEvents, this.pending));
  }

  get tasks() {
    return [...this.state.tasks.values()].filter((t) => !t.deleted);
  }

  /* --- reading --- */

  async load() {
    const manifest = await this._readJSON(PATHS.manifest);
    this.months = manifest?.months || [];

    // Always include the current month, even on a repo that has never been written.
    const cur = monthOf(todayISO());
    if (!this.months.includes(cur)) this.months = [...this.months, cur];

    const files = await Promise.all(this.months.map((m) => this._readJSON(PATHS.month(m))));
    this.remoteEvents = unionEvents(...files.map((f) => f?.events || []));
    this.loaded = true;
    return this;
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
   */
  previewCommit() {
    if (!this.hasPending) return null;
    const merged = unionEvents(this.remoteEvents, this.pending);
    const { tasks } = foldEvents(merged);
    const touchedMonths = [...new Set(this.pending.map((e) => monthOf(e.ts.slice(0, 10))))];

    const files = [
      ...touchedMonths.map((m) => ({
        path: PATHS.month(m),
        text: `${JSON.stringify({
          month: m,
          events: merged.filter((e) => monthOf(e.ts.slice(0, 10)) === m),
        }, null, 2)}\n`,
      })),
      { path: PATHS.board, text: renderBoard(tasks) },
      { path: PATHS.changelog, text: renderChangelog(merged, tasks) },
      {
        path: PATHS.manifest,
        text: `${JSON.stringify({
          schema: 1,
          app: 'worklog',
          months: [...new Set([...this.months, ...touchedMonths])].sort(),
          updated: new Date().toISOString(),
        }, null, 2)}\n`,
      },
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

    for (let attempt = 0; attempt <= retries; attempt++) {
      const preview = this.previewCommit();
      try {
        const res = await this.repo.commitFiles(preview.files, preview.message);
        // Staged events are now published; fold them into the remote baseline.
        this.remoteEvents = unionEvents(this.remoteEvents, this.pending);
        this.months = [...new Set([...this.months, ...this.pending.map((e) => monthOf(e.ts.slice(0, 10)))])].sort();
        this.discardPending();
        return res;
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt === retries) throw err;
        await this.load();               // pull peer's events, then rebuild and retry
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    return null;
  }
}
