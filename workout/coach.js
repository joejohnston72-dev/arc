// AI Coach — Anthropic tool-use call, context builder, routine validation.
// Pure logic: NO imports from app.js. The app injects its module-scoped
// helpers (getAllExercises, guessCategory, getKey) where needed.
import db from '../shared/db.js';
import { CATEGORIES } from './exercises.js';
import { buildRecords, computeStreak } from './achievements.js';
import { lifetimeTotals, exerciseFrequency, weeklySetsByCategory } from './stats.js';

const MODEL = 'claude-sonnet-5';

// Millisecond timestamp of a saved session (date preferred, startTime fallback).
function sessionTs(s) {
  const d = new Date(s?.date || s?.startTime || 0);
  const t = d.getTime();
  return isNaN(t) ? 0 : t;
}

// ── The one tool: draft_routine (schema == the app's template contract) ───────
export const DRAFT_ROUTINE_TOOL = {
  name: 'draft_routine',
  description: "Produce a structured workout routine ONLY when the user asks you to create, draft, or suggest a specific workout or training day (including 'what should I train today'). For advice, progression discussion, form/technique questions, or program review, respond with plain text instead of calling this tool.",
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short routine name, e.g. "Upper A" or "Push Day".' },
      exercises: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:     { type: 'string', description: 'Exercise name. Choose from the ALLOWED EXERCISES list in the system prompt (exact or close — the app fuzzy-matches and will add anything new as a custom exercise).' },
            category: { type: 'string', enum: CATEGORIES },
            restTime: { type: 'integer', description: 'Rest between sets in seconds, e.g. 60, 90, 120, 180.' },
            sets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  weight: { type: 'number',  description: 'Target weight in kg. 0 for bodyweight or when unknown.' },
                  reps:   { type: 'integer', description: 'Target reps. For Cardio, reps = minutes.' },
                  type:   { type: 'string', enum: ['normal', 'warmup', 'dropset'] },
                },
                required: ['weight', 'reps', 'type'],
              },
            },
          },
          required: ['name', 'category', 'restTime', 'sets'],
        },
      },
    },
    required: ['name', 'exercises'],
  },
};

// ── Action tools: let the coach make real in-app changes ──────────────────────
// The app executes these client-side (see app.js coachAddExercises / coachLogWorkouts)
// and shows a confirmation card — no second API round-trip.
export const ADD_EXERCISES_TOOL = {
  name: 'add_library_exercises',
  description: "Add one or more custom exercises to the user's exercise library so they're selectable in future workouts. Use when the user asks to add/create exercises in their library.",
  input_schema: {
    type: 'object',
    properties: {
      exercises: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:     { type: 'string', description: 'Exercise name, e.g. "Zercher Squat".' },
            category: { type: 'string', enum: CATEGORIES },
          },
          required: ['name', 'category'],
        },
      },
    },
    required: ['exercises'],
  },
};
export const LOG_WORKOUTS_TOOL = {
  name: 'log_workouts',
  description: "Log or backfill one or more completed workouts into the user's history, optionally on past dates. Use when the user asks to add, log, or backfill sessions (e.g. \"add 2 cardio sessions to last week\"). Compute real YYYY-MM-DD dates from the TODAY value in the system prompt.",
  input_schema: {
    type: 'object',
    properties: {
      workouts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title:       { type: 'string', description: 'Workout name, e.g. "Cardio".' },
            date:        { type: 'string', description: 'ISO date YYYY-MM-DD, computed from TODAY.' },
            durationMin: { type: 'integer', description: 'Optional duration in minutes.' },
            exercises: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:     { type: 'string' },
                  category: { type: 'string', enum: CATEGORIES },
                  sets: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        weight: { type: 'number',  description: '0 for bodyweight/cardio.' },
                        reps:   { type: 'integer', description: 'For Cardio, reps = minutes.' },
                        type:   { type: 'string', enum: ['normal', 'warmup', 'dropset'] },
                      },
                      required: ['weight', 'reps', 'type'],
                    },
                  },
                },
                required: ['name', 'category', 'sets'],
              },
            },
          },
          required: ['title', 'date', 'exercises'],
        },
      },
    },
    required: ['workouts'],
  },
};

