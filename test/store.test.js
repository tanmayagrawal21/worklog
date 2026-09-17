import { check, checkAsync, eq, ok, report } from './shim.js';
import {
  foldEvents, unionEvents, makeEvent, newTaskId, Store, STATUSES, statusLabel,
  PATHS, serialiseMonth, renderMonthMd, renderYearReadme, renderChangelogIndex,
  renderBoardMd, renderBoardSnapshot, afterThrough, todayISO,
} from '../js/store.js';

/** Fixed timestamps keep ordering assertions deterministic. */
const ev = (ts, type, payload = {}) => ({ id: `${ts}-${type}`, ts, type, ...payload });

const T1 = 'T-aaa111';
const T2 = 'T-bbb222';

print('\n--- fold ---');

check('create then status then note yields expected task', () => {
  const { tasks } = foldEvents([
    ev('2026-09-17T09:00:00.000Z', 'task.create', { taskId: T1, title: 'Fix flaky CI', status: 'todo' }),
    ev('2026-09-17T10:00:00.000Z', 'task.status', { taskId: T1, from: 'todo', to: 'in_progress' }),
    ev('2026-09-17T11:00:00.000Z', 'task.note',   { taskId: T1, text: 'root caused to a race' }),
  ]);
  const t = tasks.get(T1);
  eq(t.title, 'Fix flaky CI');
  eq(t.status, 'in_progress');
  eq(t.notes.length, 1);
  eq(t.notes[0].text, 'root caused to a race');
  eq(t.updated, '2026-09-17T11:00:00.000Z', 'updated should track the latest event');
});

check('events are replayed in timestamp order, not array order', () => {
  const { tasks } = foldEvents([
    ev('2026-09-17T12:00:00.000Z', 'task.status', { taskId: T1, from: 'in_progress', to: 'done' }),
    ev('2026-09-17T09:00:00.000Z', 'task.create', { taskId: T1, title: 'x', status: 'todo' }),
    ev('2026-09-17T10:00:00.000Z', 'task.status', { taskId: T1, from: 'todo', to: 'in_progress' }),
  ]);
  eq(tasks.get(T1).status, 'done', 'latest status must win regardless of input order');
  ok(tasks.get(T1).done !== null, 'done timestamp should be set');
});

check('events for an unknown task are skipped, not thrown', () => {
  const { tasks, skipped } = foldEvents([
    ev('2026-09-17T10:00:00.000Z', 'task.note', { taskId: 'T-missing', text: 'orphan' }),
  ]);
  eq(tasks.size, 0);
  eq(skipped, 1, 'orphan event should be counted as skipped');
});

check('delete marks deleted rather than dropping history', () => {
  const { tasks } = foldEvents([
    ev('2026-09-17T09:00:00.000Z', 'task.create', { taskId: T1, title: 'x' }),
    ev('2026-09-17T10:00:00.000Z', 'task.delete', { taskId: T1 }),
  ]);
  eq(tasks.get(T1).deleted, true);
});

check('edit only applies whitelisted fields', () => {
  const { tasks } = foldEvents([
    ev('2026-09-17T09:00:00.000Z', 'task.create', { taskId: T1, title: 'x' }),
    ev('2026-09-17T10:00:00.000Z', 'task.edit', { taskId: T1, fields: { title: 'y', priority: 'high', hacked: 'nope' } }),
  ]);
  const t = tasks.get(T1);
  eq(t.title, 'y');
  eq(t.priority, 'high');
  eq(t.hacked, undefined, 'unknown fields must be ignored');
});

print('\n--- merge convergence (the data-loss guard) ---');

// Laptop and desktop each edit while unaware of the other.
const laptop = [
  ev('2026-09-17T09:00:00.000Z', 'task.create', { taskId: T1, title: 'Fix flaky CI', status: 'todo' }),
  ev('2026-09-17T10:00:00.000Z', 'task.status', { taskId: T1, from: 'todo', to: 'in_progress' }),
];
const desktop = [
  ev('2026-09-17T09:30:00.000Z', 'task.create', { taskId: T2, title: 'Index bloat', status: 'todo' }),
  ev('2026-09-17T10:30:00.000Z', 'task.note',   { taskId: T1, text: 'from the other machine' }),
];

check('union is order independent', () => {
  eq(unionEvents(laptop, desktop), unionEvents(desktop, laptop));
});

