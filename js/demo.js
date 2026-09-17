/**
 * demo.js — a board you can look at before you own anything.
 *
 * The honest barrier to trying this app is not the UI, it is that the first screen
 * asks for a GitHub token and a repo. `?demo=1` skips both: a week of invented work
 * is folded into an in-memory repo, so a colleague can click a link and see the
 * board, the wiki and a summary before deciding whether to set anything up.
 *
 * The data goes through exactly the same path as real data -- rendered with the same
 * serialisers, read back with the same Store -- so the demo cannot drift into showing
 * something the app does not actually do. Writes throw, by construction: there is no
 * repo behind this and nothing to publish to.
 */
import {
  makeEvent, unionEvents, foldEvents, serialiseMonth, renderMonthMd, renderYearReadme,
  renderChangelogIndex, renderLogReadme, renderBoardMd, renderBoardSnapshot,
  renderManifest, todayISO, PATHS,
} from './store.js';

export const DEMO_SLUG = 'demo/work-log';

// Fixed ids, so the [[T-...]] cross-links in the notes below actually resolve. They
// match the same shape newTaskId() produces, which is what the wiki linkifier looks for.
const ID = {
  retry:   'T-9k2m4p', auth: 'T-4f9a2c', flake: 'T-7q1x8z', migrate: 'T-2w6e5r',
  docs:    'T-8t3y7u', oncall: 'T-5i9o1a', perf: 'T-3d8f6g', hiring: 'T-6h2j4k',
  metrics: 'T-1z5x9c', spike: 'T-0b7n3m',
};

/**
 * Timestamps are given as hours ago and then squeezed to fit inside the current
 * month, because the manifest and the changelog index are per-month: an event dated
 * into last month would be written into a month file this repo does not have. On the
 * 1st of a month the whole week compresses into that day, which looks busy but stays
 * correct.
 */
function clock() {
  const now = Date.now();
  const d = new Date(now);
  // Local month start, because that is the month file an event is written to.
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1, 0, 30).getTime();
  const room = (now - monthStart) / 3600000;
  const scale = Math.min(1, room / 170);
  return (hoursAgo) => new Date(now - hoursAgo * scale * 3600000).toISOString();
}

