/**
 * github.test.js — the two places where a size limit could silently lose data.
 *
 * No network: fetch is stubbed per case. These are the paths that only misbehave on
 * files big enough that nobody has one yet, which is exactly why they need a test.
 */
import './shim.js';
import { checkAsync, eq, ok, report } from './shim.js';
import { GitHubRepo } from '../js/github.js';

const repo = () => new GitHubRepo({ owner: 'me', repo: 'd', branch: 'main', token: 'ghp_x' });

const withFetch = async (impl, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
};

const b64 = (text) => {
  // Minimal base64 encoder: the shim has no btoa.
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (b === undefined ? '=' : A[(n >> 6) & 63]) + (c === undefined ? '=' : A[n & 63]);
  }
  return out;
};

await checkAsync('a small file is read from the inlined base64', async () => {
  const calls = [];
  const f = await withFetch(async (url, opts) => {
    calls.push(opts?.headers?.Accept || '');
    return { ok: true, status: 200, async json() { return { encoding: 'base64', content: b64('{"month":"2026-09"}'), sha: 'abc', size: 19 }; } };
  }, () => repo().getFile('data/log/2026/09.json'));
  eq(f.text, '{"month":"2026-09"}');
  eq(calls.length, 1, 'no second request needed');
});

await checkAsync('a file over 1 MB falls back to the raw blob instead of reading empty', async () => {
  // What the contents API actually answers above its inline limit.
  const accepts = [];
  const f = await withFetch(async (url, opts) => {
    accepts.push(opts?.headers?.Accept || '');
    if (accepts.length === 1) {
      return { ok: true, status: 200, async json() { return { encoding: 'none', content: '', sha: 'big', size: 1234567 }; } };
    }
    return { ok: true, status: 200, async text() { return '{"tasks":[]}'; } };
  }, () => repo().getFile('data/board.json'));
  eq(f.text, '{"tasks":[]}', 'a large file must not decode to the empty string');
  ok(/vnd\.github\.raw/.test(accepts[1]), `the retry must ask for the raw blob: ${accepts[1]}`);
});

await checkAsync('a missing file is null, not an error', async () => {
  const f = await withFetch(async () => ({ ok: false, status: 404 }), () => repo().getFile('nope.json'));
  eq(f, null);
});

await checkAsync('a write without a token is refused before any request is made', async () => {
  const r = new GitHubRepo({ owner: 'me', repo: 'd', branch: 'main', token: null });
  let threw = null;
  await withFetch(async () => { throw new Error('must not be called'); },
    () => r.commitFiles([{ path: 'a', text: 'b' }], 'm').catch((e) => { threw = e; }));
  ok(threw, 'a tokenless write must reject');
  ok(/token/i.test(threw.message), `and say why: ${threw?.message}`);
});

quit(report('github.js'));