check('merged board keeps BOTH machines\' work', () => {
  const { tasks } = foldEvents(unionEvents(laptop, desktop));
  eq(tasks.size, 2, 'both tasks should survive');
  eq(tasks.get(T1).status, 'in_progress', 'laptop status kept');
  eq(tasks.get(T1).notes.length, 1, 'desktop note kept on laptop-created task');
  eq(tasks.get(T2).title, 'Index bloat');
});

check('re-merging is idempotent (no duplicated notes on retry)', () => {
  const once = foldEvents(unionEvents(laptop, desktop));
  const twice = foldEvents(unionEvents(laptop, desktop, laptop, desktop));
  eq(twice.tasks.get(T1).notes.length, once.tasks.get(T1).notes.length, 'push retry must not duplicate');
  eq(twice.tasks.size, once.tasks.size);
});

print('\n--- staging: nothing publishes without asking ---');

const fakeRepo = { owner: 'me', repo: 'worklog-data', slug: 'me/worklog-data' };

check('staged events are visible locally but remote baseline untouched', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  s.remoteEvents = laptop.slice();
  s.stage(makeEvent('task.note', { taskId: T1, text: 'staged only' }));
  ok(s.hasPending, 'should report pending changes');
  eq(s.remoteEvents.length, 2, 'remote baseline must not change on stage');
  eq(s.state.tasks.get(T1).notes.length, 1, 'staged note shows in local view');
});

check('previewCommit describes the commit without performing it', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  s.remoteEvents = laptop.slice();
  s.stage(makeEvent('task.create', { taskId: newTaskId(), title: 'New thing', status: 'todo' }));
  const p = s.previewCommit();
  ok(p, 'preview should exist when pending');
  eq(p.count, 1);
  const month = todayISO().slice(0, 7);
  const paths = p.files.map((f) => f.path).sort();
  // JSON and its rendered page are committed together: that is what makes the repo
  // readable with no Action and no build step.
  eq(paths, [
    'CHANGELOG.md',
    'data/BOARD.md',
    'data/board.json',
    PATHS.month(month),
    PATHS.monthMd(month),
    PATHS.yearReadme(month.slice(0, 4)),
    'data/log/README.md',
    'data/manifest.json',
  ].sort());
  ok(/^worklog \d{4}-\d{2}-\d{2}: 1 new/.test(p.message), `subject should summarise: ${p.message.split('\n')[0]}`);
  ok(s.hasPending, 'preview must not clear pending');
});

check('previewCommit is null with nothing staged', () => {
  localStorage.clear();
  eq(new Store(fakeRepo).previewCommit(), null);
});

check('pendingDescriptions says what is staged, in words', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  s.remoteEvents = laptop.slice();
  s.stage(
    makeEvent('task.status', { taskId: T1, from: 'todo', to: 'done' }),
    makeEvent('task.note', { taskId: T1, text: 'shipped it' }),
  );
  const d = s.pendingDescriptions;
  eq(d.length, 2);
  ok(/→ Done$/.test(d[0].text), `should read as a move: ${d[0].text}`);
  ok(d[0].text.includes(T1), 'and name the task');
  ok(/note — shipped it$/.test(d[1].text), d[1].text);
  ok(d.every((r) => r.ts && r.type), 'each row carries its instant and type for the UI');
});

check('pendingDescriptions answers even when a month is unread', () => {
  // The whole reason it does not go through previewCommit(): that refuses, correctly,
  // and someone asking "what have I got staged?" deserves an answer regardless.
  localStorage.clear();
  const s = new Store(fakeRepo);
  s.loadedMonths = ['2024-01'];
  s.stage(makeEvent('task.note', { taskId: T1, text: 'x' }));
  let threw = null;
  try { s.previewCommit(); } catch (e) { threw = e; }
  ok(threw, 'previewCommit still refuses');
  eq(s.pendingDescriptions.length, 1, 'but the list is still available');
});

check('pending changes survive a reload', () => {
  localStorage.clear();
  const a = new Store(fakeRepo);
  a.stage(makeEvent('task.note', { taskId: T1, text: 'unpushed work' }));
  const b = new Store(fakeRepo);       // simulates reopening the tab
  eq(b.pending.length, 1, 'pending should be restored from localStorage');
  b.discardPending();
  eq(new Store(fakeRepo).pending.length, 0, 'discard should clear persisted pending');
});

