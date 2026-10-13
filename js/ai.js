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

import { makeEvent, newTaskId, todayISO, localDate, localTime } from './store.js';
import { PROVIDERS, DEFAULT_PROVIDER } from './providers.js';
import { browserChat, listBrowserModels } from './webllm.js';
import { ruleOperations, ruleSummary } from './rules.js';

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

/**
 * True when a 4xx is complaining about `response_format` specifically.
 *
 * Deliberately requires one of the format words to appear. An earlier version also
 * matched a bare "unsupported", which made a gateway refusing `temperature` look like
 * a schema complaint -- so the retry dropped the wrong knob three times and then gave
 * up with a misleading message.
 */
const isFormatComplaint = (body) => /response_format|json_schema|json_object|structured output/i.test(String(body));

/**
 * Sampling knobs are a preference, not a requirement. Some gateways pin them: a
 * LiteLLM proxy in front of a reasoning model answers `temperature=0.3` with
 * "Only temperature=1 is supported". Dropping the param and asking again is better
 * than failing the feature over a number we do not care much about.
 */
const DROPPABLE_PARAMS = ['temperature', 'top_p'];

/**
 * Which parameter a 4xx is refusing, if it is refusing one of ours.
 * Returns 'max_tokens' too, which is not droppable but is sometimes just renamed.
 */
export function refusedParam(body) {
  const s = String(body);
  if (!/unsupported|not support|unrecognized|unrecognised|unknown|unexpected|invalid|only .* is supported/i.test(s)) return null;
  for (const p of [...DROPPABLE_PARAMS, 'max_tokens']) {
    if (new RegExp(`\\b${p}\\b`).test(s)) return p;
  }
  return null;
}

