/**
 * providers.test.js — the four AI modes, and the promise each one makes.
 *
 * The claims being guarded here are user-facing promises, not implementation details:
 * "off" must reach nothing, "local" must resolve to the machine, a paid provider must
 * refuse to run without its own key, and upgrading the app must not lose a token
 * someone saved under the old single-provider layout.
 */
import { check, eq, ok, report } from './shim.js';
import { MODES, PROVIDERS, DEFAULT_PROVIDER, providersInMode, modeOf, resolveEndpoint, endpointProblem } from '../js/providers.js';
import { saveTokens, loadTokens, clearTokens } from '../js/vault.js';

print('--- the four modes are exhaustive and well-formed ---');

check('every provider belongs to one of the four modes', () => {
  const known = new Set(MODES.map((m) => m.id));
  for (const [id, p] of Object.entries(PROVIDERS)) {
    ok(known.has(p.mode), `${id} has mode "${p.mode}", which is not one of ${[...known].join('/')}`);
  }
});

check('every mode offers at least one provider', () => {
  for (const m of MODES) ok(providersInMode(m.id).length > 0, `mode ${m.id} has no providers`);
});

check('the local mode covers both in-page and own-server', () => {
  const kinds = providersInMode('local').map((p) => p.kind || 'http');
  ok(kinds.includes('webgpu'), 'no in-browser option');
  ok(kinds.includes('http'), 'no local-server option');
});

check('the default resolves to a real provider', () => {
  ok(PROVIDERS[DEFAULT_PROVIDER], 'DEFAULT_PROVIDER is not in PROVIDERS');
  eq(modeOf('nonsense-provider'), PROVIDERS[DEFAULT_PROVIDER].mode, 'unknown ids fall back to the default');
});

print('--- off means off ---');

check('the off mode resolves to no endpoint at all', () => {
  const ep = resolveEndpoint({ provider: 'none' }, {});
  eq(ep.kind, 'none');
  eq(ep.baseUrl, '', 'an off endpoint must not carry a URL');
  ok(!ep.token, 'an off endpoint must not carry a token');
});

check('the off mode reports a reason rather than failing silently', () => {
  const why = endpointProblem(resolveEndpoint({ provider: 'none' }, {}));
  ok(why && /turned off/i.test(why), `unhelpful message: ${why}`);
});

print('--- local: nothing leaves the machine ---');

check('the in-page provider needs no key and no server', () => {
  const ep = resolveEndpoint({ provider: 'webgpu' }, {});
  eq(ep.kind, 'webgpu');
  eq(ep.needsToken, false);
  ok(ep.model, 'must default to a model rather than nothing');
});

check('a local server resolves to loopback, not to a vendor', () => {
  for (const p of providersInMode('local')) {
    if ((p.kind || 'http') !== 'http') continue;
    const ep = resolveEndpoint({ provider: p.id }, {});
    ok(/^http:\/\/(localhost|127\.0\.0\.1)/.test(ep.baseUrl), `${p.id} points at ${ep.baseUrl}`);
    eq(ep.needsToken, false, `${p.id} should not demand a key`);
    eq(endpointProblem(ep), null, `${p.id} should be usable with no setup in this app`);
  }
});

check('no WebGPU is reported as a browser problem, not a config one', () => {
  globalThis.navigator = {};                       // a browser without WebGPU
  const why = endpointProblem(resolveEndpoint({ provider: 'webgpu' }, {}));
  ok(why && /WebGPU/.test(why), `expected a WebGPU explanation, got: ${why}`);
  globalThis.navigator = { gpu: {} };              // and one with it
  eq(endpointProblem(resolveEndpoint({ provider: 'webgpu' }, {})), null);
  delete globalThis.navigator;
});

print('--- hosted providers ---');

check('a hosted provider refuses to run without its own key', () => {
  for (const p of [...providersInMode('hf'), ...providersInMode('api')]) {
    if (!p.needsToken) continue;
    const why = endpointProblem(resolveEndpoint({ provider: p.id }, {}));
    ok(why && /key/i.test(why), `${p.id} did not ask for a key: ${why}`);
  }
});

check('keys are looked up per provider, never shared between them', () => {
  const tokens = { openai: 'sk-openai', anthropic: 'sk-anthropic' };
  eq(resolveEndpoint({ provider: 'openai' }, tokens).token, 'sk-openai');
  eq(resolveEndpoint({ provider: 'anthropic' }, tokens).token, 'sk-anthropic');
  eq(resolveEndpoint({ provider: 'google' }, tokens).token, null, 'a provider with no key must not borrow one');
});

check('anthropic carries the header that makes a browser call legal', () => {
  const ep = resolveEndpoint({ provider: 'anthropic' }, { anthropic: 'k' });
  eq(ep.headers['anthropic-dangerous-direct-browser-access'], 'true');
  ok(ep.headers['anthropic-version'], 'the version header is required by that API');
});

check('every hosted provider is reachable over https', () => {
  for (const p of [...providersInMode('hf'), ...providersInMode('api')]) {
    if (!p.baseUrl) continue;                      // custom has none until you set it
    ok(p.baseUrl.startsWith('https://'), `${p.id} uses ${p.baseUrl}`);
  }
});

print('--- custom endpoints ---');

check('a custom base URL wins, with its trailing slash trimmed', () => {
  const ep = resolveEndpoint({ provider: 'custom', baseUrl: 'https://gw.example.com/v1/' }, {});
  eq(ep.baseUrl, 'https://gw.example.com/v1', 'a doubled slash would 404 on every request');
});

check('an override applies to a preset provider too, for proxies', () => {
  eq(resolveEndpoint({ provider: 'openai', baseUrl: 'https://proxy.internal/v1' }, {}).baseUrl, 'https://proxy.internal/v1');
});

check('a custom provider with no URL says so', () => {
  ok(/endpoint URL/i.test(endpointProblem(resolveEndpoint({ provider: 'custom' }, {})) || ''));
});

check('an explicit model beats the provider default', () => {
  eq(resolveEndpoint({ provider: 'openai', model: 'gpt-4o' }, {}).model, 'gpt-4o');
});

print('--- upgrading must not lose a saved token ---');

check('a token saved as hfToken becomes the huggingface key', async () => {
  clearTokens();
  // Exactly what v1 of this app wrote to localStorage.
  localStorage.setItem('worklog.tokens.v1', JSON.stringify({ locked: false, secrets: { githubToken: 'ghp_x', hfToken: 'hf_y' } }));
  const secrets = await loadTokens();
  eq(secrets.githubToken, 'ghp_x');
  eq(secrets.aiTokens.huggingface, 'hf_y', 'the old HF token must survive the upgrade');
  ok(!('hfToken' in secrets), 'and must not linger under the old name');
});

check('a saved-then-loaded round trip keeps per-provider keys apart', async () => {
  clearTokens();
  await saveTokens({ githubToken: 'ghp_1', aiTokens: { openai: 'sk-a', ollama: '' } });
  const secrets = await loadTokens();
  eq(secrets.aiTokens.openai, 'sk-a');
  eq(resolveEndpoint({ provider: 'openai' }, secrets.aiTokens).token, 'sk-a');
  clearTokens();
});

quit(report('providers.js'));
