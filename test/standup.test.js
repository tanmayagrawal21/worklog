/**
 * standup.test.js — the morning and sign-off reports.
 *
 * What is pinned here is the shape of the output, because that shape is the whole
 * feature: these reports go to a team channel, and the ways they can be wrong are
 * all silent. A line that reads like a backlog entry, a status label nobody writes,
 * an internal task id, a private task — every one of those is only noticed after it
 * has been pasted.
 */
import './shim.js';
import { check, eq, ok, report } from './shim.js';
import {
  buildReport, renderReport, renderGroups, groupsOf, modelPayload, reportSize,
  standupEvent, UNGROUPED,
} from '../js/standup.js';

/* A fixed day, built in local time so the local-date filter is actually exercised. */
const DAY = '2026-10-13';
const at = (h, m = 0) => new Date(2026, 9, 13, h, m, 0).toISOString();
const yesterday = (h) => new Date(2026, 9, 12, h, 0, 0).toISOString();

const task = (id, title, extra = {}) => ({
  id, title, status: 'todo', priority: 'normal', tags: [], notes: [],
  created: at(9), updated: at(9), done: null, deleted: false, private: false, ...extra,
});

const moved = (taskId, to, ts) => ({ ts, type: 'task.status', taskId, to });
const noted = (taskId, text, ts) => ({ ts, type: 'task.note', taskId, text });
const made = (taskId, ts) => ({ ts, type: 'task.create', taskId });

const build = (tasks, events, o = {}) => buildReport({ tasks, events, date: DAY, ...o });

console.log('--- what a line says ---');

check('your note is the line, because the note is what you did', () => {
  // The title is how you described the work when you filed it; the note is what
  // happened. "Fixed tcp buffer setting bugs" is a report; "tcp buffer bugs" is a
  // backlog entry. So the note wins whenever there is one.
  const r = build([task('T-1', 'Flaky test in the scheduler suite', { tags: ['tests'] })],
    [noted('T-1', 'Injected the clock instead of sleeping on it. Green under --repeat 200.', at(14))]);
  eq(r.items[0].text, 'Injected the clock instead of sleeping on it. Green under --repeat 200');
});

check('the title is the fallback for work you moved without writing anything down', () => {
  const r = build([task('T-1', 'On-call handover notes', { tags: ['oncall'] })], [moved('T-1', 'done', at(16))]);
  eq(r.items[0].text, 'On-call handover notes');
});

check('no status vocabulary anywhere — nobody writes their day that way', () => {
  const tasks = ['done', 'review', 'in_progress', 'blocked', 'todo'].map((s, i) => task(`T-${i}`, `thing ${i}`, { tags: ['P'], status: s }));
  const events = ['done', 'review', 'in_progress', 'blocked', 'todo'].map((s, i) => moved(`T-${i}`, s, at(10 + i)));
  const text = renderReport(build(tasks, events), {});
  for (const word of ['Done', 'In progress', 'In review', 'Blocked', 'Status']) {
    ok(!text.includes(word), `"${word}" must not appear as a label:\n${text}`);
  }
  eq(text, 'Signing off:\n\nP\nthing 0\nthing 1\nthing 2\nthing 3\nthing 4');
});

check('one line per task, however many events it had', () => {
  const r = build([task('T-1', 'the migration', { tags: ['DE'] })], [
    moved('T-1', 'in_progress', at(10)),
    noted('T-1', 'swapped the driver', at(11)),
    noted('T-1', 'tests still failing', at(15)),
    moved('T-1', 'review', at(17)),
  ]);
  eq(r.items.length, 1, 'one item for one task');
  eq(r.items[0].text, 'swapped the driver; tests still failing');
});

check('a note is a fragment, so its full stop goes', () => {
  const r = build([task('T-1', 'x', { tags: ['P'] })], [
    noted('T-1', 'merged it.', at(12)),
    noted('T-1', 'still digging...', at(13)),
  ]);
  eq(r.items[0].text, 'merged it; still digging...',
    'a lone period is prose punctuation; an ellipsis is deliberate and stays');
});