/** OpenAI's reasoning models renamed max_tokens; the error body says so when they did. */
const wantsMaxCompletionTokens = (body) => /max_completion_tokens/.test(String(body));

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

  // Two independent things an endpoint may refuse: the response format, and the
  // parameters. Both are negotiated down in the same loop rather than failing --
  // the point is to get an answer from whatever the user actually pointed us at.
  const formats = schema
    ? [
      { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema, strict: true } },
      { type: 'json_object' },
      null,
    ]
    : [null];

  const dropped = new Set();
  let tokensKey = 'max_tokens';
  let fi = 0;
  let lastErr;

  // Bounded: each pass either advances the format or drops a param, both finite.
  for (let guard = 0; guard < formats.length + DROPPABLE_PARAMS.length + 2; guard++) {
    if (fi >= formats.length) break;

    const body = {
      model: ep.model,
      messages,
      [tokensKey]: maxTokens,
      ...(dropped.has('temperature') ? {} : { temperature }),
      ...(formats[fi] ? { response_format: formats[fi] } : {}),
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
    if (!(res.status >= 400 && res.status < 500)) throw lastErr;

    const bad = refusedParam(text);
    if (bad === 'max_tokens' && tokensKey === 'max_tokens' && wantsMaxCompletionTokens(text)) {
      tokensKey = 'max_completion_tokens';
      continue;
    }
    if (bad && DROPPABLE_PARAMS.includes(bad) && !dropped.has(bad)) {
      dropped.add(bad);
      continue;
    }
    // Param complaints are checked first on purpose: they are the specific reading of
    // a body that mentions both, and the format ladder is the blunter instrument.
    if (isFormatComplaint(text)) { fi++; continue; }
    throw lastErr;
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

  // The demo interpreter joins here rather than inside chat(), because it works on the
  // structured board instead of a prompt -- and it goes through the same sanitiser, so
  // the review UI cannot tell which of the two produced what it is showing.
  if (endpoint?.kind === 'rules') return sanitiseOperations(ruleOperations({ tasks, text }), tasks);

  const user = [
    `Today is ${todayISO()} (the engineer's local date).`,
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

/** How far back a morning summary looks. Long enough to notice a stall, short enough to read. */
const MORNING_DAYS = 7;

/**
 * Which events a summary is allowed to describe.
 *
 * The split matters and used to be wrong. An evening summary is about today, so it
 * reads today. A morning summary is written before the day has happened -- reading
 * today's events would make it describe work you have not done yet, and on the first
 * run of a new day there are none anyway. So morning reads the days BEFORE today, and
 * the day boundary is the local one (see store.localDate).
 */
export function summaryWindow(events, kind, { today = todayISO(), days = MORNING_DAYS } = {}) {
  const evs = (events || []).filter((e) => e.type !== 'summary.set');
  if (kind === 'morning') {
    const from = localDate(new Date(`${today}T12:00:00`).getTime() - days * 86400000);
    return evs.filter((e) => { const d = localDate(e.ts); return d < today && d >= from; });
  }
  return evs.filter((e) => localDate(e.ts) === today);
}

/**
 * Generate a summary.
 * @param {'morning'|'evening'} kind morning reports standing state; evening reports what moved.
 */
export async function summarise({ endpoint, tasks, events, kind = 'evening', previous = null, includeNotes = true, onProgress }) {
  const today = todayISO();
  const priv = new Set(tasks.filter((t) => t.private).map((t) => t.id));

  const window = summaryWindow(events, kind, { today })
    .filter((e) => !priv.has(e.taskId))
    .map((e) => ({
      on: localDate(e.ts), at: localTime(e.ts), type: e.type, taskId: e.taskId,
      ...(e.to ? { to: e.to } : {}), ...(includeNotes && e.text ? { text: e.text } : {}),
    }));

  const focus = kind === 'morning'
    ? 'Report where things STAND at the start of today: what is in flight, what is blocked, what has gone stale. Suggest a focus for today. The events below are from BEFORE today — today has not happened yet, so do not describe it as if it had.'
    : 'Report what MOVED today, based on the events. Call out anything that stalled.';

  const label = kind === 'morning'
    ? `Events from the ${MORNING_DAYS} days before today (${window.length})`
    : `Events logged today (${window.length})`;

  if (endpoint?.kind === 'rules') {
    return clampSummary(
      ruleSummary({ tasks: tasks.filter((t) => !t.private && !t.deleted), events: window, kind }),
      tasks,
    );
  }

  const user = [
    `Today is ${today} (the engineer's local date; times below are local too). This is the ${kind} summary.`,
    focus,
    '',
    'Board:',
    JSON.stringify(boardPayload(tasks, { includeNotes }), null, 1),
    '',
    `${label}:`,
    window.length ? JSON.stringify(window, null, 1) : '(none)',
    ...(previous?.headline ? ['', `Previous summary said: ${previous.headline}`] : []),
  ].join('\n');

  const raw = await chat(endpoint, [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: user },
  ], { schema: SUMMARY_SCHEMA, temperature: 0.3, onProgress });

  return clampSummary(parseJSONLoose(raw), tasks);
}

/**
 * Trim a summary to what the UI will render and drop task ids that do not exist.
 *
 * Applied to the rule engine's output too, even though that output is ours: a bullet
 * pointing at a task the board does not have would render a dead button either way, and
 * one clamp is easier to trust than two.
 */
function clampSummary(p, tasks) {
  const known = new Set(tasks.map((t) => t.id));
  return {
    headline: String(p?.headline || '').slice(0, 200),
    bullets: (Array.isArray(p?.bullets) ? p.bullets : []).slice(0, 6).map((b) => ({
      text: String(b?.text || '').slice(0, 240),
      taskIds: (Array.isArray(b?.taskIds) ? b.taskIds : []).filter((id) => known.has(id)),
    })).filter((b) => b.text),
    risks: (Array.isArray(p?.risks) ? p.risks : []).slice(0, 5).map((r) => String(r).slice(0, 240)).filter(Boolean),
    next: (Array.isArray(p?.next) ? p.next : []).slice(0, 3).map((r) => String(r).slice(0, 240)).filter(Boolean),
  };
}

/* ---------- flow 3: the report you post to your team --------------------- */

const STANDUP_SCHEMA = {
  name: 'standup_report',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['groups'],
    properties: {
      groups: {
        type: 'array',
        description: 'One per project. Keep the project strings exactly as given.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['project', 'lines'],
          properties: {
            project: { type: 'string', description: 'Copied exactly from the input, or "" if the input had none.' },
            lines: {
              type: 'array',
              items: { type: 'string', description: 'One thing done. Verb first, no bullet character, no task id.' },
            },
          },
        },
      },
    },
  },
};

