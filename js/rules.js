/**
 * rules.js — the interpreter behind the demo, so the AI half of the loop can be tried
 * without an account, a key, or a decision about what to trust with your work log.
 *
 * This is not a model and never claims to be one. It is a few dozen keyword rules over
 * exactly the inputs ai.js would have sent a provider, producing exactly the shapes it
 * would have got back. That is enough to answer the question a newcomer actually has --
 * "does it propose sensible changes, and do I really get to say no first?" -- before
 * they paste anything anywhere. Its proposals go through sanitiseOperations() and the
 * same review checkboxes as a real model's, because demonstrating the real path is the
 * whole point; a bypass would demonstrate nothing.
 *
 * Wired in as a provider with kind 'rules' (providers.js), selected automatically under
 * ?demo=1 when nothing else is configured. Every view that can reach it says so in
 * words: rules, not a model. Being obviously dumber than a model is fine. Being quietly
 * mistaken for one is not.
 */
import { statusLabel } from './store.js';

/* ---------- reading a line of English ------------------------------------ */

// Words that carry no signal about which task a line is about. Not linguistics, just
// the ones that were matching everything.
const STOP = new Set(('a an the of to for on in at is are was were be been being am do did does done'
  + ' and or but with without from into as by it its this that these those there here so then than'
  + ' not no nor too very just also still yet about over under up down out off again more most some'
  + ' any all can could should would will shall may might must have has had if when while because'
  + ' get got make made take took use used using i me my we us our you your they them their he she'
  + ' now today yesterday tomorrow bit lot thing things stuff').split(' '));