check('board snapshot is valid JSON with per-status counts', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  s.remoteEvents = unionEvents(laptop, desktop);
  s.stage(makeEvent('task.note', { taskId: T2, text: 'n' }));
  const board = JSON.parse(s.previewCommit().files.find((f) => f.path === 'data/board.json').text);
  eq(board.counts.in_progress, 1);
  eq(board.tasks.length, 2);
});

check('a month page renders newest day first', () => {
  const md = renderMonthMd('2026-09', [
    ev('2026-09-16T09:00:00.000Z', 'task.create', { taskId: T1, title: 'older' }),
    ev('2026-09-17T09:00:00.000Z', 'task.create', { taskId: T2, title: 'newer' }),
  ], new Map());
  ok(md.indexOf('## 2026-09-17') < md.indexOf('## 2026-09-16'), 'newest day must come first');
});

print('\n--- years: does this survive being used for years? ---');

/** A repo double that records what was read, so a lazy boot can be proven lazy. */
function memRepo(files = {}) {
  return {
    owner: 'me', repo: 'd', slug: 'me/d', files, reads: [], commits: 0,
    async getFile(path) { this.reads.push(path); return files[path] == null ? null : { text: files[path] }; },
    async commitFiles(list, message, { deletions = [] } = {}) {
      for (const f of list) files[f.path] = f.text;
      for (const d of deletions) delete files[d];
      this.commits++; this.lastMessage = message; this.lastDeletions = deletions;
      return { ok: true };
    },
  };
}

check('event files live in year directories, with a rendered page beside them', () => {
  eq(PATHS.month('2031-04'), 'data/log/2031/04.json');
  eq(PATHS.monthMd('2031-04'), 'data/log/2031/04.md');
  eq(PATHS.yearReadme('2031'), 'data/log/2031/README.md');
});

check('a month file is one line per event, and still ordinary JSON', () => {
  const text = serialiseMonth('2026-09', [
    ev('2026-09-17T09:00:00.000Z', 'task.create', { taskId: T1, title: 'a' }),
    ev('2026-09-17T10:00:00.000Z', 'task.note', { taskId: T1, text: 'b' }),
  ]);
  const parsed = JSON.parse(text);
  eq(parsed.month, '2026-09');
  eq(parsed.count, 2);
  eq(parsed.events.length, 2);
  // One added change must be one added line, or `git log -p` stops being readable.
  eq(text.split('\n').filter((l) => l.trim().startsWith('{"ts"')).length, 2, 'each event on its own line, ts first');
  eq(Object.keys(parsed.events[0])[0], 'ts', 'what happened comes before bookkeeping');
  ok(Object.keys(parsed.events[0]).includes('id'), 'the id must survive the reordering');
});

check('an empty month is still valid JSON', () => {
  eq(JSON.parse(serialiseMonth('2026-09', [])).events.length, 0);
});

check('a push rewrites only the month it touched', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  s.loadedMonths = ['2024-01', '2026-09'];
  s.monthStats = new Map([['2024-01', { month: '2024-01', events: 5, days: 3 }], ['2026-09', { month: '2026-09' }]]);
  s.remoteEvents = [ev('2024-01-05T09:00:00.000Z', 'task.create', { taskId: T1, title: 'ancient' })];
  s.stage({ ...makeEvent('task.note', { taskId: T1, text: 'today' }), ts: '2026-09-17T09:00:00.000Z' });
  const paths = s.previewCommit().files.map((f) => f.path);
  ok(paths.includes('data/log/2026/09.json'), 'the touched month is written');
  ok(!paths.includes('data/log/2024/01.json'), 'an untouched month must not be rewritten');
  ok(!paths.includes('data/log/2024/README.md'), 'nor an untouched year index');
});

check('previewCommit refuses to rewrite a month it has not read', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  s.loadedMonths = ['2024-01'];              // current month deliberately not loaded
  s.stage(makeEvent('task.note', { taskId: T1, text: 'x' }));
  let threw = null;
  try { s.previewCommit(); } catch (e) { threw = e; }
  ok(threw, 'silently truncating a month file would lose events');
  ok(/has not been read/.test(threw.message), threw && threw.message);
});