const STANDUP_SYSTEM = `You write one engineer's end-of-day report for their team channel.

This is NOT a summary and NOT an executive briefing. It is the plain list a working engineer posts at 5pm so colleagues know what moved.

Style, which the examples demonstrate — follow them over any instinct of your own:
- VERB FIRST, past tense, concrete. "Fixed the tcp buffer sizing", not "Work on buffers" and not "Buffer sizing task".
- Say what the change DOES or what you LEARNED when the input tells you, in the same line, after a full stop. Keep it to one or two clauses.
- One line per piece of work. Merge two inputs into one line when they are the same piece of work.
- Keep ticket ids, repo names, paths, URLs and numbers exactly as written. They are the useful part.
- NEVER write status words as labels or headings: no "Done:", no "In progress:", no "Blocked:", no "Status:". If something is stuck or unfinished, say it the way a person would — "waiting on the security team", "still digging", "did not get far".
- No preamble, no sign-off line, no "Today I", no summarising sentence at the end. Lines only.
- Never invent work, numbers, names or outcomes that the input does not contain. Fewer lines is correct when the input is thin.
- Never output an internal task id (anything shaped like T-a1b2c3).`;

/*
 * Few-shot, because this is a style transfer job and a described style does not
 * survive contact with a model the way a demonstrated one does. The four pairs are
 * shaped on how people on this team actually report: a terse lowercase-fragment
 * writer, a "Verbed X. What it does." writer, one who merges related work into a
 * single line, and one who writes a project as flowing prose with the finding in it.
 * Content is invented; only the shapes are borrowed.
 */
const STANDUP_SHOTS = [
  {
    in: [
      { project: 'AI-Assistant', task: 'point docs at the new domain', didToday: 'swapped the CNAME and fixed the broken /docs links' },
      { project: 'AI-Assistant', task: 'add the new model ids' },
      { project: 'GenAI', task: 'external web search spike', didToday: 'empty responses turned out to be a quota error, not our code' },
    ],
    out: {
      groups: [
        { project: 'AI-Assistant', lines: ['moved docs to the new domain and fixed the broken /docs links', 'added the new model ids'] },
        { project: 'GenAI', lines: ['debugged the empty responses from web search — it was a quota error on their side, not our code'] },
      ],
    },
  },
  {
    in: [
      { project: 'go-irodsclient', task: 'tcp buffer setting bugs', didToday: 'wrong size was being applied on reconnect' },
      { project: 'go-irodsclient', task: 'cover small file upload and download in tests' },
    ],
    out: {
      groups: [
        {
          project: 'go-irodsclient',
          lines: [
            'Fixed tcp buffer setting bugs — the wrong size was being applied on reconnect',
            'Updated tests to cover small file upload and download',
          ],
        },
      ],
    },
  },
  {
    in: [
      { project: 'AI Assistant', task: 'custom error pages', didToday: 'added pages for user and workspace permission errors' },
      { project: 'AI Assistant', task: 'logout button for errored users', didToday: 'still showing nothing when /users/mine itself errors' },
    ],
    out: {
      groups: [
        {
          project: 'AI Assistant',
          lines: [
            'Added custom error pages and improved handling for user and workspace permission errors',
            'Working on showing the user menu and logout button when the user is logged in but /users/mine errors',
          ],
        },
      ],
    },
  },
  {
    in: [
      { project: 'MDRepo', task: 'review page for ingest approvals', didToday: 'added a Gates page, working well in testing' },
      { project: 'MDRepo', task: 'paper search', didToday: 'fixed two bugs; lots of the papers turn out to be paywalled, asking Travis what to do' },
    ],
    out: {
      groups: [
        {
          project: 'MDRepo',
          lines: [
            "Added a 'Gates' page to review the human-in-the-loop approvals for each ingest attempt. Working well in testing so far",
            'Found and fixed a couple of issues with how we search for papers, and discovered many of them are behind paywalled publishers — talking to Travis about whether we deal with that at all',
          ],
        },
      ],
    },
  },
];

/** The messages that teach the style. Built once per call; cheap and stateless. */
function standupShots() {
  return STANDUP_SHOTS.flatMap((s) => [
    { role: 'user', content: JSON.stringify(s.in) },
    { role: 'assistant', content: JSON.stringify(s.out) },
  ]);
}

/**
 * Rewrite the day into the lines a colleague would actually post.
 *
 * The mechanical draft in standup.js is already correct; what it cannot do is phrase
 * the work the way a person does, because that is a rewriting job rather than a
 * lookup. Returns groups only — the caller renders them, so the layout, the first
 * line and your own edits are never the model's to decide.
 *
 * @returns {Promise<Array<{project: string, lines: string[]}>>}
 */
