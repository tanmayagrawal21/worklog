/**
 * ai.js — summaries and board updates, from whichever model you point it at.
 *
 * Provider-agnostic on purpose. Endpoints come in three kinds and chat() dispatches
 * on that alone: 'none' (AI switched off — every flow refuses cleanly), 'webgpu' (a
 * model running in this tab), and 'http' (anything speaking OpenAI's chat-completions
 * shape: Hugging Face, OpenAI, Anthropic, Google, OpenRouter, a server on your laptop,
 * or a custom URL). Nothing else in this file knows which one it is talking to.
 *
 * Two flows:
 *   proposeOperations() — free-text brain dump -> proposed board changes. Returns
 *     PROPOSALS ONLY. Applying them is the caller's (and the user's) decision.
 *   summarise()         — event log + board -> short executive summary in pointers.
 *
 * Reliability: structured-output support varies a lot across vendors and local
 * servers, so requests degrade json_schema -> json_object -> plain prompting, and
 * parsing tolerates a model that wraps JSON in prose or code fences. That degrade
 * chain is what makes a 7B model on a laptop and a frontier API both workable.
 *
 * Privacy: the board is sent to whatever endpoint is configured. Tasks flagged
 * `private` are never included, and notes can be withheld globally.
 */

import { makeEvent, newTaskId } from './store.js';
import { PROVIDERS, DEFAULT_PROVIDER } from './providers.js';
import { browserChat, listBrowserModels } from './webllm.js';

/** Fallback list when an endpoint cannot be asked what it serves. */
export const suggestedFor = (providerId) => [...(PROVIDERS[providerId] || PROVIDERS[DEFAULT_PROVIDER]).suggested];

export class AIError extends Error {
  constructor(msg, { retryable = false } = {}) {
    super(msg);
    this.name = 'AIError';
    this.retryable = retryable;
  }
}

/* ---------- model catalogue --------------------------------------------- */

/**
 * Ask the endpoint what it serves. Queried live rather than hardcoded because
 * catalogues move constantly -- and for a local server it is the only way to know
 * which models you have actually pulled. Falls back to the preset's list.
 */
export async function listModels(ep) {
  const fallback = suggestedFor(ep?.id);
  if (ep?.kind === 'none') return [];
  if (ep?.kind === 'webgpu') {
    try { return await listBrowserModels(); } catch { return fallback; }
  }
  if (!ep?.baseUrl) return fallback;
  try {
    const res = await fetch(`${ep.baseUrl}/models`, { headers: authHeaders(ep) });
    if (!res.ok) return fallback;
    const j = await res.json();
    const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
    return ids.length ? ids.sort() : fallback;
  } catch {
    return fallback;                    // offline, CORS-blocked, or server not running
  }
}

/* ---------- transport ---------------------------------------------------- */

function authHeaders(ep) {
  return {
    ...(ep.headers || {}),
    ...(ep.token ? { Authorization: `Bearer ${ep.token}` } : {}),
  };
}

function explainHttp(status, body, ep) {
  const who = ep.label || 'The provider';
  if (status === 401 || status === 403) {
    return new AIError(ep.needsToken
      ? `${who} rejected the API key (${status}). Check it in Settings.`
      : `${who} refused the request (${status}). If it wants an API key, add one in Settings.`);
  }
  if (status === 402) return new AIError(`${who} is out of credit (402).${ep.id === 'huggingface' ? ' Free accounts get $0.10 a month; wait for the reset, pick a smaller model, or upgrade to PRO.' : ' Top up, or switch provider in Settings.'}`);
  if (status === 429) return new AIError(`Rate limited by ${who} (429). Wait a moment and retry.`, { retryable: true });
  if (status === 404) return new AIError(`${who} does not serve "${ep.model}". Pick another model in Settings.`);
  if (status >= 500) return new AIError(`${who} failed (${status}). This is usually transient.`, { retryable: true });
  return new AIError(`${who} returned ${status}: ${String(body).slice(0, 300)}`);
}

/** True when a 4xx looks like "this provider does not support that response_format". */
const isFormatComplaint = (body) => /response_format|json_schema|schema|not supported|unsupported|invalid.*format/i.test(String(body));

/**
 * One chat completion, degrading response_format until the endpoint accepts it.
 * Returns raw assistant text.
 */
