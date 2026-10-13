/**
 * standup-view.test.js — the Standup pane, rendered for real.
 *
 * standup.test.js proves the report is built correctly; this proves the pane actually
 * renders it and that the Copy button does the two things it promises — put the text
 * on the clipboard and record it in the log. Those are the failures a pure-logic test
 * cannot see: a view that throws on render, or a button wired to nothing.
 */
import './shim.js';
import { installFakeDOM } from './fake-dom.js';
import { check, checkAsync, eq, ok, report } from './shim.js';

installFakeDOM();

/* Clipboard writes are recorded rather than performed. */
const clipboard = { text: null };
globalThis.navigator = { clipboard: { writeText: async (t) => { clipboard.text = t; } } };

const { StandupView } = await import('../js/ui/standup.js');
const { todayISO } = await import('../js/store.js');

const TODAY = todayISO();
/* Local noon today: inside the local day whichever zone the suite runs in. */
const noonish = (h) => {
  const [y, m, d] = TODAY.split('-').map(Number);
  return new Date(y, m - 1, d, h, 0, 0).toISOString();
};

const task = (id, title, extra = {}) => ({
  id, title, status: 'todo', priority: 'normal', tags: [], notes: [],
  created: noonish(9), updated: noonish(9), done: null, deleted: false, private: false, ...extra,
});

/** An app double: the three things a view reads, and a record of what it staged. */
function fakeApp(tasks, events) {
  return {
    tasks,
    staged: [],
    refreshes: 0,
    settings: { sendNotes: true },
    endpoint: { kind: 'none' },
    onRules: false,
    state: { events, standups: {}, summaries: {}, lastEventTs: null },
    stage(...evs) { this.staged.push(...evs); },
    refresh() { this.refreshes++; },
    go() {},
  };
}

const workedDay = () => fakeApp(
  [
    task('T-aaa111', 'LLM-1064 mongodb driver', { tags: ['AI Assistant'], status: 'review' }),
    task('T-bbb222', 'the errand', { status: 'done' }),
  ],
  [
    { ts: noonish(10), type: 'task.status', taskId: 'T-aaa111', to: 'review' },
    { ts: noonish(11), type: 'task.note', taskId: 'T-aaa111', text: 'swapped the driver, tests still failing' },
    { ts: noonish(12), type: 'task.status', taskId: 'T-bbb222', to: 'done' },
  ],
);

const view = (app, kind = 'evening') => {
  const v = new StandupView(app);
  v.kind = kind;       // pinned, so the test does not depend on the wall clock
  return v;
};

check('the pane renders the report into an editable box', () => {
  const v = view(workedDay());
  const root = v.render();
  const box = root.find('textarea');
  ok(box, 'there must be a textarea to edit');
  eq(box.value, [
    'Signing off:',
    '',
    'AI Assistant',
    'swapped the driver, tests still failing',
    '',
    'Misc',
    'the errand',
  ].join('\n'));
});

check('typing in the box is what gets copied, and counts as an edit', () => {
  const v = view(workedDay());
  const box = v.render().find('textarea');
  box.value = 'Signing off:\n\nmy own words';
  box.dispatch('input');
  eq(v.draft, 'Signing off:\n\nmy own words');
  ok(v.touched, 'the view must know you wrote in the box');
});

check('changing the grouping of an untouched report just re-renders it', () => {
  const v = view(workedDay());
  const sel = v.render().find('select');
  sel.value = 'none';
  sel.dispatch('change');
  eq(v.group, 'none');
  ok(!v.draft.includes('AI Assistant'), `flat drops the headings: ${v.draft}`);
  ok(!v.optionsStale);
});

check('changing the layout does NOT silently discard what you wrote', () => {
  // The unforgivable version of this feature overwrites a report you typed by hand
  // because you nudged a dropdown.
  const v = view(workedDay());
  const root = v.render();
  const box = root.find('textarea');
  box.value = 'something I wrote myself';
  box.dispatch('input');

  const sel = root.find('select');
  sel.value = 'none';
  sel.dispatch('change');

  eq(v.draft, 'something I wrote myself', 'my text survives');
  ok(v.optionsStale, 'and the pane says the layout change is waiting');
  ok(v.render().findByText('Rebuild from log'), 'with the way to apply it on screen');
});

