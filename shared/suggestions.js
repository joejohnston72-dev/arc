// Cross-module insight engine. Reads data from every module and returns a
// prioritised list of warnings + improvement tips for the home dashboard.
import db from './db.js';

const DAY = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const daysSince = iso => {
  if (!iso) return Infinity;
  const d = new Date((iso.length === 10 ? iso + 'T12:00:00' : iso));
  return isNaN(d) ? Infinity : Math.floor((Date.now() - d.getTime()) / DAY);
};
// severity weight for sorting: warn first, then tip, then good
const RANK = { warn: 0, tip: 1, good: 2 };

// Stable key from module + text, so a dismissal sticks until the wording
// (e.g. an amount or count) actually changes.
function keyOf(module, text) {
  let h = 0;
  const s = module + '|' + text;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return module.toLowerCase() + '-' + Math.abs(h).toString(36);
}

export async function generateSuggestions() {
  const out = [];
  const add = (severity, module, icon, text, href) =>
    out.push({ severity, module, icon, text, href, key: keyOf(module, text) });

  await Promise.allSettled([
    workoutSuggestions(add),
  ]);

  // Filter out anything the user has dismissed
  const dismissed = (await db.get('workout', 'suggestions-dismissed')) || [];
  const visible = out.filter(s => !dismissed.includes(s.key));

  visible.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  if (visible.length === 0) {
    visible.push({ severity:'good', module:'All', icon:'✅',
      text:"You're all caught up — nothing needs attention.", href:null, key:'all-clear' });
  }
  return visible;
}

// Mark a suggestion dismissed (persists + syncs).
export async function dismissSuggestion(key) {
  const dismissed = (await db.get('workout', 'suggestions-dismissed')) || [];
  if (!dismissed.includes(key)) {
    dismissed.push(key);
    await db.set('workout', 'suggestions-dismissed', dismissed);
  }
}

// ── Workout ───────────────────────────────────────────────────────────────────
async function workoutSuggestions(add) {
  const all = await db.getAll('workout');
  const sessions = all
    .filter(r => r.key.startsWith('session-') && r.value?.exercises)
    .map(r => r.value);

  if (!sessions.length) {
    add('tip', 'Workout', '💪', 'No workouts yet — log one or restore your backup.', 'workout/');
    return;
  }

  const lastDays = sessions.reduce((m, s) => Math.min(m, daysSince(s.date || s.startTime)), Infinity);
  if (lastDays >= 7)      add('warn', 'Workout', '🏋️', `No workout in ${lastDays} days — time to get back in.`, 'workout/');
  else if (lastDays >= 4) add('tip',  'Workout', '🏋️', `${lastDays} days since your last workout.`, 'workout/');

  // Muscle group neglect — categories not trained in 14 days
  const recent = sessions.filter(s => daysSince(s.date || s.startTime) <= 14);
  const trained = new Set();
  recent.forEach(s => s.exercises.forEach(e => e.category && trained.add(e.category)));
  const MAIN = ['Chest', 'Back', 'Shoulders', 'Quads', 'Hamstrings'];
  const skipped = MAIN.filter(c => !trained.has(c));
  if (recent.length >= 3 && skipped.length && skipped.length <= 2) {
    add('tip', 'Workout', '⚖️', `Haven't trained ${skipped.join(' or ')} in 2 weeks — balance it out.`, 'workout/');
  }

  // Consistency win
  const last7 = sessions.filter(s => daysSince(s.date || s.startTime) <= 7).length;
  if (last7 >= 4) add('good', 'Workout', 'flame', `${last7} workouts in the last 7 days — great consistency!`, 'workout/');
}
