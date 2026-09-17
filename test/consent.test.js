/**
 * consent.test.js — the cloud disclosure gate.
 *
 * The numbers in that dialog are its entire value: a warning that undercounts what
 * leaves the machine is worse than no warning, because it has been believed. So the
 * counts are checked against boardPayload() itself rather than recomputed by hand,
 * and the "already agreed" key is checked to change when the endpoint does.
 */
import './shim.js';
import { check, eq, ok, report } from './shim.js';

/* dom.js touches document when building nodes; consent.js imports it for the dialog. */
class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this._text = null; }
  append(...kids) { for (const k of kids) this.children.push(k instanceof FakeNode ? k : new FakeText(String(k))); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text ?? this.children.map((c) => c.textContent).join(''); }
}
class FakeText extends FakeNode {
  constructor(text) { super('#text'); this._text = text; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeNode(t), createTextNode: (t) => new FakeText(t) };

const { isCloud, consentKey, hasConsent, rememberConsent, forgetConsent, disclosure, cloudHint } =
  await import('../js/ui/consent.js');
const { resolveEndpoint } = await import('../js/providers.js');

const ep = (settings, tokens = {}) => resolveEndpoint(settings, tokens);

const tasks = [
  { id: 'T-a', title: 'Retry logic', status: 'review', priority: 'normal', tags: ['api'], notes: [{ text: 'PR up' }, { text: 'rebased' }] },
  { id: 'T-b', title: 'Salary review notes', status: 'todo', priority: 'high', tags: [], notes: [{ text: 'confidential' }], private: true },
  { id: 'T-c', title: 'Old thing', status: 'done', priority: 'low', tags: [], notes: [], deleted: true },
  { id: 'T-d', title: 'Flaky test', status: 'todo', priority: 'normal', tags: [], notes: [] },
];

console.log('consent.js');

/* ---- which endpoints are "away" ---------------------------------------- */

check('a hosted API is cloud', () => ok(isCloud(ep({ provider: 'openai' }))));
check('hugging face inference is cloud', () => ok(isCloud(ep({ provider: 'huggingface' }))));
check('a custom endpoint is cloud', () => ok(isCloud(ep({ provider: 'custom', baseUrl: 'https://gw.example/v1' }))));
check('a local server is not', () => ok(!isCloud(ep({ provider: 'ollama' }))));
check('the in-page model is not', () => ok(!isCloud(ep({ provider: 'webgpu' }))));
check('the demo interpreter is not', () => ok(!isCloud(ep({ provider: 'rules' }))));
check('AI turned off is not', () => ok(!isCloud(ep({ provider: 'none' }))));
check('no endpoint at all is not', () => ok(!isCloud(null)));

/* ---- consent is per place, not per app --------------------------------- */

check('the key covers provider and URL', () => {
  const a = consentKey(ep({ provider: 'custom', baseUrl: 'https://one.example/v1' }));
  const b = consentKey(ep({ provider: 'custom', baseUrl: 'https://two.example/v1' }));
  ok(a !== b, 'two gateways must not share one consent');
});

check('agreeing to one provider does not agree to another', () => {
  forgetConsent();
  const openai = ep({ provider: 'openai' });
  rememberConsent(openai);
  ok(hasConsent(openai), 'the agreed one is remembered');
  ok(!hasConsent(ep({ provider: 'huggingface' })), 'a different vendor still asks');
});

check('re-pointing a custom endpoint asks again', () => {
  forgetConsent();
  rememberConsent(ep({ provider: 'custom', baseUrl: 'https://one.example/v1' }));
  ok(!hasConsent(ep({ provider: 'custom', baseUrl: 'https://two.example/v1' })));
});

check('forgetting tokens forgets the agreement', () => {
  const e = ep({ provider: 'openai' });
  rememberConsent(e);
  forgetConsent();
  ok(!hasConsent(e));
});

/* ---- what the dialog claims is what would be sent ---------------------- */

check('counts only the tasks that would actually go', async () => {
  const d = disclosure({ endpoint: ep({ provider: 'openai' }), tasks, includeNotes: true });
  eq(d.taskCount, 2, 'private and deleted are both out');
  eq(d.excludedPrivate, 1, 'and the private one is named as excluded');
});

check('the task count matches boardPayload exactly', async () => {
  const { boardPayload } = await import('../js/ai.js');
  const d = disclosure({ endpoint: ep({ provider: 'openai' }), tasks, includeNotes: true });
  eq(d.taskCount, boardPayload(tasks.filter((t) => !t.deleted), { includeNotes: true }).length);
});

check('note count reflects the titles-only setting', () => {
  const on = disclosure({ endpoint: ep({ provider: 'openai' }), tasks, includeNotes: true });
  const off = disclosure({ endpoint: ep({ provider: 'openai' }), tasks, includeNotes: false });
  eq(on.noteCount, 2, 'two notes on the one visible task that has any');
  eq(off.noteCount, 0);
  ok(on.includeNotes && !off.includeNotes);
});

check('a deleted task contributes no notes', () => {
  const withNotes = [...tasks, { id: 'T-e', title: 'Gone', status: 'done', priority: 'low', tags: [], notes: [{ text: 'x' }], deleted: true }];
  eq(disclosure({ endpoint: ep({ provider: 'openai' }), tasks: withNotes, includeNotes: true }).noteCount, 2);
});

check('the update is disclosed verbatim, not summarised', () => {
  const text = 'Blocked on the acquisition paperwork.\nAlso fixed T-a.';
  eq(disclosure({ endpoint: ep({ provider: 'openai' }), tasks, text }).freeText, text);
});

check('an empty board still discloses the destination', () => {
  const d = disclosure({ endpoint: ep({ provider: 'openai' }), tasks: [] });
  eq(d.taskCount, 0);
  eq(d.excludedPrivate, 0);
  ok(d.baseUrl.includes('api.openai.com'), 'the URL is what someone is agreeing to');
  ok(d.model, 'and a model is named');
});

/* ---- the standing hint ------------------------------------------------- */

check('the inline hint appears only on cloud providers', () => {
  ok(cloudHint(ep({ provider: 'openai' })), 'shown when work leaves the machine');
  eq(cloudHint(ep({ provider: 'rules' })), null);
  eq(cloudHint(ep({ provider: 'ollama' })), null);
});

check('the hint says the box is not filtered', () => {
  const t = cloudHint(ep({ provider: 'openai' })).textContent;
  ok(t.includes('private'), 'names the flag that does protect tasks');
  ok(/not filtered/.test(t), 'and is plain that this box is not');
});

globalThis.exitCode = report('consent');
