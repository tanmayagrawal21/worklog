/**
 * ai.test.js — the parts of the AI layer that must not trust the model.
 *
 * The network is never touched (test/shim.js makes fetch throw), so these cover the
 * pure functions: what leaves the browser (boardPayload), what survives model output
 * (sanitiseOperations, parseJSONLoose), and what becomes an event (opsToEvents).
 */
import './shim.js';
import { check, checkAsync, eq, ok, report } from './shim.js';
import { boardPayload, sanitiseOperations, parseJSONLoose, opsToEvents, summaryEvent, refusedParam, summarise } from '../js/ai.js';
import { foldEvents } from '../js/store.js';

const task = (over = {}) => ({
  id: 'T-aaaaaa', title: 'Fix the parser', status: 'todo', priority: 'normal',
  tags: ['compiler'], private: false, notes: [], deleted: false, ...over,
});

console.log('--- what leaves the browser ---');

check('private tasks are never sent to the provider', () => {
  const out = boardPayload([task(), task({ id: 'T-secret', title: 'Salary review', private: true })]);
  eq(out.length, 1, 'only the non-private task');
  eq(out[0].id, 'T-aaaaaa');
  ok(!JSON.stringify(out).includes('Salary'), 'private title must not appear anywhere in the payload');
});

check('deleted tasks are not sent either', () => {
  eq(boardPayload([task({ deleted: true })]).length, 0);
});

check('notes can be withheld globally', () => {
  const t = [task({ notes: [{ ts: 'x', text: 'internal detail' }] })];
  ok(JSON.stringify(boardPayload(t, { includeNotes: true })).includes('internal detail'), 'included when allowed');
  ok(!JSON.stringify(boardPayload(t, { includeNotes: false })).includes('internal detail'), 'withheld when off');
});

check('only the newest few notes are sent', () => {
  const notes = Array.from({ length: 10 }, (_, i) => ({ ts: 'x', text: `n${i}` }));
  const [p] = boardPayload([task({ notes })], { noteLimit: 3 });
  eq(p.recentNotes, ['n7', 'n8', 'n9'], 'last three, in order');
});

console.log('--- model output is untrusted ---');

check('hallucinated task ids are dropped', () => {
  const ops = sanitiseOperations([
    { op: 'status', taskId: 'T-nope', status: 'done', rationale: 'r' },
    { op: 'note', taskId: 'T-alsonope', text: 'hi', rationale: 'r' },
  ], [task()]);
  eq(ops.length, 0, 'nothing referencing an unknown task survives');
});

check('invalid enums are rejected, not coerced onto the board', () => {
  const ops = sanitiseOperations([{ op: 'status', taskId: 'T-aaaaaa', status: 'shipped', rationale: 'r' }], [task()]);
  eq(ops.length, 0, '"shipped" is not a real status');
});

check('a status change to the status it already has is a no-op', () => {
  const ops = sanitiseOperations([{ op: 'status', taskId: 'T-aaaaaa', status: 'todo', rationale: 'r' }], [task()]);
  eq(ops.length, 0);
});

check('a valid status change carries the from-state for the changelog', () => {
  const [op] = sanitiseOperations([{ op: 'status', taskId: 'T-aaaaaa', status: 'in_progress', rationale: 'r' }], [task()]);
  eq(op.from, 'todo');
  eq(op.status, 'in_progress');
  eq(op.targetTitle, 'Fix the parser', 'review UI needs the title');
});

check('create needs a title; bad priority falls back rather than corrupting', () => {
  const ops = sanitiseOperations([
    { op: 'create', title: '   ', rationale: 'r' },
    { op: 'create', title: 'New work', priority: 'catastrophic', status: 'nonsense', rationale: 'r' },
  ], []);
  eq(ops.length, 1, 'the blank-title create is dropped');
  eq(ops[0].priority, 'normal');
  eq(ops[0].status, 'todo');
});

check('edits that change nothing are dropped', () => {
  const ops = sanitiseOperations([
    { op: 'edit', taskId: 'T-aaaaaa', title: 'Fix the parser', priority: 'normal', tags: ['compiler'], rationale: 'r' },
  ], [task()]);
  eq(ops.length, 0, 'identical fields are not a change');
});

check('edits keep only the fields that actually differ', () => {
  const [op] = sanitiseOperations([
    { op: 'edit', taskId: 'T-aaaaaa', title: 'Fix the parser', priority: 'urgent', tags: ['compiler'], rationale: 'r' },
  ], [task()]);
  eq(Object.keys(op.fields), ['priority'], 'unchanged title and tags are not restated');
  eq(op.fields.priority, 'urgent');
});

check('unknown operation types and junk entries are ignored', () => {
  const ops = sanitiseOperations([null, 'nope', { op: 'drop_database', taskId: 'T-aaaaaa' }, 42], [task()]);
  eq(ops.length, 0);
});

check('sanitise tolerates a non-array', () => {
  eq(sanitiseOperations(undefined, [task()]).length, 0);
  eq(sanitiseOperations({ operations: [] }, [task()]).length, 0);
});

console.log('--- parsing what the model actually returns ---');

check('plain JSON parses', () => {
  eq(parseJSONLoose('{"a":1}').a, 1);
});

check('fenced JSON parses', () => {
  eq(parseJSONLoose('```json\n{"a":1}\n```').a, 1);
});

check('JSON wrapped in prose parses', () => {
  eq(parseJSONLoose('Sure! Here you go:\n{"a":1}\nHope that helps.').a, 1);
});