// Trailing punctuation is dropped but internal is kept, so "review." matches the word
// "review" while "node.js" and "v1.2" stay one token. Without this, every word ending a
// sentence quietly failed to match anything.
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9][a-z0-9'+_.-]*/g) || [])
  .map((w) => w.replace(/[.'+_-]+$/, ''))
  .filter(Boolean);
const keyWords = (s) => words(s).filter((w) => w.length > 2 && !STOP.has(w));

/**
 * What a line says happened, if anything.
 *
 * Order is a judgement, not an accident: a line that mentions being blocked is about
 * the blocker whatever else it says, and "pushed it for review" is more precise than
 * the "finished" in the same breath. Started comes last because it is the weakest cue.
 */
const INTENTS = [
  { to: 'blocked',     re: /\b(blocked|blocking|waiting on|waiting for|stuck|held up|can'?t proceed|cannot proceed|no reply from)\b/ },
  { to: 'review',      re: /\b(in review|for review|up for review|pr (?:is )?up|pull request|raised a pr|sent it out|awaiting review)\b/ },
  { to: 'done',        re: /\b(finish(?:ed)?|ship(?:ped)?|done|complete[d]?|merged|landed|closed(?: out)?|wrapped up|deployed)\b/ },
  { to: 'in_progress', re: /\b(start(?:ed|ing)?|began|begun|picked (?:it )?up|working on|carried on|continuing|digging|looking (?:at|into)|kicked off|in progress)\b/ },
];

// Cues are written lowercase, so the line is folded before matching -- "Finished the
// retry logic" is the common case and must not be missed for its capital F.
const intentOf = (line) => {
  const l = String(line).toLowerCase();
  for (const i of INTENTS) {
    const m = l.match(i.re);
    if (m) return { to: i.to, word: m[0] };
  }
  return null;
};

const PRIORITY_CUES = [
  ['urgent', /\b(urgent|asap|critical|p0|right away|on fire)\b/],
  ['high',   /\b(important|high priority|(?:by|before|due) (?:mon|tues|wednes|thurs|fri|satur|sun)day|by eod|end of day|deadline|before the release)\b/],
  ['low',    /\b(someday|nice to have|low priority|eventually|when there is time)\b/],
];

const priorityOf = (line) => PRIORITY_CUES.find(([, re]) => re.test(String(line).toLowerCase()))?.[0] || 'normal';

/** Strip the "new:" / "need to" scaffolding off a line before it becomes a title. */
function asTitle(line) {
  let t = line.replace(/^\s*(new|todo|to-?do|next|also)\s*[:\-–]\s*/i, '')
    .replace(/^\s*(i\s+)?(need|have|want|ought)\s+to\s+/i, '')
    .replace(/^\s*(should|must|will)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!\s]+$/, '')
    .trim();
  if (t.length > 90) {
    const cut = t.slice(0, 90);
    t = `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 90)}…`;
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Which task a line is about, or null.
 *
 * Scores on the share of the TASK's words that turn up in the line, not the line's,
 * because otherwise a long paragraph matches every task on the board simply by being
 * long. An explicit id wins outright — people who type T-4f9a2c mean it.
 */
export function matchTask(line, tasks) {
  const explicit = line.match(/\bT-[a-z0-9]{4,}\b/i);
  if (explicit) {
    const hit = tasks.find((t) => t.id.toLowerCase() === explicit[0].toLowerCase());
    if (hit) return { task: hit, score: 1, why: explicit[0] };
  }

  const seen = new Set(keyWords(line));
  let best = null;
  for (const t of tasks) {
    const own = keyWords(`${t.title} ${(t.tags || []).join(' ')}`);
    if (!own.length) continue;
    const hits = [...new Set(own.filter((w) => seen.has(w)))];
    if (!hits.length) continue;
    // The bonus is what lets a two-word hit on a long title through: "retry logic" is a
    // confident match for "Retry logic for the ingest worker" despite the other words.
    const score = hits.length / new Set(own).size + (hits.length >= 2 ? 0.25 : 0);
    if (!best || score > best.score) best = { task: t, score, why: hits.join(', ') };
  }
  return best && best.score >= 0.34 ? best : null;
}

/** One line per sentence, blank ones dropped. Bullets and dashes are common here. */
const lines = (text) => String(text)
  .split(/\n+/)
  .flatMap((l) => l.split(/[.!?;]+\s+/))
  .map((l) => l.replace(/^\s*[-*•\d.)\s]+/, '').trim())
  .filter((l) => l.length > 2);

/* ---------- flow 1: text -> proposed operations --------------------------- */

/**
 * Same contract as the model path: proposals in the pre-sanitise shape, nothing
 * applied. Emits a status change when a line says work moved, a note when the line
 * carries detail worth keeping, and a task when it recognises nothing to attach to.
 */
export function ruleOperations({ tasks = [], text = '' }) {
  const open = tasks.filter((t) => !t.deleted);
  const knownTags = new Set(open.flatMap((t) => t.tags || []));
  const ops = [];
  const noted = new Set();

  for (const line of lines(text)) {
    const intent = intentOf(line);
    const m = matchTask(line, open);

    if (m) {
      const where = `matched ${m.task.id} on "${m.why}"`;
      const moved = intent && intent.to !== m.task.status;
      if (moved) {
        ops.push({
          op: 'status', taskId: m.task.id, status: intent.to,
          rationale: `"${intent.word}" — ${where}`,
        });
      }
      // Note it unless the status change already says everything the line said: a line
      // that proposed nothing would otherwise vanish, the reason is the useful half of a
      // blocker, and a long line usually carries something a status alone loses.
      const worthNoting = !moved || intent.to === 'blocked' || words(line).length > 6;
      const key = `${m.task.id}|${line.toLowerCase()}`;
      if (worthNoting && !noted.has(key)) {
        noted.add(key);
        ops.push({ op: 'note', taskId: m.task.id, text: line, rationale: where });
      }
      continue;
    }

    // Nothing on the board looks like this line, so it is new work -- the same call the
    // model prompt is told to make, and just as fallible, which is what review is for.
    if (keyWords(line).length < 2) continue;
    ops.push({
      op: 'create',
      title: asTitle(line),
      status: intent && intent.to !== 'done' ? intent.to : intent ? 'done' : 'todo',
      priority: priorityOf(line),
      tags: [...knownTags].filter((tag) => words(line).includes(tag.toLowerCase())).slice(0, 3),
      rationale: 'nothing on the board matched this line',
    });
  }
  return ops;
}

/* ---------- flow 2: board + events -> a summary --------------------------- */

const excerpt = (s, n = 90) => (String(s).length > n ? `${String(s).slice(0, n).trimEnd()}…` : String(s));

/**
 * A summary composed rather than written: counts, what moved, what is blocked, what is
 * worth picking up. Deliberately reads as a tally, because a rule engine has no view on
 * what any of it means and should not sound as though it does.
 *
 * `events` is the already-windowed, already-private-filtered list summarise() built, so
 * this sees exactly what a provider would have seen.
 */
export function ruleSummary({ tasks = [], events = [], kind = 'evening' }) {
  const open = tasks.filter((t) => !t.deleted);
  const byId = new Map(open.map((t) => [t.id, t]));
  const titleOf = (id) => byId.get(id)?.title || id;
  const inStatus = (s) => open.filter((t) => t.status === s);

  const touched = new Map();
  for (const e of events) {
    // An event about a task we were not given -- deleted, or filtered out as private --
    // can only produce a bullet pointing at nothing.
    if (!e.taskId || !byId.has(e.taskId)) continue;
    const rec = touched.get(e.taskId) || { moves: [], notes: [], created: false };
    if (e.type === 'task.status' && e.to) rec.moves.push(e.to);
    else if (e.type === 'task.note') rec.notes.push(e.text || '');
    else if (e.type === 'task.create') rec.created = true;
    touched.set(e.taskId, rec);
  }

  const finished = [...touched].filter(([, r]) => r.moves.includes('done'));
  const blocked = inStatus('blocked');
  const flight = inStatus('in_progress');

  const headline = kind === 'morning'
    ? (open.length
      ? `Standing: ${flight.length} in flight, ${blocked.length} blocked, ${inStatus('todo').length} queued, ${inStatus('review').length} in review.`
      : 'Nothing on the board yet.')
    : (events.length
      ? `Today: ${finished.length} finished, ${[...touched].filter(([, r]) => r.moves.length).length} moved, ${events.filter((e) => e.type === 'task.note').length} notes across ${touched.size} tasks.`
      : 'Nothing logged today.');

  const bullets = kind === 'morning'
    ? [...flight, ...blocked, ...inStatus('review')].slice(0, 6).map((t) => ({
      text: `${t.title} — ${statusLabel(t.status)}${touched.has(t.id) ? '' : ', no activity in this window'}`,
      taskIds: [t.id],
    }))
    : [...touched]
      .sort((a, b) => (b[1].moves.length + b[1].notes.length) - (a[1].moves.length + a[1].notes.length))
      .slice(0, 6)
      .map(([id, r]) => {
        const bits = [];
        if (r.created) bits.push('added');
        if (r.moves.length) bits.push(`now ${statusLabel(r.moves[r.moves.length - 1])}`);
        if (r.notes.length) bits.push(r.notes.length === 1 ? excerpt(r.notes[0]) : `${r.notes.length} notes`);
        return { text: `${titleOf(id)} — ${bits.join('; ') || 'touched'}`, taskIds: [id] };
      });

  return {
    headline,
    bullets,
    risks: blocked.slice(0, 5).map((t) => {
      const last = t.notes?.length ? t.notes[t.notes.length - 1].text : '';
      return `Blocked: ${t.title}${last ? ` — ${excerpt(last)}` : ''}`;
    }),
    next: [...flight, ...inStatus('todo')]
      .sort((a, b) => rank(b.priority) - rank(a.priority))
      .slice(0, 3)
      .map((t) => `${t.title} (${t.priority} priority, ${statusLabel(t.status)})`),
  };
}

const rank = (p) => ({ urgent: 3, high: 2, normal: 1, low: 0 }[p] ?? 1);