check('the changelog is an index, not the whole history', () => {
  const md = renderChangelogIndex([
    { month: '2024-01', events: 40, days: 12 },
    { month: '2026-09', events: 9, days: 3 },
  ]);
  ok(md.indexOf('## 2026') < md.indexOf('## 2024'), 'newest year first');
  ok(md.includes('data/log/2026/09.md'), 'links to the rendered month');
  ok(md.includes('data/log/2024/01.json'), 'and to the raw events');
  ok(md.length < 2000, `an index must stay small; got ${md.length} bytes`);
});

check('a year index lists its own months only', () => {
  const md = renderYearReadme('2026', [
    { month: '2025-12', events: 3, days: 1 },
    { month: '2026-01', events: 7, days: 4 },
    { month: '2026-09', events: 9, days: 3 },
  ]);
  ok(md.includes('January'), 'months are named');
  ok(md.includes('September'), 'and all of them appear');
  ok(!md.includes('December'), 'a neighbouring year must not leak in');
  ok(md.includes('16 changes this year'), 'totals come from the manifest, not from reading every month');
});

check('the board page groups by status and caps finished work', () => {
  const tasks = new Map();
  for (let i = 0; i < 20; i++) {
    tasks.set(`T-d${i}`, { id: `T-d${i}`, title: `done ${i}`, status: 'done', priority: 'normal', tags: [], notes: [], created: '2026-01-01T00:00:00.000Z', updated: `2026-0${1 + (i % 9)}-01T00:00:00.000Z`, done: `2026-0${1 + (i % 9)}-01T00:00:00.000Z`, deleted: false });
  }
  tasks.set(T1, { id: T1, title: 'live | one', status: 'in_progress', priority: 'high', tags: ['ci'], notes: [{ ts: '2026-09-17T09:00:00.000Z', text: 'latest note' }], created: '2026-09-01T00:00:00.000Z', updated: '2026-09-17T09:00:00.000Z', done: null, deleted: false });
  const md = renderBoardMd(tasks);
  ok(md.includes('## In Progress (1)'), 'open work is grouped and counted');
  ok(md.includes('## Done (20)'), 'the count is the truth even when the list is capped');
  ok(md.includes('latest note'), 'the most recent note is the useful part');
  ok(/and 5 more finished earlier/.test(md), 'the rest points at the changelog instead of growing');
  ok(md.split('\n').length < 60, 'the board page stays a page');
});

print('\n--- the checkpoint: fast boots that are still correct ---');

const YEARS = [
  ev('2024-03-01T09:00:00.000Z', 'task.create', { taskId: T1, title: 'long runner', status: 'todo' }),
  ev('2025-06-01T09:00:00.000Z', 'task.status', { taskId: T1, from: 'todo', to: 'in_progress' }),
  ev('2026-09-17T09:00:00.000Z', 'task.note', { taskId: T1, text: 'still going' }),
];

check('snapshot plus later events equals replaying everything', () => {
  const full = foldEvents(YEARS);
  const snapshot = [...foldEvents(YEARS.slice(0, 2)).tasks.values()];
  const fast = foldEvents(YEARS.slice(2), { base: snapshot });

  eq(fast.tasks.get(T1).status, full.tasks.get(T1).status);
  eq(fast.tasks.get(T1).notes.length, full.tasks.get(T1).notes.length);
  eq(fast.tasks.get(T1).updated, full.tasks.get(T1).updated);
  eq(snapshot[0].notes.length, 0, 'the snapshot must not be mutated -- state is folded on every render');
});

check('events already in the snapshot are not applied twice', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  const folded = foldEvents(YEARS);
  s.checkpoint = { through: { ts: YEARS[2].ts, id: YEARS[2].id }, tasks: [...folded.tasks.values()] };
  s.remoteEvents = YEARS.slice();          // the month file we read contains that note
  eq(s.state.tasks.get(T1).notes.length, 1, 'a duplicated note would be silent data corruption');
});

check('two events in the same millisecond are split correctly by the checkpoint', () => {
  const ts = '2026-09-17T09:00:00.000Z';
  const first = { id: `${ts}-aaa`, ts, type: 'task.note', taskId: T1, text: 'first' };
  const second = { id: `${ts}-bbb`, ts, type: 'task.note', taskId: T1, text: 'second' };
  ok(!afterThrough(first, { ts, id: first.id }), 'the boundary event itself is already folded in');
  ok(afterThrough(second, { ts, id: first.id }), 'its same-millisecond neighbour is not');
});