check('a multi-line note becomes one line — this is going into a chat window', () => {
  const r = build([task('T-1', 'x', { tags: ['P'] })], [noted('T-1', 'line one\n\nline two', at(12))]);
  eq(r.items[0].text, 'line one line two');
});

console.log('--- what must never go in one ---');

check('internal task ids never appear in the text', () => {
  const tasks = [task('T-abc123', 'the work', { tags: ['P'] })];
  const r = build(tasks, [moved('T-abc123', 'done', at(16))]);
  const text = renderReport(r, {});
  ok(!text.includes('T-abc123'), `"T-abc123" means nothing to your team, and leaked: ${text}`);
  eq(r.items[0].taskId, 'T-abc123', 'but the item still carries it, for the UI to link with');
});

check('a private task is excluded entirely', () => {
  const r = build([task('T-1', 'the salary review', { tags: ['HR'], private: true })], [moved('T-1', 'done', at(16))]);
  eq(reportSize(r), 0);
  ok(r.empty, 'and the report knows it is empty');
});

check('a deleted task is not news', () => {
  const r = build([task('T-1', 'mistake', { tags: ['P'], deleted: true })], [moved('T-1', 'done', at(16))]);
  eq(reportSize(r), 0);
});

check('yesterday stays in yesterday', () => {
  const r = build([task('T-1', 'the work', { tags: ['P'] })], [
    noted('T-1', 'yesterday\'s note', yesterday(16)),
    noted('T-1', 'today\'s note', at(10)),
  ]);
  eq(reportSize(r), 1);
  eq(r.items[0].text, 'today\'s note', 'yesterday\'s words must not turn up in today\'s report');
});

check('bookkeeping is not reported', () => {
  const r = build([task('T-1', 'x', { tags: ['P'] })], [
    { ts: at(10), type: 'task.edit', taskId: 'T-1', fields: { priority: 'high' } },
    { ts: at(11), type: 'summary.set', date: DAY, kind: 'evening', summary: { headline: 'h' } },
  ]);
  eq(reportSize(r), 0, 'retagging a card is not something you tell the team about');
});

console.log('--- grouping ---');

const twoProjects = () => build(
  [task('T-1', 'the api', { tags: ['AI Assistant'] }), task('T-2', 'the docs', { tags: ['AI Verde'] })],
  [moved('T-1', 'done', at(10)), moved('T-2', 'done', at(11))],
);

check('a project word, then the lines under it', () => {
  eq(renderReport(twoProjects(), { group: 'project' }),
    'Signing off:\n\nAI Assistant\nthe api\n\nAI Verde\nthe docs');
});

check('flat drops the headings and keeps the order', () => {
  eq(renderReport(twoProjects(), { group: 'none' }), 'Signing off:\n\nthe api\nthe docs');
});

check('markdown is a separate switch, not a separate grouping', () => {
  eq(renderReport(twoProjects(), { group: 'project', markdown: true }),
    'Signing off:\n\n## AI Assistant\n\n- the api\n\n## AI Verde\n\n- the docs');
  eq(renderReport(twoProjects(), { group: 'none', markdown: true }),
    'Signing off:\n\n- the api\n- the docs');
});

check('the busiest project comes first, ties broken by name', () => {
  const tasks = [
    task('T-1', 'a', { tags: ['Zebra'] }),
    task('T-2', 'b', { tags: ['Alpha'] }),
    task('T-3', 'c', { tags: ['Alpha'] }),
  ];
  const r = build(tasks, [moved('T-1', 'done', at(10)), moved('T-2', 'done', at(11)), moved('T-3', 'done', at(12))]);
  eq(groupsOf(r, 'project').map((g) => g.project), ['Alpha', 'Zebra']);
});

check('within a project, the order you did them', () => {
  const tasks = [task('T-1', 'first', { tags: ['P'] }), task('T-2', 'second', { tags: ['P'] })];
  const r = build(tasks, [moved('T-2', 'done', at(15)), moved('T-1', 'done', at(9))]);
  eq(groupsOf(r, 'project')[0].lines, ['first', 'second']);
});

check('untagged work gets a home rather than being dropped', () => {
  const r = build([task('T-1', 'the errand')], [moved('T-1', 'done', at(10))]);
  eq(groupsOf(r, 'project')[0].project, UNGROUPED);
});

