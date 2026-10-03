// Weekly streak maths. Pure (no db/DOM imports) so it runs under plain Node:
//   node test/unit/streak.test.mjs

// Local calendar day (YYYY-MM-DD) — not toISOString(), which is UTC.
const localYMD = (d = new Date()) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

function mondayOf(d) {
  const x = new Date(d); x.setHours(12, 0, 0, 0);
  const day = (x.getDay() + 6) % 7; // Mon=0
  x.setDate(x.getDate() - day);
  return localYMD(x);
}
function weekBefore(mondayIso) {
  const x = new Date(mondayIso + 'T12:00:00');
  x.setDate(x.getDate() - 7);
  return localYMD(x);
}
function addDays(iso, n) {
  const x = new Date(iso + 'T12:00:00');
  x.setDate(x.getDate() + n);
  return localYMD(x);
}

// Mondays of every week touched by an illness period. `to` null = still unwell
// (runs to today). Capped at a year per period so a bad date can't spin.
export function sickWeeks(sick = [], today = localYMD()) {
  const weeks = new Set();
  for (const p of sick) {
    if (!p?.from) continue;
    const to = p.to || today;
    let d = p.from;
    for (let i = 0; d <= to && i < 366; i++, d = addDays(d, 1)) weeks.add(mondayOf(new Date(d + 'T12:00:00')));
  }
  return weeks;
}

// The open (still unwell) illness period, if any.
export const currentIllness = (sick = []) => sick.find(p => p?.from && !p.to) || null;

// Consecutive weeks (ending now) with >= target workouts. The in-progress week
// counts if already met, and never breaks the chain while pending. A week with
// illness days that misses the target is paused: it neither adds to nor breaks
// the chain. If the unbroken chain reaches back to the week the seed was set,
// the seed is added.
export function computeStreak(sessions, { seed = 0, seedDate = null, target = 3, sick = [] } = {}, now = new Date()) {
  const counts = {};
  for (const s of sessions) {
    const d = s.date || (s.startTime || '').slice(0, 10);
    if (!d) continue;
    const wk = mondayOf(new Date(d + 'T12:00:00'));
    counts[wk] = (counts[wk] || 0) + 1;
  }
  const paused = sickWeeks(sick, localYMD(now));

  const thisWeek = mondayOf(now);
  let weeks = 0, pausedWeeks = 0;
  let cursor = thisWeek;
  if ((counts[cursor] || 0) >= target) { weeks++; }
  cursor = weekBefore(cursor); // pending current week never breaks the chain
  for (;;) {
    if ((counts[cursor] || 0) >= target) weeks++;
    else if (paused.has(cursor)) pausedWeeks++;
    else break;
    cursor = weekBefore(cursor);
  }

  // cursor is now the first week that FAILED. Seed bridges if every week after
  // the seed week met the target or was paused (or the seed was set this/last week).
  let total = weeks;
  if (seed > 0 && seedDate) {
    const seedWeek = mondayOf(new Date(seedDate + 'T12:00:00'));
    if (cursor <= seedWeek) total = weeks + seed;
  }
  return { weeks: total, thisWeekCount: counts[thisWeek] || 0, target,
           pausedWeeks, pausedNow: paused.has(thisWeek) };
}