async function chat(ep, messages, { schema = null, maxTokens = 1600, temperature = 0.2, onProgress } = {}) {
  if (!ep || ep.kind === 'none') {
    throw new AIError('AI is turned off. Pick a provider in Settings — including one that runs entirely on your own machine.');
  }

  if (ep.kind === 'webgpu') {
    if (!ep.model) throw new AIError('No local model chosen. Pick one in Settings.');
    try {
      return await browserChat(ep, messages, { schema, maxTokens, temperature, onProgress });
    } catch (e) {
      throw e instanceof AIError ? e : new AIError(e.message || 'The in-browser model failed to run.', { retryable: true });
    }
  }

  if (!ep.baseUrl) throw new AIError('No AI endpoint configured. Choose a provider in Settings.');
  if (ep.needsToken && !ep.token) throw new AIError(`No API key set for ${ep.label}. Add one in Settings to use AI features.`);

  const attempts = schema
    ? [
      { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema, strict: true } },
      { type: 'json_object' },
      null,
    ]
    : [null];

  let lastErr;
  for (const response_format of attempts) {
    const body = {
      model: ep.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      ...(response_format ? { response_format } : {}),
    };

    let res;
    try {
      res = await fetch(`${ep.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...authHeaders(ep), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // A blocked cross-origin request is indistinguishable from being offline here,
      // so name both -- for a local server the cause is nearly always CORS.
      throw new AIError(ep.local
        ? `Could not reach ${ep.label} at ${ep.baseUrl}. Is it running, and started with browser origins allowed?`
        : `Could not reach ${ep.label}. Check your connection, or whether that endpoint allows browser requests.`,
      { retryable: true });
    }

    if (res.ok) {
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content;
      if (!text) throw new AIError('The model returned an empty response. Try again or pick another model.', { retryable: true });
      return text;
    }

    const text = await res.text();
    lastErr = explainHttp(res.status, text, ep);
    // Only a format complaint is worth degrading for; anything else is terminal.
    if (!(res.status >= 400 && res.status < 500 && isFormatComplaint(text))) throw lastErr;
  }
  throw lastErr;
}

/**
 * Parse JSON from a model that may have added prose or code fences despite being
 * asked not to. Falls back to the outermost balanced braces.
 */
export function parseJSONLoose(text) {
  const cleaned = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new AIError('The model did not return usable JSON. Try again, or choose a different model in Settings.', { retryable: true });
}

/* ---------- what we send ------------------------------------------------- */

/**
 * Compact the board for the prompt. Excludes tasks flagged private, trims note
 * history, and drops fields the model has no use for — smaller prompts are
 * cheaper, faster and leak less.
 */
export function boardPayload(tasks, { includeNotes = true, noteLimit = 3 } = {}) {
  return tasks
    .filter((t) => !t.private && !t.deleted)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      tags: t.tags,
      ...(includeNotes && t.notes.length
        ? { recentNotes: t.notes.slice(-noteLimit).map((n) => n.text) }
        : {}),
    }));
}

const STATUS_ENUM = ['backlog', 'todo', 'in_progress', 'blocked', 'review', 'done'];
const PRIORITY_ENUM = ['low', 'normal', 'high', 'urgent'];

/* ---------- flow 1: brain dump -> proposed operations -------------------- */

/*
 * Schema note: every property is listed in `required`, with optional ones typed as
 * nullable, because strict JSON-schema modes reject partially-required objects and
 * do not reliably support oneOf. A flat, fully-required shape is the portable
 * choice across providers.
 */
const OPERATIONS_SCHEMA = {
  name: 'board_operations',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['operations'],
    properties: {
      operations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'taskId', 'title', 'status', 'priority', 'tags', 'text', 'rationale'],
          properties: {
            op: { type: 'string', enum: ['create', 'status', 'note', 'edit'] },
            taskId: { type: ['string', 'null'], description: 'Existing task id. Required for status/note/edit; null for create.' },
            title: { type: ['string', 'null'], description: 'Title for create, or a replacement title for edit.' },
            status: { type: ['string', 'null'], enum: [...STATUS_ENUM, null] },
            priority: { type: ['string', 'null'], enum: [...PRIORITY_ENUM, null] },
            tags: { type: ['array', 'null'], items: { type: 'string' } },
            text: { type: ['string', 'null'], description: 'Note body, for op=note.' },
            rationale: { type: 'string', description: 'One short clause: which words in the update justify this change.' },
          },
        },
      },
    },
  },
};

const OPS_SYSTEM = `You maintain a software engineer's task board. You translate an informal end-of-day or mid-day update into precise board operations.

Rules:
- STRONGLY prefer updating an existing task over creating a near-duplicate. Match on meaning, not exact wording.
- Use op="status" when work moved between states; op="note" to record progress, findings or blockers on a task that has not changed state; op="create" only for genuinely new work; op="edit" to fix a title, priority or tags.
- A task the user says they finished becomes status "done". Work they started becomes "in_progress". Work waiting on someone else becomes "blocked", and the reason belongs in a note.
- You may emit several operations for one task (e.g. a status change plus a note).
- Never invent work that the update does not mention. If the update is vague, emit fewer operations rather than guessing.
- taskId must be copied exactly from the board provided. Never invent an id; leave it null for op="create".
- rationale is one short clause pointing at the words that justify the operation.`;

/**
 * Turn a free-text update into proposed board operations.
 * Returns proposals for review — it never mutates anything.
 */
export async function proposeOperations({ endpoint, tasks, text, includeNotes = true, onProgress }) {
  if (!text || !text.trim()) throw new AIError('Nothing to interpret — write an update first.');

  const user = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    '',
    'Current board:',
    JSON.stringify(boardPayload(tasks, { includeNotes }), null, 1),
    '',
    "The engineer's update:",
    text.trim(),
  ].join('\n');

  const raw = await chat(endpoint, [
    { role: 'system', content: OPS_SYSTEM },
    { role: 'user', content: user },
  ], { schema: OPERATIONS_SCHEMA, temperature: 0.1, onProgress });

  const parsed = parseJSONLoose(raw);
  return sanitiseOperations(parsed.operations || [], tasks);
}

/**
 * Drop anything malformed or referring to a task that does not exist. The model is
 * untrusted input: a hallucinated task id must not become a silent no-op event, and
 * a bad enum must not corrupt the board.
 */
export function sanitiseOperations(ops, tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = [];

  for (const o of Array.isArray(ops) ? ops : []) {
    if (!o || typeof o !== 'object') continue;
    const op = String(o.op || '').toLowerCase();
    const clean = { op, rationale: typeof o.rationale === 'string' ? o.rationale : '' };

    if (op === 'create') {
      if (!o.title || !String(o.title).trim()) continue;
      clean.title = String(o.title).trim().slice(0, 200);
      clean.status = STATUS_ENUM.includes(o.status) ? o.status : 'todo';
      clean.priority = PRIORITY_ENUM.includes(o.priority) ? o.priority : 'normal';
      clean.tags = Array.isArray(o.tags) ? o.tags.filter((t) => typeof t === 'string').slice(0, 6) : [];
      out.push(clean);
      continue;
    }

    const target = byId.get(o.taskId);
    if (!target) continue;              // hallucinated or stale id
    clean.taskId = target.id;
    clean.targetTitle = target.title;   // for the review UI

    if (op === 'status') {
      if (!STATUS_ENUM.includes(o.status) || o.status === target.status) continue;
      clean.from = target.status;
      clean.status = o.status;
      out.push(clean);
    } else if (op === 'note') {
      if (!o.text || !String(o.text).trim()) continue;
      clean.text = String(o.text).trim().slice(0, 1000);
      out.push(clean);
    } else if (op === 'edit') {
      const fields = {};
      if (o.title && String(o.title).trim() && o.title !== target.title) fields.title = String(o.title).trim().slice(0, 200);
      if (PRIORITY_ENUM.includes(o.priority) && o.priority !== target.priority) fields.priority = o.priority;
      if (Array.isArray(o.tags)) {
        const tags = o.tags.filter((t) => typeof t === 'string').slice(0, 6);
        if (JSON.stringify(tags) !== JSON.stringify(target.tags)) fields.tags = tags;
      }
      if (!Object.keys(fields).length) continue;
      clean.fields = fields;
      out.push(clean);
    }
  }
  return out;
}

/* ---------- flow 2: executive summary ----------------------------------- */

const SUMMARY_SCHEMA = {
  name: 'daily_summary',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'bullets', 'risks', 'next'],
    properties: {
      headline: { type: 'string', description: 'One line, under 100 characters, stating the day at a glance.' },
      bullets: {
        type: 'array',
        description: 'Terse pointers, not prose. Max 6.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'taskIds'],
          properties: {
            text: { type: 'string', description: 'One pointer, under 140 characters. No leading bullet character.' },
            taskIds: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks this refers to, copied exactly.' },
          },
        },
      },
      risks: { type: 'array', items: { type: 'string' }, description: 'Blockers or things slipping. Empty if none.' },
      next: { type: 'array', items: { type: 'string' }, description: 'Suggested focus. Max 3. Empty if unclear.' },
    },
  },
};

const SUMMARY_SYSTEM = `You write an executive summary of a software engineer's day for the engineer themselves.

Style:
- POINTERS, NOT PROSE. Each bullet is a terse fragment, not a sentence with preamble.
- Concrete and specific. Name the work. Never pad with filler like "continued to make progress".
- Do not restate the board mechanically; say what CHANGED and what it means.
- If nothing happened, say so plainly in the headline rather than inventing activity.
- Attach the exact task ids each bullet refers to, copied from the input.
- risks: only genuine blockers or slippage. Empty array if none.
- next: at most three suggestions, grounded in what is in flight or blocked.`;

/**
 * Generate a summary.
 * @param {'morning'|'evening'} kind morning reports standing state; evening reports what moved.
 */
export async function summarise({ endpoint, tasks, events, kind = 'evening', previous = null, includeNotes = true, onProgress }) {
  const today = new Date().toISOString().slice(0, 10);
  const priv = new Set(tasks.filter((t) => t.private).map((t) => t.id));

  const todays = (events || [])
    .filter((e) => e.ts.slice(0, 10) === today && e.type !== 'summary.set' && !priv.has(e.taskId))
    .map((e) => ({ at: e.ts.slice(11, 16), type: e.type, taskId: e.taskId, ...(e.to ? { to: e.to } : {}), ...(includeNotes && e.text ? { text: e.text } : {}) }));

  const focus = kind === 'morning'
    ? 'Report where things STAND: what is in flight, what is blocked, what is stale. Suggest a focus for today.'
    : 'Report what MOVED today, based on the events. Call out anything that stalled.';

  const user = [
    `Today is ${today}. This is the ${kind} summary.`,
    focus,
    '',
    'Board:',
    JSON.stringify(boardPayload(tasks, { includeNotes }), null, 1),
    '',
    `Events logged today (${todays.length}):`,
    todays.length ? JSON.stringify(todays, null, 1) : '(none yet)',
    ...(previous?.headline ? ['', `Previous summary said: ${previous.headline}`] : []),
  ].join('\n');

  const raw = await chat(endpoint, [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: user },
  ], { schema: SUMMARY_SCHEMA, temperature: 0.3, onProgress });

  const p = parseJSONLoose(raw);
  const known = new Set(tasks.map((t) => t.id));

  return {
    headline: String(p.headline || '').slice(0, 200),
    bullets: (Array.isArray(p.bullets) ? p.bullets : []).slice(0, 6).map((b) => ({
      text: String(b?.text || '').slice(0, 240),
      taskIds: (Array.isArray(b?.taskIds) ? b.taskIds : []).filter((id) => known.has(id)),
    })).filter((b) => b.text),
    risks: (Array.isArray(p.risks) ? p.risks : []).slice(0, 5).map((r) => String(r).slice(0, 240)).filter(Boolean),
    next: (Array.isArray(p.next) ? p.next : []).slice(0, 3).map((r) => String(r).slice(0, 240)).filter(Boolean),
  };
}

/* ---------- applying proposals ------------------------------------------- */

/**
 * Convert approved operations into store events.
 *
 * Separate from proposeOperations() on purpose: the model proposes, the user
 * approves a subset in the review UI, and only then does anything become an event.
 * Pass only the operations the user actually checked.
 *
 * Note that ids for created tasks are minted HERE, not by the model, so a proposal
 * cannot reference a task it also proposes creating. That is deliberate — letting
 * the model invent ids is how stale or colliding ids get into the log.
 */
export function opsToEvents(ops) {
  const events = [];
  for (const o of Array.isArray(ops) ? ops : []) {
    switch (o?.op) {
      case 'create':
        events.push(makeEvent('task.create', {
          taskId: newTaskId(),
          title: o.title,
          status: o.status || 'todo',
          priority: o.priority || 'normal',
          tags: o.tags || [],
        }));
        break;
      case 'status':
        events.push(makeEvent('task.status', { taskId: o.taskId, from: o.from, to: o.status }));
        break;
      case 'note':
        events.push(makeEvent('task.note', { taskId: o.taskId, text: o.text }));
        break;
      case 'edit':
        events.push(makeEvent('task.edit', { taskId: o.taskId, fields: o.fields }));
        break;
      default:
        break;                          // sanitiseOperations should have dropped it
    }
  }
  return events;
}

/** Record a generated summary in the log, so it lands in the repo alongside the work. */
export function summaryEvent({ date, kind, summary, model }) {
  return makeEvent('summary.set', { date, kind, summary, model });
}