check('only the first tag decides the project', () => {
  const r = build([task('T-1', 'x', { tags: ['AI Verde', 'infra', 'urgent'] })], [moved('T-1', 'done', at(10))]);
  eq(groupsOf(r, 'project')[0].project, 'AI Verde');
});

console.log('--- the first line, and your own ---');

check('your own line sits under the first line, before the work', () => {
  const text = renderReport(twoProjects(), { preamble: 'Signing off early', note: 'dentist at 3' });
  ok(text.startsWith('Signing off early\n\ndentist at 3\n'), text);
});

check('an empty preamble omits the line rather than leaving a blank one', () => {
  eq(renderReport(twoProjects(), { preamble: '' }), 'AI Assistant\nthe api\n\nAI Verde\nthe docs');
});

check('a morning report is a greeting by default', () => {
  const r = build([task('T-1', 'x', { tags: ['P'], status: 'in_progress' })], [], { kind: 'morning' });
  eq(reportSize(r), 0, 'the plan is opt-in');
  eq(renderReport(r, {}), 'Morning');
});

check('the morning plan, when asked for, is what is in flight', () => {
  const tasks = [
    task('T-1', 'the api', { tags: ['P'], status: 'in_progress', updated: at(9) }),
    task('T-2', 'the creds', { tags: ['P'], status: 'blocked', updated: at(10) }),
    task('T-3', 'later', { tags: ['P'], status: 'todo' }),
    task('T-4', 'done already', { tags: ['P'], status: 'done' }),
  ];
  const r = build(tasks, [], { kind: 'morning', includePlan: true });
  eq(r.items.map((i) => i.text), ['the api', 'the creds'], 'in progress and blocked only — a backlog is not a plan');
});

check('an empty day renders as just the first line', () => {
  const r = build([], []);
  ok(r.empty);
  eq(renderReport(r, {}), 'Signing off:');
});

console.log('--- the model path: what it is shown, and how its answer is laid out ---');

check('the payload carries the work and never the task id', () => {
  const r = build([task('T-abc123', 'the api', { tags: ['AI Verde'] })], [noted('T-abc123', 'fixed the retry', at(10))]);
  eq(modelPayload(r), [{ project: 'AI Verde', task: 'the api', didToday: 'fixed the retry' }]);
  ok(!JSON.stringify(modelPayload(r)).includes('T-abc123'), 'no internal ids in the prompt');
});

check('notes can be withheld from the model, per Settings', () => {
  const r = build([task('T-1', 'the api', { tags: ['P'] })], [noted('T-1', 'something confidential', at(10))]);
  eq(modelPayload(r, { includeNotes: false }), [{ project: 'P', task: 'the api' }],
    'titles and tags only when note text is switched off');
});

check('model-written groups go through the same layout as the log-built ones', () => {
  const groups = [{ project: 'AI Verde', lines: ['Fixed the retry on reconnect', 'added the new model ids'] }];
  eq(renderGroups(groups, { kind: 'evening' }),
    'Signing off:\n\nAI Verde\nFixed the retry on reconnect\nadded the new model ids');
  eq(renderGroups(groups, { kind: 'evening', markdown: true, preamble: 'EOD' }),
    'EOD\n\n## AI Verde\n\n- Fixed the retry on reconnect\n- added the new model ids');
});

check('an empty group is skipped rather than leaving a dangling heading', () => {
  eq(renderGroups([{ project: 'A', lines: [] }, { project: 'B', lines: ['x'] }], { kind: 'evening' }),
    'Signing off:\n\nB\nx');
});

console.log('--- the event it records ---');

check('the recorded event reuses existing event fields', () => {
  const e = standupEvent({ date: DAY, kind: 'evening', text: 'Signing off:\n\nx', style: 'project' });
  eq(e.type, 'standup.set');
  eq(e.date, DAY);
  eq(e.kind, 'evening');
  eq(e.text, 'Signing off:\n\nx');
  eq(e.style, 'project');
  ok(e.ts && e.id, 'and it is a normal event, with a timestamp and an id');
  ok(!('taskId' in e), 'a report is about a day, not a task');
});

quit(report('standup.js'));
