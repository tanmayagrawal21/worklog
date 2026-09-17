/**
 * providers.js — where the AI requests go, if anywhere.
 *
 * Four modes, because "how much do I trust this with my work log" is the real
 * question and it deserves a real answer rather than a buried setting:
 *
 *   MODES.off    No AI at all. The board, the event log and git history work exactly
 *                as before; summaries and brain dump are simply unavailable. Nothing
 *                is ever sent anywhere but your own repo.
 *   MODES.local  Runs on your machine. Either in this browser tab on your GPU
 *                (weights downloaded once and cached, no install, no server), or a
 *                server you run yourself. In both cases no task data leaves the
 *                machine -- the only outbound traffic is fetching model weights.
 *   MODES.hf     Open-weight models via Hugging Face's hosted inference.
 *   MODES.api    A commercial API, or any endpoint that speaks OpenAI's format.
 *
 * Everything except the in-browser engine speaks the OpenAI chat-completions shape,
 * which is why one small transport in ai.js reaches all of them; the in-browser
 * engine is given the same shape by webllm.js, so ai.js never learns the difference.
 *
 * The `browser` field on each preset is not a guess. Calling an API directly from a
 * page needs that API to send CORS headers, and I probed each preflight:
 *
 *   router.huggingface.co        access-control-allow-origin: *
 *   api.openai.com               reflects the requesting origin
 *   generativelanguage.google…   reflects the requesting origin
 *   openrouter.ai                access-control-allow-origin: *
 *   api.anthropic.com            NO allow-origin -- unless the request carries
 *                                `anthropic-dangerous-direct-browser-access: true`,
 *                                which flips it to *. Hence extraHeaders below.
 *
 * Local servers are a different problem: loopback counts as a secure origin, so an
 * HTTPS page reaching http://localhost is NOT blocked as mixed content, but the local
 * server must still be told to allow this page's origin. See each preset's `setup`.
 */

/**
 * A note on keys, stated plainly because it is a real trade-off: a paid API key
 * pasted into this app lives in your browser and is sent to that vendor from your
 * machine. It is never committed and never passed to anyone else, but a browser is a
 * softer place to keep a billable key than a server is. Local providers need no key
 * at all, which is the safest option if that bothers you.
 */
export const MODES = Object.freeze([
  { id: 'off',   label: 'No AI',                  blurb: 'Just the board and the git changelog. Nothing is sent to any model.' },
  { id: 'local', label: 'On my machine',          blurb: 'In this browser on your GPU, or a server you run. No task data leaves your computer.' },
  { id: 'hf',    label: 'Open models in the cloud', blurb: 'Open-weight models on Hugging Face inference. Task titles are sent to them.' },
  { id: 'api',   label: 'A commercial or custom API', blurb: 'OpenAI, Anthropic, Google, OpenRouter, or your own OpenAI-compatible endpoint.' },
]);