check('the snapshot records what it folded in, so a boot can trust it', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  s.loadedMonths = ['2026-09'];
  s.remoteEvents = [];
  const staged = { ...makeEvent('task.create', { taskId: T2, title: 'x' }), ts: '2026-09-17T09:00:00.000Z' };
  s.stage(staged);
  const board = JSON.parse(s.previewCommit().files.find((f) => f.path === 'data/board.json').text);
  eq(board.through.id, staged.id, 'through must name the last event folded in');
  eq(board.schema, 2);
});

check('a boot with a checkpoint reads a handful of months, not every year', async () => {
  localStorage.clear();
  const months = [];
  for (let y = 2021; y <= 2026; y++) for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
  const repo = memRepo({
    'data/manifest.json': JSON.stringify({ schema: 2, months: months.map((m) => ({ month: m, events: 10, days: 5 })) }),
    'data/board.json': JSON.stringify({ through: { ts: '2026-08-01T00:00:00.000Z', id: 'x' }, tasks: [{ id: T1, title: 'carried', status: 'todo', tags: [], notes: [] }] }),
  });
  const s = new Store(repo);
  await s.load();

  eq(s.knownMonths.length >= 72, true, 'the manifest still knows every month');
  const monthReads = repo.reads.filter((p) => p.endsWith('.json') && p.startsWith('data/log/'));
  ok(monthReads.length <= 4, `a boot should read a few months, not 72 (read ${monthReads.length})`);
  eq(s.tasks.length, 1, 'the board is still complete, from the snapshot');
  ok(!s.fullyLoaded, 'and it knows it has not read everything');
});

check('older history loads on demand, and only once', async () => {
  localStorage.clear();
  const repo = memRepo({
    'data/manifest.json': JSON.stringify({ schema: 2, months: ['2024-01', '2024-02', '2026-09'] }),
    'data/board.json': JSON.stringify({ through: { ts: '2026-09-01T00:00:00.000Z', id: 'x' }, tasks: [] }),
    'data/log/2024/01.json': JSON.stringify({ month: '2024-01', events: [ev('2024-01-05T09:00:00.000Z', 'task.create', { taskId: T1, title: 'ancient' })] }),
  });
  const s = new Store(repo);
  await s.load();
  ok(!s.yearLoaded('2024'), '2024 starts unread');

  await s.loadYear('2024');
  ok(s.yearLoaded('2024'), 'and is loaded on request');
  eq(s.remoteEvents.length, 1);
  const before = repo.reads.length;
  await s.loadYear('2024');
  eq(repo.reads.length, before, 'a second request must not re-fetch');
});

check('a v1 repo still loads: flat month files and bare month strings', async () => {
  localStorage.clear();
  const repo = memRepo({
    'data/manifest.json': JSON.stringify({ schema: 1, months: ['2026-09'] }),
    'data/log/2026-09.json': JSON.stringify({ month: '2026-09', events: [ev('2026-09-10T09:00:00.000Z', 'task.create', { taskId: T1, title: 'written by v1' })] }),
  });
  const s = new Store(repo);
  await s.load();
  eq(s.tasks.length, 1, 'a v1 flat month file must still be found');
  eq(s.tasks[0].title, 'written by v1');
  ok(s.knownMonths.includes('2026-09'), 'bare month strings still index');
});

check('the snapshot drops notes from long-finished work, and says how many', () => {
  const old = '2024-01-05T09:00:00.000Z';
  const tasks = new Map([
    ['T-old111', { id: 'T-old111', title: 'finished ages ago', status: 'done', priority: 'normal', tags: [], created: old, updated: old, done: old, deleted: false,
      notes: [{ ts: old, text: 'a long note that would be carried on every boot forever' }, { ts: old, text: 'and another' }] }],
    ['T-new222', { id: 'T-new222', title: 'still open', status: 'in_progress', priority: 'normal', tags: [], created: old, updated: new Date().toISOString(), done: null, deleted: false,
      notes: [{ ts: new Date().toISOString(), text: 'current thinking, must be kept' }] }],
  ]);
  const snap = JSON.parse(renderBoardSnapshot(tasks, { ts: old, id: 'x' }));
  const stale = snap.tasks.find((t) => t.id === 'T-old111');
  const live = snap.tasks.find((t) => t.id === 'T-new222');
  eq((stale.notes || []).length, 0, 'old notes are already committed in that month; not carried here');
  eq(stale.noteCount, 2, 'but the count must be recorded so the UI can offer them');
  eq(stale.title, 'finished ages ago', 'the task itself stays, so reopening it still works');
  eq(live.notes.length, 1, 'open work keeps full fidelity');
  ok(live.noteCount === undefined, 'and is not marked as trimmed');
});

