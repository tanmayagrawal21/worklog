import { check, eq, ok, report } from './shim.js';
import {
  foldEvents, unionEvents, makeEvent, newTaskId, Store, STATUSES, statusLabel,
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
  s.months = ['2026-09'];
  s.stage(makeEvent('task.create', { taskId: newTaskId(), title: 'New thing', status: 'todo' }));
  const p = s.previewCommit();
  ok(p, 'preview should exist when pending');
  eq(p.count, 1);
  const paths = p.files.map((f) => f.path).sort();
  eq(paths, ['CHANGELOG.md', 'data/board.json', 'data/log/2026-09.json', 'data/manifest.json']);
  ok(/^worklog \d{4}-\d{2}-\d{2}: 1 new/.test(p.message), `subject should summarise: ${p.message.split('\n')[0]}`);
  ok(s.hasPending, 'preview must not clear pending');
});

check('previewCommit is null with nothing staged', () => {
  localStorage.clear();
  eq(new Store(fakeRepo).previewCommit(), null);
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

check('changelog renders newest day first', () => {
  localStorage.clear();
  const s = new Store(fakeRepo);
  s.remoteEvents = [
    ev('2026-09-16T09:00:00.000Z', 'task.create', { taskId: T1, title: 'older' }),
    ev('2026-09-17T09:00:00.000Z', 'task.create', { taskId: T2, title: 'newer' }),
  ];
  s.stage(makeEvent('task.note', { taskId: T1, text: 'n' }));
  const md = s.previewCommit().files.find((f) => f.path === 'CHANGELOG.md').text;
  ok(md.indexOf('## 2026-09-17') < md.indexOf('## 2026-09-16'), 'newest day must come first');
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
