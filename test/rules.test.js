/**
 * rules.test.js — the demo interpreter.
 *
 * It stands in for a model in ?demo=1, which means a newcomer's first impression of
 * "does this propose sensible changes" is formed here. Two properties matter more than
 * cleverness: it must not attach an update to the wrong task, and its proposals must
 * survive sanitiseOperations() unchanged — a proposal the sanitiser drops is a review
 * row that silently does nothing.
 */
import { check, eq, ok, report } from './shim.js';
import { ruleOperations, ruleSummary, matchTask } from '../js/rules.js';
import { sanitiseOperations, opsToEvents } from '../js/ai.js';
import { statusLabel } from '../js/store.js';

const board = [
  { id: 'T-retry', title: 'Retry logic for the ingest worker', status: 'review', priority: 'high', tags: ['ingest', 'reliability'], notes: [] },
  { id: 'T-auth', title: 'Auth review for the new service', status: 'in_progress', priority: 'urgent', tags: ['security'], notes: [{ text: 'chased in standup' }] },
  { id: 'T-flake', title: 'Flaky test in the scheduler suite', status: 'todo', priority: 'normal', tags: ['tests'], notes: [] },
  { id: 'T-docs', title: 'Write up the ingest runbook', status: 'todo', priority: 'low', tags: ['docs', 'ingest'], notes: [] },
];

const opsFor = (text) => ruleOperations({ tasks: board, text });
const find = (ops, op, taskId) => ops.find((o) => o.op === op && o.taskId === taskId);

print('\n--- matching a line to a task ---');

check('a line matches the task it is obviously about', () => {
  eq(matchTask('finished the retry logic, error rate down', board).task.id, 'T-retry');
  eq(matchTask('the flaky scheduler test is not flaky', board).task.id, 'T-flake');
});

check('an explicit task id wins outright', () => {
  eq(matchTask('poked at T-docs again', board).task.id, 'T-docs');
});

check('a line about nothing on the board matches nothing', () => {
  eq(matchTask('had a long conversation about hiring', board), null);
});

check('one incidental word is not a match', () => {
  // "service" alone appears in the auth title, but a single weak hit must not claim it,
  // or every line mentioning a service would land on that task.
  eq(matchTask('restarted the service', board), null);
});

print('\n--- text to proposed operations ---');

check('finished work moves to done', () => {
  const ops = opsFor('Finished the retry logic and the error rate dropped overnight.');
  const move = find(ops, 'status', 'T-retry');
  ok(move, 'a status change was proposed');
  eq(move.status, 'done');
});

check('a blocker moves the task and keeps the reason as a note', () => {
  const ops = opsFor('Auth review is blocked, still waiting on the security team.');
  eq(find(ops, 'status', 'T-auth').status, 'blocked');
  ok(find(ops, 'note', 'T-auth'), 'the reason is kept as a note, which is the useful half');
});

check('"pushed it for review" beats the "finished" in the same line', () => {
  // Both cues are present; review is the more precise claim about where the work is.
  const ops = ruleOperations({
    tasks: [{ ...board[0], status: 'in_progress' }],
    text: 'Finished the retry logic and pushed it for review.',
  });
  eq(find(ops, 'status', 'T-retry').status, 'review');
});

check('an unrecognised line becomes a new task, not a note on the wrong one', () => {
  const ops = opsFor('New: need to write up the migration plan before Thursday.');
  const made = ops.find((o) => o.op === 'create');
  ok(made, 'a task was proposed');
  eq(made.title, 'Write up the migration plan before Thursday', 'the "new: need to" scaffolding is stripped');
  eq(made.priority, 'high', 'a named weekday deadline reads as high priority');
  ok(!ops.some((o) => o.taskId === 'T-docs'), 'and it did not attach itself to the runbook task');
});

check('a status that is already correct is not proposed again', () => {
  const ops = opsFor('Still working on the auth review.');
  eq(find(ops, 'status', 'T-auth'), undefined, 'auth is already in progress');
  ok(find(ops, 'note', 'T-auth'), 'but the update is worth a note');
});

