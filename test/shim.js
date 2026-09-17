/**
 * Minimal browser-global shims so the pure logic in store.js can be exercised under
 * JavaScriptCore (`jsc -m`). Imported first by each test file; static import order is
 * evaluation order, so these land before the modules under test initialise.
 */

// Counter-based PRNG: reproducible across runs, but distinct per call so id
// collisions would still show up as genuine test failures.
let seed = 0x2545f491;
globalThis.crypto = {
  getRandomValues(arr) {
    for (let i = 0; i < arr.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      arr[i] = seed & 0xff;
    }
    return arr;
  },
};

globalThis.TextEncoder = class {
  encode(str) {
    const out = [];
    for (const ch of String(str)) {
      let c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
};

globalThis.TextDecoder = class {
  decode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < b.length;) {
      const c = b[i];
      if (c < 0x80) { s += String.fromCharCode(c); i += 1; }
      else if (c < 0xe0) { s += String.fromCharCode(((c & 31) << 6) | (b[i + 1] & 63)); i += 2; }
      else if (c < 0xf0) { s += String.fromCharCode(((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63)); i += 3; }
      else {
        s += String.fromCodePoint(((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63));
        i += 4;
      }
    }
    return s;
  }
};

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

globalThis.console = { log: (...a) => print(a.join(' ')), error: (...a) => print(a.join(' ')), warn: (...a) => print(a.join(' ')) };
globalThis.fetch = () => { throw new Error('network disabled in tests'); };

/* ---- tiny assertion harness ---- */
let pass = 0; const failures = [];

export function check(name, fn) {
  try { fn(); pass++; print(`  ok   ${name}`); }
  catch (e) { failures.push(`${name}: ${e.message}`); print(`  FAIL ${name}\n       ${e.message}`); }
}

export function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n       expected: ${b}\n       actual:   ${a}`);
}

export function ok(cond, msg = 'expected truthy') { if (!cond) throw new Error(msg); }

export function report(label) {
  print(`\n${label}: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { print('\nFailures:'); failures.forEach((f) => print(`  - ${f}`)); }
  return failures.length;
}