check('the snapshot is one line per task, and round trips', () => {
  const tasks = new Map();
  for (let i = 0; i < 5; i++) {
    tasks.set(`T-x0000${i}`, { id: `T-x0000${i}`, title: `task ${i}`, status: 'todo', priority: 'normal', tags: [], notes: [], created: '2026-09-01T00:00:00.000Z', updated: '2026-09-01T00:00:00.000Z', done: null, deleted: false, futureField: 'keep me' });
  }
  const text = renderBoardSnapshot(tasks, { ts: '2026-09-01T00:00:00.000Z', id: 'z' });
  const parsed = JSON.parse(text);
  eq(parsed.tasks.length, 5);
  eq(text.split('\n').filter((l) => l.trim().startsWith('{"id"')).length, 5, 'one task per line keeps the diff readable');
  ok(!('deleted' in parsed.tasks[0]), 'defaults fold() already applies are left out');
  ok(!('notes' in parsed.tasks[0]), 'an empty notes array is noise');
  eq(parsed.tasks[0].futureField, 'keep me', 'unknown fields must survive a round trip');
  // The snapshot is the checkpoint, so it must fold back into the same board.
  const back = foldEvents([], { base: parsed.tasks });
  eq(back.tasks.size, 5);
  eq(back.tasks.get('T-x00000').notes.length, 0, 'fold restores the omitted defaults');
  ok(!back.tasks.get('T-x00000').deleted);
});

check('a note is a set, not a sequence: applying it twice changes nothing', () => {
  const n = ev('2026-09-17T09:00:00.000Z', 'task.note', { taskId: T1, text: 'same' });
  const { tasks } = foldEvents([
    ev('2026-09-01T09:00:00.000Z', 'task.create', { taskId: T1, title: 'x' }),
    n, { ...n, id: 'different-event-id-same-content' },
  ]);
  eq(tasks.get(T1).notes.length, 1, 'a re-delivered note must not duplicate');
});

check('loading an old month restores notes the snapshot trimmed', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  const old = '2024-01-05T09:00:00.000Z';
  const noteEvent = ev(old, 'task.note', { taskId: T1, text: 'the detail I came looking for' });
  s.checkpoint = {
    through: { ts: '2026-09-01T00:00:00.000Z', id: 'z' },
    tasks: [{ id: T1, title: 'finished ages ago', status: 'done', priority: 'normal', tags: [], notes: [], noteCount: 1, created: old, updated: old, done: old, deleted: false }],
  };
  eq(s.state.tasks.get(T1).notes.length, 0, 'not loaded yet');

  s.remoteEvents = [noteEvent];                   // as if the wiki fetched 2024
  const t = s.state.tasks.get(T1);
  eq(t.notes.length, 1, 'an old note must come back when its month is read');
  eq(t.notes[0].text, 'the detail I came looking for');
  eq(t.status, 'done', 'and must not drag order-dependent state backwards');
  eq(t.updated, old < '2026' ? old : old, 'sanity');
});

check('an old status event does NOT override the snapshot', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  s.checkpoint = {
    through: { ts: '2026-09-01T00:00:00.000Z', id: 'z' },
    tasks: [{ id: T1, title: 'x', status: 'done', priority: 'normal', tags: [], notes: [], created: '2024-01-01T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z', done: '2026-08-01T00:00:00.000Z', deleted: false }],
  };
  s.remoteEvents = [ev('2024-06-01T09:00:00.000Z', 'task.status', { taskId: T1, from: 'todo', to: 'in_progress' })];
  eq(s.state.tasks.get(T1).status, 'done', 'replaying pre-checkpoint status would corrupt the board');
});