export async function writeStandup({ endpoint, payload, draft = '', includeNotes = true, onProgress }) {
  const items = Array.isArray(payload) ? payload : [];
  const keep = String(draft || '').trim();
  if (!items.length && !keep) throw new AIError('Nothing logged for today, so there is nothing to write up.');

  if (endpoint?.kind === 'rules') return ruleStandup(items, keep);

  // A draft means the engineer has already written something, and their words beat
  // ours: the job becomes tidying what they wrote and filling in what they missed.
  // Sent as ONE user message so the shots above stay the pattern being followed --
  // and because a second consecutive user turn upsets some gateways.
  const ask = keep
    ? [
      JSON.stringify(items),
      '',
      'The engineer has already written this report themselves:',
      '',
      keep,
      '',
      'Keep their wording, their lines and their order, and do not drop anything they wrote.'
        + ' Use the items above only to tidy phrasing and to add work they left out.',
    ].join('\n')
    : JSON.stringify(items);

  const raw = await chat(endpoint, [
    { role: 'system', content: STANDUP_SYSTEM },
    ...standupShots(),
    { role: 'user', content: ask },
  ], { schema: STANDUP_SCHEMA, temperature: 0.4, onProgress });

  return clampStandup(parseJSONLoose(raw), items, { includeNotes, draft: keep });
}

/**
 * The model is untrusted input, and this output goes to the user's colleagues.
 *
 * So: no more lines than there were pieces of work (a model that starts narrating
 * cannot invent a workstream), nothing longer than a chat line, no bullet characters
 * it added back, no internal task ids, and projects it did not get from us are
 * dropped rather than becoming a heading nobody recognises.
 */
export function clampStandup(parsed, items, { includeNotes = true, draft = '' } = {}) {
  const known = new Set(items.map((i) => i.project || ''));
  // A hand-written draft raises both limits, because then the engineer's own text is
  // the authority on what belongs in the report: they may have written eight lines
  // about three tasks, or named a project the board has never heard of.
  const written = String(draft || '').split('\n').filter((l) => l.trim()).length;
  const budget = Math.max(items.length, written, 1);
  const trustDraft = !!written;
  const out = [];
  let used = 0;

  for (const g of Array.isArray(parsed?.groups) ? parsed.groups : []) {
    const project = typeof g?.project === 'string' ? g.project.trim() : '';
    if (project && !trustDraft && !known.has(project)) continue;

    const lines = [];
    for (const raw of Array.isArray(g?.lines) ? g.lines : []) {
      if (used >= budget) break;
      const text = String(raw || '')
        .replace(/\s+/g, ' ')
        .replace(/^[-*••]\s*/, '')          // a bullet we are about to add ourselves
        .replace(/\bT-[0-9a-z]{6}\b/g, '')       // internal ids are not for this audience
        .replace(/^(done|in progress|blocked|in review|status)\s*[:–-]\s*/i, '')
        .trim()
        .slice(0, 400);
      if (!text) continue;
      lines.push(text);
      used++;
    }
    if (lines.length) out.push({ project, lines });
    if (used >= budget) break;
  }

  // A model that answered with nothing usable is a failure, not an empty report:
  // silently handing back a blank box would look like the day had no work in it.
  if (!out.length) {
    throw new AIError('The model did not return a usable report. Try again, or copy the draft as it is.', { retryable: true });
  }
  return includeNotes ? out : out.map((g) => ({ ...g, lines: g.lines.map((l) => l.split(' — ')[0]) }));
}

/**
 * The no-model path for the demo: group the input as given, in the user's own words.
 * Deliberately not clever — the point of the demo's interpreter is to show the shape
 * of the flow, and pretending to rewrite prose with keyword rules would be a lie.
 */
function ruleStandup(items, draft = '') {
  // Nothing a keyword rule can add to text a person wrote, so it is handed back.
  if (draft) return [{ project: '', lines: draft.split('\n').filter((l) => l.trim()) }];

  const byProject = new Map();
  for (const i of items) {
    const key = i.project || '';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(i.didToday || i.task);
  }
  return [...byProject.entries()].map(([project, lines]) => ({ project, lines }));
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