check('unparseable output raises a clear error rather than returning junk', () => {
  let msg = '';
  try { parseJSONLoose('I cannot do that.'); } catch (e) { msg = e.message; }
  ok(/did not return usable JSON/.test(msg), `helpful message, got: ${msg}`);
});

console.log('--- approved operations become events ---');

check('each operation type maps to the right event', () => {
  const ops = sanitiseOperations([
    { op: 'create', title: 'Write the docs', status: 'todo', priority: 'high', tags: ['docs'], rationale: 'r' },
    { op: 'status', taskId: 'T-aaaaaa', status: 'done', rationale: 'r' },
    { op: 'note', taskId: 'T-aaaaaa', text: 'landed the fix', rationale: 'r' },
    { op: 'edit', taskId: 'T-aaaaaa', priority: 'urgent', rationale: 'r' },
  ], [task()]);
  eq(ops.length, 4, 'all four are valid');

  const evs = opsToEvents(ops);
  eq(evs.map((e) => e.type), ['task.create', 'task.status', 'task.note', 'task.edit']);
  ok(/^T-[0-9a-z]{6}$/.test(evs[0].taskId), `minted a real id, got ${evs[0].taskId}`);
  eq(evs[1].to, 'done', 'status event uses to/from, as foldEvents expects');
  eq(evs[1].from, 'todo');
  eq(evs[3].fields.priority, 'urgent');
  ok(evs.every((e) => e.id && e.ts), 'every event is stamped');
});

check('created tasks get distinct ids', () => {
  const ops = Array.from({ length: 50 }, (_, i) => ({ op: 'create', title: `t${i}`, rationale: 'r' }));
  const evs = opsToEvents(sanitiseOperations(ops, []));
  eq(new Set(evs.map((e) => e.taskId)).size, 50, 'no id reuse across one batch');
});

check('the resulting events fold into the board the proposal described', () => {
  const existing = [
    { id: '1', ts: '2026-09-17T09:00:00.000Z', type: 'task.create', taskId: 'T-aaaaaa', title: 'Fix the parser', status: 'todo', priority: 'normal', tags: ['compiler'] },
  ];
  const ops = sanitiseOperations([
    { op: 'status', taskId: 'T-aaaaaa', status: 'in_progress', rationale: 'r' },
    { op: 'note', taskId: 'T-aaaaaa', text: 'reproduced it', rationale: 'r' },
    { op: 'create', title: 'Add a regression test', rationale: 'r' },
  ], [...foldEvents(existing).tasks.values()]);

  const { tasks } = foldEvents([...existing, ...opsToEvents(ops)]);
  eq(tasks.size, 2, 'one new task');
  const t = tasks.get('T-aaaaaa');
  eq(t.status, 'in_progress');
  eq(t.notes.length, 1);
  eq(t.notes[0].text, 'reproduced it');
});

check('opsToEvents ignores an empty or bad list', () => {
  eq(opsToEvents([]).length, 0);
  eq(opsToEvents(null).length, 0);
});

check('a summary becomes an event that folds back into state', () => {
  const summary = { headline: 'Parser fixed', bullets: [], risks: [], next: [] };
  const e = summaryEvent({ date: '2026-09-17', kind: 'evening', summary, model: 'openai/gpt-oss-120b' });
  eq(e.type, 'summary.set');
  const { summaries } = foldEvents([e]);
  eq(summaries['2026-09-17'].evening.headline, 'Parser fixed');
  eq(summaries['2026-09-17'].evening.model, 'openai/gpt-oss-120b');
});

console.log('--- negotiating with a fussy endpoint ---');

// The verbatim body a LiteLLM proxy returns in front of a model whose temperature is
// pinned. It says "Unsupported" AND names the param, which is exactly what made the
// older format-degrade heuristic misread it as a schema complaint.
const LITELLM_400 = JSON.stringify({
  error: {
    message: 'litellm.UnsupportedParamsError: us.anthropic.claude-sonnet-5 does not support temperature=0.3. Only temperature=1 is supported. To drop unsupported params, set `litellm.drop_params = True`.. Received Model Group=ai2s-claude-sonnet-5',
    type: 'invalid_request_error',
  },
});

check('a refused sampling param is recognised as such, not as a schema complaint', () => {
  eq(refusedParam(LITELLM_400), 'temperature');
  eq(refusedParam('{"message":"Unsupported value: max_tokens. Use max_completion_tokens instead."}'), 'max_tokens');
  eq(refusedParam('{"message":"response_format json_schema is not supported here"}'), null,
    'a pure format complaint must not read as a param complaint');
  eq(refusedParam('{"message":"rate limited, slow down"}'), null);
});

await checkAsync('a pinned temperature is dropped and the request retried', async () => {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    if ('temperature' in body) return { ok: false, status: 400, async text() { return LITELLM_400; } };
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({
          headline: 'One thing moved', bullets: [{ text: 'moved it', taskIds: [] }], risks: [], next: [],
        }) } }] };
      },
    };
  };
  try {
    const out = await summarise({
      endpoint: { kind: 'http', baseUrl: 'https://proxy.example/v1', model: 'ai2s-claude-sonnet-5', label: 'Custom endpoint', needsToken: false, token: null, headers: {} },
      tasks: [task()],
      events: [],
    });
    eq(out.headline, 'One thing moved', 'the feature must survive a pinned param');
    eq(sent.length, 2, 'exactly one retry: drop the param, ask again');
    eq(sent[0].response_format?.type, 'json_schema');
    eq(sent[1].response_format?.type, 'json_schema', 'the format must NOT be degraded over a param complaint');
    ok(!('temperature' in sent[1]), 'the offending param is the only thing that changed');
  } finally {
    globalThis.fetch = original;
  }
});


quit(report('ai.js'));