check('notes recovered out of order end up in date order', () => {
  const { tasks } = foldEvents([
    ev('2026-09-05T09:00:00.000Z', 'task.note', { taskId: T1, text: 'second' }),
    ev('2026-09-01T09:00:00.000Z', 'task.create', { taskId: T1, title: 'x' }),
    ev('2026-09-02T09:00:00.000Z', 'task.note', { taskId: T1, text: 'first' }),
  ]);
  eq(tasks.get(T1).notes.map((n) => n.text), ['first', 'second']);
});

check('every link in the rendered pages stays inside the repo', () => {
  // A link that walks off the top of the repo is a 404 on github.com, and these pages
  // exist precisely so nobody has to run anything to read them.
  const at = (file, md) => {
    const dir = file.split('/').slice(0, -1);
    for (const [, href] of md.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(href)) continue;
      const parts = [...dir];
      for (const seg of href.split('/')) {
        if (seg === '..') { ok(parts.length > 0, `${file}: "${href}" escapes the repo root`); parts.pop(); }
        else if (seg !== '.') parts.push(seg);
      }
    }
  };
  const month = todayISO().slice(0, 7);
  at(PATHS.boardMd, renderBoardMd(new Map()));
  at(PATHS.changelog, renderChangelogIndex([{ month, events: 1, days: 1 }]));
  at(PATHS.yearReadme(month.slice(0, 4)), renderYearReadme(month.slice(0, 4), [{ month, events: 1, days: 1 }]));
  at(PATHS.monthMd(month), renderMonthMd(month, [], new Map()));
});

print('\n--- migrating a repo written by v1 ---');

/** A repo laid out the way v1 wrote it: flat months, bare manifest, no checkpoint. */
/**
 * A repo where the newest event is a summary -- exactly the shape you get by writing
 * an evening summary and publishing it, since the summary is then the checkpoint.
 */
function repoWithSummary() {
  const events = [
    ev('2026-09-17T09:00:00.000Z', 'task.create', { taskId: T1, title: 'ship the thing', status: 'in_progress' }),
    ev('2026-09-17T17:00:00.000Z', 'summary.set', {
      date: '2026-09-17',
      kind: 'evening',
      summary: { headline: 'shipped it', bullets: [{ text: 'done', taskIds: [T1] }] },
    }),
  ];
  const { tasks } = foldEvents(events);
  const through = events[events.length - 1];
  return memRepo({
    'data/manifest.json': JSON.stringify({
      schema: 2, app: 'worklog', months: [{ month: '2026-09', events: events.length, days: 1 }],
    }),
    'data/log/2026/09.json': serialiseMonth('2026-09', events),
    'data/board.json': renderBoardSnapshot(tasks, through),
  });
}

await checkAsync('a summary survives being the checkpoint', async () => {
  // The snapshot stores tasks, not summaries, so a summary that is at or before the
  // checkpoint has to be replayed or it is gone from the UI while still in the log.
  localStorage.clear();
  const s = new Store(repoWithSummary());
  await s.load();
  const today = s.state.summaries['2026-09-17'];
  ok(today, 'no summaries at all for the day the summary was written');
  ok(today.evening, 'the evening summary is in the log but not in the folded state');
  eq(today.evening.headline, 'shipped it');
});

function v1Repo() {
  const aug = [
    ev('2026-08-11T09:00:00.000Z', 'task.create', { taskId: T1, title: 'v1 task', status: 'todo' }),
    ev('2026-08-11T10:00:00.000Z', 'task.note',   { taskId: T1, text: 'written by the old version' }),
  ];
  const sep = [
    ev('2026-09-02T09:00:00.000Z', 'task.status', { taskId: T1, from: 'todo', to: 'in_progress' }),
    ev('2026-09-02T09:30:00.000Z', 'task.create', { taskId: T2, title: 'another', status: 'todo' }),
  ];
  return memRepo({
    'data/manifest.json': JSON.stringify({ schema: 1, app: 'worklog', months: ['2026-08', '2026-09'] }),
    'data/log/2026-08.json': JSON.stringify({ month: '2026-08', events: aug }),
    'data/log/2026-09.json': JSON.stringify({ month: '2026-09', events: sep }),
    'data/board.json': JSON.stringify({ schema: 1, tasks: [] }),
    'CHANGELOG.md': '# Changelog\n\nthe whole history, in one file\n',
  });
}

