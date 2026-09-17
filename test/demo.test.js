import { check, checkAsync, eq, ok, report } from './shim.js';
import { demoEvents, demoRepo, DEMO_SLUG } from '../js/demo.js';
import { Store, foldEvents, STATUSES, todayISO } from '../js/store.js';

print('\n--- demo data ---');

check('every demo event lands inside the current month', () => {
  // The manifest and changelog index are per-month, and the demo only writes one
  // month file. An event dated into last month would be unreadable.
  const month = todayISO().slice(0, 7);
  for (const e of demoEvents()) eq(e.ts.slice(0, 7), month, `event ${e.type} dated ${e.ts}`);
});

check('demo events are ordered oldest to newest', () => {
  const events = demoEvents();
  for (let i = 1; i < events.length; i++) ok(events[i - 1].ts <= events[i].ts, `out of order at ${i}`);
});

check('the demo board fills most of the columns', () => {
  const { tasks } = foldEvents(demoEvents());
  const used = new Set([...tasks.values()].filter((t) => !t.deleted).map((t) => t.status));
  ok(used.size >= 5, `only ${used.size} of ${STATUSES.length} columns used`);
  for (const s of used) ok(STATUSES.some((x) => x.id === s), `unknown status ${s}`);
});

check('every [[T-...]] reference in a demo note resolves to a real task', () => {
  // Dead cross-links in the demo would show a colleague the wiki failing to do the
  // one thing the wiki is for.
  const events = demoEvents();
  const { tasks } = foldEvents(events);
  let found = 0;
  for (const e of events) {
    if (e.type !== 'task.note') continue;
    for (const m of String(e.text).matchAll(/\[\[(T-[0-9a-z]{6})\]\]/g)) {
      found++;
      ok(tasks.has(m[1]), `note on ${e.taskId} links to missing ${m[1]}`);
    }
  }
  ok(found >= 2, `expected cross-links in the demo notes, found ${found}`);
});

check('the demo ships a summary for today, with bullets that point at real tasks', () => {
  const events = demoEvents();
  const { tasks, summaries } = foldEvents(events);
  const today = summaries[todayISO()];
  ok(today && today.morning, 'no morning summary for today');
  ok(today.morning.headline, 'summary has no headline');
  ok(today.morning.bullets.length >= 3, 'summary is thin');
  for (const b of today.morning.bullets) {
    for (const id of b.taskIds || []) ok(tasks.has(id), `summary bullet points at missing ${id}`);
  }
});

print('\n--- demo repo ---');

await checkAsync('a real Store loads the demo repo into the demo board', async () => {
  const store = new Store(demoRepo());
  await store.load();
  const live = [...store.state.tasks.values()].filter((t) => !t.deleted);
  eq(store.repo.slug, DEMO_SLUG);
  eq(live.length, [...foldEvents(demoEvents()).tasks.values()].length);
  // The Store exposes folded state; the raw events live on remoteEvents (app.state
  // is what stitches the two together for the UI).
  ok(store.remoteEvents.length >= 20, `only ${store.remoteEvents.length} events loaded`);
  ok(live.some((t) => t.notes.length), 'no notes survived the round trip');
});

await checkAsync('the demo refuses to publish rather than pretending to', async () => {
  const store = new Store(demoRepo());
  await store.load();
  let threw = null;
  try {
    await store.repo.commitFiles([{ path: 'x', text: 'y' }], 'nope');
  } catch (e) { threw = e; }
  ok(threw, 'commitFiles resolved; the demo would look like it saved');
  ok(/demo/i.test(threw.message), `unhelpful message: ${threw.message}`);
});

quit(report('demo.js'));
