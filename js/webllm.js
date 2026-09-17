/**
 * webllm.js — running the model inside this browser tab, on your GPU.
 *
 * This is the strongest privacy option the app can offer: the weights are fetched
 * once from Hugging Face, cached by the browser, and every token after that is
 * generated locally. No task title, note or summary is ever sent to a server. There
 * is nothing to install and no localhost server to start.
 *
 * The costs, stated up front because they are real:
 *   - WebGPU only (Chrome/Edge, recent Safari and Firefox). No WebGPU, no run.
 *   - The first use downloads 0.5-2 GB. Cached afterwards, but it is not quick.
 *   - A 3B model is not a frontier model. It writes decent summaries and parses a
 *     brain dump acceptably; it will occasionally need a second attempt. The
 *     json_schema -> json_object -> plain-prompt degradation in ai.js exists partly
 *     for exactly this case.
 *   - It loads the MLC WebLLM runtime from jsDelivr at first use, so this one
 *     feature needs network access to a CDN even though inference does not.
 *
 * Generation runs in a Web Worker so a slow token stream cannot freeze the board;
 * if the worker cannot start, it falls back to the main thread rather than failing.
 */

const RUNTIME = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/lib/index.js';

export const hasWebGPU = () => typeof navigator !== 'undefined' && !!navigator.gpu;

let runtimePromise = null;
const loadRuntime = () => (runtimePromise ||= import(/* @vite-ignore */ RUNTIME));

/** Model ids this runtime ships configs for, minus the ones that are not chat models. */
export async function listBrowserModels() {
  const webllm = await loadRuntime();
  return (webllm.prebuiltAppConfig?.model_list || [])
    .map((m) => m.model_id)
    .filter((id) => !/vision|embedding|snowflake|bge-/i.test(id))
    .sort();
}

/* ---------- engine, cached per model ------------------------------------- */

const engines = new Map();     // model id -> Promise<engine>

/**
 * Get (or build) an engine for a model. Progress goes to `onProgress` as
 * {text, progress} so the UI can show the download rather than appearing hung —
 * a silent multi-gigabyte wait is indistinguishable from a broken app.
 */
async function getEngine(model, onProgress) {
  if (!hasWebGPU()) {
    throw new Error('This browser has no WebGPU, so a model cannot run in the page. Try Chrome or Edge, or choose another provider in Settings.');
  }

  const report = (r) => onProgress?.({ text: r.text || 'Preparing the model…', progress: r.progress ?? 0 });

  if (!engines.has(model)) {
    engines.set(model, (async () => {
      const webllm = await loadRuntime();
      try {
        return await webllm.CreateWebWorkerMLCEngine(
          new Worker(new URL('./webllm-worker.js', import.meta.url), { type: 'module' }),
          model,
          { initProgressCallback: report },
        );
      } catch {
        // Worker blocked (some CSPs, some embedded webviews) — correctness over polish.
        return webllm.CreateMLCEngine(model, { initProgressCallback: report });
      }
    })().catch((e) => { engines.delete(model); throw e; }));
  } else {
    onProgress?.({ text: 'Model ready.', progress: 1 });
  }

  return engines.get(model);
}

/** Free the GPU memory a loaded model holds. */
export async function unloadBrowserModel(model) {
  const pending = engines.get(model);
  if (!pending) return;
  engines.delete(model);
  try { (await pending).unload?.(); } catch { /* already gone */ }
}

export const loadedBrowserModels = () => [...engines.keys()];

/**
 * One completion, in the OpenAI shape ai.js already speaks.
 * `schema` is honoured as a JSON-mode hint only: WebLLM does not take a full
 * json_schema, and ai.js can parse a plainly-prompted answer anyway.
 */
export async function browserChat(ep, messages, { schema = null, maxTokens = 1600, temperature = 0.2, onProgress } = {}) {
  const engine = await getEngine(ep.model, onProgress);
  onProgress?.({ text: 'Generating…', progress: 1 });

  const attempts = schema ? [{ type: 'json_object' }, null] : [null];
  let lastErr;
  for (const response_format of attempts) {
    try {
      const res = await engine.chat.completions.create({
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(response_format ? { response_format } : {}),
      });
      const text = res.choices?.[0]?.message?.content;
      if (text) return text;
      lastErr = new Error('The local model returned nothing. Try again, or pick a larger model.');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Download and warm a model ahead of time, so a summary is not the thing that waits. */
export async function preloadBrowserModel(model, onProgress) {
  await getEngine(model, onProgress);
  return true;
}
