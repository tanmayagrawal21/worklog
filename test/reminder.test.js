/**
 * reminder.test.js — when the end-of-day nudge fires, and when it stays quiet.
 *
 * Every condition here is one someone would otherwise have to wait until evening to
 * see, which is exactly why the decision was pulled out of the app into a pure
 * function. The two that matter most: it must not fire twice in a day, and it must
 * still fire for someone who opens the tab hours late.
 */
import './shim.js';
import { check, eq, ok, report } from './shim.js';
import { reminderDue, parseHHMM, formatHHMM } from '../js/reminder.js';
import { localDate } from '../js/store.js';

/** A local wall-clock time today, whatever zone this run is in. */
const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
const today = () => localDate(new Date().toISOString());

console.log('reminder.js');

/* ---- parsing ------------------------------------------------------------ */

check('a time parses to minutes past midnight', () => {
  eq(parseHHMM('17:30'), 1050);
  eq(parseHHMM('00:00'), 0);
  eq(parseHHMM('9:05'), 545);
});

check('nonsense is off, not midnight', () => {
  eq(parseHHMM(''), null);
  eq(parseHHMM('later'), null);
  eq(parseHHMM('25:00'), null, 'hour out of range');
  eq(parseHHMM('17:60'), null, 'minute out of range');
  eq(parseHHMM(null), null);
});

check('formatting round-trips', () => {
  eq(formatHHMM(1050), '17:30');
  eq(formatHHMM(parseHHMM('09:05')), '09:05');
});

/* ---- the decision ------------------------------------------------------- */

check('fires in the evening with work unpublished', () => {
  const r = reminderDue({ at: '17:30', now: at(18), hasPending: true, hasEveningSummary: true });
  ok(r.due);
  eq(r.reason, 'pending', 'the summary is written, so publishing is the whole message');
  eq(r.today, today(), 'and reports the local date it fired for');
});

check('stays quiet before the time', () => {
  ok(!reminderDue({ at: '17:30', now: at(16, 59), hasPending: true }).due);
});

check('fires at exactly the time', () => {
  ok(reminderDue({ at: '17:30', now: at(17, 30), hasPending: true }).due);
});

check('a tab opened hours late still gets it', () => {
  ok(reminderDue({ at: '17:30', now: at(23, 45), hasPending: true }).due,
    'a reminder that needs the tab already open is not a reminder');
});

check('but not after midnight, when it is a different day', () => {
  ok(!reminderDue({ at: '17:30', now: at(2), hasPending: true }).due);
});

check('once a day only', () => {
  ok(!reminderDue({ at: '17:30', now: at(18), lastFired: today(), hasPending: true }).due);
});

check('yesterday having fired does not count', () => {
  ok(reminderDue({ at: '17:30', now: at(18), lastFired: '2001-01-01', hasPending: true }).due);
});

check('a missing evening summary is reason enough', () => {
  const r = reminderDue({ at: '17:30', now: at(18), hasPending: false, hasEveningSummary: false });
  ok(r.due);
  eq(r.reason, 'summary');
});

check('both reasons are reported as both', () => {
  eq(reminderDue({ at: '17:30', now: at(18), hasPending: true, hasEveningSummary: false }).reason, 'both');
});

check('a day that went right is left alone', () => {
  ok(!reminderDue({ at: '17:30', now: at(18), hasPending: false, hasEveningSummary: true }).due,
    'nothing staged and the summary written is not worth interrupting');
});

check('no configured time means never', () => {
  ok(!reminderDue({ at: '', now: at(23), hasPending: true }).due);
  ok(!reminderDue({ at: 'evening', now: at(23), hasPending: true }).due);
  ok(!reminderDue({ at: undefined, now: at(23), hasPending: true }).due);
});

check('a midnight setting is a real setting, not an off switch', () => {
  ok(reminderDue({ at: '00:00', now: at(0, 1), hasPending: true }).due);
});

check('defaults are quiet: no arguments, nothing fires', () => {
  ok(!reminderDue({}).due);
});

globalThis.exitCode = report('reminder');