export const PROVIDERS = Object.freeze({
  none: {
    label: 'AI turned off',
    mode: 'off',
    kind: 'none',
    baseUrl: '',
    needsToken: false,
    suggested: [],
    note: 'The board, notes, search, publishing and the git changelog all work. Only the summary and brain-dump features need a model.',
  },

  /**
   * The demo's stand-in. Not offered in Settings (hidden), because choosing keyword
   * rules over a model is not a real preference -- it exists so ?demo=1 can show the
   * brain dump and the summary to someone who has not pasted a key anywhere.
   */
  rules: {
    label: 'Demo interpreter (keyword rules, not a model)',
    mode: 'local',
    kind: 'rules',
    baseUrl: '',
    needsToken: false,
    local: true,
    hidden: true,
    suggested: ['keyword-rules'],
    note: 'A few dozen keyword rules running in this page. No model, no download, nothing sent anywhere — enough to see how proposals are reviewed before they are applied.',
  },

  /* ---- on your own machine ---- */

  webgpu: {
    label: 'In this browser (WebGPU, no install)',
    mode: 'local',
    kind: 'webgpu',
    baseUrl: '',
    needsToken: false,
    local: true,
    browser: 'in-page',
    note: 'Downloads the model once (0.5-2 GB) into this browser\'s cache, then runs it on your GPU. Task data never leaves the tab. Needs WebGPU -- Chrome, Edge, or a recent Safari/Firefox -- and the first run is slow while weights download.',
    // MLC-prebuilt ids; small enough to be honest about on a laptop.
    suggested: ['Qwen2.5-3B-Instruct-q4f16_1-MLC', 'Llama-3.2-3B-Instruct-q4f16_1-MLC', 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', 'Phi-3.5-mini-instruct-q4f16_1-MLC'],
  },

  huggingface: {
    label: 'Hugging Face (open models)',
    mode: 'hf',
    baseUrl: 'https://router.huggingface.co/v1',
    needsToken: true,
    browser: 'direct',
    tokenUrl: 'https://huggingface.co/settings/tokens',
    tokenHint: 'A token with the "Make calls to Inference Providers" permission.',
    note: 'Free accounts get $0.10 of inference credit a month, then requests fail until it resets or you buy more.',
    suggested: ['openai/gpt-oss-120b:fastest', 'openai/gpt-oss-20b:fastest', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  },

  openai: {
    label: 'OpenAI',
    mode: 'api',
    baseUrl: 'https://api.openai.com/v1',
    needsToken: true,
    browser: 'direct',
    tokenUrl: 'https://platform.openai.com/api-keys',
    tokenHint: 'A standard API key. Billed to your OpenAI account.',
    suggested: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  },

  anthropic: {
    label: 'Anthropic (Claude)',
    mode: 'api',
    baseUrl: 'https://api.anthropic.com/v1',
    needsToken: true,
    browser: 'direct',
    // Anthropic refuses CORS by default; this header is its documented opt-in.
    extraHeaders: { 'anthropic-dangerous-direct-browser-access': 'true', 'anthropic-version': '2023-06-01' },
    tokenUrl: 'https://console.anthropic.com/settings/keys',
    tokenHint: 'A standard API key. Billed to your Anthropic account.',
    note: 'Uses Anthropic\'s OpenAI-compatible endpoint, and must send a header that explicitly permits calling it from a browser.',
    suggested: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5'],
  },

  google: {
    label: 'Google (Gemini)',
    mode: 'api',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsToken: true,
    browser: 'direct',
    tokenUrl: 'https://aistudio.google.com/apikey',
    tokenHint: 'An AI Studio API key.',
    suggested: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },

  openrouter: {
    label: 'OpenRouter (many vendors, one key)',
    mode: 'api',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsToken: true,
    browser: 'direct',
    tokenUrl: 'https://openrouter.ai/keys',
    tokenHint: 'One key that reaches most vendors, including free-tier models.',
    suggested: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4.5', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat'],
  },

  /* ---- a model server you run yourself: no key, no vendor, no cost ---- */

  ollama: {
    label: 'Ollama (on your machine)',
    mode: 'local',
    baseUrl: 'http://localhost:11434/v1',
    needsToken: false,
    browser: 'local',
    local: true,
    setup: 'Install Ollama, then: ollama pull qwen2.5:14b\nOllama rejects browser origins unless you allow them, so start it as:\n  OLLAMA_ORIGINS=\'*\' ollama serve',
    suggested: ['qwen2.5:14b', 'llama3.3:70b', 'gpt-oss:20b', 'mistral-small'],
  },

  llamacpp: {
    label: 'llama.cpp server (on your machine)',
    mode: 'local',
    baseUrl: 'http://localhost:8080/v1',
    needsToken: false,
    browser: 'local',
    local: true,
    setup: 'llama-server -hf unsloth/gpt-oss-20b-GGUF --port 8080\nIt allows browser origins by default; add --api-key if you want one.',
    suggested: ['local-model'],
  },

  lmstudio: {
    label: 'LM Studio (on your machine)',
    mode: 'local',
    baseUrl: 'http://localhost:1234/v1',
    needsToken: false,
    browser: 'local',
    local: true,
    setup: 'In LM Studio: load a model, open the Developer tab, Start Server, and enable CORS.',
    suggested: ['local-model'],
  },

  custom: {
    label: 'Custom endpoint (OpenAI-compatible)',
    mode: 'api',
    baseUrl: '',
    needsToken: false,
    browser: 'unknown',
    custom: true,
    note: 'Any server exposing POST /chat/completions in OpenAI\'s format. It must send CORS headers allowing this page\'s origin, or the browser will block the call.',
    suggested: [],
  },
});

export const DEFAULT_PROVIDER = 'huggingface';

/** Providers offered under a given mode, in the order they should be presented. */
export const providersInMode = (mode) => Object.entries(PROVIDERS)
  .filter(([, p]) => p.mode === mode && !p.hidden)
  .map(([id, p]) => ({ id, ...p }));

export const modeOf = (providerId) => (PROVIDERS[providerId] || PROVIDERS[DEFAULT_PROVIDER]).mode;

/** Trim a trailing slash so `${baseUrl}/chat/completions` never doubles up. */
const normalise = (url) => String(url || '').replace(/\/+$/, '');

/**
 * Resolve settings + tokens into everything a request needs.
 * `kind` is what ai.js dispatches on: 'none', 'webgpu', or 'http'.
 * @returns {{id, kind, mode, baseUrl, model, token, headers, local, needsToken, label}}
 */
export function resolveEndpoint(settings = {}, tokens = {}) {
  const id = settings.provider && PROVIDERS[settings.provider] ? settings.provider : DEFAULT_PROVIDER;
  const p = PROVIDERS[id];
  const baseUrl = normalise(settings.baseUrl || p.baseUrl);

  return {
    id,
    kind: p.kind || 'http',
    mode: p.mode,
    label: p.label,
    baseUrl,
    model: settings.model || p.suggested[0] || '',
    token: tokens[id] || null,
    headers: p.extraHeaders || {},
    local: !!p.local,
    needsToken: !!p.needsToken,
  };
}

/**
 * Is this endpoint usable right now, and if not, why?
 *
 * Checks run most-fundamental first, so the message names the thing actually blocking
 * you: a custom endpoint with no URL should not be told to pick a model.
 */
export function endpointProblem(ep) {
  if (!ep || ep.kind === 'none') return 'AI is turned off. Choose a provider in Settings to use summaries and the brain dump.';

  // Rules need nothing: no key, no URL, no model, no GPU. That is their whole reason
  // for existing, so they are usable the moment they are selected.
  if (ep.kind === 'rules') return null;

  if (ep.kind === 'webgpu') {
    if (typeof navigator !== 'undefined' && !navigator.gpu) {
      return 'This browser has no WebGPU, so a model cannot run in the page. Use Chrome or Edge, or pick another provider in Settings.';
    }
    return ep.model ? null : 'No local model chosen. Pick one in Settings.';
  }

  if (!ep.baseUrl) return 'No endpoint URL set. Choose a provider in Settings.';
  if (ep.needsToken && !ep.token) return `No API key set for ${ep.label}. Add one in Settings.`;
  if (!ep.model) return 'No model chosen. Pick one in Settings.';
  return null;
}
