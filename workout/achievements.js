// Personal bests, milestones and the weekly streak.
// Pure functions over session records + a small settings blob in db.
import db from '../shared/db.js';


const STORE = 'workout';

export { e1RM, buildRecords, detectPBs, absorbSet, sessionPBs } from './records.js';

// ── Weekly streak ─────────────────────────────────────────────────────────────
export { computeStreak, currentIllness } from './streak.js';
export async function getStreakSettings() {
  const s = (await db.get(STORE, 'streak-settings')) || {};
  return { seed: s.seed || 0, seedDate: s.seedDate || null, target: s.target || 3,
           sick: Array.isArray(s.sick) ? s.sick : [] };
}
export async function saveStreakSettings(settings) {
  await db.set(STORE, 'streak-settings', settings);
}

// ── Milestones ────────────────────────────────────────────────────────────────
const WORKOUT_MARKS = [1, 5, 10, 25, 50, 100, 150, 200, 300, 365, 500];
const STREAK_MARKS  = [4, 8, 12, 26, 52, 78, 104];
const VOLUME_MARKS  = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000];

export function computeMilestones(sessions, streakWeeks) {
  const workouts = sessions.length;
  const volume = sessions.reduce((a, s) =>
    a + (s.exercises || []).flatMap(e => e.sets || [])
        .filter(st => st.done)
        .reduce((v, st) => v + (st.weight || 0) * (st.reps || 1), 0), 0);

  const earned = [];
  for (const m of WORKOUT_MARKS) if (workouts >= m) earned.push({ icon: '🏋️', label: `${m} workouts` });
  for (const m of STREAK_MARKS)  if (streakWeeks >= m) earned.push({ icon: '🔥', label: `${m}-week streak` });
  for (const m of VOLUME_MARKS)  if (volume >= m) earned.push({ icon: '⚡', label: `${(m/1000).toLocaleString()}t lifted` });
  return { earned, workouts, volume };
}