/** A week of plausible backend work: things in flight, a blocker, and finished items. */
export function demoEvents() {
  const at = clock();
  const ev = (hoursAgo, type, payload) => ({ ...makeEvent(type, payload), ts: at(hoursAgo) });
  const task = (hoursAgo, taskId, title, status, priority, tags) =>
    ev(hoursAgo, 'task.create', { taskId, title, status, priority, tags });

  return unionEvents([
    task(168, ID.retry, 'Retry logic for the ingest worker', 'done', 'high', ['ingest', 'reliability']),
    ev(160, 'task.note', { taskId: ID.retry, text: 'Exponential backoff with jitter. Capped at 5 attempts; anything past that goes to the dead-letter queue.' }),
    ev(96, 'task.note', { taskId: ID.retry, text: 'Shipped. Error rate on the ingest path dropped from 2.1% to 0.3% overnight.' }),
    ev(95, 'task.status', { taskId: ID.retry, from: 'review', to: 'done' }),

    task(150, ID.auth, 'Auth review for the new service', 'blocked', 'urgent', ['security', 'review']),
    ev(120, 'task.note', { taskId: ID.auth, text: 'Waiting on the security team. This is what is holding [[T-2w6e5r]] — the migration cannot ship until the review lands.' }),
    ev(20, 'task.note', { taskId: ID.auth, text: 'Chased in standup. Told to expect feedback Thursday.' }),

    task(144, ID.migrate, 'Migrate ingest to the new auth flow', 'in_progress', 'high', ['ingest', 'security']),
    ev(140, 'task.note', { taskId: ID.migrate, text: 'Behind a flag so it can go out dark. Blocked on the review in [[T-4f9a2c]].' }),
    ev(18, 'task.note', { taskId: ID.migrate, text: 'Wrote the fallback path: on a token error it falls back to the old flow and logs loudly rather than dropping the batch.' }),

    task(130, ID.flake, 'Flaky test in the scheduler suite', 'in_progress', 'normal', ['tests']),
    ev(30, 'task.note', { taskId: ID.flake, text: 'Not flaky — it depends on wall-clock ordering and fails on a fast machine. Reproduces every time under --repeat 50.' }),

    task(120, ID.perf, 'Profile the slow dashboard query', 'review', 'normal', ['performance']),
    ev(40, 'task.note', { taskId: ID.perf, text: 'One missing index on (org_id, created_at). 4.2s to 90ms. PR up.' }),
    ev(39, 'task.status', { taskId: ID.perf, from: 'in_progress', to: 'review' }),

    task(110, ID.metrics, 'Add ingest latency to the dashboard', 'done', 'low', ['observability']),
    ev(100, 'task.status', { taskId: ID.metrics, from: 'in_progress', to: 'done' }),

    task(90, ID.docs, 'Write up the ingest runbook', 'todo', 'normal', ['docs', 'ingest']),
    ev(88, 'task.note', { taskId: ID.docs, text: 'Should cover the dead-letter queue from [[T-9k2m4p]]: how to inspect it and how to replay.' }),

    task(80, ID.oncall, 'On-call handover notes', 'todo', 'high', ['oncall']),
    task(60, ID.hiring, 'Review two take-home submissions', 'backlog', 'normal', ['hiring']),
    task(50, ID.spike, 'Spike: is the queue the right shape for fan-out?', 'backlog', 'low', ['ingest', 'spike']),

    ev(4, 'summary.set', {
      date: todayISO(),
      kind: 'morning',
      model: 'demo',
      summary: {
        headline: 'Ingest migration is moving; the auth review is the only real blocker.',
        bullets: [
          { text: 'Retry logic shipped — ingest errors down from 2.1% to 0.3%.', taskIds: [ID.retry] },
          { text: 'Migration is flag-gated with a fallback, but cannot ship until the security review lands.', taskIds: [ID.migrate, ID.auth] },
          { text: 'Dashboard query fix is in review: one index, 4.2s to 90ms.', taskIds: [ID.perf] },
          { text: 'Scheduler test turned out to be an ordering assumption, not flake.', taskIds: [ID.flake] },
        ],
        risks: ['The auth review has slipped twice; the migration is idle until it lands.'],
        next: ['Chase the review, then write the ingest runbook while the flag is still dark.'],
      },
    }),
  ]);
}

/**
 * A repo-shaped object over an in-memory file map. Same three members the Store uses
 * against the real thing, so nothing in the Store needs to know this is a demo.
 */
export function demoRepo({ appUrl = 'https://github.com' } = {}) {
  const events = demoEvents();
  const { tasks } = foldEvents(events);
  const through = events[events.length - 1] || null;
  const month = todayISO().slice(0, 7);
  const year = month.slice(0, 4);
  const stats = new Map([[month, {
    month,
    events: events.length,
    days: new Set(events.map((e) => e.ts.slice(0, 10))).size,
    updated: new Date().toISOString(),
  }]]);
  const statList = [...stats.values()];

  const files = new Map([
    [PATHS.manifest, renderManifest(stats)],
    [PATHS.month(month), serialiseMonth(month, events)],
    [PATHS.monthMd(month), renderMonthMd(month, events, tasks)],
    [PATHS.yearReadme(year), renderYearReadme(year, statList)],
    [PATHS.logReadme, renderLogReadme()],
    [PATHS.board, renderBoardSnapshot(tasks, through)],
    [PATHS.boardMd, renderBoardMd(tasks)],
    [PATHS.changelog, renderChangelogIndex(statList)],
  ]);

  return {
    owner: 'demo',
    repo: 'work-log',
    slug: DEMO_SLUG,
    branch: 'main',
    demo: true,
    appUrl,
    async getFile(path) {
      const text = files.get(path);
      return text == null ? null : { text, sha: null };
    },
    async commitFiles() {
      throw new Error('This is the demo, so there is no repo to publish to. Open Settings to point the app at one of your own.');
    },
  };
}
