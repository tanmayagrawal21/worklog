/**
 * reminder.js — deciding whether it is time to nag about the end of the day.
 *
 * Staged changes live in one browser and nowhere else. That is deliberate — nothing
 * reaches your repo without you seeing the commit — but it means forgetting to publish
 * costs you the day's log, and the app is the only thing in a position to notice.
 *
 * Pure on purpose. The whole question is a small pile of conditions that are awkward
 * to reproduce by hand in a browser (an evening, a stale date, an already-fired flag),
 * so they are decided here where a test can set the clock.
 */
import { localDate } from './store.js';

/** 'HH:MM' -> minutes since local midnight, or null if it is not a time. */
export function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export const formatHHMM = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * Should the reminder fire right now?
 *
 * @param {object} o
 * @param {string} o.at            configured local time, 'HH:MM'; '' or junk means off
 * @param {Date}   o.now           the current instant
 * @param {string} o.lastFired     local date it last fired, so it fires once a day
 * @param {boolean} o.hasPending   unpublished changes exist
 * @param {boolean} o.hasEveningSummary  today's evening summary is already written
 * @returns {{due:boolean, reason:'pending'|'summary'|'both'|null, today:string}}
 */
export function reminderDue({ at, now = new Date(), lastFired = '', hasPending = false, hasEveningSummary = false }) {
  const today = localDate(now.toISOString());
  const target = parseHHMM(at);
  const off = { due: false, reason: null, today };

  if (target === null) return off;
  // Once per local day. Opening the app at 21:00 after missing 17:30 still gets it,
  // because the check is "at or after", not "on the minute" -- a reminder that only
  // fires if you happened to have the tab open is not a reminder.
  if (lastFired === today) return off;
  if (now.getHours() * 60 + now.getMinutes() < target) return off;

  // Nothing to say is not worth saying. A day with everything published and the
  // evening summary written is a day that went right.
  if (!hasPending && hasEveningSummary) return off;

  const reason = hasPending && !hasEveningSummary ? 'both' : hasPending ? 'pending' : 'summary';
  return { due: true, reason, today };
}
