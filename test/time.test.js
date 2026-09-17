/**
 * time.test.js — the day a piece of work belongs to.
 *
 * The bug this suite exists to prevent: dates were derived from UTC, so in Tucson
 * (UTC-7) anything logged after 5pm was filed under tomorrow — in the day pages, in
 * the summaries, and in the month file it was committed to. Timestamps stay UTC;
 * calendar dates are local.
 *
 * Written to hold in any timezone rather than pinning one, so it also passes on a
 * colleague's machine. scripts/test.sh runs it under three zones on top of that.
 */
import { check, eq, ok, report } from './shim.js';
import {
  Store, PATHS, makeEvent, newTaskId, localDate, localTime, todayISO, tzLabel,
  renderMonthMd, serialiseMonth, foldEvents,
} from '../js/store.js';
import { summaryWindow } from '../js/ai.js';

const T1 = 'T-aaa111';
const utcDate = (ts) => new Date(ts).toISOString().slice(0, 10);
/** An instant at a given local wall-clock time, expressed the way an event stores it. */
const atLocal = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const offsetMin = -new Date().getTimezoneOffset();

print(`\n--- local calendar dates (this run: ${tzLabel()}) ---`);

check('todayISO is the local date, not the UTC one', () => {
  const now = new Date();
  eq(todayISO(), `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
});

check('an evening update belongs to the evening you typed it', () => {
  // 6pm local today: the exact case that used to roll over to tomorrow west of UTC.
  const now = new Date();
  const evening = atLocal(now.getFullYear(), now.getMonth() + 1, now.getDate(), 18);
  eq(localDate(evening), todayISO(), 'an event at 18:00 local is dated today');
  eq(localTime(evening), '18:00', 'and reads as 18:00, not as its UTC hour');
  if (offsetMin < 0) {
    ok(utcDate(evening) !== localDate(evening), 'west of UTC this instant is literally tomorrow in UTC — which is the bug');
  }
});

check('midnight either side stays on the right day', () => {
  eq(localDate(atLocal(2026, 6, 15, 0, 1)), '2026-06-15');
  eq(localDate(atLocal(2026, 6, 15, 23, 59)), '2026-06-15');
});

check('tzLabel reads as an offset', () => {
  ok(/^UTC[+-]\d\d:\d\d$/.test(tzLabel()), `got ${tzLabel()}`);
});

print('\n--- a day is not split across two month pages ---');

/**
 * An instant whose local month and UTC month disagree, if this zone has such a thing.
 * West of UTC that is a late evening on the last of the month; east of UTC it is the
 * small hours of the first. Under TZ=UTC there is none, and the code below says so
 * rather than pretending to test something.
 */
function straddler() {
  for (const ts of [atLocal(2026, 9, 30, 23, 30), atLocal(2026, 10, 1, 0, 30)]) {
    if (utcDate(ts).slice(0, 7) !== localDate(ts).slice(0, 7)) return ts;
  }
  return null;
}

check('a late evening is filed under the month you were in', () => {
  const ts = straddler();
  if (!ts) { ok(offsetMin === 0, 'no straddling instant exists in UTC, which is expected'); return; }
  const localMonth = localDate(ts).slice(0, 7);
  localStorage.clear();
  const s = new Store({ owner: 'me', repo: 'data', slug: 'me/data' });
  s.stage({ ...makeEvent('task.create', { taskId: T1, title: 'evening work' }), ts });
  const paths = s.previewCommit().files.map((f) => f.path);
  ok(paths.includes(PATHS.month(localMonth)), `should write ${PATHS.month(localMonth)}, wrote ${paths.join(' ')}`);
  ok(!paths.includes(PATHS.month(utcDate(ts).slice(0, 7))), 'and not the month its UTC timestamp falls in');
});

check('rehoming a boundary event keeps exactly one copy of it', () => {
  const ts = straddler();
  if (!ts) { ok(offsetMin === 0, 'nothing to rehome in UTC'); return; }
  const localMonth = localDate(ts).slice(0, 7);
  const utcMonth = utcDate(ts).slice(0, 7);

  // The state a repo written by the old rule is in: this event sits in the UTC month's
  // file, and we are now about to rewrite the local month it actually belongs to.
  localStorage.clear();
  const s = new Store({ owner: 'me', repo: 'data', slug: 'me/data' });
  const boundary = { ...makeEvent('task.create', { taskId: T1, title: 'written last month' }), ts };
  s.remoteEvents = [boundary];
  s.stage({ ...makeEvent('task.note', { taskId: T1, text: 'this month' }), ts: atLocal(2026, 10, 20, 10) });

  const touched = s.touchedMonths;
  ok(touched.includes(localMonth) && touched.includes(utcMonth),
    `both halves of the pair must be rewritten together, got ${touched.join(' ')}`);

  const files = s.previewCommit().files.filter((f) => f.path.endsWith('.json') && f.path.includes('/log/'));
  const copies = files.filter((f) => f.text.includes(boundary.id));
  eq(copies.length, 1, 'the event exists in exactly one month file — not duplicated, and not dropped');
  eq(copies[0].path, PATHS.month(localMonth), 'and it is the file for its local month');
});

check('the month page groups by local date', () => {
  const now = new Date();
  const evening = { ...makeEvent('task.create', { taskId: T1, title: 'evening work' }), ts: atLocal(now.getFullYear(), now.getMonth() + 1, now.getDate(), 18) };
  const { tasks } = foldEvents([evening]);
  const md = renderMonthMd(todayISO().slice(0, 7), [evening], tasks);
  ok(md.includes(`## ${todayISO()}`), 'day heading is the local date');
  ok(md.includes('| 18:00 |'), 'and the time in the table is local too');
  ok(md.includes(tzLabel()), 'the page says which offset it was generated in');
  ok(serialiseMonth(todayISO().slice(0, 7), [evening]).includes(evening.ts), 'the raw event keeps its UTC timestamp');
});

print('\n--- what each summary is allowed to look at ---');

const summaryFixture = () => {
  const now = new Date();
  const day = (back, h) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, h).toISOString();
  return {
    todayMorning: { id: 'a', ts: day(0, 9), type: 'task.note', taskId: T1, text: 'today' },
    todayEvening: { id: 'b', ts: day(0, 19), type: 'task.status', taskId: T1, to: 'done' },
    yesterday: { id: 'c', ts: day(1, 14), type: 'task.note', taskId: T1, text: 'yesterday' },
    longAgo: { id: 'd', ts: day(30, 14), type: 'task.note', taskId: T1, text: 'last month' },
    summary: { id: 'e', ts: day(1, 20), type: 'summary.set', date: todayISO(), kind: 'evening' },
  };
};

check('the morning summary reads the days before today, not today', () => {
  const f = summaryFixture();
  const ids = summaryWindow(Object.values(f), 'morning').map((e) => e.id);
  eq(ids, ['c'], 'yesterday only: today has not happened yet, a month ago is out of the window, summaries are not input');
});

check('the evening summary reads today', () => {
  const f = summaryFixture();
  const ids = summaryWindow(Object.values(f), 'evening').map((e) => e.id).sort();
  eq(ids, ['a', 'b'], "today's events, in and out of business hours");
});

check('an evening event does not leak into tomorrow morning', () => {
  const f = summaryFixture();
  // Same events, read as if it were the next day: last night becomes fair game.
  const tomorrow = localDate(new Date(`${todayISO()}T12:00:00`).getTime() + 86400000);
  const ids = summaryWindow(Object.values(f), 'morning', { today: tomorrow }).map((e) => e.id).sort();
  eq(ids, ['a', 'b', 'c'], "yesterday evening's work is exactly what tomorrow's morning summary should stand on");
});

report('time');