await checkAsync('a v1 repo loads completely, and is offered an upgrade', async () => {
  localStorage.clear();
  const s = new Store(v1Repo());
  await s.load();
  eq(s.state.tasks.size, 2, 'nothing may be missing before an upgrade is even offered');
  eq(s.state.tasks.get(T1).status, 'in_progress');
  ok(s.needsMigration, 'the flat layout must be detected');
  eq(s.legacyMonths.sort(), ['2026-08', '2026-09']);
  ok(s.fullyLoaded, 'with no checkpoint, v1 months are all read, so a rewrite is safe');
});

await checkAsync('the upgrade moves every month and deletes the flat copies', async () => {
  localStorage.clear();
  const repo = v1Repo();
  const s = new Store(repo);
  await s.load();
  const plan = s.migrationCommit();

  const written = plan.files.map((f) => f.path).sort();
  ok(written.includes('data/log/2026/08.json'), 'August moves under its year');
  ok(written.includes('data/log/2026/08.md'), 'and gains a page you can read on GitHub');
  ok(written.includes('data/log/2026/README.md'));
  eq(plan.deletions.sort(), ['data/log/2026-08.json', 'data/log/2026-09.json']);
  ok(/schema 2/.test(plan.message), `the message should say what it does: ${plan.message.split('\n')[0]}`);
  ok(/Co-Authored-By/.test(plan.message));

  await s.migrate();
  eq(repo.commits, 1, 'one commit, not one per month');
  ok(repo.files['data/log/2026-08.json'] === undefined, 'the flat file must actually be gone');
  ok(repo.files['data/log/2026/08.json'], 'and its events must be at the new path');
  eq(JSON.parse(repo.files['data/manifest.json']).schema, 2);
  ok(JSON.parse(repo.files['data/board.json']).through?.ts, 'board.json becomes a checkpoint');
});

await checkAsync('upgrading changes no event, and does not need doing twice', async () => {
  localStorage.clear();
  const repo = v1Repo();
  const before = new Store(repo);
  await before.load();
  const beforeTasks = [...before.state.tasks.values()].map((t) => `${t.id}|${t.status}|${t.notes.length}`).sort();

  await before.migrate();

  const after = new Store(repo);
  await after.load();
  const afterTasks = [...after.state.tasks.values()].map((t) => `${t.id}|${t.status}|${t.notes.length}`).sort();
  eq(afterTasks, beforeTasks, 'the board must be identical after the upgrade');
  ok(!after.needsMigration, 'and the offer must stop being made');
  eq(after.migrationCommit(), null);
});

await checkAsync('a half-read history refuses to be rewritten', async () => {
  localStorage.clear();
  const repo = v1Repo();
  // Give it a checkpoint so load() reads only recent months, then ask to migrate.
  repo.files['data/board.json'] = JSON.stringify({ schema: 2, through: { ts: '2026-08-11T10:00:00.000Z', id: 'zzz' }, tasks: [] });
  repo.files['data/manifest.json'] = JSON.stringify({ schema: 1, months: ['2020-01', '2026-08', '2026-09'] });
  const s = new Store(repo);
  await s.load({ recent: 1 });
  ok(!s.fullyLoaded, 'precondition: not everything is in memory');
  let threw = null;
  try { s.migrationCommit(); } catch (e) { threw = e; }
  ok(threw && /full history/.test(threw.message), 'rewriting a month it never read would drop events');
});


print('\n--- ids & labels ---');

check('task ids are unique across many draws', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(newTaskId());
  eq(seen.size, 2000, 'no id collisions expected');
});

check('event ids are unique even within the same millisecond', () => {
  // Collisions here would make unionEvents() drop an event, so test hard.
  const ids = new Set();
  for (let i = 0; i < 20000; i++) ids.add(makeEvent('task.note', { taskId: T1, text: 'x' }).id);
  eq(ids.size, 20000);
});

check('id characters are drawn from the whole alphabet (no modulo skew)', () => {
  let s = '';
  for (let i = 0; i < 3000; i++) s += newTaskId().slice(2);
  const distinct = new Set(s.split('')).size;
  ok(distinct >= 30, `expected a broad character spread, saw ${distinct} distinct`);
});

check('every status has a human label', () => {
  for (const s of STATUSES) ok(statusLabel(s.id) && statusLabel(s.id) !== s.id, `missing label for ${s.id}`);
});

quit(report('store.js'));