check('several lines produce several tasks worth of operations', () => {
  const ops = opsFor(`Finished the retry logic and pushed it for review.
Started looking at the flaky integration test — it only fails on CI, still digging.
Blocked on the staging credentials from platform.
New: need to write up the migration plan before Thursday.`);
  ok(new Set(ops.map((o) => o.taskId || o.title)).size >= 4, 'at least four subjects touched');
  eq(find(ops, 'status', 'T-flake').status, 'in_progress');
});

check('the same note is not proposed twice for one task', () => {
  const line = 'Blocked on the security review for auth.';
  const ops = ruleOperations({ tasks: board, text: `${line}\n${line}` });
  eq(ops.filter((o) => o.op === 'note' && o.taskId === 'T-auth').length, 1);
});

check('nothing recognisable proposes nothing', () => {
  eq(opsFor('ok'), []);
});

print('\n--- proposals survive the real path ---');

check('every proposal survives sanitiseOperations', () => {
  const ops = opsFor(`Finished the retry logic and pushed it for review.
Blocked on the staging credentials from platform.
Started digging into the flaky scheduler test.`);
  const clean = sanitiseOperations(ops, board);
  eq(clean.length, ops.length, 'a dropped proposal would be a review row that does nothing');
});

check('approved proposals become events', () => {
  const events = opsToEvents(sanitiseOperations(opsFor('Finished the retry logic.'), board));
  ok(events.length >= 1);
  ok(events.every((e) => e.id && e.ts && e.type.startsWith('task.')), 'real events, same as a model\'s');
});

print('\n--- composed summaries ---');

const evening = [
  { type: 'task.status', taskId: 'T-retry', to: 'done' },
  { type: 'task.note', taskId: 'T-retry', text: 'Error rate 2.1% to 0.3%.' },
  { type: 'task.note', taskId: 'T-auth', text: 'Chased in standup.' },
];

check('an evening summary counts what actually moved', () => {
  const s = ruleSummary({ tasks: board, events: evening, kind: 'evening' });
  ok(/1 finished/.test(s.headline), `headline says one finished: ${s.headline}`);
  ok(s.bullets.length >= 2 && s.bullets[0].taskIds.length === 1, 'bullets point at tasks');
  ok(s.bullets.every((b) => b.text), 'no empty bullets');
});

check('an empty day says so rather than inventing activity', () => {
  eq(ruleSummary({ tasks: board, events: [], kind: 'evening' }).headline, 'Nothing logged today.');
});

check('a morning summary describes standing state and flags what has not moved', () => {
  const withBlocker = board.map((t) => (t.id === 'T-auth' ? { ...t, status: 'blocked' } : t));
  const s = ruleSummary({ tasks: withBlocker, events: [], kind: 'morning' });
  ok(/1 blocked/.test(s.headline), `headline reports the blocker: ${s.headline}`);
  ok(s.risks.some((r) => r.includes('Auth review')), 'the blocked task is a risk');
  ok(s.risks.some((r) => r.includes('chased in standup')), 'and carries its last note');
  ok(s.bullets.some((b) => /no activity/.test(b.text)), 'a task with nothing in the window is called out');
});

check('next points at the most urgent open work, with its status spelled out', () => {
  const s = ruleSummary({ tasks: board, events: evening, kind: 'morning' });
  ok(s.next.length && s.next[0].includes('Auth review'), `urgent first: ${JSON.stringify(s.next)}`);
  ok(s.next[0].includes(statusLabel('in_progress')), 'says where it is');
  ok(s.next.length <= 3, 'at most three');
});

check('bullets never reference a task the board does not have', () => {
  const s = ruleSummary({ tasks: board, events: [{ type: 'task.note', taskId: 'T-gone', text: 'x' }], kind: 'evening' });
  ok(s.bullets.every((b) => b.taskIds.every((id) => board.some((t) => t.id === id))), 'no dead task refs');
});

globalThis.exitCode = report('rules');