export const EDIT_ROUTINE_TOOL = {
  name: 'suggest_routine_edit',
  description: "Propose ONE concrete, high-value change to a saved routine, based on the user's history, PBs, training balance, and how they've been swapping/editing exercises. Use when they ask you to analyse/improve/review their routines. Give a short rationale plus specific edit operations the app can apply with one tap.",
  input_schema: {
    type: 'object',
    properties: {
      routine:   { type: 'string', description: 'Exact name of the saved routine to change (from SAVED ROUTINES).' },
      rationale: { type: 'string', description: 'One or two plain sentences: what to change and why it helps.' },
      operations: {
        type: 'array',
        description: 'The concrete edits. Keep it focused — usually 1–3 ops.',
        items: {
          type: 'object',
          properties: {
            action:      { type: 'string', enum: ['replace', 'add', 'remove', 'set_reps'] },
            exercise:    { type: 'string', description: 'Existing exercise name in the routine (replace / remove / set_reps).' },
            newExercise: { type: 'string', description: 'New exercise name (replace / add).' },
            category:    { type: 'string', enum: CATEGORIES, description: 'Category for an added/new exercise.' },
            sets:        { type: 'integer', description: 'Number of working sets (add / set_reps).' },
            reps:        { type: 'integer', description: 'Target reps (add / set_reps).' },
          },
          required: ['action'],
        },
      },
    },
    required: ['routine', 'rationale', 'operations'],
  },
};

// ── draft_split: a full multi-day programme the app saves as several routines ──
export const DRAFT_SPLIT_TOOL = {
  name: 'draft_split',
  description: "Produce a complete multi-day training split (e.g. Push/Pull/Legs, Upper/Lower) when the user asks you to BUILD or CREATE a new programme or rebalance their training week. Return every day as its own routine; the app saves them all with one tap. Design the split to correct the imbalances shown in TRAINING BALANCE.",
  input_schema: {
    type: 'object',
    properties: {
      splitName: { type: 'string', description: 'Overall programme name, e.g. "PPL — rebalanced" or "Upper/Lower".' },
      days: {
        type: 'array',
        description: 'The training days, in order. Usually 3–6.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Day/routine name, e.g. "Push A", "Legs".' },
            exercises: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:     { type: 'string', description: 'Exercise name from the ALLOWED EXERCISES list (fuzzy is fine).' },
                  category: { type: 'string', enum: CATEGORIES },
                  restTime: { type: 'integer', description: 'Rest between sets in seconds (60/90/120/180).' },
                  sets: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        weight: { type: 'number',  description: 'Target kg. 0 for bodyweight/unknown.' },
                        reps:   { type: 'integer', description: 'Target reps. For Cardio, reps = minutes.' },
                        type:   { type: 'string', enum: ['normal', 'warmup', 'dropset'] },
                      },
                      required: ['weight', 'reps', 'type'],
                    },
                  },
                },
                required: ['name', 'category', 'restTime', 'sets'],
              },
            },
          },
          required: ['name', 'exercises'],
        },
      },
    },
    required: ['splitName', 'days'],
  },
};