check('an empty day still renders, and says so', () => {
  const v = view(fakeApp([], []));
  const root = v.render();
  ok(root.find('textarea'), 'the box is still there to type into');
  ok(root.textContent.includes('Nothing is logged against today yet'), root.textContent);
});

check('the morning report is a greeting, with the plan behind a toggle', () => {
  const app = fakeApp([task('T-aaa111', 'the api', { tags: ['P'], status: 'in_progress' })], []);
  const v = view(app, 'morning');
  const root = v.render();
  eq(root.find('textarea').value, 'Morning');

  // Two checkboxes now: markdown, then the plan.
  const boxes = root.findAll('input').filter((n) => n.attrs.type === 'checkbox');
  eq(boxes.length, 2, 'markdown and the plan toggle');
  boxes[1].checked = true;
  boxes[1].dispatch('change');
  eq(v.draft, 'Morning\n\nP\nthe api');
});

await checkAsync('Copy puts the text on the clipboard and records it in the log', async () => {
  const app = workedDay();
  const v = view(app);
  v.render();
  await v.copy();

  ok(clipboard.text.startsWith('Signing off:'), `the clipboard gets the report: ${clipboard.text}`);
  eq(app.staged.length, 1, 'and exactly one event is staged');
  const e = app.staged[0];
  eq(e.type, 'standup.set');
  eq(e.date, TODAY);
  eq(e.kind, 'evening');
  eq(e.text, clipboard.text, 'the recorded text is the text that was copied');
});

await checkAsync('an edited report is recorded as edited, not as generated', async () => {
  const app = workedDay();
  const v = view(app);
  const box = v.render().find('textarea');
  box.value = 'Signing off:\n\nhand-written';
  box.dispatch('input');
  await v.copy();

  eq(app.staged[0].text, 'Signing off:\n\nhand-written');
  ok(v.touched, 'and copying does not make the pane forget you wrote it');
});

await checkAsync('a clipboard the browser refuses does not record a report that never went', async () => {
  const app = workedDay();
  const v = view(app);
  v.render();
  const real = globalThis.navigator;
  globalThis.navigator = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
  globalThis.document.execCommand = () => false;
  try {
    await v.copy();
  } finally {
    globalThis.navigator = real;
    globalThis.document.execCommand = () => true;
  }
  eq(app.staged.length, 0, 'nothing was copied, so nothing should claim it was sent');
});

check('the draft fills in when the log arrives after the first render', () => {
  // The real bug this caught: the first render happens before the repo has loaded, so
  // an empty report got frozen into the box and the pane sat there claiming nothing
  // had happened today while the board filled in behind it.
  const app = fakeApp([], []);
  const v = view(app);
  eq(v.render().find('textarea').value, 'Signing off:', 'nothing loaded yet');

  const loaded = workedDay();
  app.tasks = loaded.tasks;
  app.state = loaded.state;
  app.state.lastEventTs = loaded.state.events[loaded.state.events.length - 1].ts;

  const box = v.render().find('textarea');
  ok(box.value.includes('swapped the driver'), `the pane must pick up the loaded log: ${box.value}`);
});

check('but a log change does NOT overwrite what you typed', () => {
  const app = workedDay();
  const v = view(app);
  const box = v.render().find('textarea');
  box.value = 'mine';
  box.dispatch('input');

  app.state.lastEventTs = noonish(20);
  const after = v.render();
  eq(v.draft, 'mine', 'your text survives a log change');
  ok(after.textContent.includes('Your log has changed'), 'and the pane offers the rebuild instead');
});

await checkAsync('writing it up with the demo interpreter fills the box from the model path', async () => {
  const app = workedDay();
  app.endpoint = { kind: 'rules' };
  app.onRules = true;
  const v = view(app);
  v.render();
  await v.writeUp();
  ok(v.written, 'the model path should have produced groups');
  ok(v.draft.includes('AI Assistant'), v.draft);
  eq(v.error, null);
});

quit(report('standup view'));
