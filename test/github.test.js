/**
 * github.test.js — the two places where a size limit could silently lose data.
 *
 * No network: fetch is stubbed per case. These are the paths that only misbehave on
 * files big enough that nobody has one yet, which is exactly why they need a test.
 */
import './shim.js';
import { check, checkAsync, eq, ok, report } from './shim.js';
import { GitHubRepo, DEFAULT_REPO, repoTargetProblem, resolveRepoTarget } from '../js/github.js';

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

/* The repo target: a blank field behind a suggested name used to be saved as "no repo",
   which left the create step with nothing to create and no message about why. */
console.log('--- repoTargetProblem() ---');

check('an owner with the suggested name is fine', () => {
  eq(repoTargetProblem({ owner: 'me', repo: DEFAULT_REPO }), null);
});

check('both blank is not an error — that is just an unconfigured app', () => {
  eq(repoTargetProblem({ owner: '', repo: '' }), null);
  eq(repoTargetProblem({}), null);
});

check('a named repo with no owner names the owner field', () => {
  const p = repoTargetProblem({ owner: '  ', repo: DEFAULT_REPO });
  eq(p?.field, 'owner', `expected the owner field: ${JSON.stringify(p)}`);
});

check('an owner with no repo is reported instead of silently saved', () => {
  const p = repoTargetProblem({ owner: 'me', repo: '   ' });
  eq(p?.field, 'repo', `expected the repo field: ${JSON.stringify(p)}`);
  ok(p.message.includes(DEFAULT_REPO), `and should suggest a name: ${p.message}`);
});

check('a slug pasted into either field is caught, not turned into me/a/b', () => {
  eq(repoTargetProblem({ owner: 'me/data', repo: 'x' })?.field, 'owner');
  eq(repoTargetProblem({ owner: 'me', repo: 'me/data' })?.field, 'repo');
});

check('names GitHub itself would refuse are caught before the request', () => {
  eq(repoTargetProblem({ owner: '-me', repo: 'ok' })?.field, 'owner', 'owner cannot start with a dash');
  eq(repoTargetProblem({ owner: 'me-', repo: 'ok' })?.field, 'owner', 'owner cannot end with a dash');
  eq(repoTargetProblem({ owner: 'a--b', repo: 'ok' })?.field, 'owner', 'no doubled dashes');
  eq(repoTargetProblem({ owner: 'm'.repeat(40), repo: 'ok' })?.field, 'owner', '39 characters is the limit');
  eq(repoTargetProblem({ owner: 'me', repo: '..' })?.field, 'repo', '".." is not a repo name');
  eq(repoTargetProblem({ owner: 'me', repo: 'my repo' })?.field, 'repo', 'spaces are not allowed');
});

check('legal-but-unusual names are allowed through', () => {
  eq(repoTargetProblem({ owner: 'a', repo: '.github' }), null);
  eq(repoTargetProblem({ owner: 'My-Org-1', repo: 'work_log.data-2026' }), null);
  eq(repoTargetProblem({ owner: ' me ', repo: ' data ' }), null, 'surrounding space is trimmed, not rejected');
});

console.log('--- resolveRepoTarget(): the prefilled suggestion ---');

check('accepting the suggestion by typing only an owner configures that repo', () => {
  eq(resolveRepoTarget({ owner: 'me', repo: DEFAULT_REPO, saved: '' }), { owner: 'me', repo: DEFAULT_REPO });
});

check('the suggestion alone, with no owner, is still "no repo yet"', () => {
  // Opening Settings to pick an AI provider must not demand a GitHub owner.
  eq(resolveRepoTarget({ owner: '', repo: DEFAULT_REPO, saved: '' }), { owner: '', repo: '' });
});

check('a configured repo that happens to be the suggested name is kept', () => {
  eq(resolveRepoTarget({ owner: '', repo: DEFAULT_REPO, saved: DEFAULT_REPO }), { owner: '', repo: DEFAULT_REPO },
    'clearing only the owner is an error to report, not a reason to forget the repo');
});

check('a name the user actually typed is never dropped', () => {
  eq(resolveRepoTarget({ owner: '', repo: 'my-log', saved: '' }), { owner: '', repo: 'my-log' });
});

check('values are trimmed', () => {
  eq(resolveRepoTarget({ owner: ' me ', repo: ' my-log ' }), { owner: 'me', repo: 'my-log' });
});

await checkAsync('creating a repo that lands on the wrong account fails loudly', async () => {
  // POST /user/repos ignores the owner and uses the token's account. A typed org must
  // not end up as a repo on someone's personal account that this app never reads.
  const r = new GitHubRepo({ owner: 'some-org', repo: 'd', branch: 'main', token: 'ghp_x' });
  let threw = null;
  await withFetch(
    async () => ({ ok: true, status: 201, async json() { return { full_name: 'me/d', private: true, default_branch: 'main' }; } }),
    () => r.createRepo({ private: true }).catch((e) => { threw = e; }),
  );
  ok(threw, 'a repo created under the wrong owner must reject');
  ok(/me\/d/.test(threw.message) && /some-org\/d/.test(threw.message), `and name both places: ${threw?.message}`);
});

await checkAsync('creating it on the token owner account succeeds', async () => {
  const r = new GitHubRepo({ owner: 'Me', repo: 'd', branch: 'main', token: 'ghp_x' });
  const out = await withFetch(
    async () => ({ ok: true, status: 201, async json() { return { full_name: 'me/d', private: true, html_url: 'u', default_branch: 'main' }; } }),
    () => r.createRepo({ private: true }),
  );
  eq(out.created, true, 'a case difference in the owner is the same account');
});

quit(report('github.js'));