// ── Name normalisation (ported from cues.js — that copy is not exported) ──────
export function normName(s) {
  return String(s).toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\btriceps\b/g, 'tricep')
    .replace(/\bbiceps\b/g, 'bicep')
    .replace(/\bmachine\b/g, ' ')
    .replace(/\bcable\b/g, ' ')
    .replace(/\bbarbell\b/g, ' ')
    .replace(/\bdumbbell\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// What the app can do — so the coach can answer "how do I…" questions.
const APP_CAPABILITIES = `This app (the user's training app) can: log workouts live (sets with kg×reps, or reps/time/distance for other exercise types), auto rest-timer per exercise with a chime, previous-performance ghosts, PB trophies, weekly streak, a Stats tab (monthly calendar, weekly volume, muscle balance, per-exercise progression charts) with workout history + CSV/JSON backup import, a routine Library and saved routines, and this AI Coach. Swipe a set left to delete / right for a drop set; long-press an exercise to reorder; "…" on an exercise to replace it or superset it.`;

// ── Context builder → system prompt ───────────────────────────────────────────
export function buildCoachContext(sessions, templates, records, streak, allExercises) {
  const byCat = {};
  for (const e of allExercises) (byCat[e.category] ||= []).push(e.name);
  const allowed = Object.entries(byCat)
    .map(([cat, names]) => `${cat}: ${names.join(', ')}`)
    .join('\n');

  const lt = lifetimeTotals(sessions);
  const freq = exerciseFrequency(sessions).slice(0, 20);
  const topLines = freq.map(f => {
    const r = records[f.name];
    const best = r ? `best ${r.maxWeight}kg, e1RM ${Math.round(r.maxE1rm)}kg` : 'no working sets';
    return `- ${f.name} (${f.category}): ${best}, done ${f.n}×`;
  }).join('\n');

  const recent = sessions.slice(0, 6).map(s => {
    const date = s.date || (s.startTime || '').slice(0, 10);
    const lifts = (s.exercises || []).slice(0, 4).map(ex => {
      const done = (ex.sets || []).filter(st => st.done && st.weight);
      if (!done.length) return ex.name;
      const top = done.reduce((a, b) => (b.weight > a.weight ? b : a));
      return ex.category === 'Cardio' ? `${ex.name} ${top.reps}min` : `${ex.name} ${top.weight}×${top.reps}`;
    }).join(', ');
    return `- ${date} ${s.title || 'Workout'}: ${lifts}`;
  }).join('\n');

  const routines = (templates || []).slice(0, 8).map(t =>
    `- ${t.name}: ${t.exercises.map(e => e.name).join(', ')}`
  ).join('\n');

  // Training-balance analysis: avg working sets/muscle group/week over the last
  // 4 weeks (recent) and 8 weeks (baseline), flagged against the 10–20 set band.
  const bal4 = weeklySetsByCategory(sessions, 4);
  const bal8 = weeklySetsByCategory(sessions, 8);
  const eightByCat = Object.fromEntries(bal8.rows.map(r => [r.cat, r.perWk]));
  const balanceLines = bal4.rows.map(r => {
    const flag = r.status === 'low' ? ' ⟵ under 10 (low)' : r.status === 'high' ? ' ⟵ over 20 (high)' : '';
    const trend = eightByCat[r.cat] != null ? ` (8-wk avg ${eightByCat[r.cat].toFixed(1)})` : '';
    return `- ${r.cat}: ${r.perWk.toFixed(1)} sets/wk${trend}${flag}`;
  }).join('\n');
  const cardioLine = bal4.cardioMinPerWk > 0 ? `\n- Cardio: ${bal4.cardioMinPerWk.toFixed(0)} min/wk` : '';

  // ── Recovery / readiness: days since each muscle group was last trained ──────
  // This is what lets the coach say "not legs today" or "your chest is fresh" —
  // proactive, data-backed session steering rather than generic advice.
  const DAY = 86400000;
  const nowTs = Date.now();
  const catLastTs = {};
  let lastWorkoutTs = 0;
  for (const s of sessions) {
    const t = sessionTs(s);
    if (!t) continue;
    if (t > lastWorkoutTs) lastWorkoutTs = t;
    for (const ex of s.exercises || []) {
      const c = ex.category;
      if (!c || c === 'Cardio') continue;
      if (!catLastTs[c] || t > catLastTs[c]) catLastTs[c] = t;
    }
  }
  const daysAgo = t => { const d = Math.floor((nowTs - t) / DAY); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
  const recoveryLines = Object.entries(catLastTs)
    .map(([c, t]) => ({ c, d: Math.floor((nowTs - t) / DAY), t }))
    .sort((a, b) => b.d - a.d)   // stalest (most rested) first — the freshest to hit
    .map(r => `- ${r.c}: last trained ${daysAgo(r.t)}`)
    .join('\n');
  const sinceLast = lastWorkoutTs ? daysAgo(lastWorkoutTs) : 'no sessions yet';

  // ── Progression signals: per-lift top-set trend (rising / stalled) ───────────
  const seriesByEx = {};
  for (let i = sessions.length - 1; i >= 0; i--) {   // oldest → newest (chronological)
    for (const ex of sessions[i].exercises || []) {
      const working = (ex.sets || []).filter(st => st.done && (st.weight || 0) > 0 && st.type !== 'warmup' && st.type !== 'dropset');
      if (!working.length) continue;
      const top = working.reduce((a, b) => (b.weight > a.weight ? b : a));
      (seriesByEx[ex.name] ||= []).push(top.weight);
    }
  }
  const signals = [];
  for (const [name, ser] of Object.entries(seriesByEx)) {
    if (ser.length < 3) continue;
    const recent = ser.slice(-4);
    const max = Math.max(...recent), min = Math.min(...recent);
    const first = ser[0], last = ser[ser.length - 1];
    if (max > 0 && (max - min) / max < 0.03) signals.push({ n: ser.length, s: `- ${name}: STALLED — flat ~${last}kg over last ${recent.length} sessions` });
    else if (last > first) signals.push({ n: ser.length, s: `- ${name}: rising — ${first}→${last}kg over ${ser.length} sessions` });
    else if (last < first) signals.push({ n: ser.length, s: `- ${name}: down — ${first}→${last}kg over ${ser.length} sessions` });
  }
  const signalLines = signals.sort((a, b) => b.n - a.n).slice(0, 8).map(x => x.s).join('\n');

  const now = new Date();
  const todayStr = `${now.toISOString().slice(0, 10)} (${now.toLocaleDateString('en-GB', { weekday: 'long' })})`;

  return `You are an expert strength & hypertrophy coach and training assistant living inside the user's workout app. The user is an experienced lifter in the UK — all weights are in KILOGRAMS (kg), never pounds or dollars.

TODAY: ${todayStr}. Compute any relative dates ("last week", "yesterday") from this.

VOICE — technical & precise, always explain the why
- You are the ARC coach: an experienced strength coach with a sports-science bent. Confident, precise, never padded, never hype.
- Back every recommendation with the mechanism, ratio, or number behind it — one clause is enough (e.g. "long head only loads at full stretch", "quads run 3:1 over hamstrings", "est. 1RM up 6%"). Precision IS the encouragement; don't cheerlead.
- The user is an experienced lifter — skip the basics, surface the reasoning. Numbers over adjectives. British English, kilograms.
- Be concise: a clear, justified recommendation, not an exhaustive survey. At most one meaningful emoji per reply (🏆/🔥), usually none.

HOW TO RESPOND
- Answer ANY question the user asks — training, technique/form, programming, progression, recovery, nutrition-for-lifters, or how to use this app. Always give a real answer in plain text; never refuse a normal training/health question or reply with just a routine when they asked something else.
- Ground everything in the user's own data below — their lifts, PBs, recent sessions, streak, and ESPECIALLY the four analysis blocks: TRAINING BALANCE (volume per muscle), RECOVERY/READINESS (days since each muscle was trained), PROGRESSION SIGNALS (which lifts are rising vs stalled), and their SAVED ROUTINES. When they ask "what am I doing too much / not enough", read straight off TRAINING BALANCE: name the groups above 20 sets/wk (too much) and below 10 (too little), with numbers.
- Interpret intent generously and act on the data instead of stalling. If a request is vague ("what should I do", "sort me out", "I'm bored"), DON'T interrogate — read the data and make the highest-value call. Only ask a clarifying question when a real constraint is genuinely unknown (available equipment, time, an injury) and it would change the answer.
- ONLY call draft_routine when the user wants a single workout/day created or asks "what should I train today". For a whole multi-day programme/split, call draft_split instead. For everything else, reply with text.

STEERING TODAY'S SESSION (proactive, data-driven)
- You can and should suggest ALTERING today's plan when the data warrants it. If a muscle group is under-recovered (trained in the last ~48h per RECOVERY/READINESS) or already over-volume (TRAINING BALANCE >20/wk), steer away from it: "Skip legs today — quads trained yesterday and are already at 22 sets/wk; here's an upper session that hits your lagging back instead." Use draft_routine to hand them the altered session.
- If their week is structurally off (a lagging group chronically under 10 sets, push:pull skewed, a lift stalled for weeks), propose swapping the split — call draft_split and say in text which groups you rebalanced and why, citing the numbers.
- Favour the freshest, most-recovered muscle groups and the lifts that are still rising; program around stalled lifts (small load bump, extra set, or a short deload) rather than repeating them unchanged.

ACTIONS YOU CAN TAKE (make real changes in the app)
- add_library_exercises — add custom exercises to the user's library when they ask you to.
- log_workouts — log/backfill completed sessions into their history, including on past dates (use TODAY to compute them).
- suggest_routine_edit — when asked to analyse/improve/review an EXISTING saved routine, propose ONE concrete change to a specific routine (rationale + edit operations, one-tap Apply). Don't rewrite the whole routine — target the highest-value tweak from their data (lagging groups, stalled lifts, exercises they keep swapping, over/under-volume from TRAINING BALANCE).
- draft_split — when the user asks you to BUILD/CREATE a new split or programme (multiple training days), or to rebalance their week. Return the full set of days; the app saves them all as routines with one tap. Design the split to fix the imbalances in TRAINING BALANCE — pull volume from over-worked groups toward under-worked ones, and say in your text reply which groups you rebalanced and why.
Call these when the user clearly asks. Do it, then confirm briefly in text. Don't call them for purely hypothetical talk.

APP CAPABILITIES (for "how do I…" questions)
${APP_CAPABILITIES}

DRAFTING RULES
- Only use exercise names from the ALLOWED EXERCISES list below (close/fuzzy is fine — the app remaps; anything genuinely new becomes a custom exercise).
- Respect any equipment, time, or injury constraints the user states.
- Sensible defaults: main compounds 3–4 working sets of 5–8 reps, rest 120–180s; accessories/isolation 3 sets of 8–15 reps, rest 60–90s. Add 1–2 warmup sets (type "warmup") on the first heavy compound. Prioritise compounds first. For Cardio, set reps = minutes and weight = 0. Use the user's recent working weights (below) as the starting target where known.

ALLOWED EXERCISES
${allowed}

THIS LIFTER
Lifetime: ${lt.workouts} workouts, ${lt.hours.toFixed(0)}h trained, ${(lt.volume/1000).toFixed(1)} tonnes lifted. Current streak: ${streak.weeks} week(s) (${streak.thisWeekCount}/${streak.target} this week).

Last workout: ${sinceLast}.

TRAINING BALANCE (avg working sets/muscle group/week — target band 10–20; <10 = too little, >20 = too much)
${balanceLines || '- (not enough recent history)'}${cardioLine}

RECOVERY / READINESS (days since each muscle group was last trained — freshest/most-rested listed first)
${recoveryLines || '- (not enough recent history)'}

PROGRESSION SIGNALS (top-set trend per lift — rising lifts to keep pushing, STALLED lifts to program around)
${signalLines || '- (not enough history to read trends yet)'}

TOP EXERCISES (by frequency, with bests)
${topLines || '- (no history yet)'}

RECENT SESSIONS
${recent || '- (none yet)'}

SAVED ROUTINES
${routines || '- (none yet)'}`;
}

// Assemble everything callers need for a request. Convenience wrapper.
export async function assembleContext({ loadSessions, getTemplates, getAllExercises, getStreakSettings }) {
  const sessions  = await loadSessions();
  const templates = await getTemplates();
  const records   = buildRecords(sessions);
  const streak    = computeStreak(sessions, await getStreakSettings());
  const allEx     = await getAllExercises();
  return buildCoachContext(sessions, templates, records, streak, allEx);
}

// ── Validate/normalise a model-produced routine into the template contract ────
export async function validateRoutine(routine, { getAllExercises, guessCategory }) {
  const all = await getAllExercises();
  const NORM_INDEX = {};
  for (const e of all) { const n = normName(e.name); if (!(n in NORM_INDEX)) NORM_INDEX[n] = e; }

  const resolve = (name) => {
    const n = normName(name);
    if (!n) return null;
    if (NORM_INDEX[n]) return NORM_INDEX[n];
    // Containment fallback for qualified names (e.g. "Lat Pulldown Wide Grip" → "Lat Pulldown").
    // Only where a known name is a substring of the AI's (more-qualified) name, and the
    // known name is substantial (>=6 chars) so single words like "row"/"curl"/"dip" don't
    // collapse novel exercises onto arbitrary ones. Longest match wins.
    let best = null, bestLen = 0;
    for (const [norm, e] of Object.entries(NORM_INDEX)) {
      if (norm.length >= 6 && norm.length > bestLen && n.includes(norm)) {
        best = e; bestLen = norm.length;
      }
    }
    return best;
  };

  const existingCustom = (await db.get('workout', 'exercises-custom')) || [];
  let customsChanged = false;

  const out = { name: String(routine?.name || 'AI Routine').slice(0, 60), exercises: [] };
  for (const ex of (routine?.exercises || [])) {
    const hit = resolve(ex.name || '');
    let name, category;
    if (hit) {
      name = hit.name; category = hit.category;
    } else {
      name = String(ex.name || 'Exercise').slice(0, 60);
      category = CATEGORIES.includes(ex.category) ? ex.category : guessCategory(name);
      // register as a custom exercise (dedupe by normName)
      const nn = normName(name);
      if (!all.some(e => normName(e.name) === nn) && !existingCustom.some(e => normName(e.name) === nn)) {
        existingCustom.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2,7), name, category, custom: true });
        NORM_INDEX[nn] = { name, category };
        all.push({ name, category, custom: true });
        customsChanged = true;
      }
    }
    let sets = Array.isArray(ex.sets) ? ex.sets : [];
    sets = sets.map(s => ({
      weight: Math.max(0, Number(s?.weight) || 0),
      reps:   Math.max(0, parseInt(s?.reps) || 0),
      type:   ['normal','warmup','dropset'].includes(s?.type) ? s.type : 'normal',
    }));
    if (!sets.length) sets = [{ weight: 0, reps: 8, type: 'normal' }];
    out.exercises.push({ name, category, restTime: Math.max(0, parseInt(ex.restTime) || 60), sets });
  }
  if (customsChanged) await db.set('workout', 'exercises-custom', existingCustom);
  if (!out.exercises.length) throw new Error('empty routine');
  return out;
}

