/**
 * fake-dom.js — enough of a DOM to render a real view under `jsc`.
 *
 * This exists because the pure-logic tests cannot catch the failure that actually
 * breaks a feature: a view that throws the moment it renders. A missing import or a
 * helper called with the wrong shape is invisible to a renderer test that never runs
 * the renderer, and there is no browser in this test runner to find it instead.
 *
 * Deliberately not a DOM implementation. It is the subset js/ui/ touches: build a
 * node, set props, append children, read text back, and clear a parent. Anything
 * beyond that should fail loudly here rather than be quietly faked.
 */

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.parent = null;
    this.value = '';
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this._text = null;
  }

  append(...kids) {
    for (const k of kids) {
      const node = k instanceof FakeNode ? k : new FakeText(String(k));
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  select() { this.selected = true; }
  focus() { this.focused = true; }

  /** Fire every listener for `type`, the way a click or a change would. */
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn({ target: this, ...event });
  }

  get firstChild() { return this.children[0] || null; }

  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    return this._text ?? this.children.map((c) => c.textContent).join('');
  }

  /* ---- helpers the tests use, not part of the DOM ---- */

  /** Every node in this subtree, including this one. */
  walk() {
    return [this, ...this.children.flatMap((c) => (c.walk ? c.walk() : [c]))];
  }

  /** First descendant with this tag name, e.g. find('textarea'). */
  find(tag) {
    return this.walk().find((n) => n.tagName === String(tag).toUpperCase()) || null;
  }

  /** Every descendant with this tag name. */
  findAll(tag) {
    return this.walk().filter((n) => n.tagName === String(tag).toUpperCase());
  }

  /** First descendant whose rendered text is exactly this, e.g. a button label. */
  findByText(text) {
    return this.walk().find((n) => n.tagName !== '#TEXT' && n.textContent === text) || null;
  }
}

class FakeText extends FakeNode {
  constructor(text) { super('#text'); this._text = text; }
}

/** Install the globals js/ui/ expects. Returns the fake document. */
export function installFakeDOM() {
  const body = new FakeNode('body');
  const doc = {
    body,
    documentElement: new FakeNode('html'),
    createElement: (t) => new FakeNode(t),
    createTextNode: (t) => new FakeText(t),
    // Only ever asked for '#toasts', which does not exist until a toast is shown.
    querySelector: () => null,
    execCommand: () => true,
  };
  globalThis.Node = FakeNode;
  globalThis.document = doc;
  globalThis.setTimeout = globalThis.setTimeout || ((fn) => fn());
  return doc;
}

export { FakeNode, FakeText };
