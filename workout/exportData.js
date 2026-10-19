// Data export. Pure: app.js passes in the lookups it owns (aliases, overrides,
// split names), so this runs under node for tests.
//   buildSetRows → one row per logged set, every stored field plus derived
//   columns (volume, e1RM, best-to-date, PB flags, muscles), oldest first.
//   toCSV        → RFC 4180 text for those rows.
//   buildBackup  → the JSON backup: `entries` stays the import format.
import { muscleContributions } from './exercises.js';

// Same Epley formula as achievements.js (which pulls in db.js, so not imported here).
const e1RM = (w, r) => (r > 0 ? w * (1 + r / 30) : w);

// Keys that hold credentials. Never written to a file the user may share.
export const SECRET_KEYS = new Set(['anthropic-key']);

export const SET_COLUMNS = [
  'session_id', 'date', 'weekday', 'start_time', 'end_time', 'session_duration_sec', 'session_title',
  'split', 'workout', 'session_pbs',
  'exercise_order', 'exercise', 'canonical_exercise', 'category', 'secondary_muscles', 'log_type',
  'superset_id', 'rest_sec', 'rep_range_min', 'rep_range_max', 'rep_range_source',
  'exercise_notes', 'coach_note', 'exercise_pbs',
  'set_order', 'working_set_order', 'set_id', 'set_type', 'done',
  'weight_kg', 'reps', 'weight2_kg', 'reps2', 'distance_km', 'duration_sec', 'rpe',
  'target_weight_kg', 'target_reps', 'hit_target_reps',
  'volume_kg', 'e1rm_kg', 'best_e1rm_before_kg', 'is_e1rm_pb', 'is_weight_pb',
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const num = v => (v === '' || v == null || !Number.isFinite(+v) ? '' : +v);
const round = (v, d = 1) => (v === '' ? '' : Math.round(v * 10 ** d) / 10 ** d);
const sessionTime = s => Date.parse(s.startTime || '') || Date.parse((s.date || '') + 'T12:00:00') || 0;
const isWorking = s => s && s.done && (s.weight || 0) > 0 && s.type !== 'warmup' && s.type !== 'dropset';

export function buildSetRows(sessions, {
  canonicalName = n => n,
  resolveLogType = ex => ex.logType || 'weighted',
  resolveRepRange = ex => ex.repRange || null,
  splitName = () => '',
  workoutName = () => '',
} = {}) {
  const ordered = [...sessions].filter(s => s && Array.isArray(s.exercises)).sort((a, b) => sessionTime(a) - sessionTime(b));
  const bestE1rm = new Map();     // canonical exercise → best e1RM so far
  const bestWeight = new Map();   // canonical exercise → heaviest working set so far
  const rows = [];
  for (const s of ordered) {
    const day = s.date ? new Date(s.date + 'T12:00:00') : null;
    const sessionPbs = (s.pbs || []).map(p => `${p.exercise}: ${p.label}`).join(' | ');
    s.exercises.forEach((ex, ei) => {
      const canon = canonicalName(ex.name);
      const lt = resolveLogType(ex);
      const range = resolveRepRange({ ...ex, logType: lt });
      const secondary = muscleContributions(ex).filter(m => !m.primary).map(m => `${m.muscle}:${m.frac}`).join('|');
      const exPbs = (s.pbs || []).filter(p => p.exercise === ex.name).map(p => p.label).join(' | ');
      let working = 0;
      (ex.sets || []).forEach((set, si) => {
        const w = num(set.weight), r = num(set.reps);
        const work = isWorking(set);
        if (work) working++;
        const weighted = lt === 'weighted' && ex.category !== 'Cardio';
        const est = work && weighted ? e1RM(+set.weight, +set.reps || 1) : '';
        const prevE = bestE1rm.get(canon) ?? '';
        const prevW = bestWeight.get(canon) ?? '';
        if (est !== '' && (prevE === '' || est > prevE)) bestE1rm.set(canon, est);
        if (work && weighted && (prevW === '' || +set.weight > prevW)) bestWeight.set(canon, +set.weight);
        const tR = num(set.targetReps ?? set.tR);
        rows.push({
          session_id: s.id ?? '', date: s.date ?? '', weekday: day && !isNaN(day) ? WEEKDAYS[day.getDay()] : '',
          start_time: s.startTime ?? '', end_time: s.endTime ?? '', session_duration_sec: num(s.duration),
          session_title: s.title ?? '', split: splitName(s) || '', workout: workoutName(s) || '', session_pbs: sessionPbs,
          exercise_order: ei + 1, exercise: ex.name ?? '', canonical_exercise: canon ?? '', category: ex.category ?? '',
          secondary_muscles: secondary, log_type: lt, superset_id: ex.supersetId ?? '', rest_sec: num(ex.restTime),
          rep_range_min: range?.min ?? '', rep_range_max: range?.max ?? '',
          rep_range_source: range ? (ex.repSource || (ex.repRange ? 'stored' : 'standard')) : '',
          exercise_notes: ex.notes ?? '', coach_note: ex.coachNote ?? '', exercise_pbs: exPbs,
          set_order: si + 1, working_set_order: work ? working : '', set_id: set.id ?? '', set_type: set.type || 'normal',
          done: set.done ? 1 : 0,
          weight_kg: w, reps: r, weight2_kg: num(set.weight2), reps2: num(set.reps2),
          distance_km: num(set.distance), duration_sec: num(set.duration), rpe: num(set.rpe),
          target_weight_kg: num(set.targetWeight ?? set.tW), target_reps: tR,
          hit_target_reps: tR !== '' && set.done && r !== '' ? (r >= tR ? 1 : 0) : '',
          volume_kg: set.done && weighted && w !== '' && r !== '' ? round(w * r) : '',
          e1rm_kg: round(est), best_e1rm_before_kg: round(prevE),
          is_e1rm_pb: est === '' || prevE === '' ? '' : (est > prevE ? 1 : 0),
          is_weight_pb: !(work && weighted) || prevW === '' ? '' : (+set.weight > prevW ? 1 : 0),
        });
      });
    });
  }
  return rows;
}

const cell = v => {
  if (v == null) return '';
  const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export function toCSV(columns, rows) {
  return [columns.join(','), ...rows.map(r => columns.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

// stores = { workout: [{key,value}], calories: [...], habits: [...] }.
// `entries` (the workout store) keeps the shape Import reads, so an old or new
// backup restores the same way; the rest is for analysis and completeness.
export function buildBackup({ stores, reference = {}, exportedAt = new Date().toISOString() }) {
  const clean = rows => (rows || []).filter(r => !SECRET_KEYS.has(r.key));
  const other = {};
  for (const [name, rows] of Object.entries(stores)) if (name !== 'workout') other[name] = clean(rows);
  return { app: 'arc', version: 2, exportedAt, entries: clean(stores.workout), stores: other, reference };
}