// The Messages API requires the first message to be role 'user' and generally
// dislikes empty content — malformed histories were a source of silent 400s on
// custom prompts. Normalise: drop leading non-user + empties, merge consecutive
// same-role turns, keep only the last ~20 turns.
function sanitizeMessages(msgs) {
  const out = [];
  for (const m of (msgs || [])) {
    const content = String(m?.content ?? '').trim();
    if (!content) continue;
    if (!out.length && m.role !== 'user') continue;
    if (out.length && out[out.length - 1].role === m.role) {
      out[out.length - 1].content += '\n\n' + content;
    } else {
      out.push({ role: m.role, content });
    }
  }
  return out.slice(-20);
}

// ── The API call ──────────────────────────────────────────────────────────────
// apiMessages: [{role:'user'|'assistant', content:string}]
// Returns { text, routine|null, error|null }.
export async function callCoach({ apiMessages, system, forceTool = false, getKey }) {
  const key = await getKey();
  if (!key) return { error: 'nokey' };

  const messages = sanitizeMessages(apiMessages);
  if (!messages.length) return { error: 'api', detail: 'no message' };

  const body = {
    model: MODEL,
    max_tokens: forceTool ? 1600 : 2000,   // more room for detailed chat answers
    system,
    tools: [DRAFT_ROUTINE_TOOL, ADD_EXERCISES_TOOL, LOG_WORKOUTS_TOOL, EDIT_ROUTINE_TOOL, DRAFT_SPLIT_TOOL],
    // forceTool may be a boolean (legacy → draft_routine) or a specific tool name.
    tool_choice: forceTool
      ? { type: 'tool', name: (typeof forceTool === 'string' && forceTool !== '1') ? forceTool : 'draft_routine' }
      : { type: 'auto' },
    messages,
  };

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (_) {
    return { error: 'network' };
  }

  if (res.status === 401) return { error: 'auth' };
  if (res.status === 429) return { error: 'ratelimit' };
  if (res.status === 413) return { error: 'toolarge' };
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json())?.error?.message || msg; } catch (_) {}
    return { error: 'api', detail: msg };
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') return { text: "I can't help with that one.", routine: null };
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const toolBlock  = (data.content || []).find(b => b.type === 'tool_use');
  return {
    text: textBlocks,
    tool: toolBlock ? { name: toolBlock.name, input: toolBlock.input } : null,
  };
}
