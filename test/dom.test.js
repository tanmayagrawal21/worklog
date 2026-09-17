/**
 * dom.test.js — node building.
 *
 * These exist because of a real bug: the header rendered the literal text "null"
 * next to the Publish button. Native Node.append() stringifies non-Node arguments,
 * so a `cond ? node : null` child becomes the string "null". el() filtered its
 * children but a raw .append() call did not.
 */
import './shim.js';
import { check, eq, ok, report } from './shim.js';

/* A DOM small enough to be obviously correct, real enough to catch stringification. */
class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this._text = null;
  }
  append(...kids) {
    for (const k of kids) this.children.push(k instanceof FakeNode ? k : new FakeText(String(k)));
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text ?? this.children.map((c) => c.textContent).join(''); }
}
class FakeText extends FakeNode {
  constructor(text) { super('#text'); this._text = text; }
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createTextNode: (t) => new FakeText(t),
};

const { el, add } = await import('../js/ui/dom.js');

console.log('--- el() ---');

check('sets text and class', () => {
  const n = el('div', { class: 'card', text: 'hi' });
  eq(n.className, 'card');
  eq(n.textContent, 'hi');
});

check('null, undefined and false children are skipped', () => {
  const n = el('div', {}, 'a', null, undefined, false, 'b');
  eq(n.textContent, 'ab', 'no "null" or "false" text leaks in');
});

check('zero is kept — it is real content, unlike null', () => {
  eq(el('span', {}, 0).textContent, '0');
});

check('arrays of children are flattened', () => {
  eq(el('div', {}, ['a', 'b'], [[null, 'c']]).textContent, 'abc');
});

check('false-valued props are dropped rather than set', () => {
  const n = el('button', { disabled: false, title: 'x' });
  ok(!('disabled' in n.attrs), 'disabled:false must not become an attribute');
  eq(n.attrs.title, 'x');
});

console.log('--- add(): the "null null" regression ---');

check('add() skips nulls that native append would stringify', () => {
  const header = new FakeNode('header');
  const pending = false;                       // nothing staged: both conditionals are null
  add(header,
    el('span', { text: 'Work Log' }),
    pending ? el('span', { text: 'badge' }) : null,
    pending ? el('button', { text: 'Discard' }) : null,
    el('button', { text: 'Publish' }));
  eq(header.textContent, 'Work LogPublish', 'no "null" between the brand and Publish');
});

check('native append is what got this wrong — the guard is doing real work', () => {
  const naive = new FakeNode('header');
  naive.append('a', null, 'b');
  eq(naive.textContent, 'anullb', 'confirms Node.append() stringifies null');
});

check('add() keeps the nodes it is given, in order', () => {
  const p = new FakeNode('div');
  add(p, el('i', { text: '1' }), null, el('i', { text: '2' }));
  eq(p.children.length, 2);
  eq(p.textContent, '12');
});

quit(report('dom.js'));
