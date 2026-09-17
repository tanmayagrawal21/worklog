/**
 * bootstrap.js — get a first-time user from "no repo" to "working board".
 *
 * Everything here is gated on explicit confirmation in the UI: this module only
 * describes and performs work that the user has already agreed to. Nothing runs
 * on page load.
 *
 * There are three states a target repo can be in, and each needs different
 * handling:
 *   MISSING   — does not exist. Offer to create it (token permitting), or explain
 *               the two manual routes.
 *   EMPTY     — exists but has no commits, so no branch exists yet either. Needs
 *               a first commit via the contents API rather than the tree API.
 *   UNSEEDED  — has commits but no data/manifest.json. Add the scaffolding.
 *   READY     — has a manifest; just load it.
 */

import {
  makeEvent, newTaskId, todayISO, foldEvents, unionEvents, PATHS,
  serialiseMonth, renderMonthMd, renderYearReadme, renderChangelogIndex,
  renderLogReadme, renderBoardMd, renderBoardSnapshot, renderManifest,
} from './store.js';

export const RepoState = Object.freeze({
  MISSING: 'missing',
  EMPTY: 'empty',
  UNSEEDED: 'unseeded',
  READY: 'ready',
});

/** Inspect the repo without changing anything. */
export async function inspect(repo) {
  if (!(await repo.exists())) return { state: RepoState.MISSING };

  const info = await repo.info();
  if (!(await repo.hasCommits())) return { state: RepoState.EMPTY, info };

  const manifest = await repo.getFile('data/manifest.json');
  return { state: manifest ? RepoState.READY : RepoState.UNSEEDED, info };
}

/**
 * Example tasks so a new board is not an intimidating blank slate. They
 * demonstrate the statuses, tags, notes and priorities the AI understands, and
 * they are ordinary tasks the user can delete in one click.
 */
export function starterEvents() {
  const a = newTaskId(); const b = newTaskId(); const c = newTaskId();
  const at = (mins) => new Date(Date.now() - mins * 60000).toISOString();

  const events = [
    { ...makeEvent('task.create', { taskId: a, title: 'Read the AI summary each morning', status: 'in_progress', priority: 'normal', tags: ['habit'] }), ts: at(50) },
    { ...makeEvent('task.note',   { taskId: a, text: 'Summary is generated from this event log, so the more you log the better it gets.' }), ts: at(45) },
    { ...makeEvent('task.create', { taskId: b, title: 'Try the brain dump: type what you did, let AI update the board', status: 'todo', priority: 'high', tags: ['workflow'] }), ts: at(40) },
    { ...makeEvent('task.create', { taskId: c, title: 'Delete these examples once you get the idea', status: 'todo', priority: 'low', tags: ['setup'] }), ts: at(35) },
  ];
  return events;
}

/** A short README committed into the data repo so it explains itself later. */
function dataRepoReadme(appUrl, slug) {
  const month = todayISO().slice(0, 7);
  return `# Work log data

Task data for a personal work log. **This repo is the data, not the app.**

## Read it right here

You do not need to run anything, install anything, or set up an Action. Every page
below is committed markdown, so GitHub renders it — in a private repo too.

- **[Current board](${PATHS.boardMd})** — what is in flight, right now.
- **[Changelog](${PATHS.changelog})** — an index by year and month.
- **[This month](${PATHS.monthMd(month)})** — the day-by-day record.

## How it is laid out

\`\`\`
${PATHS.month(month)}      the append-only event log for one month -- the source of truth
${PATHS.monthMd(month)}        the same month rendered for reading
data/log/${month.slice(0, 4)}/README.md    that year's index, rendered when you open the folder
${PATHS.board}          a snapshot of the current board (generated)
${PATHS.boardMd}            the same snapshot, rendered
\`\`\`

One file per month means every diff is about a month of work rather than about your
whole history, so this stays readable however many years pile up.

## Reading your own history

\`\`\`sh
git log --oneline                                    # one entry per push
git log -p data/log/$(date +%Y)/$(date +%m).json     # this month's events, in detail
\`\`\`

The event JSON keeps one event per line on purpose: a new change is one added line.

## Editing

Open the app and point it at \`${slug}\`:

${appUrl}

Edits are staged in the browser and only committed when you press **Publish**, so
nothing reaches this repo without you asking for it. Hand-editing the JSON here
also works — the app reads whatever is committed.
`;
}

/**
 * Build the scaffolding commit. Pure: returns files for the caller to confirm and
 * commit, so the preview shown to the user is exactly what gets written.
 *
 * Deliberately writes the rendered pages too, not just the JSON. A repo whose first
 * commit already renders a board and a changelog is one you can hand to a colleague;
 * one containing only machine files is not.
 */
export function scaffoldFiles({ slug, appUrl = 'https://github.com', withExamples = true }) {
  const month = todayISO().slice(0, 7);
  const year = month.slice(0, 4);
  const events = unionEvents(withExamples ? starterEvents() : []);
  const { tasks } = foldEvents(events);
  const through = events[events.length - 1] || null;

  const stats = new Map([[month, {
    month,
    events: events.length,
    days: new Set(events.map((e) => e.ts.slice(0, 10))).size,
    updated: new Date().toISOString(),
  }]]);
  const statList = [...stats.values()];

  return {
    events,
    files: [
      { path: PATHS.manifest,         text: renderManifest(stats) },
      { path: PATHS.month(month),     text: serialiseMonth(month, events) },
      { path: PATHS.monthMd(month),   text: renderMonthMd(month, events, tasks) },
      { path: PATHS.yearReadme(year), text: renderYearReadme(year, statList) },
      { path: PATHS.logReadme,        text: renderLogReadme() },
      { path: PATHS.board,            text: renderBoardSnapshot(tasks, through) },
      { path: PATHS.boardMd,          text: renderBoardMd(tasks) },
      { path: PATHS.changelog,        text: renderChangelogIndex(statList) },
      { path: 'README.md',            text: dataRepoReadme(appUrl, slug) },
    ],
  };
}

/**
 * Create and/or seed the repo. Call only after the user confirms.
 * @param {object} opts.repo GitHubRepo instance
 * @param {'missing'|'empty'|'unseeded'} opts.state from inspect()
 */
export async function scaffold({ repo, state, isPrivate = true, withExamples = true, appUrl }) {
  if (state === RepoState.MISSING) {
    await repo.createRepo({ private: isPrivate, description: 'Personal work log (data)' });
  }

  const { files } = scaffoldFiles({ slug: repo.slug, appUrl, withExamples });
  const message = `worklog: initialise data repo\n\nScaffolding created by the work log app.\n`;

  // An empty or brand-new repo has no branch, so the first write must create one.
  if (state === RepoState.MISSING || state === RepoState.EMPTY || !(await repo.hasCommits())) {
    await repo.initialCommit(files, message);
  } else {
    await repo.commitFiles(files, message);
  }
  return { seeded: true };
}
