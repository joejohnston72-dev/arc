import { supabase }                     from '../shared/supabase.js';
import db, { initialSync }              from '../shared/db.js';
import { EXERCISES, CATEGORIES, CATEGORY_COLORS } from './exercises.js';
import { resolveCues } from './cues.js';
import { ROUTINE_LIBRARY } from './routineLibrary.js';
import { MY_ROUTINES } from './myRoutines.js';
import { buildRecords, detectPBs, absorbSet, e1RM,
         getStreakSettings, saveStreakSettings, computeStreak, computeMilestones } from './achievements.js';
import { lifetimeTotals, weeklyVolumeHTML, muscleBalanceHTML,
         exerciseFrequency, progressionHTML, monthlyViewHTML, weeklySetsByCategory } from './stats.js';
import { assembleContext, callCoach, validateRoutine, normName } from './coach.js';
import { resolveRepRange, fetchAIRepRange } from './repRanges.js';
import { icon, renderIcons } from '../shared/icons.js';
import { dismissSuggestion } from '../shared/suggestions.js';

// Paint any static/dynamic `<i data-lucide>` placeholders. Cheap + idempotent,
// so it's safe to call after every render that may inject new icon markup.
const refreshIcons = () => renderIcons(document);

// ── Auth guard ────────────────────────────────────────────────────────────────
// Auth lives in Arc itself now (the shared hub was retired). With no session we
// show the in-app login overlay and wait for it, instead of redirecting away.
let { data: { session } } = await supabase.auth.getSession();
const hadSessionAtImport = !!session;   // did db.js's import-time initialSync pull?
if (!session) session = await showAuthGate();

// db.js kicks off the cloud pull (`initialSync`) at IMPORT time, but it only
// pulls when a session already exists then. When the hub existed, auth happened
// before this app loaded, so that was always true. Now that auth lives in-app,
// a fresh sign-in via the gate means initialSync already resolved to 0 (no
// session at import) and never pulled — which would render an EMPTY history and
// look like data loss. So: reuse initialSync only if we were already signed in;
// otherwise run the pull now, post-login. Everything below awaits `restore`, so
// history is restored before the first render AND before any mirror-up to cloud.
const restore = hadSessionAtImport ? initialSync : db.sync();

// In-app email-OTP login. Resolves with the session once the user signs in.
function showAuthGate() {
  return new Promise(resolve => {
    const overlay       = document.getElementById('authOverlay');
    const authForm      = document.getElementById('authForm');
    const authCodeForm  = document.getElementById('authCodeForm');
    const authEmail     = document.getElementById('authEmail');
    const authCode      = document.getElementById('authCode');
    const authBtn       = document.getElementById('authBtn');
    const authVerifyBtn = document.getElementById('authVerifyBtn');
    const authResendBtn = document.getElementById('authResendBtn');
    let pendingEmail = '';
    overlay.classList.add('visible');
    refreshIcons();

    const { data: authSub } = supabase.auth.onAuthStateChange((_e, sess) => {
      if (!sess) return;
      authSub.subscription.unsubscribe();
      overlay.classList.remove('visible');
      resolve(sess);
    });

    authBtn.onclick = async () => {
      const email = authEmail.value.trim();
      if (!email) { authEmail.focus(); return; }
      authBtn.disabled = true; authBtn.textContent = 'Sending…';
      const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      authBtn.disabled = false; authBtn.textContent = 'Send code';
      if (error) { alert(error.message); return; }
      pendingEmail = email;
      authForm.style.display = 'none';
      authCodeForm.style.display = 'block';
      authCode.focus();
    };
    authVerifyBtn.onclick = async () => {
      const token = authCode.value.trim();
      if (token.length < 6) { authCode.focus(); return; }   // 6–8 digit codes
      authVerifyBtn.disabled = true; authVerifyBtn.textContent = 'Verifying…';
      const { error } = await supabase.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
      authVerifyBtn.disabled = false; authVerifyBtn.textContent = 'Verify & sign in';
      if (error) { alert(error.message); authCode.select(); return; }
      // onAuthStateChange above resolves the promise once the session lands.
    };
    authCode.addEventListener('keydown', e => { if (e.key === 'Enter') authVerifyBtn.click(); });
    authResendBtn.onclick = () => {
      authCodeForm.style.display = 'none';
      authForm.style.display = 'block';
      authCode.value = '';
      authEmail.focus();
    };
  });
}

// ── Constants & helpers ───────────────────────────────────────────────────────
const STORE = 'workout';
const uid   = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
// Deterministic ID for CSV imports — same workout always gets same key
function stableId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return 'hevy-' + Math.abs(h).toString(36);
}
// Escapes quotes too, not just <>& — names are user-typed free text and get
// interpolated into HTML attributes (data-cue="...", data-name="...") in
// several places, so an unescaped " would break out of the attribute.
const esc   = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const fmtKg = v => String(v || 0);
const fmtTime = secs => {
  const m = Math.floor(secs / 60), s = secs % 60;
  return m + ':' + String(s).padStart(2,'0');
};
const fmtRest = secs => (secs <= 0 ? 'Off' : fmtTime(secs));   // rest timer can be disabled

// Forgiving search: case-insensitive, order-independent "all words present".
// "bench barbell" matches "Bench Press (Barbell)"; empty query matches everything.
function matchesSearch(text, q) {
  if (!q || !q.trim()) return true;
  const hay = String(text || '').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(tok => hay.includes(tok));
}

// ── Exercise tracking types ───────────────────────────────────────────────────
// Which fields a set records. 'time' is stored in set.duration (seconds),
// 'distance' in set.distance (km). weight/reps as before.
const LOGTYPES = {
  weighted:   { cols: ['weight', 'reps'],     head: ['kg', 'Reps'],  label: 'Weight & reps' },
  bodyweight: { cols: ['reps'],               head: ['Reps'],        label: 'Reps only (bodyweight)' },
  duration:   { cols: ['time'],               head: ['Time'],        label: 'Time / hold' },
  cardio:     { cols: ['distance', 'time'],   head: ['km', 'Time'],  label: 'Distance & time (cardio)' },
};
// User edits to the core library (via the "…" → Edit exercise sheet). Keyed by
// the built-in exercise's canonical name → { category?, logType? }. Loaded once
// at init (loadExOverrides) and kept in sync on every edit. Custom exercises are
// edited in place in `exercises-custom` instead, so they don't live here.
let exOverrides = {};
// ── Exercise identity / alias map ─────────────────────────────────────────────
// User-declared "these logged names are the same lift" merges, applied at READ
// time so nothing stored is ever rewritten (fully reversible). Store key
// `exercise-aliases` in the workout store = { rawNameLower: canonicalName }.
// `canonicalName(name)` folds any logged/variation name onto the identity the
// user picked; it's applied wherever history is grouped by name (stats map,
// exercise detail, PR timeline, frequency, progression) so a merged exercise
// reads as one continuous history. Removing an entry ("Separate") splits it back
// out. Chains are followed one hop at a time with a cycle guard.
let exAliases = {};
async function loadExAliases() {
  exAliases = (await db.get(STORE, 'exercise-aliases')) || {};
  return exAliases;
}
function canonicalName(name) {
  if (!name) return name;
  let cur = name;
  const seen = new Set();
  while (true) {
    const key = cur.toLowerCase();
    if (seen.has(key)) break;                 // cycle guard
    seen.add(key);
    const next = exAliases[key];
    if (!next || next.toLowerCase() === key) break;
    cur = next;
  }
  return cur;
}
// The distinct raw logged names that currently fold onto `canon` (excluding the
// canonical name itself), gathered from history + the stored alias map.
function aliasMembers(canon, sessions) {
  const out = new Map();                       // lowerName -> display name
  const canonLc = canon.toLowerCase();
  // History first — real, properly-cased logged names (first occurrence wins).
  for (const s of sessions || []) {
    for (const ex of s.exercises || []) {
      const k = ex.name.toLowerCase();
      if (k !== canonLc && !out.has(k) && canonicalName(ex.name) === canon) out.set(k, ex.name);
    }
  }
  // Then any merged names that have never been logged yet (fall back to the key).
  for (const [raw, target] of Object.entries(exAliases)) {
    const k = raw.toLowerCase();
    if (k !== canonLc && !out.has(k) && canonicalName(target) === canon) out.set(k, raw);
  }
  return [...out.values()];
}
// A read-only view of sessions with every exercise name replaced by its canonical
// identity (shallow clones — never written back). Feed this to name-grouping
// helpers in stats.js (progressionHTML etc.) so merged variations aggregate too.
function canonicalizeSessions(sessions) {
  return (sessions || []).map(s => ({
    ...s,
    exercises: (s.exercises || []).map(e => {
      const c = canonicalName(e.name);
      return c === e.name ? e : { ...e, name: c };
    }),
  }));
}
// Session loader yielding merged identities — fed to the AI coach so it reasons
// over the same consolidated per-lift history the user sees.
const loadSessionsCanonical = async () => canonicalizeSessions(await loadSessions());
// Persist a merge (rawName -> canonical) or, with target=null, a "separate".
async function setExerciseAlias(rawName, canonical) {
  const key = rawName.toLowerCase();
  if (!canonical || canonical.toLowerCase() === key) delete exAliases[key];
  else exAliases[key] = canonical;
  await db.set(STORE, 'exercise-aliases', exAliases);
  db.backup();
}
// NB: bare "hang" was removed — it false-matched "Leg Raise (Hanging)" (a
// rep-based exercise) and forced it into time-tracking. "dead hang" alone
// covers the actual isometric hold.
const DURATION_NAMES = /plank|hold|wall sit|dead hang|l-sit|hollow/i;
// Movements that are inherently reps-only (bodyweight). Used to infer the type
// for exercises with none stored AND to correct a wrong 'weighted' default that
// got baked into old/imported copies (e.g. an imported "Hanging Leg Raise").
const BODYWEIGHT_NAMES = /leg raise|knee raise|toes[- ]?to[- ]?bar|hanging raise/i;
// Infer a tracking type for a built-in / legacy exercise that has none stored.
// Cardio defaults to time (matches "25min stairs/cycle"); distance+time ('cardio')
// is only used when the user explicitly picks it for a new exercise.
function exLogType(name, category) {
  if (category === 'Cardio') return 'duration';
  if (DURATION_NAMES.test(name || '')) return 'duration';
  if (BODYWEIGHT_NAMES.test(name || '')) return 'bodyweight';
  return 'weighted';
}
// A stored logType normally wins — EXCEPT for inherently reps-only movements
// (leg raises etc.), which are always bodyweight. This overrides any stale type
// baked into old/imported data — including a 'duration' left over from when a
// bare "hang" match wrongly forced "Hanging Leg Raise" into time-tracking.
const resolveLogType = ex => {
  // An explicit user edit to the library (built-in override, or a custom
  // exercise's own stored type) is authoritative everywhere — that's the whole
  // point of "Edit exercise writes to the core library".
  const ov = exOverrides[ex?.name]?.logType;
  if (ov && LOGTYPES[ov]) return ov;
  if (BODYWEIGHT_NAMES.test(ex?.name || '')) return 'bodyweight';
  const stored = ex?.logType;
  return LOGTYPES[stored] ? stored : exLogType(ex?.name, ex?.category);
};
// Always mm:ss with leading zeros (stopwatch style, e.g. 90s → "01:30", 45s → "00:45").
const fmtDuration = secs => { if (!secs) return ''; const m = Math.floor(secs/60), s = secs%60; return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0'); };
// Returns seconds. "m:ss" is always minutes:seconds. A bare number is minutes
// for cardio (you did "25" → 25 min) but seconds for holds/planks ("45" → 45s).
function parseTime(str, asMinutes = false) {
  if (str == null || str === '') return 0;
  str = String(str).trim();
  if (str.includes(':')) { const [m, s] = str.split(':'); return (parseInt(m)||0)*60 + (parseInt(s)||0); }
  const n = parseFloat(str) || 0;
  return Math.round(asMinutes ? n * 60 : n);
}
const isCardioEx = ex => ex?.category === 'Cardio' || resolveLogType(ex) === 'cardio';
// Live stopwatch mask for time entry: the digits fill mm:ss from the right, so
// typing "2000" → "20:00" (20 min), "230" → "02:30", "45" → "00:45". Returns the
// formatted text and the value in seconds.
function maskTime(raw) {
  const d = String(raw ?? '').replace(/\D/g, '').replace(/^0+(?=\d\d)/, '').slice(-4);
  if (!d) return { text: '', secs: 0 };
  const p = d.padStart(3, '0');           // ensure at least M + SS
  const sec = p.slice(-2), min = p.slice(0, -2);
  return { text: min.padStart(2, '0') + ':' + sec, secs: (parseInt(min, 10) || 0) * 60 + (parseInt(sec, 10) || 0) };
}
const MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
// Milestone emoji (from achievements.js) → Lucide icon names.
const MILESTONE_ICONS = { '🏋️': 'dumbbell', '🔥': 'flame', '⚡': 'zap' };

function parseToDate(str) {
  if (!str) return null;
  str = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str))
    return new Date(str + 'T12:00:00');
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(str))
    return new Date(str.replace(' ', 'T'));
  // Common tracker format: "4 Jun 2026, 17:14"
  const hm = str.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/);
  if (hm) {
    const mon = MONTHS[hm[2].toLowerCase()];
    if (mon !== undefined)
      return new Date(+hm[3], mon, +hm[1], +hm[4], +hm[5]);
  }
  const d = new Date(str);
  return isNaN(d) ? null : d;
}
function extractDateStr(str) {
  const d = parseToDate(str);
  return d ? d.toISOString().slice(0, 10) : '';
}
const fmtDate = iso => {
  const d = parseToDate(iso);
  if (!d || isNaN(d)) return 'Unknown date';
  return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
};

// Load all saved sessions, newest first. Single source used everywhere.
async function loadSessions() {
  const all = await db.getAll(STORE);
  return all
    .filter(r => r.key.startsWith('session-') && r.value?.exercises)
    .map(r => r.value)
    .sort((a,b) => (parseToDate(b.date||b.startTime||'')?.getTime()||0) - (parseToDate(a.date||a.startTime||'')?.getTime()||0));
}

// ── Bodyweight tracking (syncs + backs up via the shared 'workout' store) ─────
const CALORIE_APP_URL = 'https://joejohnston72-dev.github.io/calorieAI/';
const toNum = x => (typeof x === 'number' && isFinite(x)) ? x
  : (x != null && x !== '' && !isNaN(+x)) ? +x : null;

async function getBodyLog() {
  const log = (await db.get(STORE, 'bodyweight-log')) || [];
  return log.filter(e => e && e.date && e.kg > 0).sort((a, b) => a.date.localeCompare(b.date));
}
async function logBodyweight(kg, date) {
  const log = (await db.get(STORE, 'bodyweight-log')) || [];
  const d = date || new Date().toISOString().slice(0, 10);
  const i = log.findIndex(e => e.date === d);
  if (i >= 0) log[i] = { date: d, kg }; else log.push({ date: d, kg });
  await db.set(STORE, 'bodyweight-log', log);
  db.backup();
}
// Latest weight + change across the log window (first → last), plus the series.
function bodyStats(log) {
  if (!log || !log.length) return null;
  const latest = log[log.length - 1], first = log[0];
  return {
    latest: latest.kg, date: latest.date,
    delta: +(latest.kg - first.kg).toFixed(1),
    points: log.map(e => e.kg), n: log.length,
  };
}

// Nutrition snapshot — best-effort read of the shared 'calories' store that the
// separate CalorieAI app writes to the same Supabase project (both apps sync
// every store). Its schema is owned by that app, so we probe defensively and
// fall back to a link-out when nothing is found. Returns {kcal,goal,protein}|null.
async function getNutritionToday() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.getAll('calories');
    for (const { key, value } of rows) {
      if (!String(key).includes(today)) continue;
      const v = value && typeof value === 'object' ? value : null;
      if (!v) continue;
      const kcal = toNum(v.kcal ?? v.calories ?? v.total ?? v.totalCalories ?? v.energy);
      if (kcal == null) continue;
      return {
        kcal: Math.round(kcal),
        goal: toNum(v.goal ?? v.target ?? v.kcalGoal ?? v.calorieGoal ?? v.dailyGoal),
        protein: toNum(v.protein ?? v.proteinG ?? v.protein_g),
      };
    }
  } catch (_) {}
  return null;
}

// ── Personal-record timeline (flattened from saved session.pbs, newest first) ──
function collectPRs(sessions, limit = 40) {
  const out = [];
  for (const s of sessions) {
    const ts = parseToDate(s.date || s.startTime || '')?.getTime() || 0;
    for (const pb of (s.pbs || [])) {
      if (!pb?.exercise) continue;
      out.push({ exercise: canonicalName(pb.exercise), type: pb.type || '', label: pb.label || '', ts,
                 date: s.date || (s.startTime || '').slice(0, 10) });
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// ── Weekly plan helpers ────────────────────────────────────────────────────────
function mondayOf(d) {
  const x = new Date(d); x.setHours(12, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const ymd = d => new Date(d).toISOString().slice(0, 10);
async function getWeekPlanMap() { return (await db.get(STORE, 'week-plan')) || {}; }
async function setPlanDay(date, tid) {
  const map = await getWeekPlanMap();
  if (tid) map[date] = tid; else delete map[date];
  await db.set(STORE, 'week-plan', map);
  db.backup();
}

// ── Bodyweight log modal ───────────────────────────────────────────────────────
function openBodyweightModal(date) {
  const iEl = document.getElementById('bwInput');
  document.getElementById('bwDate').value = date || new Date().toISOString().slice(0, 10);
  iEl.value = '';
  getBodyLog().then(log => { const last = log[log.length - 1]; iEl.placeholder = last ? `Last: ${last.kg} kg` : 'e.g. 82.4'; });
  document.getElementById('bodyweightModal').classList.add('open');
  syncScrollLock();
  setTimeout(() => iEl.focus(), 60);
}
function closeBodyweightModal() {
  document.getElementById('bodyweightModal').classList.remove('open');
  syncScrollLock();
}
document.getElementById('bwCancel').onclick = closeBodyweightModal;
document.getElementById('bodyweightModal').addEventListener('click', e => {
  if (e.target === document.getElementById('bodyweightModal')) closeBodyweightModal();
});
document.getElementById('bwSave').onclick = async () => {
  const kg = parseFloat(document.getElementById('bwInput').value);
  const date = document.getElementById('bwDate').value || new Date().toISOString().slice(0, 10);
  if (!kg || kg <= 0) { closeBodyweightModal(); return; }
  await logBodyweight(+kg.toFixed(1), date);
  closeBodyweightModal();
  if (activeTab === 'Dashboard') renderDashboard();
  if (activeTab === 'Stats') renderStats();
};

// ── Screen wake lock ──────────────────────────────────────────────────────────
let wakeLock = null;
async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(_) {}
}
function releaseWakeLock() { wakeLock?.release(); wakeLock = null; }

// ── Active session state ──────────────────────────────────────────────────────
let activeSession   = null;   // { id, title, startTime, exercises: [...], pbs: [...] }
let sessionStartMs  = 0;      // duration derives from this — no on-screen countup (deliberately
                              // not displayed: a running total invites "how long left" anxiety
                              // instead of focus on the workout itself). Still recorded for stats.
let sessionRecords  = {};     // per-exercise all-time bests, for PB detection + typo guard
let routineMode     = false;

const sessionSecsNow = () => Math.max(0, Math.floor((Date.now() - sessionStartMs) / 1000));
let backfillDate = null;   // when set, the in-progress workout saves to this past date (calendar backfill)

// ── Rest timer state (timestamp-based — survives backgrounding) ───────────────
let restTimer      = null;
let restEndsAt     = null;   // epoch ms
let restTotalSecs  = 0;      // for the progress fill
let restExName     = '';     // exercise the current rest belongs to (focus ring sub)
let restSubText    = '';     // "Set 3 logged · 35 kg × 8 — new best" for the focus rest card
let restFiredChime = false;

// ── Focus mode (one exercise at a time; toggled from the active workout) ──────
let focusMode  = false;
let focusIndex = 0;

// ── In-progress autosave ──────────────────────────────────────────────────────
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveActiveSession, 1000);
}
function saveActiveSession() {
  clearTimeout(saveTimer);
  if (!activeSession) return;
  db.set(STORE, 'active-session', {
    session: activeSession,
    routineMode,
    title: document.getElementById('awTitle').value,
    savedAt: Date.now(),
  });
}
async function clearActiveSessionStore() {
  await db.set(STORE, 'active-session', null);
  await db.set(STORE, 'active-rest', null);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
let activeTab = 'Dashboard';
document.querySelectorAll('.tab').forEach(btn => {
  btn.onclick = () => {
    activeTab = btn.dataset.tab;
    if (typeof syncHeaderHeight === 'function') syncHeaderHeight();   // keep Coach flush below the header
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById('sec' + activeTab).classList.add('active');
    document.getElementById('miniBar').classList.toggle('visible', !!activeSession);
    if (activeTab === 'Dashboard') { renderDashboard(); }
    if (activeTab === 'Plan')      { renderPlan();      }
    if (activeTab === 'Library')   { renderLibrary();   }
    if (activeTab === 'Stats')     { renderStats(); renderHistory(); }
    if (activeTab === 'Coach')     { renderCoach();     }
  };
});

// ── Workout start / open ──────────────────────────────────────────────────────
document.getElementById('startEmptyBtn').onclick = () => { closeRoutineChooser(); startEmptyWorkout(); };
document.getElementById('newRoutineBtn').onclick = () => { closeRoutineChooser(); startNewRoutine(); };
document.getElementById('dashAllHistory').onclick = () => document.querySelector('.tab[data-tab="Stats"]').click();

// Ghost targets: what the inputs *suggest* (placeholder), never pre-filled values.
function ghostsFor(prevSets, templateSet, si) {
  const prev = prevSets?.[si] ?? prevSets?.at(-1) ?? null;
  return {
    tW: prev?.weight || templateSet?.weight || null,
    tR: prev?.reps   || templateSet?.reps   || null,
  };
}

function freshSet(tpl, prevSets, si) {
  const { tW, tR } = ghostsFor(prevSets, tpl, si);
  return {
    id: uid(),
    type: tpl?.type === 'warmup' || tpl?.type === 'dropset' ? tpl.type : 'normal',
    weight: 0, reps: 0, done: false,
    touched: { weight: false, reps: false },
    tW, tR,
  };
}

async function startEmptyWorkout(prefill = null, backfill = null) {
  routineMode = false;
  backfillDate = backfill;
  autoNotedEx.clear();   // fresh coach-note tracking per workout
  document.getElementById('awFinishBtn').textContent = backfill ? 'Save' : 'Finish';
  document.getElementById('awTitle').placeholder = backfill ? `Workout on ${fmtDate(backfill)}…` : 'Workout name…';

  // One history load powers previous-performance ghosts AND PB records.
  const past = await loadSessions();
  sessionRecords = buildRecords(past);

  const allEx = await getAllExercises();
  const exercises = (prefill?.exercises || []).map(e => {
    const prev = prevPerfFrom(past, e.name);
    const def = allEx.find(x => x.name === e.name);
    // resolveLogType corrects a stale 'weighted' on inherently-bodyweight moves
    // (leg raises etc.) so they're reps-only from the start, not just at render.
    const logType = resolveLogType({ name: e.name, category: e.category,
      logType: e.logType || prev?.logType || def?.logType || exLogType(e.name, e.category) });
    return {
      id: uid(), name: e.name, category: e.category, logType,
      restTime: e.restTime ?? prev?.restTime ?? 60,
      notes: prev?.notes || '',
      repRange: e.repRange || def?.repRange || null,
      prevPerf: prev ? prev.sets.slice(0,3).map(s => `${fmtKg(s.weight)}×${s.reps}`).join(', ') : null,
      prevSets: prev?.sets || null,
      ...(e.supersetId ? { supersetId: e.supersetId } : {}),
      sets: (e.sets?.length ? e.sets : [{}]).map((tpl, si) => freshSet(tpl, prev?.sets || null, si)),
    };
  });

  activeSession = {
    id: uid(),
    title: prefill?.title || prefill?.name || '',
    startTime: new Date().toISOString(),
    exercises,
    pbs: [],
  };
  sessionStartMs = Date.now();
  ensureExercisesInRepo(exercises);   // catalogue anything a started routine references
  acquireWakeLock();
  openActiveWorkout();
  renderActiveSession();
  saveSoon();
}

// Build a routine from scratch — reuses the workout editor, but Finish saves a template.
function startNewRoutine(prefill = null) {
  routineMode = true;
  activeSession = {
    id: uid(),
    title: prefill?.name || '',
    startTime: new Date().toISOString(),
    exercises: (prefill?.exercises || []).map(e => ({
      ...e, id: uid(),
      sets: (e.sets || [{}]).map(s => ({ ...s, id: uid(), done: false, touched: { weight:false, reps:false } })),
    })),
    pbs: [],
  };
  document.getElementById('awFinishBtn').textContent = 'Save';
  openActiveWorkout();
  document.getElementById('awTitle').placeholder = 'Routine name…';
  renderActiveSession();
}

function openActiveWorkout() {
  document.getElementById('miniBar').classList.remove('visible');
  document.getElementById('activeWorkout').classList.add('visible');
  document.getElementById('awTitle').value = activeSession?.title || '';
  syncScrollLock();   // pin the page so an overscroll can't lift the overlay
  fitActiveWorkout();
  // Restore focus mode if it was on when the app was last backgrounded/reloaded.
  try {
    const f = JSON.parse(localStorage.getItem('arc-focus') || 'null');
    if (f && activeSession?.exercises?.length) enterFocusMode(f.index || 0);
  } catch (_) {}
}

// Tear focus mode down whenever a workout ends (save/discard).
function closeFocusMode() {
  focusMode = false;
  document.getElementById('focusMode').classList.remove('visible');
  try { localStorage.removeItem('arc-focus'); } catch (_) {}
}

// ── iOS-reliable scroll lock ─────────────────────────────────────────────────
// The battle-tested fix (position:fixed + scroll save/restore): pin the body at
// its current offset so there is NO scrollable root to rubber-band — which is
// what let a swipe at the bottom of the workout drag the fixed overlay up and
// reveal the dashboard beneath. `overflow:hidden` alone does NOT stop iOS from
// touch-scrolling the root; and a naive position:fixed toggle jumps the scroll
// and janks momentum on close, so we store the exact offset and restore it.
//
// It's driven CENTRALLY: the lock is on whenever *any* full-screen overlay or
// modal is open, recomputed from the DOM by syncScrollLock(). A MutationObserver
// on class changes keeps it in sync through every open/close path, so this can't
// drift out of balance and future overlays are covered for free. Dynamically
// created modals (which set their class at creation, not via a toggle) call
// syncScrollLock() explicitly.
let lockedScrollY = 0;
function lockBodyScroll() {
  if (document.body.classList.contains('scroll-locked')) return;
  lockedScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.style.top = `-${lockedScrollY}px`;
  document.body.classList.add('scroll-locked');
}
function unlockBodyScroll() {
  if (!document.body.classList.contains('scroll-locked')) return;
  document.body.classList.remove('scroll-locked');
  document.body.style.top = '';
  window.scrollTo(0, lockedScrollY);
}
const OVERLAY_OPEN_SELECTOR =
  '#activeWorkout.visible, #exercisePicker.visible, #routineLibrary.visible, ' +
  '#libraryDetail.visible, #historyDetail.visible, #exerciseDetail.visible, #workoutSummary.visible, .modal-backdrop.open';
function syncScrollLock() {
  if (document.querySelector(OVERLAY_OPEN_SELECTOR)) lockBodyScroll();
  else unlockBodyScroll();
}
let scrollSyncRaf = 0;
new MutationObserver(() => {
  cancelAnimationFrame(scrollSyncRaf);
  scrollSyncRaf = requestAnimationFrame(syncScrollLock);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });

// Keyboard handling. The overlay ALWAYS stays full-screen (inset:0) — a shrunk
// overlay was the whole bug: any strip it didn't cover let the dashboard behind
// leak through under the keyboard. Instead we only pad the overlay's bottom by
// the keyboard's height, which lifts the footer/rest-bar above the keyboard while
// the overlay's own solid background fills that padded strip. Because the overlay
// never gets smaller than the screen, nothing behind it can ever show.
//
// It's also idempotent + rAF-batched: visualViewport fires 'scroll' on every
// momentum frame, and re-writing layout each time was a big source of the
// jitter. We recompute at most once per frame and skip the write when unchanged.
let lastKb = -1, fitRaf = 0;
function fitActiveWorkout() {
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    const aw = document.getElementById('activeWorkout');
    if (!aw.classList.contains('visible')) return;
    const vv = window.visualViewport;
    if (!vv) return;
    // Height of the keyboard = layout viewport minus the still-visible strip.
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    const applied = kb > 80 ? kb : 0;   // ignore tiny insets / the input accessory bar
    if (applied === lastKb) return;     // no change → no reflow, no jitter
    lastKb = applied;
    aw.style.paddingBottom = applied ? applied + 'px' : '';
  });
}
function unfitActiveWorkout() {
  cancelAnimationFrame(fitRaf);
  const aw = document.getElementById('activeWorkout');
  aw.style.paddingBottom = '';
  lastKb = -1;
  syncScrollLock();
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitActiveWorkout);
  window.visualViewport.addEventListener('scroll', fitActiveWorkout);
}

// ── Restore an in-progress workout after a kill/reload ────────────────────────
async function checkForAbandonedSession() {
  const saved = await db.get(STORE, 'active-session');
  if (!saved?.session?.exercises?.length) return;
  const ageMin = Math.round((Date.now() - (saved.savedAt || 0)) / 60000);
  const ageTxt = ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin/60)}h ago`;
  const label  = saved.title || saved.session.title || 'Workout';
  if (ageMin > 720) { await clearActiveSessionStore(); return; } // stale >12h — silently drop
  if (!confirm(`Resume "${label}" in progress? (last active ${ageTxt})`)) {
    await clearActiveSessionStore();
    return;
  }
  routineMode = !!saved.routineMode;
  activeSession = saved.session;
  activeSession.pbs ||= [];
  sessionStartMs = Date.parse(activeSession.startTime) || (Date.now() - 60000);
  const past = await loadSessions();
  sessionRecords = buildRecords(past, activeSession.id);
  document.getElementById('awFinishBtn').textContent = routineMode ? 'Save' : 'Finish';
  acquireWakeLock();
  openActiveWorkout();
  document.getElementById('awTitle').value = saved.title || activeSession.title || '';
  renderActiveSession();
  const rest = await db.get(STORE, 'active-rest');
  if (rest?.endsAt) resumeRestFromDb(rest);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACTIVE SESSION RENDERING — full render only on structure change;
//  everything else patches the DOM in place (no keyboard loss, no jumps).
// ═══════════════════════════════════════════════════════════════════════════════
const awBody = document.getElementById('awBody');

function findSet(ei, setId) {
  const ex = activeSession?.exercises[ei];
  if (!ex) return {};
  const si = ex.sets.findIndex(s => s.id === setId);
  return { ex, set: ex.sets[si], si };
}

function setPrevText(lt, prev) {
  if (!prev) return '—';
  switch (lt) {
    case 'bodyweight': return `${prev.reps || 0} reps`;
    case 'duration':   return fmtDuration(prev.duration) || '—';
    case 'cardio':     return `${prev.distance || 0}km ${fmtDuration(prev.duration) || ''}`.trim();
    default:           return `${fmtKg(prev.weight)}×${prev.reps}`;
  }
}
function setInputCell(col, set, ex, ei, prev) {
  const common = `data-ei="${ei}" data-set-id="${set.id}"`;
  if (col === 'weight')
    return `<td><input class="set-input" type="number" min="0" step="0.5" value="${set.weight || ''}" placeholder="${set.tW ?? 0}" inputmode="decimal" ${common} data-field="weight"></td>`;
  if (col === 'reps')
    return `<td><input class="set-input" type="number" min="0" step="1" value="${set.reps || ''}" placeholder="${set.tR ?? 0}" inputmode="numeric" ${common} data-field="reps"></td>`;
  if (col === 'distance')
    return `<td><input class="set-input" type="number" min="0" step="0.01" value="${set.distance || ''}" placeholder="${prev?.distance ?? 0}" inputmode="decimal" ${common} data-field="distance"></td>`;
  if (col === 'time') {
    const ph = prev?.duration ? fmtDuration(prev.duration) : '00:00';
    return `<td><input class="set-input set-time" type="text" value="${set.duration ? fmtDuration(set.duration) : ''}" placeholder="${ph}" inputmode="numeric" ${common} data-field="time"></td>`;
  }
  return '<td></td>';
}
// Warm-up and drop sets each carry a second logged entry so the pairing is
// explicit and self-documenting (was: a bare colour with no second value —
// "unclear how it's intended to be used"):
//   warm-up  = the lighter warm-up load  →  the actual working set
//   drop set = the main working set       →  the lighter drop
// Only weighted lifts get the dual entry; the labels below name each line.
const DUAL_LABELS = {
  warmup:  { primary: 'Warm', secondary: 'Work' },
  dropset: { primary: 'Set',  secondary: 'Drop' },
};
function isDualSet(set, lt) {
  return lt === 'weighted' && (set.type === 'warmup' || set.type === 'dropset');
}
// One stacked cell for a dual set: primary input over a secondary (…2) input,
// each tagged with its label so the two loads are never ambiguous.
function dualSetCell(field, set, ei, labels) {
  const common = `data-ei="${ei}" data-set-id="${set.id}"`;
  const isW = field === 'weight';
  const step = isW ? '0.5' : '1';
  const mode = isW ? 'decimal' : 'numeric';
  const line = (f, val, lbl) => `
    <div class="dual-line">
      <span class="dual-lbl">${lbl}</span>
      <input class="set-input" type="number" min="0" step="${step}" value="${val || ''}" inputmode="${mode}" ${common} data-field="${f}">
    </div>`;
  return `<td class="set-dual-cell">
    ${line(field, set[field], labels.primary)}
    ${line(field + '2', set[field + '2'], labels.secondary)}
  </td>`;
}

function buildSetRow(ex, ei, set) {
  const si = ex.sets.indexOf(set);
  const lt = resolveLogType(ex);
  const cfg = LOGTYPES[lt];
  const prev = ex.prevSets?.[si] ?? null;
  const dual = isDualSet(set, lt);
  const tr = document.createElement('tr');
  tr.className = 'set-row'
    + (set.done ? ' done' : '')
    + (set.type === 'warmup' ? ' set-warmup' : '')
    + (set.type === 'dropset' ? ' set-dropset' : '')
    + (dual ? ' set-dual' : '');
  tr.dataset.ei = ei;
  tr.dataset.setId = set.id;
  const labels = DUAL_LABELS[set.type];
  tr.innerHTML = `
    <td class="set-num" title="Tap to cycle: warm-up → drop set → normal">${si + 1}</td>
    ${dual
      ? dualSetCell('weight', set, ei, labels) + dualSetCell('reps', set, ei, labels)
      : cfg.cols.map(c => setInputCell(c, set, ex, ei, prev)).join('')}
    <td class="set-check-cell"><button class="set-check" data-ei="${ei}" data-set-id="${set.id}">${set.done ? icon('check', { size: 16 }) : ''}</button></td>
  `;
  return tr;
}

// Rebuild a single set row in place — used when a set's type changes so the
// dual warm-up / drop-set inputs appear or disappear without a full re-render
// (which would drop keyboard focus and scroll position).
function replaceSetRow(ei, setId) {
  const { ex, set } = findSet(ei, setId);
  if (!ex || !set) return;
  const old = awBody.querySelector(`.set-row[data-set-id="${setId}"]`);
  if (!old) return;
  old.replaceWith(buildSetRow(ex, ei, set));
  if (!routineMode) refreshExercisePBs(ei);
  refreshIcons();
}

// Target rep-range badge markup (icon + text), shared by the block build and
// the async AI-lookup patcher so both render identically.
function repRangeHTML(range) {
  return range ? `${icon('target', { size: 13 })} Target: ${range.min}–${range.max} reps` : '';
}

function buildExerciseBlock(ex, ei) {
  const block = document.createElement('div');
  block.className = 'ex-block';
  block.dataset.ei = ei;
  // Superset grouping — contiguous exercises sharing a supersetId form a group.
  const prevEx = activeSession.exercises[ei - 1];
  const nextEx = activeSession.exercises[ei + 1];
  const inSS = !!ex.supersetId;
  const firstOfGroup = inSS && (!prevEx || prevEx.supersetId !== ex.supersetId);
  const lastOfGroup  = inSS && (!nextEx || nextEx.supersetId !== ex.supersetId);
  if (inSS) block.classList.add('ss-member');
  if (firstOfGroup) block.classList.add('ss-first');
  if (lastOfGroup)  block.classList.add('ss-last');
  const color = CATEGORY_COLORS[ex.category] || '#8e8e9a';
  const lt = resolveLogType(ex);
  const cfg = LOGTYPES[lt];
  const headCols = cfg.head.map(h => `<th>${h}</th>`).join('');
  const colspan = cfg.cols.length + 2;
  const range = resolveRepRange({ name: ex.name, category: ex.category, logType: lt, repRange: ex.repRange });

  block.innerHTML = `
    ${firstOfGroup ? `<div class="ss-label">${icon('repeat', { size: 12 })} Superset</div>` : ''}
    <div class="ex-block-header" data-ei="${ei}">
      <div class="ex-cat-dot" style="background:${color}"></div>
      <div class="ex-name linked" data-open-ex="${esc(ex.name)}">${esc(ex.name)}<span class="ex-chev">${icon('chevron-right', { size: 15 })}</span></div>
      <button class="ex-cue-btn" data-cue="${esc(ex.name)}" aria-label="Form cues" data-tip="Form cues" title="Form cues">${icon('info', { size: 17 })}</button>
      <button class="ex-menu-btn" data-ei="${ei}" aria-label="Exercise options" data-tip="Options" title="Options">${icon('ellipsis', { size: 18 })}</button>
    </div>
    <div class="ex-rep-range" data-ex-name="${esc(ex.name)}">${repRangeHTML(range)}</div>
    <div class="ex-rest-control">
      <span class="ex-rest-icon">${icon('timer', { size: 15 })}</span>
      <span class="ex-rest-label">Rest timer</span>
      <button class="ex-rest-step" data-ei="${ei}" data-delta="-15">−</button>
      <button class="ex-rest-value" data-ei="${ei}" id="restval-${ei}">${fmtRest(ex.restTime ?? 60)}</button>
      <button class="ex-rest-step" data-ei="${ei}" data-delta="15">+</button>
    </div>
    <input class="ex-notes-input" placeholder="Notes…" value="${esc(ex.notes||'')}" data-ei="${ei}" data-field="notes">
    ${ex.coachNote ? coachNoteBubbleHTML(ex.coachNote) : ''}
    <table class="sets-table">
      <thead><tr><th>#</th>${headCols}<th></th></tr></thead>
      <tbody class="sets-body" data-ei="${ei}"></tbody>
    </table>
    <table class="sets-table"><tbody>
      <tr class="add-set-row"><td colspan="${colspan}">
        <button class="add-set-mini" data-ei="${ei}">${icon('plus', { size: 14 })} Add Set</button>
      </td></tr>
    </tbody></table>
  `;
  const tbody = block.querySelector('.sets-body');
  ex.sets.forEach(set => tbody.appendChild(buildSetRow(ex, ei, set)));
  return block;
}

function renderActiveSession() {
  awBody.innerHTML = '';
  if (!activeSession) return;
  normalizeSupersets();   // keep groups contiguous through removes/reorders
  if (activeSession.exercises.length === 0) {
    awBody.innerHTML = `<div class="empty-state" style="padding-top:60px">
      Tap <strong>Add Exercise</strong> below to get started.
    </div>`;
    return;
  }
  activeSession.exercises.forEach((ex, ei) => awBody.appendChild(buildExerciseBlock(ex, ei)));
  refreshAllPBs();   // re-apply trophies to any already-completed sets
  refreshIcons();    // paint <i data-lucide> placeholders in the fresh blocks
}

function renumberSetRows(tbody) {
  [...tbody.querySelectorAll('.set-row')].forEach((row, i) => {
    row.querySelector('.set-num').textContent = i + 1;
  });
}

// ── Focus mode ────────────────────────────────────────────────────────────────
// A one-exercise-at-a-time view layered over the active workout. It reads the
// same activeSession and reuses the same PB / rest / autosave machinery — the
// table view underneath stays intact, so this is a pure toggle, never a rewrite.
function persistFocus() {
  try { localStorage.setItem('arc-focus', JSON.stringify({ index: focusIndex })); } catch (_) {}
}

function enterFocusMode(restoreIndex = null) {
  if (!activeSession || !activeSession.exercises.length) return;
  if (!awBody.children.length) renderActiveSession();   // ensure table rows exist for sync
  focusMode = true;
  if (restoreIndex != null) focusIndex = restoreIndex;
  else {
    const idx = activeSession.exercises.findIndex(e => e.sets.some(s => !s.done));
    focusIndex = idx >= 0 ? idx : 0;
  }
  persistFocus();
  document.getElementById('focusMode').classList.add('visible');
  renderFocusMode();
}

function exitFocusMode() {
  focusMode = false;
  document.getElementById('focusMode').classList.remove('visible');
  try { localStorage.removeItem('arc-focus'); } catch (_) {}
  renderActiveSession();   // reflect any edits back into the table view
}

function refreshFocusRest() {
  const ring = document.getElementById('fmRingProg');
  if (!ring) return;
  const countEl = document.getElementById('fmRingCount');
  const titleEl = document.getElementById('fmRestTitle');
  const subEl   = document.getElementById('fmRestSub');
  const card    = document.getElementById('fmRest');
  const C = 150.8;
  if (restEndsAt) {
    const remaining = Math.max(0, Math.ceil((restEndsAt - Date.now()) / 1000));
    const frac = Math.max(0, Math.min(1, remaining / (restTotalSecs || 1)));
    ring.style.strokeDashoffset = (C * (1 - frac)).toFixed(1);
    ring.style.stroke = remaining <= 20 ? 'var(--amber)' : 'var(--blue)';
    countEl.textContent = fmtTime(remaining);
    if (remaining <= 0) {
      titleEl.textContent = 'Ready'; subEl.textContent = 'Rest done — next set';
      card.classList.add('pulsing');
    } else {
      titleEl.textContent = 'Resting';
      subEl.textContent = restSubText || (restExName ? `Resting — ${restExName}` : 'Resting');
      card.classList.toggle('pulsing', remaining <= 6);
    }
  } else {
    ring.style.strokeDashoffset = C.toFixed(1);
    ring.style.stroke = 'var(--blue)';
    countEl.textContent = '0:00';
    titleEl.textContent = 'Ready';
    subEl.textContent = 'Check a set to start the timer';
    card.classList.remove('pulsing');
  }
}

function renderFocusMode() {
  if (!focusMode) return;
  if (!activeSession || !activeSession.exercises.length) { exitFocusMode(); return; }
  const exs = activeSession.exercises;
  focusIndex = Math.max(0, Math.min(focusIndex, exs.length - 1));
  const ex = exs[focusIndex];
  const lt = resolveLogType(ex);
  const cfg = LOGTYPES[lt];

  document.getElementById('fmTitle').textContent = activeSession.title || 'Workout';
  document.getElementById('fmSub').textContent = `${fmtTime(sessionSecsNow())} elapsed · ${focusIndex + 1} of ${exs.length}`;

  document.getElementById('fmRail').innerHTML = exs.map((e, i) => {
    const allDone = e.sets.length && e.sets.every(s => s.done);
    return `<div class="fm-rail-bar ${i === focusIndex ? 'current' : allDone ? 'done' : ''}"></div>`;
  }).join('');

  const color = CATEGORY_COLORS[ex.category] || '#8e8e9a';
  const range = resolveRepRange({ name: ex.name, category: ex.category, logType: lt, repRange: ex.repRange });
  const last = ex.prevPerf || (ex.prevSets?.length ? ex.prevSets.slice(0, 3).map(s => setPrevText(lt, s)).join(', ') : null);
  document.getElementById('fmExHead').innerHTML = `
    <div class="fm-exhead-top">
      <span class="fm-exhead-dot" style="background:${color}"></span>
      <span class="fm-exname">${esc(ex.name)}</span>
      <button class="fm-info" data-cue="${esc(ex.name)}" aria-label="Form cues">${icon('info', { size: 19 })}</button>
    </div>
    <div class="fm-exmeta">
      ${range ? `<span class="fm-target">${icon('target', { size: 14 })} Target ${range.min}–${range.max}</span>` : ''}
      ${last ? `<span class="fm-last">Last: ${esc(last)}</span>` : ''}
    </div>`;

  const unit = { weight: 'kg', reps: 'reps', distance: 'km', time: 'time' };
  document.getElementById('fmSets').innerHTML = ex.sets.map((set, si) => {
    const fields = cfg.cols.map(col => {
      const field = col;
      let val = '';
      if (col === 'weight') val = set.weight || '';
      else if (col === 'reps') val = set.reps || '';
      else if (col === 'distance') val = set.distance || '';
      else if (col === 'time') val = set.duration ? fmtDuration(set.duration) : '';
      const type = col === 'time' ? 'text' : 'number';
      const im = col === 'weight' || col === 'distance' ? 'decimal' : 'numeric';
      return `<div class="fm-field"><input type="${type}" inputmode="${im}" value="${val}" data-ei="${focusIndex}" data-set-id="${set.id}" data-field="${field}"><div class="fm-field-unit">${unit[col]}</div></div>`;
    }).join('');
    return `
      <div class="fm-set ${set.done ? 'done' : ''} ${set.type === 'warmup' ? 'warmup' : ''}" data-set-id="${set.id}">
        <span class="fm-set-num">${si + 1}</span>
        ${fields}
        <button class="fm-check" data-ei="${focusIndex}" data-set-id="${set.id}">${set.done ? icon('check', { size: 18 }) : ''}</button>
      </div>`;
  }).join('') + `<button class="fm-add-set" data-ei="${focusIndex}">+ Add set</button>`;

  document.getElementById('fmBack').disabled = focusIndex === 0;
  const nextBtn = document.getElementById('fmNext');
  nextBtn.innerHTML = focusIndex < exs.length - 1
    ? `Next: ${esc(exs[focusIndex + 1].name)} ${icon('chevron-right', { size: 20 })}`
    : `Finish ${icon('check', { size: 18 })}`;

  refreshFocusRest();
  refreshIcons();
}

// Toggle a set done from focus mode. Self-contained (no table-DOM focus jumps),
// but reuses the shared PB / rest / autosave logic so it behaves like the table.
function fmToggleSet(ei, setId) {
  const { ex, set, si } = findSet(ei, setId);
  if (!set) return;
  set.done = !set.done;
  set.touched ||= {};
  const lt = resolveLogType(ex);
  if (set.done) {
    const commit = (field, ghost) => {
      if (ghost == null || ghost === 0 || ghost === '') return;
      if (field === 'time') { if (!set.duration) set.duration = ghost; }
      else if (!set[field]) set[field] = ghost;
    };
    const prev = ex.prevSets?.[si] ?? null;
    if (lt === 'weighted') { commit('weight', set.tW); commit('reps', set.tR); }
    else if (lt === 'bodyweight') commit('reps', set.tR ?? prev?.reps);
    else if (lt === 'duration')   commit('time', prev?.duration);
    else if (lt === 'cardio')   { commit('distance', prev?.distance); commit('time', prev?.duration); }
    const next = ex.sets[si + 1];
    const carry = nextSetCarryWeight(set, next);
    if (next && !next.done && lt === 'weighted' && !next.touched?.weight && carry) next.weight = carry;
    unlockAudio();
    if (!routineMode && isLastSupersetMember(ei)) startRest(ex.restTime ?? 60, ex.name);
  }
  if (!routineMode) {
    const res = refreshExercisePBs(ei);   // also repaints table trophies (harmless)
    const isPb = set.done && res.pbBySet.has(set.id);
    if (set.done) restSubText = restSubForSet(ex, set, isPb);
    if (isPb) showPbToast(res.pbBySet.get(set.id));
  }
  // keep the underlying table row consistent for when the user flips back
  const tRow = awBody.querySelector(`.set-row[data-set-id="${setId}"]`);
  if (tRow) {
    tRow.classList.toggle('done', set.done);
    const c = tRow.querySelector('.set-check'); if (c) c.innerHTML = set.done ? icon('check', { size: 16 }) : '';
    const wi = tRow.querySelector('[data-field="weight"]'); if (wi && set.weight) wi.value = set.weight;
    const ri = tRow.querySelector('[data-field="reps"]'); if (ri && set.reps) ri.value = set.reps;
  }
  saveSoon();
  if (set.done) maybeAutoCoachNote(ei);
  renderFocusMode();
}

// Focus-mode wiring (bound once).
document.getElementById('awFocusBtn').onclick = () => enterFocusMode();
document.getElementById('fmExit').onclick = exitFocusMode;
document.getElementById('fmFinish').onclick = () => document.getElementById('awFinishBtn').click();
document.getElementById('fmBack').onclick = () => { if (focusIndex > 0) { focusIndex--; persistFocus(); renderFocusMode(); } };
document.getElementById('fmNext').onclick = () => {
  if (focusIndex < (activeSession?.exercises.length || 0) - 1) { focusIndex++; persistFocus(); renderFocusMode(); }
  else document.getElementById('awFinishBtn').click();
};
{
  const fmSets = document.getElementById('fmSets');
  fmSets.addEventListener('input', e => {
    const t = e.target;
    if (t.tagName !== 'INPUT') return;
    const { setId, field } = t.dataset;
    // mirror to the table input and let its handler own the model update / PB check
    const tInput = awBody.querySelector(`.set-input[data-set-id="${setId}"][data-field="${field}"]`);
    if (tInput) { tInput.value = t.value; tInput.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  fmSets.addEventListener('click', e => {
    const check = e.target.closest('.fm-check');
    if (check) { fmToggleSet(+check.dataset.ei, check.dataset.setId); return; }
    const add = e.target.closest('.fm-add-set');
    if (add) {
      const btn = awBody.querySelector(`.add-set-mini[data-ei="${add.dataset.ei}"]`);
      if (btn) btn.click();
      renderFocusMode();
    }
  });
  document.getElementById('fmExHead').addEventListener('click', e => {
    const info = e.target.closest('.fm-info');
    if (info) showCues(info.dataset.cue);
  });
  // Horizontal swipe on the body changes exercise (buttons/inputs excluded).
  const fmScroll = document.getElementById('fmScroll');
  let sx = null, sy = null;
  fmScroll.addEventListener('pointerdown', e => {
    if (e.target.closest('input, button')) { sx = null; return; }
    sx = e.clientX; sy = e.clientY;
  });
  fmScroll.addEventListener('pointerup', e => {
    if (sx == null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      const n = activeSession?.exercises.length || 0;
      if (dx < 0 && focusIndex < n - 1) { focusIndex++; persistFocus(); renderFocusMode(); }
      else if (dx > 0 && focusIndex > 0) { focusIndex--; persistFocus(); renderFocusMode(); }
    }
  });
}

// ── Delegated listeners (bound ONCE — never rebound on render) ────────────────
awBody.addEventListener('input', e => {
  const t = e.target;
  if (t.classList.contains('set-input')) {
    const { ei, setId, field } = t.dataset;
    const { ex, set } = findSet(ei, setId);
    if (!set) return;
    if (field === 'reps')          set.reps = parseInt(t.value) || 0;
    else if (field === 'reps2')    set.reps2 = parseInt(t.value) || 0;      // warm-up→work / drop-set secondary reps
    else if (field === 'weight2')  set.weight2 = parseFloat(t.value) || 0;  // secondary load
    else if (field === 'distance') set.distance = parseFloat(t.value) || 0;
    else if (field === 'time')     { const m = maskTime(t.value); t.value = m.text; set.duration = m.secs; }
    else                           set[field] = parseFloat(t.value) || 0;   // weight
    (set.touched ||= {})[field] = true;
    if (field === 'weight') { t.closest('td')?.querySelector('.set-nudge')?.remove(); queueSanityCheck(ex, set, t.closest('.set-row')); }
    // Editing a completed set's weight/reps re-checks its trophy live, so a
    // mistyped PB disappears the moment the number is corrected.
    if (!routineMode && set.done && (field === 'weight' || field === 'reps')) refreshExercisePBs(ei);
    saveSoon();
  } else if (t.classList.contains('ex-notes-input')) {
    const ex = activeSession?.exercises[t.dataset.ei];
    if (ex) { ex.notes = t.value; saveSoon(); }
  }
});

// Reformat a time set to mm:ss once the user leaves the field, so "90" or "1:5"
// becomes "01:30" / "01:05" — the 00:00 stopwatch format.
awBody.addEventListener('focusout', e => {
  const t = e.target;
  if (!t.classList?.contains('set-time')) return;
  const { ei, setId } = t.dataset;
  const { set } = findSet(ei, setId);
  t.value = set?.duration ? fmtDuration(set.duration) : '';
});

awBody.addEventListener('click', e => {
  // Apply an in-set weight nudge to the next set's weight.
  const nudge = e.target.closest('.set-nudge');
  if (nudge) {
    const { ei, setId, target } = nudge.dataset;
    const { set } = findSet(ei, setId);
    if (set) {
      set.weight = parseFloat(target) || 0;
      (set.touched ||= {}).weight = true;
      const wi = awBody.querySelector(`.set-input[data-ei="${ei}"][data-set-id="${setId}"][data-field="weight"]`);
      if (wi) wi.value = set.weight;
      if (!routineMode && set.done) refreshExercisePBs(ei);
      saveSoon();
    }
    nudge.remove();
    return;
  }
  // Dismiss a coach note bubble (clears it so it won't re-render).
  const ecnClose = e.target.closest('.ecn-close');
  if (ecnClose) {
    const block = ecnClose.closest('.ex-block');
    const ex = activeSession?.exercises[block?.dataset.ei];
    if (ex) { ex.coachNote = ''; saveSoon(); }
    block?.querySelector('.ex-coach-note')?.remove();
    return;
  }
  // Tap the set number to cycle its type: normal → warmup → dropset → normal.
  // (Swipe-right still toggles drop set; this adds a discoverable path and the
  // only way to mark a warm-up mid-workout.)
  const numCell = e.target.closest('.set-num');
  if (numCell) {
    const row = numCell.closest('.set-row');
    if (row && !row.classList.contains('removing')) {
      const { set } = findSet(row.dataset.ei, row.dataset.setId);
      if (set) {
        set.type = set.type === 'normal' ? 'warmup' : set.type === 'warmup' ? 'dropset' : 'normal';
        replaceSetRow(row.dataset.ei, row.dataset.setId);   // show/hide the dual entry
        saveSoon();
      }
    }
    return;
  }
  // Tap the exercise name → full exercise detail (PB, trend, coach note, history).
  const nameEl = e.target.closest('.ex-name');
  if (nameEl) { openExerciseDetail(nameEl.dataset.openEx || nameEl.textContent.trim()); return; }
  const check = e.target.closest('.set-check');
  if (check) {
    // If a swipe revealed the delete button, this cell hosts it instead
    if (check.classList.contains('as-delete')) {
      deleteSet(check.dataset.ei, check.dataset.setId);
      return;
    }
    toggleSetDone(check.dataset.ei, check.dataset.setId, check.closest('.set-row'));
    return;
  }
  const addSet = e.target.closest('.add-set-mini');
  if (addSet) {
    const ei = parseInt(addSet.dataset.ei);
    const ex = activeSession.exercises[ei];
    const last = ex.sets.at(-1);
    const set = {
      id: uid(), type: 'normal', weight: 0, reps: 0, done: false,
      touched: { weight: false, reps: false },
      tW: last?.weight || last?.tW || null,
      tR: last?.reps   || last?.tR || null,
    };
    ex.sets.push(set);
    const tbody = awBody.querySelector(`.sets-body[data-ei="${ei}"]`);
    tbody.appendChild(buildSetRow(ex, ei, set));
    saveSoon();
    return;
  }
  const step = e.target.closest('.ex-rest-step');
  if (step) {
    const ei = parseInt(step.dataset.ei);
    const ex = activeSession.exercises[ei];
    ex.restTime = Math.max(0, (ex.restTime ?? 60) + parseInt(step.dataset.delta));
    document.getElementById('restval-' + ei).textContent = fmtRest(ex.restTime);
    saveSoon();
    return;
  }
  const restVal = e.target.closest('.ex-rest-value');
  if (restVal) { openRestSheet(parseInt(restVal.dataset.ei)); return; }
  const cueBtn = e.target.closest('.ex-cue-btn');
  if (cueBtn) { showCues(cueBtn.dataset.cue); return; }
  const menuBtn = e.target.closest('.ex-menu-btn');
  if (menuBtn) { openExMenuSheet(parseInt(menuBtn.dataset.ei)); return; }
});

// ── Rest-timer preset sheet (tap the value; includes Off) ─────────────────────
let restSheetEi = null;
function openRestSheet(ei) {
  restSheetEi = ei;
  const cur = activeSession.exercises[ei]?.restTime ?? 60;
  document.querySelectorAll('#restPresetGrid .rest-preset').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.secs) === cur));
  document.getElementById('restSheet').classList.add('open');
}
document.getElementById('restSheetCancel').onclick = () => document.getElementById('restSheet').classList.remove('open');
document.getElementById('restSheet').addEventListener('click', e => {
  if (e.target === document.getElementById('restSheet')) document.getElementById('restSheet').classList.remove('open');
});
document.querySelectorAll('#restPresetGrid .rest-preset').forEach(btn => {
  btn.onclick = () => {
    if (restSheetEi == null || !activeSession) return;
    const secs = parseInt(btn.dataset.secs);
    activeSession.exercises[restSheetEi].restTime = secs;
    const el = document.getElementById('restval-' + restSheetEi);
    if (el) el.textContent = fmtRest(secs);
    document.getElementById('restSheet').classList.remove('open');
    saveSoon();
  };
});

// Weight to pre-fill into the NEXT set once `set` is completed. A warm-up / drop
// set must NOT carry its deliberately-lighter load into the working set that
// follows — use that next set's own working target (tW) instead.
function nextSetCarryWeight(set, next) {
  if (!next) return 0;
  if (set.type === 'warmup' || set.type === 'dropset') return next.tW || 0;
  return set.weight || 0;
}

// Rule-based in-set nudge: after a working set, if reps landed at/above the top
// of the target range, suggest a load bump for the next set (or a cut if below
// the bottom). Renders a small tap-to-apply arrow on the next set's weight cell.
function maybeSetNudge(ei, ex, set, next, nextRow, lt) {
  // One live suggestion at a time — clear any stale nudges in this exercise.
  awBody.querySelector(`.sets-body[data-ei="${ei}"]`)?.querySelectorAll('.set-nudge').forEach(n => n.remove());
  if (lt !== 'weighted' || !next || next.done) return;
  if (set.type === 'warmup' || set.type === 'dropset') return;
  const r = ex.repRange || resolveRepRange({ name: ex.name, category: ex.category, logType: lt, repRange: ex.repRange });
  const reps = set.reps || 0;
  if (!r?.min || !r?.max || !reps || !set.weight) return;
  let dir = null, delta = 0;
  if (reps >= r.max)     { dir = 'up';   delta = reps >= r.max + 3 ? 5 : 2.5; }
  else if (reps < r.min) { dir = 'down'; delta = reps <= r.min - 3 ? -5 : -2.5; }
  else return;   // landed inside the range — leave it
  const cell = nextRow?.querySelector('[data-field="weight"]')?.closest('td');
  if (!cell) return;
  const base = next.weight || set.weight || 0;
  const target = Math.max(0, +(base + delta).toFixed(1));
  if (target === base) return;
  cell.style.position = 'relative';
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'set-nudge ' + dir;
  chip.dataset.ei = ei; chip.dataset.setId = next.id; chip.dataset.target = target;
  chip.textContent = `${dir === 'up' ? '▲' : '▼'} ${target}`;
  chip.title = dir === 'up'
    ? `Hit ${reps} reps (top of ${r.min}–${r.max}) — tap to try ${target}kg next set`
    : `Missed ${r.min} reps — tap to try ${target}kg next set`;
  cell.appendChild(chip);
}

function toggleSetDone(ei, setId, rowEl) {
  const { ex, set, si } = findSet(ei, setId);
  if (!set) return;
  set.done = !set.done;
  if (set.done) rowEl.querySelector('.set-nudge')?.remove();   // clear a nudge on the row being completed

  const lt = resolveLogType(ex);
  set.touched ||= {};
  if (set.done) {
    // Commit ghosts: an empty checked set means "did the target"
    const commit = (field, ghost) => {
      if (ghost == null || ghost === 0 || ghost === '') return;
      if (field === 'time') {
        if (!set.duration && !set.touched.time) { set.duration = ghost; const i = rowEl.querySelector('[data-field="time"]'); if (i) i.value = fmtDuration(ghost); }
      } else if (!set[field] && !set.touched[field]) {
        set[field] = ghost; const i = rowEl.querySelector(`[data-field="${field}"]`); if (i) i.value = ghost;
      }
    };
    const prev = ex.prevSets?.[si] ?? null;
    if (lt === 'weighted')   { commit('weight', set.tW); commit('reps', set.tR); }
    else if (lt === 'bodyweight') commit('reps', set.tR ?? prev?.reps);
    else if (lt === 'duration')   commit('time', prev?.duration);
    else if (lt === 'cardio')   { commit('distance', prev?.distance); commit('time', prev?.duration); }

    // Auto-fill the next set + jump focus so the keyboard stays up (weighted flow).
    const next = ex.sets[si + 1];
    if (next && !next.done) {
      const nextRow = rowEl.parentElement.querySelector(`.set-row[data-set-id="${next.id}"]`);
      if (lt === 'weighted') {
        const nWeight = nextRow?.querySelector('[data-field="weight"]');
        const carry = nextSetCarryWeight(set, next);
        if (nWeight && !next.touched?.weight && carry) { next.weight = carry; nWeight.value = carry; }
        const target = nextRow?.querySelector('[data-field="reps"]') || nWeight;
        if (target) { target.focus({ preventScroll: true }); try { target.select(); } catch(_) {} }
        maybeSetNudge(ei, ex, set, next, nextRow, lt);
      } else {
        const target = nextRow?.querySelector('.set-input');
        if (target) { target.focus({ preventScroll: true }); try { target.select(); } catch(_) {} }
      }
    }

    unlockAudio();
    // In a superset you go straight to the paired exercise — only rest after the
    // last member of the group (or a normal, ungrouped exercise).
    if (!routineMode && isLastSupersetMember(ei)) startRest(ex.restTime ?? 60, ex.name);
  }

  rowEl.classList.toggle('done', set.done);
  rowEl.querySelector('.set-check').innerHTML = set.done ? icon('check', { size: 16 }) : '';

  // Re-evaluate PBs for this exercise from the immutable historical baseline.
  // Because it always recomputes (never accumulates), correcting a typo removes
  // any trophy it wrongly earned. Fanfare fires only for the set just checked.
  if (!routineMode) {
    const res = refreshExercisePBs(ei);
    const isPb = set.done && res.pbBySet.has(set.id);
    if (set.done) restSubText = restSubForSet(ex, set, isPb);
    if (isPb) showPbToast(res.pbBySet.get(set.id));
  }
  saveSoon();
  if (set.done) maybeAutoCoachNote(ei);
}

// The focus rest card's subtitle: "Set 3 logged · 35 kg × 8 — new best".
function restSubForSet(ex, set, isPb) {
  const lt = resolveLogType(ex);
  const n = ex.sets.indexOf(set) + 1;
  const val = lt === 'weighted' ? `${fmtKg(set.weight)} kg × ${set.reps}`
    : lt === 'bodyweight' ? `${set.reps} reps`
    : lt === 'duration' ? `${set.duration || 0}s`
    : `${set.distance || 0} km`;
  return `Set ${n} logged · ${val}${isPb ? ' — new best' : ''}`;
}

// A completed exercise is "notable" — worth a coach note — when it set a PB this
// session or its top set landed outside the target rep range. Everything else is
// routine and skipped, so the coach only spends a call on meaningful sets.
function exerciseNotable(ex) {
  const pb = (activeSession?.pbs || []).some(p => p.exercise === ex.name);
  const r = ex.repRange;
  let offRange = false, dir = '';
  const working = ex.sets.filter(s => s.done && (s.weight || 0) > 0 && s.type !== 'warmup' && s.type !== 'dropset');
  if (r?.min && r?.max && working.length) {
    const top = working.reduce((a, b) => (b.weight > a.weight ? b : a));
    if ((top.reps || 0) > r.max + 1) { offRange = true; dir = 'over'; }
    else if ((top.reps || 0) > 0 && top.reps < r.min) { offRange = true; dir = 'under'; }
  }
  return { notable: pb || offRange, pb, offRange, dir };
}

// ── Coach note bubble (live, in-workout AI note) ──────────────────────────────
// The coach's note pops into a distinct speech bubble on the exercise (NOT the
// plain notes field — that stays yours), so an AI observation never eats your
// own note or bloats the notes box. Persists on `ex.coachNote`, dismissible.
function coachNoteBubbleHTML(note, loading = false) {
  return `<div class="ex-coach-note${loading ? ' loading' : ''}">
    <span class="ecn-icon">${icon('zap', { size: 13 })}</span>
    <span class="ecn-text">${loading ? 'Coach is noting…' : esc(note)}</span>
    ${loading ? '' : `<button class="ecn-close" aria-label="Dismiss note">${icon('x', { size: 12 })}</button>`}
  </div>`;
}
function showCoachNoteBubble(ei, note, loading = false) {
  const block = awBody.querySelector(`.ex-block[data-ei="${ei}"]`);
  if (!block) return;
  const html = coachNoteBubbleHTML(note, loading);
  const existing = block.querySelector('.ex-coach-note');
  if (existing) {
    existing.outerHTML = html;
  } else {
    const anchor = block.querySelector('.ex-notes-input') || block.querySelector('.ex-block-header');
    anchor?.insertAdjacentHTML('afterend', html);
  }
  if (!loading) block.querySelector('.ex-coach-note')?.classList.add('pop');
}
function removeCoachNoteBubble(ei) {
  awBody.querySelector(`.ex-block[data-ei="${ei}"] .ex-coach-note`)?.remove();
}

// When every set of an exercise is completed AND it was notable (a PB or a
// top set off the rep target), ask the coach for a one-line note and pop it
// into a coach bubble on the exercise. Fires once per exercise, only with an
// API key, and never touches the notes field you type into yourself.
const autoNotedEx = new Set();
async function maybeAutoCoachNote(ei) {
  if (routineMode) return;
  const ex = activeSession?.exercises[ei];
  if (!ex || autoNotedEx.has(ex.id)) return;
  if ((ex.coachNote || '').trim()) return;                   // already have a coach note
  const working = ex.sets.filter(s => s.type !== 'warmup');  // dropsets count as effort
  if (!working.length || working.some(s => !s.done)) return; // not fully complete yet
  if (!working.some(s => s.done && ((s.weight || 0) > 0 || (s.reps || 0) > 0))) return;
  const why = exerciseNotable(ex);
  if (!why.notable) return;                                  // routine set — no call, may re-evaluate after edits
  const key = await coachGetKey();
  if (!key) return;
  autoNotedEx.add(ex.id);

  const lt = resolveLogType(ex);
  const range = ex.repRange ? `${ex.repRange.min}-${ex.repRange.max}` : 'n/a';
  const setsStr = ex.sets.filter(s => s.done).map(s =>
    lt === 'weighted' ? `${fmtKg(s.weight)}kg x ${s.reps}` :
    lt === 'bodyweight' ? `${s.reps} reps` :
    lt === 'duration' ? `${s.duration || 0}s` : `${s.distance || 0}km`).join(', ');
  const highlight = `${why.pb ? 'Hit a personal best this session. ' : ''}`
    + `${why.offRange ? (why.dir === 'over' ? 'Top set went above the rep target. ' : 'Top set fell short of the rep target. ') : ''}`;
  const prompt =
    `Exercise: ${ex.name}. Target reps: ${range}. Today's sets: ${setsStr}. `
    + `${ex.prevPerf ? `Previous session: ${ex.prevPerf}. ` : 'No prior data. '}${highlight}\n`
    + `Write ONE short coaching note (max 16 words) on this performance — whether to add load or reps next time, or a form/tempo cue. Note text only, no preamble.`;
  const system = 'You are a concise strength coach. Reply with a single short note (≤16 words), plain text, British English, numbers over adjectives, at most one emoji.';

  showCoachNoteBubble(ei, '', true);   // transient "Coach is noting…" bubble
  let res;
  try { res = await callCoach({ apiMessages: [{ role: 'user', content: prompt }], system, getKey: coachGetKey }); }
  catch (_) { res = { error: 'network' }; }

  const note = (res?.text || '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '').slice(0, 140);
  if (!note || res?.error) { autoNotedEx.delete(ex.id); removeCoachNoteBubble(ei); return; }   // allow a retry later
  // Write it back only if the exercise is still here and still un-noted.
  const cur = activeSession?.exercises[ei];
  if (!cur || cur.id !== ex.id || (cur.coachNote || '').trim()) { removeCoachNoteBubble(ei); return; }
  cur.coachNote = note;
  const curEi = activeSession.exercises.indexOf(cur);   // index may have shifted
  showCoachNoteBubble(curEi, note);
  saveSoon();
}

// ── PB recomputation (idempotent — trophies track live set values) ────────────
// sessionRecords stays the immutable historical baseline; each recompute seeds a
// throwaway copy from it and absorbs the current session's done sets in order,
// so a set only keeps a trophy while its numbers still beat everything before it.
function computeExercisePBs(ei) {
  const ex = activeSession?.exercises[ei];
  const pbs = [], pbSetIds = new Set(), pbBySet = new Map();
  if (!ex) return { pbs, pbSetIds, pbBySet };
  const base = sessionRecords[ex.name];
  const rec = {};
  if (base) rec[ex.name] = { maxWeight: base.maxWeight, maxE1rm: base.maxE1rm, repsAtWeight: { ...base.repsAtWeight } };
  for (const set of ex.sets) {
    if (!set.done) continue;
    const found = detectPBs(ex.name, set, rec);
    if (found.length) {
      // Carry the achieving set's numbers so surfaces (e.g. the PB-first summary)
      // can render {kg}×{reps} + est. 1RM without re-scanning the session.
      for (const p of found) { p.weight = set.weight; p.reps = set.reps || 0; p.est = Math.round(e1RM(set.weight, set.reps || 1)); }
      pbs.push(...found); pbSetIds.add(set.id); pbBySet.set(set.id, found[0]);
    }
    absorbSet(ex.name, set, rec);
  }
  return { pbs, pbSetIds, pbBySet };
}

function applyPbClasses(ei, pbSetIds) {
  const tbody = awBody.querySelector(`.sets-body[data-ei="${ei}"]`);
  if (!tbody) return;
  tbody.querySelectorAll('.set-row').forEach(row => {
    row.classList.toggle('pb', pbSetIds.has(row.dataset.setId));
  });
}

function refreshExercisePBs(ei) {
  const ex = activeSession?.exercises[ei];
  const res = computeExercisePBs(ei);
  if (ex) activeSession.pbs = (activeSession.pbs || []).filter(p => p.exercise !== ex.name).concat(res.pbs);
  applyPbClasses(ei, res.pbSetIds);
  return res;
}

function refreshAllPBs() {
  if (!activeSession) return;
  activeSession.pbs = [];
  if (routineMode) return;
  activeSession.exercises.forEach((_, ei) => {
    const res = computeExercisePBs(ei);
    activeSession.pbs.push(...res.pbs);
    applyPbClasses(ei, res.pbSetIds);
  });
}

function deleteSet(ei, setId) {
  const { ex, si } = findSet(ei, setId);
  if (!ex || si < 0) return;
  ex.sets.splice(si, 1);
  const tbody = awBody.querySelector(`.sets-body[data-ei="${ei}"]`);
  tbody.querySelector(`.set-row[data-set-id="${setId}"]`)?.remove();
  renumberSetRows(tbody);
  saveSoon();
}

function toggleDropSet(ei, setId) {
  const { set } = findSet(ei, setId);
  if (!set || set.type === 'warmup') return;
  set.type = set.type === 'dropset' ? 'normal' : 'dropset';
  replaceSetRow(ei, setId);   // show/hide the drop-set dual entry
  saveSoon();
}

// ── PB toast ──────────────────────────────────────────────────────────────────
let pbToastTimer = null;
function showPbToast(pb) {
  const el = document.getElementById('pbToast');
  el.innerHTML = `<span style="color:var(--amber);display:inline-flex;vertical-align:-0.2em;margin-right:4px">${icon('trophy', { size: 18 })}</span><strong>PB!</strong> ${esc(pb.exercise)} — ${esc(pb.label)}`;
  el.classList.add('visible');
  clearTimeout(pbToastTimer);
  pbToastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

// ── Typo guard ────────────────────────────────────────────────────────────────
let sanityTimer = null;
function queueSanityCheck(ex, set, rowEl) {
  clearTimeout(sanityTimer);
  sanityTimer = setTimeout(() => checkWeightSanity(ex, set, rowEl), 400);
}
function checkWeightSanity(ex, set, rowEl) {
  if (!rowEl) return;
  const tbody = rowEl.parentElement;
  const existing = tbody?.querySelector(`.set-warn-row[data-for="${set.id}"]`);
  const best = sessionRecords[ex.name]?.maxWeight || set.tW || 0;
  const suspect = best > 0 && set.weight > 0 && (set.weight > best * 2 || set.weight < best * 0.4);
  rowEl.classList.toggle('warn', suspect);
  if (!suspect) { existing?.remove(); return; }
  if (existing) return;
  const tr = document.createElement('tr');
  tr.className = 'set-warn-row';
  tr.dataset.for = set.id;
  tr.innerHTML = `<td colspan="5">⚠️ Unusual weight — best previous is ${fmtKg(best)} kg. Typo?</td>`;
  rowEl.after(tr);
}

// ── Exercise history peek (tap the name in the active workout) ────────────────
async function openExerciseHistorySheet(name) {
  const past = await loadSessions();
  const entries = [];
  for (const s of past) {
    if (s.id === activeSession?.id) continue;
    const ex = (s.exercises || []).find(e => e.name === name);
    if (!ex) continue;
    const sets = (ex.sets || []).filter(st => st.done || st.weight || st.reps || st.duration || st.distance);
    if (!sets.length) continue;
    entries.push({ date: s.date || (s.startTime || '').slice(0, 10), ex, sets });
    if (entries.length >= 6) break;
  }
  const back = document.createElement('div');
  back.className = 'modal-backdrop open';
  back.innerHTML = `<div class="modal">
    <p class="modal-title" style="display:flex;align-items:center;gap:7px"><span style="color:var(--blue);display:flex">${icon('chart-line', { size: 17 })}</span>${esc(name)}</p>
    <div style="max-height:50vh;overflow-y:auto">
    ${entries.length ? entries.map(en => `
      <div class="exh-row">
        <div class="exh-date">${fmtDate(en.date)}</div>
        <div class="exh-sets">${en.sets.map(st => esc(setPrevText(resolveLogType(en.ex), st))).join(' · ')}</div>
      </div>`).join('')
    : '<div class="empty-state" style="padding:14px 0">No previous sessions with this exercise yet.</div>'}
    </div>
    <div class="modal-btns"><button class="btn btn-p" data-close>Close</button></div>
  </div>`;
  document.body.appendChild(back);
  syncScrollLock();
  back.addEventListener('click', e => {
    if (e.target === back || e.target.closest('[data-close]')) { back.remove(); syncScrollLock(); }
  });
}

// ── Exercise detail (the anti-silo page: one lift's PB, trend, coach note, cues,
// history, and one-tap add-to-workout — reachable from Library, Progress, Coach,
// and the live workout) ───────────────────────────────────────────────────────
function closeExerciseDetail() {
  document.getElementById('exerciseDetail').classList.remove('visible');
  syncScrollLock();
}
async function openExerciseDetail(name) {
  if (!name) return;
  name = canonicalName(name);                  // always show the merged identity
  const [sessions, allEx] = await Promise.all([loadSessions(), getAllExercises()]);
  const def = allEx.find(x => x.name === name) || { name, category: guessCategory(name) };
  const st = buildExerciseStatsMap(sessions).get(name);
  const members = aliasMembers(name, sessions); // other logged names folded into this one

  // Recent sessions of this lift + best single-set volume (across all merged names).
  const history = [];
  let bestVol = 0;
  for (const s of sessions) {
    const ex = (s.exercises || []).find(e => canonicalName(e.name) === name);
    if (!ex) continue;
    const sets = (ex.sets || []).filter(x => x.done || x.weight || x.reps || x.duration || x.distance);
    if (!sets.length) continue;
    sets.forEach(x => { const v = (x.weight || 0) * (x.reps || 0); if (v > bestVol) bestVol = v; });
    if (history.length < 6) history.push({ date: s.date || (s.startTime || '').slice(0, 10), lt: resolveLogType(ex), sets, raw: ex.name !== name ? ex.name : null, pb: (s.pbs || []).some(p => canonicalName(p.exercise) === name) });
  }

  // Header
  document.getElementById('exDetailTitle').textContent = name;
  const catEl = document.getElementById('exDetailCat');
  const cc = CATEGORY_COLORS[def.category];
  catEl.textContent = def.category || '';
  catEl.style.display = def.category ? '' : 'none';
  if (cc) { catEl.style.color = cc; catEl.style.background = 'rgba(255,255,255,0.07)'; }

  // Hero stats
  const heroHTML = `<div class="ed-hstats">
    <div class="ed-hbox"><div class="ed-hval amber">${st ? fmtKg(st.pbWeight) + '×' + st.pbReps : '—'}</div><div class="ed-hlbl">Best set</div></div>
    <div class="ed-hbox"><div class="ed-hval">${st && st.e1rm ? Math.round(st.e1rm) + ' kg' : '—'}</div><div class="ed-hlbl">Est. 1RM</div></div>
    <div class="ed-hbox"><div class="ed-hval">${bestVol ? Math.round(bestVol).toLocaleString() : '—'}</div><div class="ed-hlbl">Best vol</div></div>
    <div class="ed-hbox"><div class="ed-hval">${st ? st.count : 0}</div><div class="ed-hlbl">Sessions</div></div>
  </div>`;

  // Progression chart (canonicalized so merged variations show on the same line)
  const chrono = canonicalizeSessions([...sessions].reverse());
  const progCard = st && st.series.length > 1
    ? `<div class="ed-card"><div class="ed-card-title">Top set over time <span class="sub">${st.series.length} sessions</span></div>${progressionHTML(chrono, name)}</div>`
    : '';

  // Coach note — stalling / progressing, with a one-tap ask.
  let note = '';
  const askLink = (prompt, force) => `<button class="ed-note-link" data-prompt="${esc(prompt)}" data-force="${esc(force || '')}">Ask coach to help ${icon('arrow-right', { size: 13 })}</button>`;
  if (st && st.series.length >= 4) {
    const recent = st.series.slice(-4), max = Math.max(...recent), min = Math.min(...recent);
    if (max > 0 && (max - min) / max < 0.03) {
      note = `<div class="ed-note"><span class="ci">${icon('bot', { size: 19 })}</span><div><div class="ed-note-body"><b>Stalling — 4 sessions flat.</b> Your top set has held around ${fmtKg(max)} kg. A short deload or an extra work set usually breaks this.</div>${askLink(`My ${name} has stalled for 4 sessions. Suggest one concrete change to progress it.`, 'suggest_routine_edit')}</div></div>`;
    } else if (st.series[st.series.length - 1] > st.series[0]) {
      note = `<div class="ed-note good"><span class="ci">${icon('bot', { size: 19 })}</span><div><div class="ed-note-body"><b>Progressing.</b> Top set is up from ${fmtKg(st.series[0])} to ${fmtKg(st.series[st.series.length - 1])} kg. Whatever you're doing, keep it.</div>${askLink(`How do I keep progressing my ${name}?`)}</div></div>`;
    }
  }

  // Target reps + form cues
  const range = resolveRepRange(def);
  const targetHTML = range ? `<div style="margin-bottom:14px"><span class="ed-target">${icon('target', { size: 15 })} Target ${range.min}–${range.max} reps</span></div>` : '';
  const cues = resolveCues(name) || [];
  const cuesHTML = cues.length
    ? `<div class="ed-card"><div class="ed-card-title">Form cues</div><ul class="ed-cues">${cues.map((c, i) => `<li class="ed-cue"><span class="ed-cue-n">${i + 1}</span><span>${esc(c)}</span></li>`).join('')}</ul></div>`
    : '';

  // Recent sets (a merged-in variation is tagged with the name it was logged as)
  const histHTML = history.length
    ? `<div class="ed-card"><div class="ed-card-title">Recent sets</div>${history.map(h => `<div class="ed-hrow"><span class="ed-hdate">${fmtDate(h.date)}${h.raw ? ` <span class="ed-raw-tag" data-tip="Logged as “${esc(h.raw)}”">${esc(h.raw)}</span>` : ''}</span><span class="ed-hsets">${h.pb ? `<span class="pbmark">${icon('trophy', { size: 11 })}</span> ` : ''}${h.sets.map(x => esc(setPrevText(h.lt, x))).join(' · ')}</span></div>`).join('')}</div>`
    : '<div class="ed-card"><div class="stats-empty">No logged sets yet — add it to a workout to start tracking.</div></div>';

  // Identity / history mapping — merge variations & customs into one lift, or split back out.
  const idCard = `<div class="ed-card"><div class="ed-card-title">Identity <span class="sub">history mapping</span></div>`
    + (members.length
        ? `<div class="ed-id-sub">Merging the history of ${members.length} other logged name${members.length > 1 ? 's' : ''}. Tap ✕ to separate one back out.</div>`
          + `<div class="ed-id-chips">${members.map(m => `<span class="ed-id-chip">${esc(m)}<button class="ed-id-x" data-sep="${esc(m)}" aria-label="Separate">${icon('x', { size: 12 })}</button></span>`).join('')}</div>`
        : `<div class="ed-id-sub">If the app is splitting this lift across different names — a variation or one of your customs — merge them so their history counts as one.</div>`)
    + `<button class="ed-id-merge" id="edMerge">${icon('plus-circle', { size: 15 })} Merge another exercise into this</button></div>`;

  document.getElementById('exDetailBody').innerHTML = heroHTML + progCard + note + targetHTML + idCard + cuesHTML + histHTML;

  // Actions (context-aware) — match by canonical so a merged identity still resolves to the live exercise
  const ei = activeSession ? (activeSession.exercises || []).findIndex(e => canonicalName(e.name) === name) : -1;
  const actEl = document.getElementById('exDetailActions');
  if (ei >= 0) {
    actEl.innerHTML = `<button class="ed-abtn p" id="edBack2">${icon('arrow-left', { size: 17 })} Back to workout</button>
      <button class="ed-abtn g" id="edSwap">${icon('repeat', { size: 16 })} Swap</button>`;
  } else {
    actEl.innerHTML = `<button class="ed-abtn p" id="edAdd">${icon('plus', { size: 18 })} ${activeSession ? 'Add to this workout' : 'Add to a workout'}</button>`;
  }

  document.getElementById('exerciseDetail').classList.add('visible');
  refreshIcons();
  syncScrollLock();

  // Wiring
  actEl.querySelector('#edBack2')?.addEventListener('click', () => { closeExerciseDetail(); openActiveWorkout(); });
  actEl.querySelector('#edSwap')?.addEventListener('click', () => { closeExerciseDetail(); openExPicker({ replaceEi: ei }); });
  actEl.querySelector('#edAdd')?.addEventListener('click', () => {
    if (activeSession) { addExerciseToSession(name, def.category); closeExerciseDetail(); openActiveWorkout(); }
    else { closeExerciseDetail(); startEmptyWorkout({ exercises: [{ name, category: def.category }] }); }
  });
  document.getElementById('exDetailBody').querySelectorAll('.ed-note-link').forEach(b => b.onclick = () => {
    const p = b.dataset.prompt, f = b.dataset.force;
    closeExerciseDetail();
    if (p) askCoachFromHome(p, f || false);
  });
  // Identity mapping
  document.getElementById('edMerge')?.addEventListener('click', () => openMergePicker(name));
  document.getElementById('exDetailBody').querySelectorAll('.ed-id-x').forEach(b => b.onclick = async () => {
    await setExerciseAlias(b.dataset.sep, null);   // remove the alias → split back out
    openExerciseDetail(name);                       // re-render the detail in place
  });
}
document.getElementById('exDetailBack').onclick = closeExerciseDetail;

// ── Merge picker: choose an exercise whose history folds into `canon` ──────────
// Lists every other known identity (built-ins, customs, and any name seen in
// history) minus those already merged here. Selecting one writes an alias
// (picked → canon) so its past sets count toward `canon` everywhere.
let mergeTargetCanon = null;
async function openMergePicker(canon) {
  mergeTargetCanon = canon;
  const [sessions, allEx] = await Promise.all([loadSessions(), getAllExercises()]);
  const seen = new Map();                          // lowerName -> display + category
  for (const e of allEx) seen.set(e.name.toLowerCase(), { name: e.name, category: e.category });
  for (const s of sessions) for (const ex of s.exercises || []) {
    if (!seen.has(ex.name.toLowerCase())) seen.set(ex.name.toLowerCase(), { name: ex.name, category: ex.category });
  }
  // Exclude the canonical itself and anything already resolving to it.
  const options = [...seen.values()]
    .filter(o => canonicalName(o.name) !== canon)
    .sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById('mergeExTitle').textContent = `Merge into “${canon}”`;
  document.getElementById('mergeExSearch').value = '';
  renderMergeOptions(options);
  window._mergeOptions = options;
  document.getElementById('mergeExModal').classList.add('open');
  syncScrollLock();
  setTimeout(() => document.getElementById('mergeExSearch').focus(), 120);
}
function renderMergeOptions(options) {
  const q = (document.getElementById('mergeExSearch').value || '').trim().toLowerCase();
  const list = q ? options.filter(o => o.name.toLowerCase().includes(q)) : options;
  const el = document.getElementById('mergeExList');
  el.innerHTML = list.length
    ? list.slice(0, 60).map(o => `<div class="ep-item" data-name="${esc(o.name)}"><span class="ep-cat-pill" style="background:${CATEGORY_COLORS[o.category] || '#8e8e9a'}">${esc(o.category || '')}</span><span class="ep-ex-name">${esc(o.name)}</span></div>`).join('')
    : `<div class="stats-empty" style="padding:18px">No matching exercise.</div>`;
  el.querySelectorAll('.ep-item').forEach(row => row.onclick = async () => {
    await setExerciseAlias(row.dataset.name, mergeTargetCanon);   // picked → canon
    closeMergePicker();
    openExerciseDetail(mergeTargetCanon);
  });
}
function closeMergePicker() {
  document.getElementById('mergeExModal').classList.remove('open');
  syncScrollLock();
}
document.getElementById('mergeExCancel').onclick = closeMergePicker;
document.getElementById('mergeExModal').addEventListener('click', e => {
  if (e.target === document.getElementById('mergeExModal')) closeMergePicker();
});
document.getElementById('mergeExSearch').oninput = () => renderMergeOptions(window._mergeOptions || []);

// ── Supersets ─────────────────────────────────────────────────────────────────
// Contiguous exercises that share a supersetId are performed back-to-back; rest
// only fires after the last member (see toggleSetDone).
// Repair superset ids after any structural edit (remove / reorder / replace):
// each maximal contiguous run keeps its id, singletons dissolve, and a gid that
// reappears in a later, separated run gets a fresh id — so groups are always
// valid unbroken blocks no matter how the list was rearranged.
function normalizeSupersets() {
  const list = activeSession?.exercises || [];
  const seen = new Set();
  let i = 0;
  while (i < list.length) {
    const gid = list[i].supersetId;
    if (!gid) { i++; continue; }
    let j = i;
    while (j < list.length && list[j].supersetId === gid) j++;
    if (j - i === 1) delete list[i].supersetId;
    else if (seen.has(gid)) {
      const ng = 'ss' + uid();
      for (let k = i; k < j; k++) list[k].supersetId = ng;
      seen.add(ng);
    } else seen.add(gid);
    i = j;
  }
}

function isLastSupersetMember(ei) {
  const ex = activeSession?.exercises[+ei];
  if (!ex?.supersetId) return true;
  const next = activeSession.exercises[+ei + 1];
  return !next || next.supersetId !== ex.supersetId;
}
// Pick which exercises to pair (any of them, not just the adjacent one). The
// chosen members are reordered to sit contiguously so the group stays a valid,
// unbroken block — that's the invariant the rail + rest-gating rely on.
function openSupersetPicker(ei) {
  const list = activeSession.exercises;
  const anchor = list[ei];
  if (!anchor) return;
  const gid = anchor.supersetId || null;
  const selected = new Set(list.map((_, i) => i).filter(i => i !== ei && gid && list[i].supersetId === gid));
  const back = document.createElement('div');
  back.className = 'modal-backdrop open';
  const rows = list.map((e, i) => i === ei ? '' : `
    <button class="sheet-btn ss-pick" data-i="${i}" style="display:flex;align-items:center;gap:12px;text-align:left">
      <span class="ss-tick" style="width:20px;color:var(--purple);display:inline-flex">${selected.has(i) ? icon('check', { size: 16 }) : ''}</span>
      <span style="flex:1">${esc(e.name)}</span>
    </button>`).join('');
  back.innerHTML = `<div class="modal">
    <p class="modal-title">Superset ${esc(anchor.name)} with…</p>
    <p style="font-size:0.78rem;color:var(--text-muted);margin:-8px 0 12px;line-height:1.5">Pick the exercises to pair — they'll be grouped together and the rest timer only runs after the last one.</p>
    <div style="max-height:44vh;overflow-y:auto;margin-bottom:6px">${rows || '<div class="empty-state" style="padding:16px 0">Add another exercise first.</div>'}</div>
    <div class="modal-btns">
      <button class="btn btn-g" data-act="cancel">Cancel</button>
      ${gid ? '<button class="btn btn-d" data-act="ungroup">Ungroup</button>' : ''}
      <button class="btn btn-p" data-act="done">Done</button>
    </div>
  </div>`;
  document.body.appendChild(back);
  syncScrollLock();
  const close = () => { back.remove(); syncScrollLock(); };
  back.addEventListener('click', e => {
    const pick = e.target.closest('.ss-pick');
    if (pick) {
      const i = +pick.dataset.i;
      selected.has(i) ? selected.delete(i) : selected.add(i);
      pick.querySelector('.ss-tick').innerHTML = selected.has(i) ? icon('check', { size: 16 }) : '';
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (e.target === back || act === 'cancel') { close(); return; }
    if (act === 'ungroup') { close(); ungroupSuperset(ei); return; }
    if (act === 'done')    { close(); applySuperset(ei, [...selected]); return; }
  });
}

function ungroupSuperset(ei) {
  const gid = activeSession.exercises[ei]?.supersetId;
  if (gid) for (const e of activeSession.exercises) if (e.supersetId === gid) delete e.supersetId;
  renderActiveSession();
  saveSoon();
}

function applySuperset(anchorEi, selectedIdxs) {
  const list = activeSession.exercises;
  const anchor = list[anchorEi];
  if (!anchor) return;
  const oldGid = anchor.supersetId || null;
  const members = new Set([anchorEi, ...selectedIdxs.filter(i => i >= 0 && i < list.length && i !== anchorEi)]);
  if (members.size < 2) { ungroupSuperset(anchorEi); return; }   // deselected all → ungroup
  // Drop any previous group member the user unchecked this time.
  if (oldGid) list.forEach((e, i) => { if (e.supersetId === oldGid && !members.has(i)) delete e.supersetId; });
  const gid = oldGid || ('ss' + uid());
  const ordered = [...members].sort((a, b) => a - b);
  const memberExs = ordered.map(i => list[i]);
  memberExs.forEach(e => e.supersetId = gid);
  // Reinsert the members as one contiguous block at the anchor's relative slot.
  let insertAt = 0;
  for (let i = 0; i < anchorEi; i++) if (!members.has(i)) insertAt++;
  const rest = list.filter((_, i) => !members.has(i));
  rest.splice(insertAt, 0, ...memberExs);
  activeSession.exercises = rest;
  renderActiveSession();
  saveSoon();
}

// ── Exercise "…" action sheet ─────────────────────────────────────────────────
let menuEi = null;
function openExMenuSheet(ei) {
  menuEi = ei;
  const ex = activeSession.exercises[ei];
  document.getElementById('exMenuTitle').textContent = ex.name;
  // Configure the superset row — needs at least one other exercise to pair with.
  const ssBtn = document.getElementById('exMenuSuperset');
  if (activeSession.exercises.length > 1) {
    ssBtn.style.display = '';
    ssBtn.innerHTML = `${icon('repeat', { size: 17 })} ${ex.supersetId ? 'Edit superset…' : 'Superset…'}`;
  } else {
    ssBtn.style.display = 'none';
  }
  document.getElementById('exMenuSheet').classList.add('open');
}
const exMenuSheet = document.getElementById('exMenuSheet');
exMenuSheet.addEventListener('click', e => { if (e.target === exMenuSheet) exMenuSheet.classList.remove('open'); });
document.getElementById('exMenuCancel').onclick  = () => exMenuSheet.classList.remove('open');
document.getElementById('exMenuEdit').onclick = () => {
  exMenuSheet.classList.remove('open');
  openEditExerciseModal(menuEi);
};
document.getElementById('exMenuReplace').onclick = () => {
  exMenuSheet.classList.remove('open');
  openExPicker({ replaceEi: menuEi });
};
document.getElementById('exMenuSuperset').onclick = () => {
  exMenuSheet.classList.remove('open');
  openSupersetPicker(menuEi);
};
document.getElementById('exMenuReorder').onclick = () => {
  exMenuSheet.classList.remove('open');
  enterReorderMode();
};
document.getElementById('exMenuRemove').onclick = () => {
  const ex = activeSession.exercises[menuEi];
  exMenuSheet.classList.remove('open');
  if (confirm(`Remove "${ex.name}" from this workout?`)) {
    activeSession.exercises.splice(menuEi, 1);
    renderActiveSession();
    saveSoon();
  }
};

// ── Replace exercise ("often picked" learned per original exercise) ──────────
async function replaceExercise(ei, newName, newCat) {
  const past = await loadSessions();
  const old = activeSession.exercises[ei];
  const prev = prevPerfFrom(past, newName);

  // Remember this replacement so it ranks first next time
  const prefs = (await db.get(STORE, 'replacement-prefs')) || {};
  const m = (prefs[old.name] ||= {});
  m[newName] = (m[newName] || 0) + 1;
  await db.set(STORE, 'replacement-prefs', prefs);

  // Re-derive logType/repRange for the NEW exercise — carrying over the old
  // exercise's was a bug: e.g. replacing a weighted lift with a duration-based
  // one (a plank, cardio) kept showing weight×reps columns.
  const allEx = await getAllExercises();
  const def = allEx.find(x => x.name === newName);
  const logType = prev?.logType || def?.logType || exLogType(newName, newCat);

  activeSession.exercises[ei] = {
    ...old,
    name: newName, category: newCat, logType,
    notes: prev?.notes || '',
    repRange: def?.repRange || null,
    prevPerf: prev ? prev.sets.slice(0,3).map(s => `${fmtKg(s.weight)}×${s.reps}`).join(', ') : null,
    prevSets: prev?.sets || null,
    restTime: old.restTime ?? prev?.restTime ?? 60,
    // Completed sets keep their logged numbers; pending sets get re-ghosted
    sets: old.sets.map((s, si) => {
      if (s.done) return s;
      const g = ghostsFor(prev?.sets || null, null, si);
      return {
        ...s, tW: g.tW, tR: g.tR,
        weight: s.touched?.weight ? s.weight : 0,
        reps:   s.touched?.reps   ? s.reps   : 0,
      };
    }),
  };
  renderActiveSession();
  saveSoon();
}

// ── Reorder mode (long-press or menu) ─────────────────────────────────────────
let reordering = false;
function enterReorderMode() {
  if (!activeSession?.exercises.length) return;
  reordering = true;
  try { navigator.vibrate?.(10); } catch(_) {}
  awBody.innerHTML = `
    <div class="reorder-hint">Drag to reorder, then tap Done.</div>
    <div id="reorderList">
      ${activeSession.exercises.map((ex, ei) => `
        <div class="reorder-card" data-ei="${ei}">
          <span class="ex-cat-dot" style="background:${CATEGORY_COLORS[ex.category]||'#8e8e9a'}"></span>
          <span class="reorder-name">${esc(ex.name)}</span>
          <span class="reorder-grip">${icon('grip-horizontal', { size: 18 })}</span>
        </div>`).join('')}
    </div>
    <button class="reorder-done" id="reorderDone">Done</button>
  `;
  document.getElementById('reorderDone').onclick = exitReorderMode;
}
function exitReorderMode() {
  const order = [...awBody.querySelectorAll('.reorder-card')].map(c => parseInt(c.dataset.ei));
  activeSession.exercises = order.map(i => activeSession.exercises[i]);
  reordering = false;
  renderActiveSession();
  saveSoon();
}

// ── Touch gestures: swipe on set rows, long-press on exercise headers,
//    drag in reorder mode. Pointer events only; touch-action does the rest. ────
// ── Set-row swipe gestures (work anywhere on the row, including the inputs) ────
// Taps still focus inputs; a clear horizontal drag becomes a swipe. Swipe left
// past threshold deletes the set (slide-out); swipe right toggles a drop set.
const gesture = { active: false };
let longPressTimer = null;
const SWIPE = { DECIDE: 10, DELETE: 72, DROP: 58, HINT: 22, MAX: 130 };

awBody.addEventListener('pointerdown', e => {
  if (reordering) {
    const card = e.target.closest('.reorder-card');
    if (card) startReorderDrag(e, card);
    return;
  }
  const header = e.target.closest('.ex-block-header');
  if (header && !e.target.closest('button')) {
    longPressTimer = setTimeout(() => { longPressTimer = null; enterReorderMode(); }, 400);
  }
  const row = e.target.closest('.set-row');
  // Allow swipe to begin on inputs too — only the check button is excluded so
  // its completion tap is never hijacked.
  if (!row || e.target.closest('.set-check') || row.classList.contains('removing')) return;
  Object.assign(gesture, {
    active: true, row, startX: e.clientX, startY: e.clientY,
    pointerId: e.pointerId, decided: false, horizontal: false, dx: 0,
    onInput: !!e.target.closest('.set-input'),
  });
});

awBody.addEventListener('pointermove', e => {
  if (longPressTimer !== null) {
    if (Math.abs(e.movementX || 0) > 8 || Math.abs(e.movementY || 0) > 8) { clearTimeout(longPressTimer); longPressTimer = null; }
  }
  if (!gesture.active) return;
  const dx = e.clientX - gesture.startX;
  const dy = e.clientY - gesture.startY;
  if (!gesture.decided && (Math.abs(dx) > SWIPE.DECIDE || Math.abs(dy) > SWIPE.DECIDE)) {
    gesture.decided = true;
    gesture.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
    if (gesture.horizontal) {
      try { gesture.row.setPointerCapture?.(gesture.pointerId); } catch(_) {}
      if (gesture.onInput) document.activeElement?.blur?.();   // drop the caret when a swipe wins
      gesture.row.classList.add('snapping');                    // ensure no transition lag mid-drag
      gesture.row.classList.remove('snapping');
    } else {
      gesture.active = false;                                   // vertical → let the list scroll
      return;
    }
  }
  if (gesture.decided && gesture.horizontal) {
    // light resistance past MAX so it never flies off
    let d = dx;
    if (Math.abs(d) > SWIPE.MAX) d = Math.sign(d) * (SWIPE.MAX + (Math.abs(d) - SWIPE.MAX) * 0.25);
    gesture.dx = d;
    gesture.row.style.transform = `translateX(${d}px)`;
    gesture.row.classList.toggle('swipe-del',  d <= -SWIPE.HINT);
    gesture.row.classList.toggle('swipe-drop', d >=  SWIPE.HINT);
    if (e.cancelable) e.preventDefault();
  }
});

function endSwipe(e) {
  clearTimeout(longPressTimer); longPressTimer = null;
  if (!gesture.active) return;
  const { row, dx, horizontal } = gesture;
  gesture.active = false;
  if (!horizontal) return;
  row.classList.remove('swipe-del', 'swipe-drop');
  const ei = row.dataset.ei, setId = row.dataset.setId;

  if (e.type !== 'pointercancel' && dx <= -SWIPE.DELETE) {
    slideOutDelete(row, ei, setId);
    return;
  }
  if (e.type !== 'pointercancel' && dx >= SWIPE.DROP) {
    toggleDropSet(ei, setId);
  }
  snapBack(row);
}
awBody.addEventListener('pointerup', endSwipe);
awBody.addEventListener('pointercancel', endSwipe);

function snapBack(row) {
  row.classList.add('snapping');
  row.style.transform = '';
  setTimeout(() => row.classList.remove('snapping'), 200);
}

function slideOutDelete(row, ei, setId) {
  row.classList.add('removing');
  row.style.transform = 'translateX(-110%)';
  setTimeout(() => deleteSet(ei, setId), 210);
}

// Reorder-mode dragging
function startReorderDrag(e, card) {
  const list = document.getElementById('reorderList');
  card.setPointerCapture?.(e.pointerId);
  card.classList.add('dragging');
  // anchorY maps the finger position to transform:0 (card at its DOM slot). When
  // we reorder in the DOM, the card's natural slot shifts by a row height, so we
  // adjust anchorY by that amount to keep the card glued to the finger — this is
  // what prevents the jump/overlap glitch.
  let anchorY = e.clientY;

  const move = ev => {
    if (ev.cancelable) ev.preventDefault();
    card.style.transform = `translateY(${ev.clientY - anchorY}px)`;
    const rect = card.getBoundingClientRect();
    const cardMid = rect.top + rect.height / 2;
    for (const other of [...list.querySelectorAll('.reorder-card')]) {
      if (other === card) continue;
      const r = other.getBoundingClientRect();
      const otherMid = r.top + r.height / 2;
      const pos = card.compareDocumentPosition(other);
      // dragged above a preceding neighbour → move card up before it
      if (pos & Node.DOCUMENT_POSITION_PRECEDING && cardMid < otherMid) {
        list.insertBefore(card, other);
        anchorY -= r.height;
        card.style.transform = `translateY(${ev.clientY - anchorY}px)`;
        break;
      }
      // dragged below a following neighbour → move card down after it
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING && cardMid > otherMid) {
        other.after(card);
        anchorY += r.height;
        card.style.transform = `translateY(${ev.clientY - anchorY}px)`;
        break;
      }
    }
  };
  const up = () => {
    card.classList.add('snapback');
    card.style.transform = '';
    card.classList.remove('dragging');
    setTimeout(() => card.classList.remove('snapback'), 150);
    card.removeEventListener('pointermove', move);
    card.removeEventListener('pointerup', up);
    card.removeEventListener('pointercancel', up);
  };
  card.addEventListener('pointermove', move);
  card.addEventListener('pointerup', up);
  card.addEventListener('pointercancel', up);
}

// ── Finish workout ────────────────────────────────────────────────────────────
document.getElementById('awFinishBtn').onclick = () => {
  if (!activeSession) return;
  if (routineMode) {
    if (activeSession.exercises.length === 0) { cancelWorkout(); return; }
    openSaveTemplateModal();
    return;
  }
  if (activeSession.exercises.length === 0) { cancelWorkout(); return; }
  showWorkoutSummary();
};

function finishWarnings() {
  const warnings = [];
  let incomplete = 0, empty = 0, suspect = 0;
  for (const ex of activeSession.exercises) {
    const done = ex.sets.filter(s => s.done);
    if (!done.length) { empty++; continue; }
    incomplete += ex.sets.length - done.length;
    const best = sessionRecords[ex.name]?.maxWeight || 0;
    for (const s of done) {
      if (best > 0 && s.weight > best * 2) suspect++;
    }
  }
  if (empty)      warnings.push(`${empty} exercise${empty>1?'s':''} with no completed sets`);
  if (incomplete) warnings.push(`${incomplete} set${incomplete>1?'s':''} not checked off`);
  if (suspect)    warnings.push(`${suspect} set${suspect>1?'s':''} with an unusually heavy weight — typo?`);
  return warnings;
}

async function showWorkoutSummary() {
  skipRest();
  refreshAllPBs();   // ensure the PB count reflects the final, corrected numbers
  const title = document.getElementById('awTitle').value.trim() || 'Workout';
  activeSession.title = title;

  const doneSets = activeSession.exercises.flatMap(e => e.sets.filter(s => s.done));
  const volume   = doneSets.reduce((s, set) => s + (set.weight || 0) * (set.reps || 1), 0);
  const durSecs  = sessionSecsNow();
  const pbs      = activeSession.pbs || [];
  const pbCount  = pbs.length;

  // ── Header: PBs lead; fall back to the routine name when there are none ──────
  const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const headTitle = pbCount ? `${pbCount} personal best${pbCount > 1 ? 's' : ''}` : esc(title);
  const badge = pbCount
    ? `<div class="summary-badge">${icon('trophy', { size: 24 })}</div>`
    : `<div class="summary-badge ok">${icon('check', { size: 24 })}</div>`;
  document.getElementById('summaryHeader').innerHTML = `
    ${badge}
    <div class="summary-htext">
      <div class="summary-title">${headTitle}</div>
      <div class="summary-date">${esc(title)} · ${dateStr}</div>
    </div>`;

  // ── PB list: one row per PB, {kg}×{reps} + est. 1RM / heaviest-ever delta ────
  document.getElementById('summaryPBs').innerHTML = pbCount ? `
    <div class="summary-pbs">
      ${pbs.map(p => {
        const baseMax = sessionRecords[p.exercise]?.maxWeight || 0;
        const delta = p.type === 'weight' && baseMax > 0 ? Math.round(p.weight - baseMax) : 0;
        const suffix = delta > 0 ? `+${delta} kg` : `est. 1RM ${p.est} kg`;
        return `<div class="summary-pb-row">
          <span class="summary-pb-name">${esc(p.exercise)}</span>
          <span class="summary-pb-val">${fmtKg(p.weight)} × ${p.reps} <span class="sub">· ${suffix}</span></span>
        </div>`;
      }).join('')}
    </div>
    <button class="stats-link" id="summaryPrLink" style="margin-top:-4px">View on your PR timeline ${icon('arrow-right', { size: 14 })}</button>` : '';

  // ── Three stat boxes (PB box dropped — PBs now lead) ─────────────────────────
  document.getElementById('summaryStats').innerHTML = `
    <div class="stat-box"><div class="stat-val">${fmtTime(durSecs)}</div><div class="stat-label">Duration</div></div>
    <div class="stat-box"><div class="stat-val">${doneSets.length}</div><div class="stat-label">Sets</div></div>
    <div class="stat-box"><div class="stat-val">${Math.round(volume).toLocaleString()}</div><div class="stat-label">Volume kg</div></div>
  `;

  const warnings = finishWarnings();
  const warnIcon = `<span style="color:var(--amber);display:inline-flex;vertical-align:-0.2em;margin-right:4px">${icon('triangle-alert', { size: 15 })}</span>`;
  document.getElementById('summaryWarnings').innerHTML = warnings.length
    ? `<div class="summary-warn-box">${warnings.map(w => warnIcon + esc(w)).join('<br>')}<br><span>Check before saving, or save anyway.</span></div>`
    : '';

  // ── vs. your last {routine}: volume + duration deltas ────────────────────────
  const sessions = await loadSessions();
  const last = sessions.find(s => (s.title || '') === title);
  let compareHTML = '';
  if (last) {
    const lastVol = (last.exercises || []).flatMap(e => (e.sets || []).filter(st => st.done))
      .reduce((a, st) => a + (st.weight || 0) * (st.reps || 1), 0);
    const volDelta = Math.round(volume - lastVol);
    const durDelta = durSecs - (last.duration || 0);
    const volStr = `${volDelta >= 0 ? '+' : '−'}${Math.abs(volDelta).toLocaleString()} kg`;
    const durStr = last.duration ? `${durDelta >= 0 ? '+' : '−'}${fmtTime(Math.abs(durDelta))}` : '—';
    compareHTML = `
      <div class="summary-compare">
        <div class="summary-compare-rule">vs. your last ${esc(title)}</div>
        <div class="summary-compare-figs">
          <div class="summary-compare-fig"><div class="cf-val${volDelta > 0 ? ' up' : ''}">${volStr}</div><div class="cf-lbl">Volume</div></div>
          <div class="summary-compare-fig"><div class="cf-val">${durStr}</div><div class="cf-lbl">Duration</div></div>
        </div>
      </div>`;
  }
  document.getElementById('summaryCompare').innerHTML = compareHTML;

  // ── Coach note: top-set-vs-rep-range check (skip if nothing to say) ──────────
  const note = summaryCoachNote();
  document.getElementById('summaryCoachNote').innerHTML = note
    ? `<div class="summary-coach">${icon('bot', { size: 17 })}<div class="summary-coach-body">${esc(note)}</div></div>`
    : '';

  document.getElementById('workoutSummary').classList.add('visible');
  // Save, then jump to the PR timeline in Progress (the PB you just set leads it).
  document.getElementById('summaryPrLink')?.addEventListener('click', () => {
    document.getElementById('saveBtn').click();
    setTimeout(() => { statsView = 'training'; document.querySelector('.tab[data-tab="Stats"]').click(); }, 80);
  });
}

// Generate one actionable sentence from the top working set vs. its rep-range
// target — reuses the ranges already resolved onto each exercise. Returns '' if
// nothing stands out (so the card is dropped).
function summaryCoachNote() {
  for (const ex of activeSession.exercises) {
    const range = ex.repRange || resolveRepRange(ex);
    if (!range || !range.min || !range.max) continue;
    const working = ex.sets.filter(s => s.done && (s.weight || 0) > 0 && s.type !== 'warmup' && s.type !== 'dropset');
    if (!working.length) continue;
    const top = working.reduce((a, b) => (b.weight > a.weight ? b : a));
    if ((top.reps || 0) > range.max + 1) {
      return `${ex.name}: your top set hit ${top.reps} reps, above the ${range.min}–${range.max} target — add weight next time to stay in range.`;
    }
    if ((top.reps || 0) > 0 && top.reps < range.min) {
      return `${ex.name}: your top set landed at ${top.reps} reps, under the ${range.min}–${range.max} target — drop the load a touch next time.`;
    }
  }
  return '';
}

function handleSummaryBgClick(e) {
  if (e.target === document.getElementById('workoutSummary')) {
    // Tap outside = go back to the workout, not lose it
    document.getElementById('workoutSummary').classList.remove('visible');
  }
}

document.getElementById('saveBtn').onclick    = saveWorkout;
document.getElementById('discardBtn').onclick = () => { if (confirm('Discard this workout? All logged sets will be lost.')) cancelWorkout(); };

async function saveWorkout() {
  releaseWakeLock();
  // Backfill: a workout logged for a past day via the calendar saves to that
  // date with a neutral noon timestamp and 0 duration (both editable after).
  const isBackfill = !!backfillDate;
  const dateStr = isBackfill ? backfillDate : new Date().toISOString().slice(0,10);
  const session = {
    ...activeSession,
    title:     document.getElementById('awTitle').value.trim() || 'Workout',
    date:      dateStr,
    startTime: isBackfill ? `${dateStr}T12:00:00` : activeSession.startTime,
    endTime:   isBackfill ? `${dateStr}T12:00:00` : new Date().toISOString(),
    duration:  isBackfill ? 0 : sessionSecsNow(),
    // Strip transient/derived fields — prevPerf/prevSets were only ghosting aids
    // for the live editor and would otherwise bloat every saved session forever.
    exercises: activeSession.exercises.map(({ prevPerf, prevSets, ...e }) => ({
      ...e,
      sets: e.sets.map(({ touched, tW, tR, ...s }) => s), // strip transient fields
    })),
  };
  await ensureExercisesInRepo(session.exercises);   // catalogue anything new
  await db.set(STORE, 'session-' + session.id, session);
  await clearActiveSessionStore();
  backfillDate = null;
  closeFocusMode();
  document.getElementById('workoutSummary').classList.remove('visible');
  document.getElementById('activeWorkout').classList.remove('visible');
  unfitActiveWorkout();
  activeSession = null;
  document.getElementById('miniBar').classList.remove('visible');
  renderDashboard();
  renderHistory();   // so a backfilled (past-dated) workout shows up immediately
  renderStats();     // refresh the calendar + charts too
  db.backup();       // mirror the new session up (self-healing background push)
}

function cancelWorkout() {
  releaseWakeLock();
  skipRest();
  routineMode = false;
  backfillDate = null;
  activeSession = null;
  clearActiveSessionStore();
  closeFocusMode();
  document.getElementById('workoutSummary').classList.remove('visible');
  document.getElementById('activeWorkout').classList.remove('visible');
  unfitActiveWorkout();
  document.getElementById('miniBar').classList.remove('visible');
}

// ── Rest-end chime (Web Audio — mixes with your music) ───────────────────────
// Web Audio LAYERS the beep over whatever else is playing (Spotify/Apple Music
// keep going) instead of taking over playback. Trade-off: iOS silences Web Audio
// when the physical ringer switch is on SILENT. Since you train with music
// playing, the phone isn't on silent — so the alarm both sounds and mixes. (An
// <audio>-element alarm plays through the silent switch but PAUSES your music;
// iOS gives web pages no way to make that session mix, so it's a hard either/or.
// A settings toggle can offer both modes if wanted.) Neither can play while the
// PWA is fully backgrounded; the chime then fires on return if rest elapsed hidden.
let audioCtx = null;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== 'running') audioCtx.resume();
    // Warm the hardware with a silent tick so the first real chime isn't eaten.
    const buf = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf; src.connect(audioCtx.destination); src.start(0);
  } catch (_) {}
}
function playChime() {
  if (!audioCtx) return;
  const play = () => {
    try {
      // Loud, attention-grabbing alarm: two urgent triads through a limiter so
      // it's as loud as possible without clipping. (iOS still respects the
      // physical mute switch — nothing JS can do about that.)
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -8; comp.ratio.value = 12; comp.attack.value = 0.002; comp.release.value = 0.1;
      comp.connect(audioCtx.destination);
      const master = audioCtx.createGain();
      master.gain.value = 1.0;
      master.connect(comp);

      const now = audioCtx.currentTime;
      const beeps = [0, 0.16, 0.32, 0.62, 0.78, 0.94]; // two triads
      const freqs = [988, 1319, 1568, 988, 1319, 1568];
      beeps.forEach((offset, i) => {
        const t = now + offset;
        // layer a sine + square for a fuller, louder tone
        ['sine', 'square'].forEach((type, j) => {
          const osc = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          osc.type = type;
          osc.frequency.value = freqs[i];
          const peak = type === 'square' ? 0.28 : 0.6;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(peak, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
          osc.connect(g).connect(master);
          osc.start(t);
          osc.stop(t + 0.16);
        });
      });
    } catch (_) {}
  };
  try {
    if (audioCtx.state !== 'running') audioCtx.resume().then(play).catch(() => {});
    else play();
  } catch (_) {}
}

// ── Rest timer (timestamp-based; survives backgrounding & reload) ────────────
function startRest(secs = 60, exName = '') {
  if (secs <= 0) { skipRest(); return; }
  clearInterval(restTimer);
  restEndsAt = Date.now() + secs * 1000;
  restTotalSecs = secs;
  restExName = exName;
  restFiredChime = false;
  db.set(STORE, 'active-rest', { endsAt: restEndsAt, totalSecs: secs, exName });
  const bar = document.getElementById('restBar');
  bar.classList.add('visible');
  bar.classList.remove('flash', 'done-state');
  document.getElementById('restBarName').textContent = exName ? `Rest — ${exName}` : 'Rest';
  tickRest();
  restTimer = setInterval(tickRest, 250);
}

function tickRest() {
  if (!restEndsAt) return;
  const remaining = Math.ceil((restEndsAt - Date.now()) / 1000);
  updateRestDisplay(remaining);
  if (remaining <= 0) finishRest();
}

function finishRest() {
  if (restFiredChime) return;
  restFiredChime = true;
  clearInterval(restTimer);
  updateRestDisplay(0);
  const bar = document.getElementById('restBar');
  if (bar) {
    bar.classList.add('flash', 'done-state');            // pulses until dismissed
    document.getElementById('restBarName').innerHTML = `${icon('circle-check', { size: 15 })} Rest done — next set!`;
  }
  playChime();
  try { navigator.vibrate?.([300,120,300,120,300]); } catch(_) {}
  // NB: intentionally NOT auto-dismissed — the bar stays visible/pulsing until
  // the user hits Skip or checks off the next set (which restarts the timer).
}

function updateRestDisplay(remaining) {
  const el = document.getElementById('restBarCount');
  if (!el) return;
  const r = Math.max(0, remaining);
  el.textContent = fmtTime(r);
  el.className = 'rest-bar-count' + (r <= 0 ? ' done' : r <= 10 ? ' low' : '');
  const fill = document.getElementById('restBarFill');
  if (fill && restTotalSecs > 0) {
    fill.style.width = `${Math.max(0, Math.min(100, (r / restTotalSecs) * 100))}%`;
  }
  if (focusMode) refreshFocusRest();
}

function skipRest() {
  clearInterval(restTimer);
  restEndsAt = null;
  restSubText = '';
  const bar = document.getElementById('restBar');
  bar?.classList.remove('visible', 'flash', 'done-state');
  db.set(STORE, 'active-rest', null);
  if (focusMode) refreshFocusRest();
}

function bumpRest(delta) {
  if (!restEndsAt) return;
  restEndsAt = Math.max(Date.now() + 1000, restEndsAt + delta * 1000);
  restTotalSecs = Math.max(restTotalSecs + delta, 1);
  restFiredChime = false;
  db.set(STORE, 'active-rest', { endsAt: restEndsAt, totalSecs: restTotalSecs });
  tickRest();
}

function resumeRestFromDb(saved) {
  if (!saved?.endsAt) return;
  restTotalSecs = saved.totalSecs || 60;
  if (saved.endsAt > Date.now()) {
    restEndsAt = saved.endsAt;
    restFiredChime = false;
    const bar = document.getElementById('restBar');
    bar.classList.add('visible');
    document.getElementById('restBarName').textContent = saved.exName ? `Rest — ${saved.exName}` : 'Rest';
    clearInterval(restTimer);
    tickRest();
    restTimer = setInterval(tickRest, 250);
  } else if (Date.now() - saved.endsAt < 60_000) {
    // Expired very recently (probably while backgrounded) — signal once
    restEndsAt = saved.endsAt;
    document.getElementById('restBar').classList.add('visible');
    finishRest();
  } else {
    db.set(STORE, 'active-rest', null);
  }
}

// ── Auto cloud backup (throttled) ─────────────────────────────────────────────
// Mirror local → cloud on app open and on resume, at most once per window. This
// is cheap and safe: db.backup() is upsert-only (it never deletes), so it can't
// wipe the cloud even if it somehow ran mid-restore — the throttle just avoids
// needless network calls. ~6h means a couple of automatic backups a day plus one
// every time you open the app after a gap, with no button to remember.
const AUTO_BACKUP_MS = 6 * 60 * 60 * 1000;
async function autoBackupIfStale() {
  try {
    const last = +(localStorage.getItem('arc-last-backup') || 0);
    if (Date.now() - last < AUTO_BACKUP_MS) return;
    await restore.catch(() => {});   // never race the initial restore (post-login pull included)
    await db.backup();
    localStorage.setItem('arc-last-backup', String(Date.now()));
  } catch (_) { /* offline / no session — try again next open */ }
}

// ── Visibility: the app coming back from background ───────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (activeSession) saveActiveSession(); // flush — beforeunload is unreliable on iOS
    return;
  }
  // visible again
  if (activeSession) {
    acquireWakeLock(); // iOS silently releases it on hide
  }
  if (restEndsAt) {
    if (Date.now() >= restEndsAt) finishRest();
    else tickRest();
  }
  autoBackupIfStale();   // resumed after a gap — mirror up if due
});

// expose to HTML
window.skipRest = skipRest;
window.bumpRest = bumpRest;
window.handleSummaryBgClick = handleSummaryBgClick;
window.openActiveWorkout = openActiveWorkout;

// ── Exercise picker (also handles replace mode) ───────────────────────────────
let epFilter = 'All';
let epReplaceEi = null; // when set, picking replaces instead of appends

async function getAllExercises() {
  const custom = (await db.get(STORE, 'exercises-custom')) || [];
  // Apply any library edits to the built-in list (category / tracking type).
  const builtin = EXERCISES.map(e => {
    const ov = exOverrides[e.name];
    if (!ov) return e;
    const merged = { ...e };
    if (ov.category && CATEGORIES.includes(ov.category)) merged.category = ov.category;
    if (ov.logType && LOGTYPES[ov.logType]) merged.logType = ov.logType;
    return merged;
  });
  return [...builtin, ...custom.map(e => ({ ...e, custom: true }))];
}

// Load the built-in library overrides into the module cache. Called at init
// before the first render so resolveLogType/resolveCategory see them, and again
// after each edit so they stay current.
async function loadExOverrides() {
  exOverrides = (await db.get(STORE, 'exercises-overrides')) || {};
  return exOverrides;
}

document.getElementById('awAddExBtn').onclick   = () => openExPicker();
document.getElementById('epCancel').onclick     = closeExPicker;

function openExPicker(opts = {}) {
  epFilter = 'All';
  epReplaceEi = opts.replaceEi ?? null;
  document.getElementById('epSearch').value = '';
  document.getElementById('epSearch').placeholder = epReplaceEi !== null
    ? 'Search all exercises…'
    : 'Search exercises…';
  document.getElementById('exercisePicker').classList.add('visible');
  renderExPicker();
  setTimeout(() => document.getElementById('epSearch').focus(), 150);
}

function closeExPicker() {
  epReplaceEi = null;
  document.getElementById('epReplaceHead').style.display = 'none';
  document.getElementById('exercisePicker').classList.remove('visible');
}

document.getElementById('epSearch').oninput = renderExPicker;

// Generic, honest per-category note for swap mode — a mechanical hint, not
// fabricated per-exercise copy (the design flags swapNote as optional).
const CATEGORY_SWAP_NOTE = {
  Chest:      'Same pressing pattern at a different angle — expect a comparable load.',
  Back:       'Same pulling pattern; grip and angle shift where you feel it.',
  Shoulders:  'Delt-focused — lighter loads and higher reps suit it best.',
  Biceps:     'Elbow flexion; the angle changes the long-vs-short-head bias.',
  Triceps:    'Elbow extension — a different head bias at a similar fatigue cost.',
  Quads:      'Knee-dominant — expect a similar load and fatigue cost.',
  Hamstrings: 'Hip-hinge or knee-flexion; mind the stretch under load.',
  Glutes:     'Hip extension — often heavier, with longer rest.',
  Calves:     'High-rep, short rest; small range, big stretch.',
  Core:       'Trunk work — reps and control over load.',
  Cardio:     'Conditioning — tracked by time, not weight.',
};

function pickerRow(e) {
  return `
    <div class="ep-item" data-name="${esc(e.name)}" data-cat="${esc(e.category)}">
      <span class="ep-cat-pill" style="background:${CATEGORY_COLORS[e.category]||'#8e8e9a'}">${esc(e.category)}</span>
      <span class="ep-ex-name">${esc(e.name)}</span>
      ${e.custom ? '<span style="font-size:0.65rem;color:var(--text-muted)">Custom</span>' : ''}
    </div>`;
}

function swapMatchCard(e, st, first) {
  const why = CATEGORY_SWAP_NOTE[e.category] || 'Similar movement pattern.';
  const hist = st
    ? `<div class="ep-match-hist">Your last: <b>${fmtKg(st.lastWeight)} × ${st.lastReps}</b> · ${st.count} session${st.count > 1 ? 's' : ''}</div>`
    : '';
  return `
    <div class="ep-match-card ep-item${first ? ' first' : ''}" data-name="${esc(e.name)}" data-cat="${esc(e.category)}">
      <div class="ep-match-top">
        <span class="ep-cat-pill" style="background:${CATEGORY_COLORS[e.category]||'#8e8e9a'}">${esc(e.category)}</span>
        <span class="ep-match-name">${esc(e.name)}</span>
        ${st ? '' : '<span class="ep-new-chip">New</span>'}
      </div>
      <div class="ep-match-why">${esc(why)}</div>
      ${hist}
    </div>`;
}

function bindPickerItems(listEl) {
  listEl.querySelectorAll('.ep-item').forEach(item => {
    item.onclick = async () => {
      if (epReplaceEi !== null) {
        const ei = epReplaceEi;
        closeExPicker();
        await replaceExercise(ei, item.dataset.name, item.dataset.cat);
      } else {
        await addExerciseToSession(item.dataset.name, item.dataset.cat);
        closeExPicker();
        renderActiveSession();
        saveSoon();
      }
    };
  });
  const custom = listEl.querySelector('#epAddCustom');
  if (custom) custom.onclick = () => { closeExPicker(); openCustomExModal(); };
}

async function renderExPicker() {
  const q    = document.getElementById('epSearch').value.toLowerCase();
  const all  = await getAllExercises();
  const swap = epReplaceEi !== null;
  const listEl   = document.getElementById('epList');
  const headEl   = document.getElementById('epReplaceHead');
  const filtersEl = document.getElementById('epFilters');

  // Swap-mode header ("REPLACING / <name>"); category filters hidden.
  if (swap) {
    const cur = activeSession.exercises[epReplaceEi];
    headEl.style.display = '';
    headEl.innerHTML = `<div class="ep-replace-eyebrow">Replacing</div><div class="ep-replace-name">${esc(cur?.name || '')}</div>`;
    filtersEl.style.display = 'none';
  } else {
    headEl.style.display = 'none';
    filtersEl.style.display = '';
    const cats = ['All', ...CATEGORIES];
    filtersEl.innerHTML = cats.map(c =>
      `<button class="ep-filter ${c === epFilter ? 'active' : ''}" data-cat="${c}">${c}</button>`
    ).join('');
    filtersEl.querySelectorAll('.ep-filter').forEach(btn => {
      btn.onclick = () => { epFilter = btn.dataset.cat; renderExPicker(); };
    });
  }

  // ── Swap mode, empty query: ranked closest matches + rest of the category ──
  if (swap && !q) {
    const orig = activeSession.exercises[epReplaceEi];
    const origName = orig?.name, origCat = orig?.category;
    const [prefs, sessions] = await Promise.all([db.get(STORE, 'replacement-prefs'), loadSessions()]);
    const co = (prefs || {})[origName] || {};
    const stats = buildExerciseStatsMap(sessions);
    const sameCat = all.filter(e => e.category === origCat && e.name !== origName);
    // same category first (already filtered), then co-occurrence, then frequency.
    sameCat.sort((a, b) =>
      (co[b.name] || 0) - (co[a.name] || 0) ||
      (stats.get(b.name)?.count || 0) - (stats.get(a.name)?.count || 0) ||
      a.name.localeCompare(b.name));
    const matches = sameCat.slice(0, 4);
    const rest    = sameCat.slice(4);

    const matchHTML = matches.length
      ? matches.map((e, i) => swapMatchCard(e, stats.get(e.name), i === 0)).join('')
      : `<div class="routines-empty">No other ${esc(origCat)} exercises yet — search above.</div>`;
    const restHTML = rest.length
      ? `<div class="ep-else-head">Everything else in ${esc(origCat)}</div>${rest.map(pickerRow).join('')}`
      : '';

    listEl.innerHTML = `
      <div class="ep-match-head">${icon('repeat', { size: 13 })} Closest match</div>
      ${matchHTML}
      ${restHTML}
      <div class="ep-custom-row"><button class="ep-custom-btn" id="epAddCustom">+ Create custom exercise</button></div>`;
    bindPickerItems(listEl);
    return;
  }

  // ── Default: add mode, or swap-with-a-query — flat filtered list ──
  const filtered = all.filter(e =>
    (swap || epFilter === 'All' || e.category === epFilter) &&
    matchesSearch(`${e.name} ${e.category}`, q)
  );

  listEl.innerHTML = filtered.map(pickerRow).join('') + `
    <div class="ep-custom-row">
      <button class="ep-custom-btn" id="epAddCustom">+ Create custom exercise</button>
    </div>`;
  bindPickerItems(listEl);
}

async function addExerciseToSession(name, category) {
  const past = await loadSessions();
  const prev = prevPerfFrom(past, name);
  const prevSets = prev?.sets || null;
  // logType: prefer the previous session's / custom exercise's stored type, else infer.
  const all = await getAllExercises();
  const def = all.find(e => e.name === name);
  const logType = prev?.logType || def?.logType || exLogType(name, category);
  activeSession.exercises.push({
    id: uid(), name, category, logType,
    notes: prev?.notes || '',
    restTime: prev?.restTime ?? 60,
    repRange: def?.repRange || null,
    prevPerf: prev ? prev.sets.slice(0,3).map(s => `${fmtKg(s.weight)}×${s.reps}`).join(', ') : null,
    prevSets,
    sets: [freshSet(null, prevSets, 0)],
  });
  ensureExercisesInRepo([{ name, category, logType }]);  // catalogue it for reuse
}

// Guarantee every exercise passed is present in the exercise repository. Anything
// added during a workout — picked, coach-drafted, from a prefilled routine, or
// CSV-imported — becomes selectable next time and shows in the Library. Built-in
// exercises are left untouched; only genuinely new names get catalogued (custom).
async function ensureExercisesInRepo(exercises) {
  if (!exercises?.length) return;
  const custom = (await db.get(STORE, 'exercises-custom')) || [];
  const known = new Set([
    ...EXERCISES.map(e => e.name.toLowerCase()),
    ...custom.map(e => e.name.toLowerCase()),
  ]);
  const added = [];
  for (const ex of exercises) {
    const name = (ex.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    const entry = {
      id: uid(), name,
      category: ex.category || guessCategory(name),
      logType: ex.logType || exLogType(name, ex.category),
      custom: true,
    };
    custom.push(entry);
    added.push(entry);
  }
  if (!added.length) return;
  await db.set(STORE, 'exercises-custom', custom);
  added.forEach(lookupRepRangeForCustom);   // background AI rep-range fill
}

// Most recent past performance of an exercise, from a preloaded session list.
// Equipment tokens the library uses to distinguish variants. Equipment MATTERS
// for load (a cable row ≠ a barbell row ≠ a dumbbell row), so the pre-fill match
// must be equipment-aware — it may bridge naming *style* but never mix equipment.
// Order: more specific first ("smith machine" before "machine").
const EQUIP_TOKENS = [
  ['smith machine', 'smith'], ['smith', 'smith'],
  ['barbell', 'barbell'], ['dumbbell', 'dumbbell'], ['kettlebell', 'kettlebell'],
  ['cable', 'cable'], ['machine', 'machine'], ['resistance band', 'band'], ['band', 'band'],
  ['ez bar', 'ezbar'], ['ez-bar', 'ezbar'], ['trap bar', 'trapbar'], ['hex bar', 'trapbar'],
  ['landmine', 'landmine'], ['bodyweight', 'bodyweight'], ['sled', 'sled'],
];
function equipOf(name) {
  const n = String(name || '').toLowerCase();
  for (const [tok, id] of EQUIP_TOKENS) if (n.includes(tok)) return id;
  return '';   // unspecified
}
function baseOf(name) {
  let n = String(name || '').toLowerCase().replace(/\(.*?\)/g, ' ');
  for (const [tok] of EQUIP_TOKENS) n = n.split(tok).join(' ');
  return n.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// Find the most recent history for this exercise, tolerant of naming style but
// STRICT on equipment. Tiers: exact name → same movement + same equipment →
// same movement where one side left equipment unspecified. Two DIFFERENT explicit
// equipments (cable vs dumbbell) never match, so their weights never cross over.
function prevPerfFrom(sessions, exerciseName) {
  const tBase = baseOf(exerciseName), tEq = equipOf(exerciseName);
  let sameEquip = null, oneUnspecified = null;
  for (const s of sessions) {
    if (s.id === activeSession?.id) continue;
    for (const e of (s.exercises || [])) {
      if (!e.sets?.length) continue;
      if (e.name === exerciseName) return e;                 // tier 1: exact
      if (baseOf(e.name) !== tBase) continue;
      const eq = equipOf(e.name);
      if (eq === tEq) { sameEquip ||= e; }                   // tier 2: same equipment
      else if (eq === '' || tEq === '') { oneUnspecified ||= e; } // tier 3: one side generic
    }
  }
  return sameEquip || oneUnspecified;
}

// ── Custom exercise modal ─────────────────────────────────────────────────────
function openCustomExModal() {
  const sel = document.getElementById('customExCat');
  sel.innerHTML = CATEGORIES.map(c => `<option>${c}</option>`).join('');
  const typeSel = document.getElementById('customExType');
  typeSel.innerHTML = Object.entries(LOGTYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  document.getElementById('customExName').value = '';
  document.getElementById('customExModal').classList.add('open');
}
document.getElementById('customExCancel').onclick = () => document.getElementById('customExModal').classList.remove('open');
document.getElementById('customExSave').onclick = async () => {
  const name = document.getElementById('customExName').value.trim();
  if (!name) return;
  const cat     = document.getElementById('customExCat').value;
  const logType = document.getElementById('customExType').value || 'weighted';
  const custom = (await db.get(STORE, 'exercises-custom')) || [];
  const entry = { id: uid(), name, category: cat, logType, custom: true };
  custom.push(entry);
  await db.set(STORE, 'exercises-custom', custom);
  document.getElementById('customExModal').classList.remove('open');
  await addExerciseToSession(name, cat);
  openActiveWorkout();
  renderActiveSession();
  saveSoon();
  lookupRepRangeForCustom(entry); // background AI lookup — updates in place when it resolves
  // If this looks like an exercise they already have, offer to merge (coach nudge).
  const similar = await findSimilarExercise(name);
  if (similar) suggestExerciseMerge({ name, category: cat }, similar);
};

// ── Similar-exercise detection + merge suggestion ─────────────────────────────
// Normalise for similarity: strip equipment words/abbreviations and word order so
// "Incline DB Press" and "Incline Dumbbell Press" collapse to the same key.
const SIM_EXTRA = new Set(['db', 'bb', 'ez', 'smith']);
function simNorm(name) {
  return normName(name).split(' ').filter(w => w && !SIM_EXTRA.has(w)).sort().join(' ');
}
// Highest-confidence existing exercise that looks like the same lift as `name`
// (near-identical only — differing by equipment/abbrev/word order/plural), or null.
async function findSimilarExercise(name) {
  const t = simNorm(name);
  if (!t) return null;
  const tset = new Set(t.split(' ').filter(Boolean));
  const all = await getAllExercises();
  let best = null, bestScore = 0;
  for (const e of all) {
    if (e.name.toLowerCase() === name.toLowerCase()) continue;   // itself
    if (canonicalName(e.name) === canonicalName(name)) continue; // already merged
    const n = simNorm(e.name);
    if (!n) continue;
    let score;
    if (n === t) score = 1;
    else {
      const nset = new Set(n.split(' ').filter(Boolean));
      const inter = [...tset].filter(x => nset.has(x)).length;
      const uni = new Set([...tset, ...nset]).size;
      score = uni ? inter / uni : 0;
    }
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 0.85 ? best : null;   // high bar — unprompted suggestion must be confident
}

// A dynamically-built "these look like the same lift" sheet with a which-to-keep
// choice. `made` is the exercise the user just created; `existing` is the match.
function suggestExerciseMerge(made, existing) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop open';
  back.innerHTML = `
    <div class="modal">
      <p class="modal-title" style="display:flex;align-items:center;gap:7px"><span style="color:var(--blue);display:flex">${icon('bot', { size: 18 })}</span> Looks like the same lift</p>
      <p style="font-size:0.85rem;color:var(--text-muted);margin:-6px 0 16px;line-height:1.5">
        You just added <b style="color:var(--text)">${esc(made.name)}</b>, but you already have <b style="color:var(--text)">${esc(existing.name)}</b>. Combine them so their history counts as one lift? Which name do you want to keep?</p>
      <div class="merge-opts">
        <button class="merge-opt" data-keep="existing">${icon('check', { size: 15 })} Keep “${esc(existing.name)}”<span>use the existing one — drops the duplicate</span></button>
        <button class="merge-opt" data-keep="new">${icon('check', { size: 15 })} Keep “${esc(made.name)}”<span>rename — folds the old history in under this name</span></button>
        <button class="merge-opt subtle" data-keep="separate">They're different — keep both</button>
      </div>
    </div>`;
  document.body.appendChild(back);
  syncScrollLock();
  const close = () => { back.remove(); syncScrollLock(); };
  back.addEventListener('click', async e => {
    if (e.target === back) return close();
    const opt = e.target.closest('.merge-opt');
    if (!opt) return;
    const keep = opt.dataset.keep;
    if (keep === 'existing') {
      // Discard the just-made duplicate, use the existing exercise instead.
      let custom = (await db.get(STORE, 'exercises-custom')) || [];
      custom = custom.filter(x => x.name.toLowerCase() !== made.name.toLowerCase());
      await db.set(STORE, 'exercises-custom', custom);
      if (activeSession) {
        activeSession.exercises = activeSession.exercises.filter(x => x.name.toLowerCase() !== made.name.toLowerCase());
        await addExerciseToSession(existing.name, existing.category);
        renderActiveSession();
      }
      db.backup();
    } else if (keep === 'new') {
      // Keep the new name as the identity; fold the existing lift's history into it.
      await setExerciseAlias(existing.name, made.name);
    }
    close();
  });
}

// ── Edit exercise (writes to the core library) ────────────────────────────────
// Change an exercise's muscle group and tracking type (and, for custom exercises,
// its name). Built-in exercises are edited via an overrides layer keyed by their
// canonical name; custom exercises are edited in place in `exercises-custom`. The
// change applies everywhere the exercise appears (resolveLogType/resolveCategory
// + getAllExercises read the same overrides), not just this workout.
let editExEi = null;
async function openEditExerciseModal(ei) {
  const ex = activeSession?.exercises?.[ei];
  if (!ex) return;
  editExEi = ei;
  const custom = (await db.get(STORE, 'exercises-custom')) || [];
  const isCustom = custom.some(e => e.name.toLowerCase() === ex.name.toLowerCase());

  const nameEl = document.getElementById('editExName');
  nameEl.value = ex.name;
  nameEl.readOnly = !isCustom;                      // built-in names are fixed
  document.getElementById('editExNameHint').style.display = isCustom ? 'none' : '';

  const catSel = document.getElementById('editExCat');
  catSel.innerHTML = CATEGORIES.map(c => `<option${c === ex.category ? ' selected' : ''}>${c}</option>`).join('');

  const typeSel = document.getElementById('editExType');
  const curType = resolveLogType(ex);
  typeSel.innerHTML = Object.entries(LOGTYPES)
    .map(([k, v]) => `<option value="${k}"${k === curType ? ' selected' : ''}>${v.label}</option>`).join('');

  document.getElementById('editExModal').classList.add('open');
}
document.getElementById('editExCancel').onclick = () => document.getElementById('editExModal').classList.remove('open');
document.getElementById('editExModal').addEventListener('click', e => {
  if (e.target === document.getElementById('editExModal')) document.getElementById('editExModal').classList.remove('open');
});
document.getElementById('editExSave').onclick = async () => {
  if (editExEi == null || !activeSession?.exercises?.[editExEi]) {
    document.getElementById('editExModal').classList.remove('open'); return;
  }
  const ex = activeSession.exercises[editExEi];
  const oldName  = ex.name;
  const newName  = document.getElementById('editExName').value.trim() || oldName;
  const newCat   = document.getElementById('editExCat').value;
  const newType  = document.getElementById('editExType').value || 'weighted';

  const custom = (await db.get(STORE, 'exercises-custom')) || [];
  const cIdx = custom.findIndex(e => e.name.toLowerCase() === oldName.toLowerCase());

  if (cIdx !== -1) {
    // Custom exercise — edit its library entry in place (name editable).
    custom[cIdx] = { ...custom[cIdx], name: newName, category: newCat, logType: newType };
    if (newType === 'duration' || newType === 'cardio') delete custom[cIdx].repRange;
    await db.set(STORE, 'exercises-custom', custom);
  } else {
    // Built-in exercise — record a library override (name stays canonical).
    exOverrides[oldName] = { ...(exOverrides[oldName] || {}), category: newCat, logType: newType };
    await db.set(STORE, 'exercises-overrides', exOverrides);
  }

  // Reflect on the live exercise immediately.
  ex.name = newName;
  ex.category = newCat;
  ex.logType = newType;
  if (newType === 'duration' || newType === 'cardio') ex.repRange = null;
  else ex.repRange = resolveRepRange({ name: newName, category: newCat, logType: newType, repRange: ex.repRange });

  document.getElementById('editExModal').classList.remove('open');
  renderActiveSession();
  saveSoon();
  db.backup();
  if (activeTab === 'Library') renderLibrary();
  // For a renamed custom exercise with no stored range yet, kick a background lookup.
  if (cIdx !== -1 && !custom[cIdx].repRange && newType !== 'duration' && newType !== 'cardio') {
    lookupRepRangeForCustom(custom[cIdx]);
  }
};

// ── Ideal rep range for custom exercises: AI lookup + cache ───────────────────
// Patches any already-rendered rep-range badges for this exercise name in place.
function patchRepRangeBadge(name, range) {
  if (!range) return;
  document.querySelectorAll('.ex-rep-range').forEach(el => {
    if (el.dataset.exName === name) el.innerHTML = repRangeHTML(range);
  });
  if (activeSession) {
    for (const ex of activeSession.exercises) if (ex.name === name) ex.repRange = range;
  }
}

async function lookupRepRangeForCustom(entry) {
  if (entry.logType === 'duration' || entry.logType === 'cardio') return;
  const range = await fetchAIRepRange({ name: entry.name, category: entry.category, getKey: coachGetKey });
  if (!range) return;
  const list = (await db.get(STORE, 'exercises-custom')) || [];
  const idx = list.findIndex(e => e.id === entry.id);
  if (idx === -1) return;
  list[idx].repRange = range;
  await db.set(STORE, 'exercises-custom', list);
  patchRepRangeBadge(entry.name, range);
  saveSoon();
}

// One-time-per-load backfill: any saved custom exercise still missing a rep
// range (created before this feature, or before an API key was set) gets an
// AI lookup so "add to all existing" also covers exercises added earlier.
async function backfillCustomRepRanges() {
  const custom = (await db.get(STORE, 'exercises-custom')) || [];
  const pending = custom.filter(e => !e.repRange && e.logType !== 'duration' && e.logType !== 'cardio');
  if (!pending.length) return;
  const key = await coachGetKey();
  if (!key) return;
  let changed = false;
  for (const entry of pending) {
    const range = await fetchAIRepRange({ name: entry.name, category: entry.category, getKey: coachGetKey });
    if (range) {
      const idx = custom.findIndex(e => e.id === entry.id);
      if (idx !== -1) { custom[idx].repRange = range; changed = true; patchRepRangeBadge(entry.name, range); }
    }
  }
  if (changed) await db.set(STORE, 'exercises-custom', custom);
}

// ── Templates ─────────────────────────────────────────────────────────────────
async function getTemplates() { return (await db.get(STORE, 'templates')) || []; }

async function seedMyRoutinesOnce() {
  const done = await db.get(STORE, 'my-routines-seeded');
  if (done) return;
  const templates = await getTemplates();
  const existingNames = new Set(templates.map(t => t.name));
  for (const day of MY_ROUTINES) {
    if (existingNames.has(day.name)) continue;
    templates.push({ id: uid(), name: day.name, exercises: day.exercises });
  }
  await db.set(STORE, 'templates', templates);
  await db.set(STORE, 'my-routines-seeded', true);
}

async function fixIncompletePushDayOnce() {
  const done = await db.get(STORE, 'push-day-fixed');
  if (done) return;
  const OLD_NAME = 'Push Hypertrophy (Delts) [INCOMPLETE — add missing exercises]';
  const templates = await getTemplates();
  const idx = templates.findIndex(t => t.name === OLD_NAME);
  const complete = MY_ROUTINES.find(d => d.name === 'Push Hypertrophy (Delts)');
  if (idx !== -1 && complete) {
    templates[idx] = { ...templates[idx], name: complete.name, exercises: complete.exercises };
    await db.set(STORE, 'templates', templates);
  }
  await db.set(STORE, 'push-day-fixed', true);
}

document.getElementById('templateNameCancel').onclick = () => document.getElementById('templateNameModal').classList.remove('open');
document.getElementById('awFinishBtn').addEventListener('contextmenu', e => { e.preventDefault(); openSaveTemplateModal(); });

function openSaveTemplateModal() {
  const typed = document.getElementById('awTitle').value.trim();
  document.getElementById('templateNameInput').value = typed || activeSession?.title || '';
  document.getElementById('templateNameModal').classList.add('open');
}

document.getElementById('templateNameSave').onclick = async () => {
  const name = document.getElementById('templateNameInput').value.trim();
  if (!name) return;
  const templates = await getTemplates();
  templates.push({
    id: uid(), name,
    exercises: activeSession.exercises.map(e => ({
      name: e.name, category: e.category, restTime: e.restTime ?? 60, logType: resolveLogType(e),
      ...(e.supersetId ? { supersetId: e.supersetId } : {}),
      sets: e.sets.map(s => ({ weight: s.weight || s.tW || 0, reps: s.reps || s.tR || 0, distance: s.distance || 0, duration: s.duration || 0, type: s.type })),
    })),
  });
  await db.set(STORE, 'templates', templates);
  document.getElementById('templateNameModal').classList.remove('open');

  if (routineMode) {
    routineMode = false;
    activeSession = null;
    clearActiveSessionStore();
    document.getElementById('activeWorkout').classList.remove('visible');
    unfitActiveWorkout();
    renderDashboard();
  } else {
    alert('Saved as routine!');
  }
};

// ── Routine library (pre-built, science-backed splits) ────────────────────────
const libraryEl       = document.getElementById('routineLibrary');
const libraryDetailEl = document.getElementById('libraryDetail');
let openSplitId = null;

document.getElementById('libraryBtn').onclick = () => {
  closeRoutineChooser();
  renderLibraryList();
  libraryEl.classList.add('visible');
};
document.getElementById('libraryClose').onclick = () => libraryEl.classList.remove('visible');
document.getElementById('libraryDetailBack').onclick = () => libraryDetailEl.classList.remove('visible');

let daysFilter = null; // null | 2 | 3 | 4 | 6 — "days a week you can train"

// Weekly working sets per category for a library split (all sets are 'normal').
function splitSetsByCategory(split) {
  const cat = {};
  for (const day of split.days) for (const e of day.exercises) {
    if (e.category === 'Cardio') continue;
    cat[e.category] = (cat[e.category] || 0) + (e.sets?.length || 0);
  }
  return cat;
}

// Fit tag: compares the split's total weekly set count against the user's own.
// Returns null when there's no history to measure against.
function splitFitTag(split, userTotal) {
  if (!userTotal) return null;
  const splitTotal = Object.values(splitSetsByCategory(split)).reduce((a, b) => a + b, 0);
  const ratio = splitTotal / userTotal;
  if (ratio > 1.15) return { cls: 'split-fit-more', label: 'More volume', border: 'var(--blue)' };
  if (ratio < 0.85) return { cls: 'split-fit-less', label: 'Less volume', border: 'var(--orange)' };
  return { cls: 'split-fit-best', label: 'Best fit', border: 'var(--green)' };
}

async function renderLibraryList() {
  const sessions = await loadSessions();
  const { rows } = weeklySetsByCategory(sessions);
  const userTotal = rows.reduce((a, r) => a + r.perWk, 0);

  const PILLS = [{ v: null, t: 'Any' }, { v: 2, t: '2 days' }, { v: 3, t: '3 days' }, { v: 4, t: '4 days' }, { v: 6, t: '6 days' }];
  const pillsHTML = `
    <div class="rl-filter-prompt">How many days a week can you train?</div>
    <div class="rl-pills">
      ${PILLS.map(p => `<button class="rl-pill${daysFilter === p.v ? ' active' : ''}" data-days="${p.v === null ? '' : p.v}">${p.t}</button>`).join('')}
    </div>`;

  const shown = ROUTINE_LIBRARY.filter(s => daysFilter == null || s.days.length === daysFilter);

  const cardsHTML = shown.map(split => {
    const fit = splitFitTag(split, userTotal);
    const days = split.days.length;
    const shape = Array.from({ length: 7 }, (_, i) => `<span class="week-sq${i < days ? ' on' : ''}"></span>`).join('');
    return `
      <div class="split-card" data-split="${split.id}"${fit ? ` style="border-left-color:${fit.border}"` : ''}>
        <div class="split-card-head">
          <span class="split-name">${esc(split.name)}</span>
          ${fit ? `<span class="split-fit-tag ${fit.cls}">${fit.label}</span>` : ''}
        </div>
        <div class="split-tagline">${esc(split.tagline)}</div>
        <div class="split-card-foot">
          <div class="split-week-shape">${shape}</div>
          <span class="split-meta">${esc(split.meta)}</span>
        </div>
      </div>`;
  }).join('') || `<div class="routines-empty">No splits at that frequency.</div>`;

  // Footnote: day-filter count, else what the fit is measured against.
  let foot = '';
  if (daysFilter != null) {
    const n = ROUTINE_LIBRARY.filter(s => s.days.length === daysFilter).length;
    foot = `${n} of ${ROUTINE_LIBRARY.length} splits fit ${daysFilter} days a week.`;
  } else if (userTotal) {
    const top = rows.slice(0, 3).map(r => `${Math.round(r.perWk)} sets/wk ${r.cat.toLowerCase()}`).join(', ');
    foot = `Fit is measured against your current ${top}.`;
  }

  document.getElementById('libraryList').innerHTML = pillsHTML + cardsHTML + (foot ? `<div class="rl-foot">${esc(foot)}</div>` : '');

  document.querySelectorAll('#libraryList .rl-pill').forEach(pill => {
    pill.onclick = () => { daysFilter = pill.dataset.days ? +pill.dataset.days : null; renderLibraryList(); };
  });
  document.querySelectorAll('#libraryList .split-card').forEach(card => {
    card.onclick = () => openSplitDetail(card.dataset.split);
  });
}

function openSplitDetail(splitId) {
  const split = ROUTINE_LIBRARY.find(s => s.id === splitId);
  if (!split) return;
  openSplitId = splitId;
  document.getElementById('libraryDetailTitle').textContent = split.name;
  document.getElementById('libraryDetailTagline').textContent = `${split.meta} — ${split.tagline}`;
  document.getElementById('libraryDetailDays').innerHTML = split.days.map(day => `
    <div class="lib-day-card">
      <div class="lib-day-name">${esc(day.name)}</div>
      ${day.exercises.map(e => `
        <div class="lib-day-ex">
          <span class="lib-day-ex-name">${esc(e.name)}</span>
          <span>${e.sets.length}×${e.sets[0].reps}</span>
        </div>
      `).join('')}
    </div>
  `).join('');
  libraryDetailEl.classList.add('visible');
}

document.getElementById('libraryAddBtn').onclick = async () => {
  const split = ROUTINE_LIBRARY.find(s => s.id === openSplitId);
  if (!split) return;
  const templates = await getTemplates();
  const existingNames = new Set(templates.map(t => t.name));
  let added = 0;
  for (const day of split.days) {
    if (existingNames.has(day.name)) continue;
    templates.push({
      id: uid(), name: day.name,
      exercises: day.exercises.map(e => ({
        name: e.name, category: e.category, restTime: e.restTime,
        sets: e.sets.map(s => ({ weight: s.weight, reps: s.reps, type: s.type })),
      })),
    });
    added++;
  }
  await db.set(STORE, 'templates', templates);
  libraryDetailEl.classList.remove('visible');
  libraryEl.classList.remove('visible');
  renderDashboard();
  alert(added > 0
    ? `Added ${added} routine${added > 1 ? 's' : ''} from "${split.name}" — find them on your dashboard.`
    : `"${split.name}" is already in your routines.`);
};

// ── Streak (weekly, with an editable seed) ────────────────────────
async function renderStreakChip(sessions) {
  const settings = await getStreakSettings();
  const { weeks, thisWeekCount, target } = computeStreak(sessions, settings);
  const el = document.getElementById('streakChip');
  if (!el) return;
  const flame = `<span style="color:var(--amber);display:inline-flex;vertical-align:-0.2em">${icon('flame', { size: 16 })}</span>`;
  el.innerHTML = weeks > 0
    ? `${flame} <strong>${weeks}-week streak</strong> · ${thisWeekCount}/${target} this week`
    : `${flame} ${thisWeekCount}/${target} workouts this week`;
}

document.getElementById('streakChip').onclick = async () => {
  const s = await getStreakSettings();
  document.getElementById('streakSeedInput').value   = s.seed || '';
  document.getElementById('streakTargetInput').value = s.target || 3;
  document.getElementById('streakModal').classList.add('open');
};
document.getElementById('streakCancel').onclick = () => document.getElementById('streakModal').classList.remove('open');
document.getElementById('streakModal').addEventListener('click', e => {
  if (e.target === document.getElementById('streakModal')) document.getElementById('streakModal').classList.remove('open');
});
document.getElementById('streakSave').onclick = async () => {
  const seed   = parseInt(document.getElementById('streakSeedInput').value) || 0;
  const target = Math.max(1, parseInt(document.getElementById('streakTargetInput').value) || 3);
  const prev = await getStreakSettings();
  await saveStreakSettings({
    seed, target,
    seedDate: seed !== prev.seed ? new Date().toISOString().slice(0,10) : (prev.seedDate || new Date().toISOString().slice(0,10)),
  });
  document.getElementById('streakModal').classList.remove('open');
  renderStreakChip(await loadSessions());
};

// ── Skeleton loaders (shown while IndexedDB/stats resolve) ────────────────────
function skeletonCards(n = 2) {
  return Array.from({ length: n }, () =>
    `<div class="skeleton" style="height:78px;margin-bottom:10px;border-radius:var(--radius)"></div>`).join('');
}
function statsSkeleton() {
  return `
    <div class="skeleton" style="height:190px;margin-bottom:12px;border-radius:var(--radius)"></div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      ${Array.from({ length: 5 }, () => '<div class="skeleton" style="flex:1;height:58px"></div>').join('')}
    </div>
    <div class="skeleton" style="height:150px;border-radius:var(--radius)"></div>`;
}

// ── Dashboard render ──────────────────────────────────────────────────────────
// ISO-8601 week number (Mon-based), for the "Week N · day N" header line.
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  return 1 + Math.round((date - firstThu) / (7 * 86400000));
}

// "Next in your split" follows the manual routine order (the templates list —
// editable in the "…" chooser). Next = the routine after the most recently
// completed one in that sequence, wrapping around; off-plan workouts don't
// advance it. Falls back to the first routine when none has been done yet.
function computeNextTemplate(templates, sessions) {
  if (!templates.length) return null;
  const names = templates.map(t => t.name);
  let lastIdx = -1;
  for (const s of sessions) {                       // newest-first
    const i = names.indexOf(s.title || '');
    if (i >= 0) { lastIdx = i; break; }
  }
  const nextIdx = lastIdx >= 0 ? (lastIdx + 1) % templates.length : 0;
  const nextName = names[nextIdx];
  let lastTs = 0;                                    // last time THIS routine was done
  for (const s of sessions) {
    if ((s.title || '') === nextName) { lastTs = parseToDate(s.date || s.startTime || '')?.getTime() || 0; break; }
  }
  return { template: templates[nextIdx], lastTs, nextIdx };
}

function nextSessionCard(next, sessions) {
  const t = next.template;
  const exNames = (t.exercises || []).map(e => e.name);
  const tags = exNames.slice(0, 3).map(n => `<span class="next-tag">${esc(n)}</span>`).join('')
    + (exNames.length > 3 ? `<span class="next-tag">+${exNames.length - 3} more</span>` : '');
  const totalSets = t.exercises.reduce((a, e) => a + (e.sets?.length || 0), 0);
  const mins = Math.max(20, Math.round(totalSets * 3.5 / 5) * 5);
  const daysAgo = next.lastTs ? Math.floor((Date.now() - next.lastTs) / 86400000) : null;
  const lastTxt = daysAgo == null ? 'not done yet'
    : daysAgo === 0 ? 'last done today'
    : `last done ${daysAgo} day${daysAgo > 1 ? 's' : ''} ago`;
  let rationale = `${t.exercises.length} exercises · ~${mins} min · ${lastTxt}.`;
  const byCat = {}; weeklySetsByCategory(sessions).rows.forEach(r => { byCat[r.cat] = r.perWk; });
  const catSets = {};
  t.exercises.forEach(e => { if (e.category && e.category !== 'Cardio') catSets[e.category] = (catSets[e.category] || 0) + (e.sets?.length || 0); });
  const primary = Object.entries(catSets).sort((a, b) => b[1] - a[1])[0];
  if (primary && byCat[primary[0]] != null) {
    const cur = Math.round(byCat[primary[0]]);
    const to = Math.round(byCat[primary[0]] + primary[1]);
    rationale += ` ${primary[0]} sits at ${cur} sets/wk — this session brings it to ${to}.`;
  }
  return `
    <div class="next-card">
      <div class="next-eyebrow">${icon('zap', { size: 13 })} NEXT IN YOUR SPLIT</div>
      <div class="next-name">${esc(t.name)}</div>
      <div class="next-rationale">${esc(rationale)}</div>
      <div class="next-tags">${tags}</div>
      <div class="next-actions">
        <button class="next-start" data-tid="${t.id}">${icon('play', { size: 19 })} Start ${esc(t.name)}</button>
        <button class="next-more" aria-label="Choose another routine">${icon('ellipsis', { size: 20 })}</button>
      </div>
    </div>`;
}

function emptyHeroCard() {
  return `
    <div class="next-card">
      <div class="next-eyebrow">${icon('zap', { size: 13 })} GET STARTED</div>
      <div class="next-name">No routine yet</div>
      <div class="next-rationale">Add a ready-made split from the Library, or start an empty workout and build as you go.</div>
      <div class="next-actions">
        <button class="next-start hero-empty-start">${icon('play', { size: 19 })} Start empty workout</button>
        <button class="next-more hero-empty-lib" aria-label="Browse library">${icon('book-open', { size: 20 })}</button>
      </div>
    </div>`;
}

// The Coach tab no longer carries an attention sticker — proactive coach content
// lives on Home now (renderDashCoach), so there's nothing to badge here. Kept as a
// guaranteed clear so any previously-stuck badge is removed on the next render.
function updateCoachBadge() {
  const tab = document.querySelector('.tab[data-tab="Coach"]');
  tab?.querySelector('.tab-badge')?.remove();
}

// Routines list lives in the "…" chooser sheet. It doubles as the order editor:
// the list order is the manual split sequence that drives "next in your split".
let chooserEditOrder = false;

async function deleteRoutine(id) {
  const ts = await getTemplates();
  const t = ts.find(x => x.id === id);
  if (!confirm(`Delete routine "${t?.name || ''}"? This can't be undone.`)) return;
  await db.set(STORE, 'templates', ts.filter(x => x.id !== id));
  db.backup();
  renderDashboard();
}

async function moveRoutine(from, to) {
  const ts = await getTemplates();
  if (to < 0 || to >= ts.length) return;
  const [item] = ts.splice(from, 1);
  ts.splice(to, 0, item);
  await db.set(STORE, 'templates', ts);
  db.backup();
  renderDashboard();   // re-renders the hero (next) and the chooser together
}

function renderRoutinesChooser(templates, nextId = null) {
  const tmplEl = document.getElementById('templatesList');
  if (!tmplEl) return;
  const editing = chooserEditOrder && templates.length > 0;
  document.getElementById('routinesEmpty').style.display = templates.length ? 'none' : '';
  document.getElementById('routinesHint').style.display = (templates.length && !editing) ? '' : 'none';
  document.getElementById('chooserOrderHint').style.display = editing ? '' : 'none';
  const editBtn = document.getElementById('chooserEditOrder');
  editBtn.style.display = templates.length > 1 ? '' : 'none';
  editBtn.textContent = editing ? 'Done' : 'Edit order';

  if (editing) {
    tmplEl.innerHTML = templates.map((t, i) => `
      <div class="template-card tc-editing" data-tid="${t.id}">
        <div>
          <div class="tc-name">${esc(t.name)}${t.id === nextId ? '<span class="tc-next-badge">Next</span>' : ''}</div>
          <div class="tc-ex">${t.exercises.map(e => esc(e.name)).join(' · ')}</div>
        </div>
        <div class="tc-move">
          <button class="tc-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="tc-down" data-i="${i}" ${i === templates.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        </div>
        <button class="tc-del" data-tid="${t.id}" aria-label="Delete">${icon('trash-2', { size: 16 })}</button>
      </div>`).join('');
    tmplEl.querySelectorAll('.tc-up').forEach(b => b.onclick = () => moveRoutine(+b.dataset.i, +b.dataset.i - 1));
    tmplEl.querySelectorAll('.tc-down').forEach(b => b.onclick = () => moveRoutine(+b.dataset.i, +b.dataset.i + 1));
    tmplEl.querySelectorAll('.tc-del').forEach(b => b.onclick = () => deleteRoutine(b.dataset.tid));
    refreshIcons();
    return;
  }

  tmplEl.innerHTML = templates.map(t => `
    <div class="template-card" data-tid="${t.id}">
      <div>
        <div class="tc-name">${esc(t.name)}${t.id === nextId ? '<span class="tc-next-badge">Next</span>' : ''}</div>
        <div class="tc-ex">${t.exercises.map(e => esc(e.name)).join(' · ')}</div>
      </div>
    </div>
  `).join('');
  tmplEl.querySelectorAll('.template-card').forEach(card => {
    const tid = card.dataset.tid;
    // Long-press guards deletion so routines can't be lost with a stray tap.
    let holdTimer = null, held = false, sx = 0, sy = 0;
    const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; card.classList.remove('tc-holding'); };
    card.addEventListener('pointerdown', e => {
      held = false; sx = e.clientX; sy = e.clientY;
      card.classList.add('tc-holding');
      holdTimer = setTimeout(() => { held = true; card.classList.remove('tc-holding'); deleteRoutine(tid); }, 550);
    });
    card.addEventListener('pointermove', e => {
      if (holdTimer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancelHold();
    });
    card.addEventListener('pointerup', cancelHold);
    card.addEventListener('pointercancel', cancelHold);
    card.addEventListener('click', () => {
      if (held) { held = false; return; } // long-press already handled it
      const t = templates.find(x => x.id === tid);
      closeRoutineChooser();
      startEmptyWorkout(t);
    });
  });
}

document.getElementById('chooserEditOrder').onclick = () => { chooserEditOrder = !chooserEditOrder; renderDashboard(); };
document.getElementById('chooserClose').onclick = closeRoutineChooser;

function openRoutineChooser() {
  document.getElementById('routineChooser').classList.add('open');
}
function closeRoutineChooser() {
  chooserEditOrder = false;   // always reopen in tap-to-start mode
  document.getElementById('routineChooser').classList.remove('open');
}
document.getElementById('routineChooser').addEventListener('click', e => {
  if (e.target === document.getElementById('routineChooser')) closeRoutineChooser();
});

// ── Plan tab (weekly schedule) ─────────────────────────────────────────────────
let planWeekOffset = 0;
async function renderPlan() {
  const el = document.getElementById('planBody');
  const [templates, sessions, streakSettings, planMap] = await Promise.all([
    getTemplates(), loadSessions(), getStreakSettings(), getWeekPlanMap()]);
  const base = new Date(); base.setDate(base.getDate() + planWeekOffset * 7);
  const start = mondayOf(base);
  const end = new Date(start); end.setDate(start.getDate() + 7);
  const todayStr = ymd(new Date());
  const rangeLbl = `${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${new Date(end.getTime() - 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

  const byDate = {};
  sessions.forEach(s => { const d = s.date || (s.startTime || '').slice(0, 10); (byDate[d] = byDate[d] || []).push(s); });
  const next = computeNextTemplate(templates, sessions);
  const tById = id => templates.find(t => t.id === id);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = ymd(d);
    days.push({ ds, dow: d.toLocaleDateString('en-GB', { weekday: 'short' }), num: d.getDate(),
      isToday: ds === todayStr, past: ds < todayStr, done: byDate[ds] || [], assigned: tById(planMap[ds]) });
  }

  const strip = days.map(dy => {
    let dot;
    if (dy.done.length) dot = `<span class="wdot done">${icon('check', { size: 12 })}</span>`;
    else if (dy.isToday)  dot = `<span class="wdot now">•</span>`;
    else if (dy.past)     dot = `<span class="wdot rest"></span>`;
    else                  dot = `<span class="wdot up"></span>`;
    return `<div class="wcol${dy.isToday ? ' today' : ''}"><span class="wdow">${dy.dow}</span><span class="wnum">${dy.num}</span>${dot}</div>`;
  }).join('');

  const dayCards = days.map(dy => {
    const lbl = `${dy.dow} ${dy.num}${dy.isToday ? ' · Today' : ''}`;
    if (dy.done.length) {
      const s = dy.done[0];
      const vol = (s.exercises || []).flatMap(e => (e.sets || []).filter(st => st.done)).reduce((a, st) => a + (st.weight || 0) * (st.reps || 1), 0);
      const meta = s.pbs?.length ? `<span class="dpb">${icon('trophy', { size: 12 })} ${s.pbs.length} PB${s.pbs.length > 1 ? 's' : ''}</span>` : `${Math.round(vol).toLocaleString()} kg`;
      return `<div class="dcard done" data-open="${esc(s.id)}">
        <span class="dstate done">${icon('check', { size: 16 })}</span>
        <div class="dbody"><div class="dday">${lbl}</div><div class="dname">${esc(s.title || 'Workout')}${dy.done.length > 1 ? ` +${dy.done.length - 1}` : ''}</div>
        <div class="dmeta">${fmtTime(s.duration || 0)} · ${meta}</div></div></div>`;
    }
    if (dy.isToday) {
      const t = dy.assigned || next?.template;
      const body = t
        ? `<div class="dname">${esc(t.name)}</div><div class="dmeta">${t.exercises.length} exercises</div>`
        : `<div class="dname">Open workout</div><div class="dmeta">Tap to choose a routine</div>`;
      return `<div class="dcard today" data-assign="${dy.ds}">
        <span class="dstate today">${icon('dumbbell', { size: 15 })}</span>
        <div class="dbody"><div class="dday" style="color:var(--blue)">${lbl}</div>${body}</div>
        ${t ? `<button class="dstart" data-start="${t.id}">Start</button>` : ''}</div>`;
    }
    if (dy.assigned) {
      return `<div class="dcard" data-assign="${dy.ds}">
        <span class="dstate up">${icon('dumbbell', { size: 15 })}</span>
        <div class="dbody"><div class="dday">${lbl}</div><div class="dname">${esc(dy.assigned.name)}</div>
        <div class="dmeta">planned · ${dy.assigned.exercises.length} exercises</div></div></div>`;
    }
    if (dy.past) {
      return `<div class="dcard rest"><span class="dstate rest">${icon('moon', { size: 15 })}</span>
        <div class="dbody"><div class="dday">${lbl}</div><div class="dname muted">Rest day</div></div></div>`;
    }
    return `<div class="dcard" data-assign="${dy.ds}"><span class="dstate up">${icon('plus', { size: 15 })}</span>
      <div class="dbody"><div class="dday">${lbl}</div><div class="dname muted">Open</div><div class="dmeta">Tap to plan a routine</div></div></div>`;
  }).join('');

  const { thisWeekCount, target } = computeStreak(sessions, streakSettings);
  const imbalance = generateCoachFindings(sessions).find(f => f.severity === 'warn');
  const streakLine = thisWeekCount >= target
    ? `You've hit your <b>${target}/week</b> target — nice.`
    : `You're at <b>${thisWeekCount}/${target}</b> this week — ${target - thisWeekCount} to go.`;
  const noteBody = imbalance ? `${streakLine} Coach flagged an ${esc(imbalance.eyebrow.toLowerCase())}: ${esc(imbalance.body)}` : streakLine;
  const noteHTML = `<div class="plan-note"><span class="ci">${icon('bot', { size: 19 })}</span><div class="plan-note-body">${noteBody}</div></div>`;

  // Weekly volume — this week's completed sets vs one full rotation of your routines.
  const catAlias = c => (['Quads', 'Hamstrings', 'Glutes', 'Calves'].includes(c)) ? 'Legs'
    : (['Biceps', 'Triceps'].includes(c)) ? 'Arms' : c;
  const CATS = ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core'];
  const cur = {}, plan = {};
  sessions.forEach(s => { const d = s.date || (s.startTime || '').slice(0, 10);
    if (d >= ymd(start) && d < ymd(end)) (s.exercises || []).forEach(e => { const c = catAlias(e.category); cur[c] = (cur[c] || 0) + (e.sets || []).filter(st => st.done).length; }); });
  templates.forEach(t => (t.exercises || []).forEach(e => { const c = catAlias(e.category); plan[c] = (plan[c] || 0) + (e.sets?.length || 0); }));
  const curTotal = Object.values(cur).reduce((a, b) => a + b, 0);
  const planTotal = Object.values(plan).reduce((a, b) => a + b, 0) || 1;
  const barColors = { Chest: 'var(--red)', Back: 'var(--blue)', Legs: 'var(--green)', Shoulders: 'var(--purple)', Arms: 'var(--amber)', Core: 'var(--orange)' };
  const mrows = CATS.filter(c => plan[c] || cur[c]).map(c => {
    const p = plan[c] || 0, cu = cur[c] || 0, pct = p ? Math.min(100, (cu / p) * 100) : (cu ? 100 : 0), behind = p && cu < p * 0.6;
    return `<div class="plan-mrow"><span class="plan-mcat${behind ? ' behind' : ''}">${c}</span>
      <span class="plan-mtrack"><span class="plan-mfill" style="width:${pct.toFixed(0)}%;background:${behind ? 'var(--amber)' : (barColors[c] || 'var(--blue)')}"></span></span>
      <span class="plan-mval${behind ? ' behind' : ''}">${cu}/${p}</span></div>`;
  }).join('');
  const volHTML = `<div class="plan-vcard">
    <div class="plan-vtop"><span class="plan-vtitle">Weekly training volume</span><span class="plan-vsub">${curTotal} / ${planTotal} sets</span></div>
    <div class="plan-vbar"><div class="plan-vfill" style="width:${Math.min(100, (curTotal / planTotal) * 100).toFixed(0)}%"></div></div>
    ${mrows || '<div class="stats-empty">Add routines to see planned volume.</div>'}
    <button class="plan-vlink" id="planToBalance">See full muscle balance ${icon('arrow-right', { size: 14 })}</button>
  </div>`;

  el.innerHTML = `
    <div class="plan-head"><span class="plan-title">Plan</span>
      <span class="plan-wknav"><button id="planPrev">${icon('chevron-left', { size: 16 })}</button><span>${rangeLbl}</span><button id="planNext">${icon('chevron-right', { size: 16 })}</button></span>
    </div>
    <div class="week-strip">${strip}</div>
    <div class="section-heading" style="margin-bottom:10px">${planWeekOffset === 0 ? 'This week' : 'Week'}</div>
    <div class="day-list">${dayCards}</div>
    ${noteHTML}
    ${volHTML}`;
  refreshIcons();

  document.getElementById('planPrev').onclick = () => { planWeekOffset--; renderPlan(); };
  document.getElementById('planNext').onclick = () => { planWeekOffset++; renderPlan(); };
  document.getElementById('planToBalance').onclick = () => document.querySelector('.tab[data-tab="Stats"]').click();
  el.querySelectorAll('.dstart').forEach(b => b.onclick = e => { e.stopPropagation(); const t = tById(b.dataset.start); if (t) startEmptyWorkout(t); });
  el.querySelectorAll('.dcard[data-open]').forEach(c => c.onclick = () => openHistoryDetail(c.dataset.open));
  el.querySelectorAll('.dcard[data-assign]').forEach(c => c.onclick = () => assignPlanDay(c.dataset.assign, templates));
}

function assignPlanDay(date, templates) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop open';
  back.innerHTML = `<div class="modal">
    <p class="modal-title">Plan ${esc(fmtDate(date))}</p>
    ${templates.map(t => `<button class="sheet-btn" data-tid="${esc(t.id)}">${esc(t.name)} — ${t.exercises.length} exercises</button>`).join('')}
    <button class="sheet-btn" data-clear="1" style="color:var(--text-muted)">Clear / rest day</button>
    <button class="sheet-btn" data-cancel="1" style="text-align:center;background:none;color:var(--text-muted)">Cancel</button>
  </div>`;
  document.body.appendChild(back);
  syncScrollLock();
  const close = () => { back.remove(); syncScrollLock(); };
  back.addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (e.target === back || btn?.dataset.cancel) return close();
    if (btn?.dataset.clear) { await setPlanDay(date, null); close(); renderPlan(); return; }
    if (btn?.dataset.tid)   { await setPlanDay(date, btn.dataset.tid); close(); renderPlan(); }
  });
}

async function renderDashboard() {
  const dashTop = document.getElementById('dashTop');
  const recentEl0 = document.getElementById('recentList');
  if (recentEl0 && !recentEl0.children.length) recentEl0.innerHTML = skeletonCards(1);

  const [templates, sessions, streakSettings, bodyLog, nutri] = await Promise.all([
    getTemplates(), loadSessions(), getStreakSettings(), getBodyLog(), getNutritionToday()]);
  const body = bodyStats(bodyLog);
  const next = computeNextTemplate(templates, sessions);
  renderRoutinesChooser(templates, next?.template?.id || null);
  renderStreakChip(sessions); // keeps the (hidden) chip fresh for the settings modal

  const now = new Date();
  const weekday = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const weekNo = isoWeek(now);
  const dayNo = ((now.getDay() + 6) % 7) + 1;
  const { weeks, thisWeekCount, target } = computeStreak(sessions, streakSettings);

  const ym = now.toISOString().slice(0, 7);
  const monthVol = sessions
    .filter(s => (s.date || s.startTime || '').slice(0, 7) === ym)
    .flatMap(s => (s.exercises || []).flatMap(e => (e.sets || []).filter(st => st.done)))
    .reduce((a, st) => a + (st.weight || 0) * (st.reps || 1), 0);

  const heroHTML = next ? nextSessionCard(next, sessions) : emptyHeroCard();

  const streakVal = weeks > 0 ? `${weeks} wk${weeks > 1 ? 's' : ''}` : `${thisWeekCount}/${target}`;
  // Snapshot: the two halves of the app on one screen — training streak, body, nutrition.
  const bodyTile = body
    ? `<div><div class="snap-val">${body.latest} kg</div><div class="snap-lbl">Bodyweight</div></div>
       <div class="snap-sub flat">${body.delta ? icon(body.delta < 0 ? 'trending-down' : 'trending-up', { size: 12 }) : ''}${body.delta ? Math.abs(body.delta) + ' kg' : 'steady'}</div>`
    : `<div><div class="snap-val">Log</div><div class="snap-lbl">Bodyweight</div></div><div class="snap-sub flat">Tap to add</div>`;
  const calRing = nutri && nutri.goal
    ? (() => { const pct = Math.max(0, Math.min(1, nutri.kcal / nutri.goal)); const C = 81.7, off = C * (1 - pct);
        return `<span class="snap-ring"><svg width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="13" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="4"/><circle cx="15" cy="15" r="13" fill="none" stroke="var(--orange)" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 15 15)"/></svg><span class="rc" style="color:var(--orange)">${Math.round(pct * 100)}%</span></span>`; })()
    : `<span class="snap-ico" style="background:rgba(var(--orange-rgb),0.14);color:var(--orange)">${icon('utensils', { size: 15 })}</span>`;
  const calTile = nutri
    ? `<div><div class="snap-val">${nutri.kcal.toLocaleString()}</div><div class="snap-lbl">${nutri.goal ? `of ${nutri.goal.toLocaleString()} kcal` : 'kcal today'}</div></div>
       <div class="snap-sub flat">${nutri.protein != null ? nutri.protein + 'g protein · ' : ''}CalorieAI</div>`
    : `<div><div class="snap-val">Calories</div><div class="snap-lbl">via CalorieAI</div></div><div class="snap-sub flat">Open ${icon('arrow-right', { size: 11 })}</div>`;
  const tilesHTML = `
    <div class="dash-snapshot">
      <div class="snap-tile" id="tileStreak">
        <span class="snap-ico" style="background:rgba(var(--amber-rgb),0.14);color:var(--amber)">${icon('flame', { size: 16 })}</span>
        <div><div class="snap-val">${streakVal}</div><div class="snap-lbl">Streak</div></div>
        <div class="snap-sub flat">${thisWeekCount} / ${target} this week</div>
      </div>
      <div class="snap-tile" id="tileBody">
        <span class="snap-ico" style="background:rgba(var(--blue-rgb),0.14);color:var(--blue)">${icon('scale', { size: 16 })}</span>
        ${bodyTile}
      </div>
      <div class="snap-tile" id="tileCal">
        ${calRing}
        ${calTile}
      </div>
    </div>`;

  dashTop.innerHTML = `
    <div class="dash-datehead">
      <span class="dash-weekday">${weekday}</span>
      <span class="dash-weekmeta">Week ${weekNo} · day ${dayNo}</span>
    </div>
    ${heroHTML}
    ${tilesHTML}`;

  // Wire the hero + tiles
  const startBtn = dashTop.querySelector('.next-start[data-tid]');
  if (startBtn) startBtn.onclick = () => { const t = templates.find(x => x.id === startBtn.dataset.tid); startEmptyWorkout(t); };
  dashTop.querySelector('.next-more:not(.hero-empty-lib)')?.addEventListener('click', openRoutineChooser);
  dashTop.querySelector('.hero-empty-start')?.addEventListener('click', () => startEmptyWorkout());
  dashTop.querySelector('.hero-empty-lib')?.addEventListener('click', () => document.getElementById('libraryBtn').click());
  dashTop.querySelector('#tileStreak')?.addEventListener('click', () => document.getElementById('streakChip').click());
  dashTop.querySelector('#tileBody')?.addEventListener('click', () => openBodyweightModal());
  dashTop.querySelector('#tileCal')?.addEventListener('click', () => { try { window.open(CALORIE_APP_URL, '_blank'); } catch (_) { location.href = CALORIE_APP_URL; } });

  // Proactive coach content (daily pick + observations) lives on Home now — the
  // base of operations, rendered into #dashCoach below the snapshot. The Coach tab
  // is reserved for direct questions, so it carries no attention sticker.
  renderDashCoach(sessions);
  updateCoachBadge();

  const recentEl = document.getElementById('recentList');
  if (!sessions.length) {
    recentEl.innerHTML = `<div class="empty-state">No workouts yet.<br>Start a workout, or restore from cloud in Stats.</div>`;
    return;
  }
  // Show a few recent workouts so the home screen fills the viewport rather than
  // trailing off into empty space above the tab bar. Heading matches the count.
  const recent = sessions.slice(0, 4);
  const headingEl = document.getElementById('dashRecentHeading');
  if (headingEl) headingEl.textContent = recent.length > 1 ? 'Recent' : 'Last session';
  recentEl.innerHTML = recent.map(s => workoutCard(s)).join('');
  recentEl.querySelectorAll('.workout-card').forEach(card => {
    card.onclick = () => openHistoryDetail(card.dataset.sid);
  });
}

function workoutCard(s, { tags = true } = {}) {
  const exList = (s.exercises||[]).slice(0,4).map(e => `<span class="wc-ex-tag">${esc(e.name)}</span>`).join('');
  const more   = (s.exercises||[]).length > 4 ? `<span class="wc-ex-tag">+${s.exercises.length - 4} more</span>` : '';
  const doneSets = (s.exercises||[]).flatMap(e => (e.sets||[]).filter(st => st.done));
  const vol = doneSets.reduce((a,st) => a + (st.weight||0)*(st.reps||1), 0);
  const pbCount = s.pbs?.length || 0;
  return `
    <div class="workout-card" data-sid="${s.id}">
      <div class="wc-header">
        <span class="wc-title">${esc(s.title||'Workout')}${pbCount ? ` <span class="wc-pb">${icon('trophy', { size: 12 })} ${pbCount}</span>` : ''}</span>
        <span class="wc-date">${fmtDate(s.date||s.startTime||'')}</span>
      </div>
      <div class="wc-meta">${fmtTime(s.duration||0)} · ${(s.exercises||[]).length} exercises · ${Math.round(vol).toLocaleString()} kg</div>
      ${tags ? `<div class="wc-exercises">${exList}${more}</div>` : ''}
    </div>`;
}

// ── Stats tab ─────────────────────────────────────────────────────────────────
let statsExercise = null;
let statsMonth = null; // { y, m } — defaults to current month
let statsView = 'training'; // 'training' | 'body'

// PR timeline card — banked personal records, newest first, each opens the lift.
function prTimelineHTML(prs) {
  if (!prs.length) return '';
  return `<div class="stats-card">
    <div class="stats-card-title">Recent PRs <span class="stats-card-sub">${prs.length} banked</span></div>
    ${prs.map((p, i) => `
      <div class="pr-row">
        <div class="pr-rail"><span class="pr-dot">${icon('trophy', { size: 15 })}</span>${i < prs.length - 1 ? '<span class="pr-line"></span>' : ''}</div>
        <div class="pr-info" data-ex="${esc(p.exercise)}">
          <div class="pr-l1"><span class="pr-name">${esc(p.exercise)}</span><span class="pr-date">${relTime(p.ts)}</span></div>
          <div class="pr-detail">${esc(p.label || p.type || 'New personal record')}</div>
        </div>
      </div>`).join('')}
  </div>`;
}

// Muscle-balance action strip — surfaces the top coach finding with a one-tap fix.
function mbFixHTML(sessions) {
  const f = generateCoachFindings(sessions).find(x => x.severity === 'warn' || x.severity === 'stalling');
  if (!f) return '';
  const a = (f.actions || []).find(x => x.kind === 'primary');
  return `<div class="mb-fix">
    <span class="mb-fix-txt"><b>${esc(f.eyebrow)}.</b> ${esc(f.body)}</span>
    <button class="mb-fix-btn" data-mbprompt="${esc(a?.prompt || '')}" data-mbforce="${esc(a?.force || '')}">${icon('bot', { size: 14 })} Fix with coach</button>
  </div>`;
}

function bwChartSVG(points) {
  if (!points || points.length < 2) return '<div class="stats-empty">Log a few more weigh-ins to see a trend.</div>';
  const w = 330, h = 96, pad = 6, min = Math.min(...points), max = Math.max(...points), span = (max - min) || 1;
  const X = i => (i / (points.length - 1)) * (w - pad * 2) + pad;
  const Y = v => (h - 14) - ((v - min) / span) * (h - 28);
  const line = points.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const li = points.length - 1;
  return `<svg class="bw-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${line} L${X(li).toFixed(1)},${h} L${X(0).toFixed(1)},${h} Z" fill="rgba(56,189,248,0.12)"/>
    <path d="${line}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${X(li).toFixed(1)}" cy="${Y(points[li]).toFixed(1)}" r="3.5" fill="var(--blue)"/>
  </svg>`;
}

function bodyViewHTML(log) {
  const st = bodyStats(log);
  if (!st) {
    return `<div class="stats-card">
      <div class="stats-card-title">Bodyweight</div>
      <div class="stats-empty">No weigh-ins yet — track your bodyweight alongside your lifts.</div>
      <button class="bw-log" id="bwLogBtn">${icon('plus', { size: 16 })} Log today's weight</button>
    </div>`;
  }
  const cls = st.delta < 0 ? 'down' : st.delta > 0 ? 'up' : 'flat';
  const ico = st.delta ? icon(st.delta < 0 ? 'trending-down' : 'trending-up', { size: 13 }) : '';
  const recent = log.slice(-10).reverse();
  return `<div class="stats-card">
    <div class="stats-card-title">Bodyweight <span class="stats-card-sub">${st.n} entr${st.n === 1 ? 'y' : 'ies'}</span></div>
    <div class="bw-top"><span class="bw-val">${st.latest} kg</span><span class="bw-delta ${cls}">${ico}${st.delta ? Math.abs(st.delta) + ' kg' : 'steady'}</span></div>
    ${bwChartSVG(st.points)}
    <button class="bw-log" id="bwLogBtn">${icon('plus', { size: 16 })} Log today's weight</button>
  </div>
  <div class="stats-card">
    <div class="stats-card-title">Recent weigh-ins</div>
    ${recent.map(e => `<div class="ed-hrow"><span class="ed-hdate">${fmtDate(e.date)}</span><span class="ed-hsets">${e.kg} kg</span></div>`).join('')}
  </div>`;
}

async function renderStats() {
  const el = document.getElementById('statsBody');
  if (el && !el.children.length) el.innerHTML = statsSkeleton();
  const [sessions, bodyLog] = await Promise.all([loadSessions(), getBodyLog()]);
  if (!sessions.length && !bodyLog.length) {
    el.innerHTML = `<div class="empty-state">No workouts yet — stats appear after your first logged session.</div>`;
    return;
  }
  const seg = `<div class="seg">
    <button class="${statsView === 'training' ? 'on' : ''}" data-sview="training">Training</button>
    <button class="${statsView === 'body' ? 'on' : ''}" data-sview="body">Body</button>
  </div>`;
  const wireSeg = () => el.querySelectorAll('[data-sview]').forEach(b => b.onclick = () => { statsView = b.dataset.sview; renderStats(); });

  // ── Body view ──
  if (statsView === 'body') {
    el.innerHTML = seg + bodyViewHTML(bodyLog);
    wireSeg();
    el.querySelector('#bwLogBtn')?.addEventListener('click', () => openBodyweightModal());
    return;
  }

  // ── Training view ──
  if (!sessions.length) {
    el.innerHTML = seg + `<div class="empty-state">No training logged yet — switch to Body to track weigh-ins, or start a workout.</div>`;
    wireSeg();
    return;
  }
  const chrono = [...sessions].reverse(); // oldest → newest for charts
  const cchrono = canonicalizeSessions(chrono); // merged identities for the per-lift progression chart
  const totals = lifetimeTotals(sessions);
  const settings = await getStreakSettings();
  const streak = computeStreak(sessions, settings);
  const miles = computeMilestones(sessions, streak.weeks);
  const pbTotal = sessions.reduce((a, s) => a + (s.pbs?.length || 0), 0);
  const trophies = miles.earned.length + pbTotal;
  const freq = exerciseFrequency(canonicalizeSessions(sessions)); // dropdown lists merged identities
  if (statsExercise) statsExercise = canonicalName(statsExercise); // a prior pick may now be a merged-in name
  if (!statsExercise && freq.length) statsExercise = freq[0].name;
  const now = new Date();
  if (!statsMonth) statsMonth = { y: now.getFullYear(), m: now.getMonth() };

  el.innerHTML = seg + `
    ${monthlyViewHTML(sessions, statsMonth.y, statsMonth.m)}

    <div class="stats-totals">
      <div class="stat-box"><div class="stat-val">${totals.workouts}</div><div class="stat-label">Workouts</div></div>
      <div class="stat-box"><div class="stat-val">${totals.hours.toFixed(0)}h</div><div class="stat-label">Trained</div></div>
      <div class="stat-box"><div class="stat-val">${(totals.volume/1000).toFixed(1)}t</div><div class="stat-label">Lifted</div></div>
      <div class="stat-box"><div class="stat-val"><span style="color:var(--amber);display:inline-flex;vertical-align:-0.15em">${icon('flame', { size: 17 })}</span> ${streak.weeks}</div><div class="stat-label">Wk streak</div></div>
      <div class="stat-box"><div class="stat-val"><span style="color:var(--amber);display:inline-flex;vertical-align:-0.15em">${icon('trophy', { size: 17 })}</span> ${trophies}</div><div class="stat-label">Trophies</div></div>
    </div>

    ${prTimelineHTML(collectPRs(sessions, 6))}

    ${miles.earned.length ? `
      <div class="stats-card">
        <div class="stats-card-title">Milestones</div>
        <div class="milestone-wrap">${miles.earned.map(m => `<span class="milestone-chip"><span style="color:var(--amber);display:inline-flex;vertical-align:-0.18em">${icon(MILESTONE_ICONS[m.icon] || 'award', { size: 14 })}</span> ${esc(m.label)}</span>`).join('')}</div>
      </div>` : ''}

    ${weeklyVolumeHTML(chrono)}
    ${muscleBalanceHTML(chrono)}
    ${mbFixHTML(sessions)}

    <div class="stats-card">
      <div class="stats-card-title">Exercise progression</div>
      <select class="form-input" id="statsExSelect" style="margin-bottom:10px">
        ${freq.slice(0, 40).map(f => `<option ${f.name === statsExercise ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
      </select>
      <div id="statsProgression"></div>
    </div>
  `;
  wireSeg();

  // PR timeline rows → exercise detail
  el.querySelectorAll('.pr-info[data-ex]').forEach(r => r.onclick = () => openExerciseDetail(r.dataset.ex));
  // Muscle-balance fix → coach
  el.querySelector('.mb-fix-btn')?.addEventListener('click', e => {
    const b = e.currentTarget;
    if (b.dataset.mbprompt) askCoachFromHome(b.dataset.mbprompt, b.dataset.mbforce || false);
  });

  // Month navigation
  const shiftMonth = delta => {
    let { y, m } = statsMonth;
    m += delta;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    statsMonth = { y, m };
    renderStats();
  };
  document.getElementById('monthPrev').onclick = () => shiftMonth(-1);
  const nextBtn = document.getElementById('monthNext');
  if (nextBtn && !nextBtn.disabled) nextBtn.onclick = () => shiftMonth(1);

  // Tap a calendar day → open/edit that day's workout, or backfill an empty day.
  el.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
    cell.onclick = () => openDayFromCalendar(cell.dataset.date, sessions);
  });

  const renderProg = () => {
    document.getElementById('statsProgression').innerHTML =
      statsExercise ? progressionHTML(cchrono, statsExercise) : '';
  };
  document.getElementById('statsExSelect').onchange = e => { statsExercise = e.target.value; renderProg(); };
  renderProg();
}

// ── Calendar day tap → open/edit that day, or backfill an empty day ──────────
function sessionsOnDate(sessions, dateStr) {
  return sessions.filter(s => (s.date || (s.startTime || '').slice(0, 10)) === dateStr);
}
function openDayFromCalendar(dateStr, sessions) {
  const onDay = sessionsOnDate(sessions, dateStr);
  if (onDay.length === 0) {
    if (confirm(`No workout logged on ${fmtDate(dateStr)}.\n\nAdd one for this day?`)) {
      startEmptyWorkout(null, dateStr);
    }
    return;
  }
  if (onDay.length === 1) { openHistoryDetail(onDay[0].id); return; }
  openDayChooser(dateStr, onDay);
}
function openDayChooser(dateStr, list) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop open';
  back.innerHTML = `<div class="modal">
    <p class="modal-title">${esc(fmtDate(dateStr))}</p>
    ${list.map(s => `<button class="sheet-btn" data-sid="${esc(s.id)}">${esc(s.title || 'Workout')} — ${(s.exercises || []).length} exercises</button>`).join('')}
    <button class="sheet-btn" data-add="1" style="color:var(--blue)">+ Add another workout for this day</button>
    <button class="sheet-btn" data-cancel="1" style="text-align:center;background:none;color:var(--text-muted)">Cancel</button>
  </div>`;
  document.body.appendChild(back);
  syncScrollLock();
  const close = () => { back.remove(); syncScrollLock(); };   // observer can't see removals
  back.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (e.target === back || btn?.dataset.cancel) { close(); return; }
    if (btn?.dataset.sid) { close(); openHistoryDetail(btn.dataset.sid); return; }
    if (btn?.dataset.add) { close(); startEmptyWorkout(null, dateStr); }
  });
}

// ── History render ────────────────────────────────────────────────────────────
async function renderHistory() {
  const el = document.getElementById('historyList');
  if (el && !el.children.length) el.innerHTML = skeletonCards(4);  // shimmer while IndexedDB loads
  let sessions = await loadSessions();
  document.getElementById('buildRoutinesBtn').style.display = sessions.length ? '' : 'none';
  if (!sessions.length) {
    el.innerHTML = `<div class="empty-state">No history yet.<br>Restore from cloud, or import a backup, in Stats.</div>`;
    return;
  }

  // Search filter — matches workout title or any exercise name.
  const q = (document.getElementById('histSearch')?.value || '').trim();
  if (q) {
    sessions = sessions.filter(s =>
      matchesSearch(`${s.title || ''} ${(s.exercises || []).map(e => e.name).join(' ')}`, q));
    if (!sessions.length) {
      el.innerHTML = `<div class="empty-state">Nothing matches “${esc(q)}”.</div>`;
      return;
    }
  }

  const groups = {};
  sessions.forEach(s => {
    const d = s.date || s.startTime?.slice(0,10) || '';
    const key = d.slice(0,7);
    (groups[key] = groups[key] || []).push(s);
  });

  el.innerHTML = Object.entries(groups)
    .sort((a,b) => b[0].localeCompare(a[0]))
    .map(([key, ss]) => `
      <div class="month-heading">${new Date(key+'-15').toLocaleDateString('en-GB',{month:'long',year:'numeric'})}</div>
      ${ss.map(s => workoutCard(s)).join('')}
    `).join('');

  el.querySelectorAll('.workout-card').forEach(card => {
    card.onclick = () => openHistoryDetail(card.dataset.sid);
  });
}

// ── History detail ────────────────────────────────────────────────────────────
function hdSetVal(ex, st) {
  const lt = resolveLogType(ex);
  if (lt === 'bodyweight') return `${st.reps || 0} reps`;
  if (lt === 'duration')   return st.duration ? fmtDuration(st.duration) : (st.reps ? `${st.reps} min` : '—');
  if (lt === 'cardio')     return `${st.distance || 0} km · ${st.duration ? fmtDuration(st.duration) : (st.reps ? st.reps + ' min' : '0:00')}`;
  let out = `${fmtKg(st.weight)} kg × ${st.reps} reps`;
  if ((st.type === 'warmup' || st.type === 'dropset') && (st.weight2 || st.reps2)) {
    const lbl = st.type === 'warmup' ? 'work' : 'drop';
    out += ` <span style="color:var(--text-muted)">→ ${fmtKg(st.weight2)} kg × ${st.reps2 || 0} (${lbl})</span>`;
  }
  return out;
}
// Inputs for one editable set (history amend mode); mapped back by real indices.
function hdSetEditInputs(ex, ei, st, si) {
  const lt = resolveLogType(ex);
  const inp = (field, val, ph, step, mode) =>
    `<input class="hd-edit-input" data-ei="${ei}" data-si="${si}" data-field="${field}"
      type="${field === 'time' ? 'text' : 'number'}" ${field !== 'time' ? `min="0" step="${step}"` : ''}
      inputmode="${mode}" value="${val}" placeholder="${ph}">`;
  if (lt === 'bodyweight') return inp('reps', st.reps || '', 'reps', '1', 'numeric');
  if (lt === 'duration')   return inp('time', st.duration ? fmtDuration(st.duration) : '', '00:00', '1', 'numeric');
  if (lt === 'cardio')     return inp('distance', st.distance || '', 'km', '0.01', 'decimal') +
                                  inp('time', st.duration ? fmtDuration(st.duration) : '', '00:00', '1', 'numeric');
  let out = inp('weight', st.weight || '', 'kg', '0.5', 'decimal') + inp('reps', st.reps || '', 'reps', '1', 'numeric');
  if (st.type === 'warmup' || st.type === 'dropset') {
    const lbl = st.type === 'warmup' ? 'work' : 'drop';
    out += inp('weight2', st.weight2 || '', `${lbl} kg`, '0.5', 'decimal') + inp('reps2', st.reps2 || '', `${lbl} reps`, '1', 'numeric');
  }
  return out;
}

let hdSession   = null;
let hdEditMode  = false;

function renderHistoryDetailBody() {
  const s = hdSession;
  if (!s) return;
  document.getElementById('hdTitle').textContent = s.title || 'Workout';
  document.getElementById('hdDelete').dataset.sid = s.id;

  const body = document.getElementById('hdBody');
  const doneSets = (s.exercises||[]).flatMap(e => (e.sets||[]).filter(st => st.done));
  const vol = doneSets.reduce((a,st) => a + (st.weight||0)*(st.reps||1), 0);
  const pbCount = s.pbs?.length || 0;

  body.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
      <div class="stat-box" id="hdDateBox" style="background:var(--surface);border-radius:10px;padding:10px 14px;min-width:80px;text-align:center;cursor:pointer">
        <div class="stat-val">${fmtDate(s.date||s.startTime||'')}</div>
        <div class="stat-label">Date ${icon('pencil', { size: 11 })}</div>
      </div>
      <div class="stat-box" id="hdDurBox" style="background:var(--surface);border-radius:10px;padding:10px 14px;text-align:center;cursor:pointer">
        <div class="stat-val">${fmtTime(s.duration||0)}</div>
        <div class="stat-label">Duration ${icon('pencil', { size: 11 })}</div>
      </div>
      <div class="stat-box" style="background:var(--surface);border-radius:10px;padding:10px 14px;text-align:center">
        <div class="stat-val">${Math.round(vol).toLocaleString()}</div>
        <div class="stat-label">Volume kg</div>
      </div>
      ${pbCount ? `
      <div class="stat-box" style="background:var(--surface);border-radius:10px;padding:10px 14px;text-align:center">
        <div class="stat-val"><span style="color:var(--amber);display:inline-flex;vertical-align:-0.15em">${icon('trophy', { size: 16 })}</span> ${pbCount}</div>
        <div class="stat-label">PBs</div>
      </div>` : ''}
    </div>
    ${pbCount ? `<div class="hd-pb-list">${s.pbs.map(p => `<div><span style="color:var(--amber);display:inline-flex;vertical-align:-0.2em;margin-right:4px">${icon('trophy', { size: 14 })}</span>${esc(p.exercise)} — ${esc(p.label)}</div>`).join('')}</div>` : ''}
    ${(s.exercises||[]).map((ex, ei) => `
      <div style="background:var(--surface);border-radius:12px;padding:14px;margin-bottom:10px;border-left:4px solid ${CATEGORY_COLORS[ex.category]||'#38bdf8'}">
        <div style="font-size:0.95rem;font-weight:700;margin-bottom:10px">${esc(ex.name)}</div>
        ${ex.notes ? `<div style="font-size:0.75rem;color:var(--text-muted);margin:-6px 0 8px;display:flex;gap:5px;align-items:flex-start">${icon('notebook-pen', { size: 13 })} <span>${esc(ex.notes)}</span></div>` : ''}
        ${ex.coachNote ? `<div style="font-size:0.75rem;color:var(--purple);margin:-6px 0 8px;display:flex;gap:5px;align-items:flex-start">${icon('zap', { size: 13 })} <span>${esc(ex.coachNote)}</span></div>` : ''}
        ${hdEditMode
          ? (ex.sets||[]).map((st, si) => `
            <div class="hd-set-row hd-set-edit">
              <span class="hd-set-num">${si+1}</span>
              <div class="hd-edit-fields">${hdSetEditInputs(ex, ei, st, si)}</div>
            </div>`).join('')
          : (ex.sets||[]).filter(st => st.done || st.weight || st.reps || st.duration || st.distance).map((st,i) => `
            <div class="hd-set-row">
              <span class="hd-set-num">${i+1}${st.type === 'dropset' ? '<span style="color:#a78bfa"> D</span>' : st.type === 'warmup' ? '<span style="color:#fbbf24"> W</span>' : ''}</span>
              <span class="hd-set-val">${hdSetVal(ex, st)}</span>
              ${st.rpe ? `<span style="color:var(--text-muted);margin-left:auto;font-size:0.75rem">RPE ${st.rpe}</span>` : ''}
            </div>`).join('')}
      </div>
    `).join('')}
    <div style="margin-bottom:20px"></div>
  `;

  // Edit-sets toggle / save+cancel
  if (hdEditMode) {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'header-btn primary';
    saveBtn.innerHTML = `${icon('check', { size: 15 })} Save changes`;
    saveBtn.style.cssText = 'display:block;width:100%;margin-bottom:8px;padding:12px;border-radius:10px;font-size:0.9rem;cursor:pointer;';
    saveBtn.onclick = saveHistoryEdits;
    body.appendChild(saveBtn);
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'header-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'display:block;width:100%;margin-bottom:12px;padding:12px;border-radius:10px;background:var(--surface);border:1px solid rgba(255,255,255,0.12);color:var(--text);font-size:0.9rem;cursor:pointer;';
    cancelBtn.onclick = async () => { await openHistoryDetail(s.id); };
    body.appendChild(cancelBtn);
  } else {
    const editBtn = document.createElement('button');
    editBtn.className = 'header-btn';
    editBtn.innerHTML = `${icon('pencil', { size: 14 })} Edit sets`;
    editBtn.style.cssText = 'display:block;width:100%;margin-bottom:8px;padding:12px;border-radius:10px;background:var(--surface);border:1px solid rgba(56,189,248,0.4);color:var(--blue);font-size:0.9rem;font-weight:700;cursor:pointer;';
    editBtn.onclick = () => { hdEditMode = true; renderHistoryDetailBody(); };
    body.appendChild(editBtn);

    const tplBtn = document.createElement('button');
    tplBtn.className = 'header-btn';
    tplBtn.textContent = 'Save as Routine';
    tplBtn.style.cssText = 'display:block;width:100%;margin-bottom:12px;padding:12px;border-radius:10px;background:var(--surface);border:1px solid rgba(255,255,255,0.12);color:var(--text);font-size:0.9rem;cursor:pointer;';
    tplBtn.onclick = () => {
      const name = prompt('Routine name:', s.title || 'My Routine');
      if (!name) return;
      saveTemplate(name, s.exercises);
    };
    body.appendChild(tplBtn);
  }

  document.getElementById('hdDateBox').onclick = () => openDateEditor(s.id, s);
  document.getElementById('hdDurBox').onclick  = () => openDateEditor(s.id, s);
}

async function saveHistoryEdits() {
  if (!hdSession) return;
  document.querySelectorAll('#hdBody .hd-edit-input').forEach(inp => {
    const ei = +inp.dataset.ei, si = +inp.dataset.si, field = inp.dataset.field;
    const ex = hdSession.exercises?.[ei];
    const st = ex?.sets?.[si];
    if (!st) return;
    if (field === 'reps')          st.reps = parseInt(inp.value) || 0;
    else if (field === 'reps2')    st.reps2 = parseInt(inp.value) || 0;
    else if (field === 'weight2')  st.weight2 = parseFloat(inp.value) || 0;
    else if (field === 'distance') st.distance = parseFloat(inp.value) || 0;
    else if (field === 'time')     st.duration = maskTime(inp.value).secs;
    else                           st.weight = parseFloat(inp.value) || 0;   // weight
  });
  // Any set that now carries data counts toward stats; fully-empty rows don't.
  for (const ex of hdSession.exercises || []) {
    for (const st of ex.sets || []) {
      st.done = !!(st.weight || st.reps || st.duration || st.distance);
    }
  }
  await db.set(STORE, 'session-' + hdSession.id, hdSession);
  hdEditMode = false;
  renderHistoryDetailBody();
  renderHistory();
  renderStats();
  renderDashboard();
}

async function openHistoryDetail(sessionId) {
  const s = await db.get(STORE, 'session-' + sessionId);
  if (!s) return;
  hdSession = s;
  hdEditMode = false;
  renderHistoryDetailBody();
  document.getElementById('historyDetail').classList.add('visible');
}

// ── Edit a past workout's date & time ─────────────────────────────────────────
let hdEditSid = null;
function openDateEditor(sessionId, s) {
  hdEditSid = sessionId;
  const d = parseToDate(s.startTime || s.date || '') || new Date();
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('hdDateInput').value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  document.getElementById('hdTimeInput').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  document.getElementById('hdDurationInput').value = s.duration ? Math.round(s.duration / 60) : '';
  document.getElementById('hdDateModal').classList.add('open');
}
document.getElementById('hdDateCancel').onclick = () => document.getElementById('hdDateModal').classList.remove('open');
document.getElementById('hdDateModal').addEventListener('click', e => {
  if (e.target === document.getElementById('hdDateModal')) document.getElementById('hdDateModal').classList.remove('open');
});
document.getElementById('hdDateSave').onclick = async () => {
  const dateVal = document.getElementById('hdDateInput').value;   // YYYY-MM-DD
  const timeVal = document.getElementById('hdTimeInput').value || '12:00';
  if (!dateVal || !hdEditSid) return;
  const s = await db.get(STORE, 'session-' + hdEditSid);
  if (!s) return;
  s.date = dateVal;
  s.startTime = `${dateVal}T${timeVal}:00`;
  // Duration edit (minutes → seconds). Blank leaves it unchanged.
  const durRaw = document.getElementById('hdDurationInput').value.trim();
  if (durRaw !== '') s.duration = Math.max(0, Math.round(parseFloat(durRaw) * 60)) || 0;
  if (s.duration) {
    const end = new Date(`${dateVal}T${timeVal}:00`);
    end.setSeconds(end.getSeconds() + s.duration);
    s.endTime = end.toISOString();
  }
  await db.set(STORE, 'session-' + hdEditSid, s);
  document.getElementById('hdDateModal').classList.remove('open');
  await openHistoryDetail(hdEditSid);   // refresh the detail
  renderHistory();
  renderStats();
  renderDashboard();
};

async function saveTemplate(name, exercises) {
  const templates = await getTemplates();
  templates.push({
    id: uid(), name,
    exercises: exercises.map(e => ({
      name: e.name, category: e.category, restTime: e.restTime ?? 60, logType: resolveLogType(e),
      ...(e.supersetId ? { supersetId: e.supersetId } : {}),
      sets: e.sets.filter(s => s.done||s.weight||s.reps||s.duration||s.distance).map(s => ({ weight: s.weight, reps: s.reps, distance: s.distance || 0, duration: s.duration || 0, type: s.type })),
    })),
  });
  await db.set(STORE, 'templates', templates);
  alert('Saved as routine!');
}

// Live mm:ss mask for the history-edit time fields (same behaviour as the
// active-workout inputs). Delegated on the persistent #hdBody container.
document.getElementById('hdBody').addEventListener('input', e => {
  const t = e.target;
  if (!t.classList?.contains('hd-edit-input') || t.dataset.field !== 'time') return;
  const m = maskTime(t.value); t.value = m.text;
  const st = hdSession?.exercises?.[+t.dataset.ei]?.sets?.[+t.dataset.si];
  if (st) st.duration = m.secs;
});
document.getElementById('hdBack').onclick   = () => document.getElementById('historyDetail').classList.remove('visible');
document.getElementById('hdDelete').onclick = async () => {
  const sid = document.getElementById('hdDelete').dataset.sid;
  if (!confirm('Delete this workout?')) return;
  await db.delete(STORE, 'session-' + sid);
  document.getElementById('historyDetail').classList.remove('visible');
  renderHistory();
  renderStats();     // clear the removed day from the calendar too
  renderDashboard();
  db.backup();
};

// ── Build routines from history ───────────────────────────────────────────────
document.getElementById('buildRoutinesBtn').onclick = async () => {
  const panel = document.getElementById('routineBuilder');
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }

  const sessions = await loadSessions();
  const byTitle = {};
  sessions.forEach(s => {
    const key = (s.title||'Workout').trim();
    if (!byTitle[key]) byTitle[key] = s;
  });

  const existing  = await getTemplates();
  const existingNames = new Set(existing.map(t => t.name.trim()));

  const container = document.getElementById('routineCandidates');
  const candidates = Object.entries(byTitle);

  container.innerHTML = candidates.map(([title, s]) => {
    const saved = existingNames.has(title);
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05)" data-title="${esc(title)}" data-sid="${s.id}">
        <div style="flex:1">
          <div style="font-size:0.9rem;font-weight:500">${esc(title)}</div>
          <div style="font-size:0.72rem;color:var(--text-muted)">${s.exercises.map(e=>esc(e.name)).join(' · ')}</div>
        </div>
        <button class="routine-save-btn" data-title="${esc(title)}" data-sid="${s.id}"
          style="background:${saved?'rgba(52,211,153,0.15)':'var(--surface2)'};border:none;border-radius:8px;
                 color:${saved?'#34d399':'var(--text-muted)'};font-size:0.8rem;padding:6px 12px;cursor:pointer;white-space:nowrap">
          ${saved ? '✓ Saved' : 'Save'}
        </button>
      </div>`;
  }).join('') || '<div style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:16px">No workouts in history yet.</div>';

  container.querySelectorAll('.routine-save-btn').forEach(btn => {
    btn.onclick = async () => {
      if (btn.textContent.trim().startsWith('✓')) return;
      const s = await db.get(STORE, 'session-' + btn.dataset.sid);
      if (!s) return;
      await saveTemplate(btn.dataset.title, s.exercises);
      btn.textContent = '✓ Saved';
      btn.style.background = 'rgba(52,211,153,0.15)';
      btn.style.color = '#34d399';
    };
  });

  panel.style.display = '';
};

document.getElementById('routineBuilderDone').onclick = () => {
  document.getElementById('routineBuilder').style.display = 'none';
};

// ── Library render ────────────────────────────────────────────────────────────
// ── Per-exercise history stats (one pass over sessions) ───────────────────────
// name -> { pbWeight, pbReps, e1rm, lastTs, count, series:[topSetWeight…] }.
// Built once per Library/picker render and shared, never recomputed per row.
function buildExerciseStatsMap(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const d = parseToDate(s.date || s.startTime || '');
    const t = d && !isNaN(d) ? d.getTime() : 0;
    for (const ex of s.exercises || []) {
      const working = (ex.sets || []).filter(st => st.done && (st.weight || 0) > 0 && st.type !== 'warmup' && st.type !== 'dropset');
      if (!working.length) continue;
      const key = canonicalName(ex.name);      // fold merged variations into one identity
      const existed = map.has(key);
      const m = map.get(key) || { pbWeight: 0, pbReps: 0, e1rm: 0, lastTs: 0, lastWeight: 0, lastReps: 0, count: 0, _series: [] };
      const top = working.reduce((a, b) => (b.weight > a.weight ? b : a));
      if (!existed) { m.lastWeight = top.weight; m.lastReps = top.reps || 0; } // sessions newest-first → first hit is latest
      for (const st of working) {
        if (st.weight > m.pbWeight || (st.weight === m.pbWeight && (st.reps || 0) > m.pbReps)) {
          m.pbWeight = st.weight; m.pbReps = st.reps || 0;
        }
        const est = e1RM(st.weight, st.reps || 1);
        if (est > m.e1rm) m.e1rm = est;
      }
      m.count++;
      if (t > m.lastTs) m.lastTs = t;
      if (t) m._series.push({ t, w: top.weight });
      map.set(key, m);
    }
  }
  for (const m of map.values()) {
    m._series.sort((a, b) => a.t - b.t);
    m.series = m._series.map(p => p.w);
    delete m._series;
  }
  return map;
}

function relTime(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7)   return `${days} days ago`;
  if (days < 30)  return `${Math.floor(days / 7)} wk ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

// Tiny inline sparkline of a numeric series (top-set weights). '' if <2 points.
function sparklineSVG(vals, { w = 52, h = 16, stroke = 1.6, color = 'var(--blue)', dot = false } = {}) {
  if (!vals || vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1, pad = 2;
  const X = i => (i / (vals.length - 1)) * (w - pad * 2) + pad;
  const Y = v => (h - pad) - ((v - min) / span) * (h - pad * 2);
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const li = vals.length - 1;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" aria-hidden="true">`
    + `<path d="${d}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`
    + (dot ? `<circle cx="${X(li).toFixed(1)}" cy="${Y(vals[li]).toFixed(1)}" r="2.4" fill="${color}"/>` : '')
    + `</svg>`;
}

let libFilter = 'all'; // 'all' | 'routines' | 'never' | 'custom'

async function renderLibrary() {
  const q      = document.getElementById('libSearch').value.trim();
  const libEl0 = document.getElementById('libraryList2');
  if (libEl0 && !libEl0.children.length && !q)
    libEl0.innerHTML = Array.from({ length: 8 }, () =>
      `<div class="skeleton" style="height:56px;margin-bottom:8px;border-radius:14px"></div>`).join('');

  const [all, sessions, templates] = await Promise.all([getAllExercises(), loadSessions(), getTemplates()]);
  // Hide exercises that have been merged into another identity — they show under
  // the canonical exercise now, not as their own library row.
  const visible = all.filter(e => canonicalName(e.name) === e.name);
  const stats = buildExerciseStatsMap(sessions);
  const setsByCat = {};
  weeklySetsByCategory(sessions).rows.forEach(r => { setsByCat[r.cat] = r.perWk; });
  const inRoutines = new Set(templates.flatMap(t => (t.exercises || []).map(e => e.name)));

  // Count line
  const loggedCount = visible.filter(e => stats.has(e.name)).length;
  document.getElementById('libCount').textContent = `${visible.length} exercises · ${loggedCount} logged`;

  // Your routines — start any of them straight from the Library (tap to begin).
  const libRoutinesEl = document.getElementById('libRoutines');
  libRoutinesEl.innerHTML = `
    <div class="lib-routines-head">
      <span class="section-heading" style="margin:0">Your routines</span>
      <button class="dash-link" id="libBrowseSplits">Browse splits</button>
    </div>
    ${templates.length
      ? templates.map(t => `
        <div class="lib-routine-card" data-tid="${t.id}">
          <div class="lib-routine-name">${esc(t.name)}</div>
          <div class="lib-routine-ex">${t.exercises.map(e => esc(e.name)).join(' · ')}</div>
        </div>`).join('')
      : `<div class="routines-empty">No routines yet — tap <strong>Browse splits</strong> for ready-made ones.</div>`}
    <div class="lib-routines-divider">Exercises</div>`;
  libRoutinesEl.querySelector('#libBrowseSplits').onclick = () => {
    renderLibraryList();
    document.getElementById('routineLibrary').classList.add('visible');
  };
  libRoutinesEl.querySelectorAll('.lib-routine-card').forEach(card => {
    card.onclick = () => startEmptyWorkout(templates.find(t => t.id === card.dataset.tid));
  });

  // Filter chips
  const CHIPS = [
    { v: 'routines', t: 'In my routines' }, { v: 'all', t: 'All' },
    { v: 'never', t: 'Never tried' }, { v: 'custom', t: 'Custom' },
  ];
  document.getElementById('libChips').innerHTML = CHIPS.map(c =>
    `<button class="lib-chip${libFilter === c.v ? ' active' : ''}" data-filter="${c.v}">${c.t}</button>`).join('');
  document.querySelectorAll('#libChips .lib-chip').forEach(chip => {
    chip.onclick = () => { libFilter = chip.dataset.filter; renderLibrary(); };
  });

  const matchesFilter = e =>
    libFilter === 'all' ? true :
    libFilter === 'routines' ? inRoutines.has(e.name) :
    libFilter === 'never' ? !stats.has(e.name) :
    libFilter === 'custom' ? !!e.custom : true;

  const filtered = visible.filter(e =>
    matchesFilter(e) && matchesSearch(`${e.name} ${e.category}`, q));

  const el = document.getElementById('libraryList2');
  if (!filtered.length) {
    el.innerHTML = `<div class="routines-empty">No exercises match.</div>`;
    return;
  }

  const groups = {};
  filtered.forEach(e => (groups[e.category] = groups[e.category] || []).push(e));

  el.innerHTML = Object.entries(groups).map(([cat, exs]) => {
    // logged rows first (most-recent first), then never-logged.
    const rows = exs.slice().sort((a, b) => {
      const sa = stats.get(a.name), sb = stats.get(b.name);
      if (!!sa !== !!sb) return sa ? -1 : 1;
      if (sa && sb) return sb.lastTs - sa.lastTs;
      return a.name.localeCompare(b.name);
    });
    const setsLbl = setsByCat[cat] ? `<span class="lib-group-sets">${Math.round(setsByCat[cat])} sets/wk</span>` : '';
    return `
      <div class="lib-group-head">
        <span class="ex-cat-dot" style="background:${CATEGORY_COLORS[cat] || '#8e8e9a'}"></span>
        <span class="lib-group-name">${esc(cat)}</span>${setsLbl}
      </div>
      ${rows.map(e => libraryRow(e, stats.get(e.name))).join('')}`;
  }).join('');

  el.querySelectorAll('.lib-row').forEach(item => {
    item.onclick = () => openExerciseDetail(item.dataset.cue);
  });
}

function libraryRow(e, st) {
  if (!st) {
    return `
      <div class="lib-row never" data-cue="${esc(e.name)}">
        <div class="lib-row-l1">
          <span class="lib-row-name">${esc(e.name)}</span>
          ${e.custom ? '<span class="lib-custom-badge">Custom</span>' : '<span class="lib-row-never">Never logged</span>'}
        </div>
      </div>`;
  }
  const spark = sparklineSVG(st.series, { w: 52, h: 16 });
  return `
    <div class="lib-row" data-cue="${esc(e.name)}">
      <div class="lib-row-l1">
        <span class="lib-row-name">${esc(e.name)}</span>
        <span class="lib-row-pb">${icon('trophy', { size: 12 })} ${fmtKg(st.pbWeight)} × ${st.pbReps}</span>
      </div>
      <div class="lib-row-l2">
        <span>Last: ${relTime(st.lastTs)}</span>
        <span>est. 1RM <b>${Math.round(st.e1rm)} kg</b></span>
        ${spark}
      </div>
    </div>`;
}

// ── Form cues sheet ───────────────────────────────────────────────────────────
function showCues(name) {
  const cues = resolveCues(name);
  document.getElementById('cuesTitle').textContent = name;
  const body = document.getElementById('cuesBody');
  if (cues && cues.length) {
    body.innerHTML = cues.map(c => `<li>${esc(c)}</li>`).join('');
  } else {
    body.innerHTML = `<li style="list-style:none;color:var(--text-muted);margin-left:-20px">No form cues for this exercise yet.</li>`;
  }
  document.getElementById('cuesModal').classList.add('open');
}
document.getElementById('cuesClose').onclick = () => document.getElementById('cuesModal').classList.remove('open');
document.getElementById('cuesModal').addEventListener('click', e => {
  if (e.target === document.getElementById('cuesModal')) document.getElementById('cuesModal').classList.remove('open');
});
document.getElementById('libSearch').oninput = renderLibrary;
document.getElementById('histSearch').oninput = renderHistory;

// Clear-history was intentionally removed — history is edit-only now, so there's
// no one-tap way to wipe it (and no matching cloud delete).

// ── Backup & restore ──────────────────────────────────────────────────────────
function showProgress(msg, hideAfter = 0) {
  const progress = document.getElementById('importProgress');
  progress.style.display = 'block';
  progress.textContent = msg;
  if (hideAfter) setTimeout(() => { progress.style.display = 'none'; }, hideAfter);
}
function countSessions() { return loadSessions().then(s => s.length); }

// Pull the cloud copy back onto this device (paginated — see db.js). Reports the
// number of items restored so it's obvious whether the cloud has the history.
document.getElementById('restoreCloudBtn').onclick = async () => {
  showProgress('Restoring from cloud…');
  try {
    const n = await db.sync();
    const sessions = await countSessions();
    showProgress(`✅ Restored ${n} item${n === 1 ? '' : 's'} from cloud — ${sessions} workout${sessions === 1 ? '' : 's'} in history.`, 6000);
    renderHistory(); renderDashboard(); renderStats();
  } catch (err) { showProgress('❌ Restore failed: ' + err.message, 6000); }
};

// Push everything on this device up to the cloud (batched — see db.js). Use this
// after an import, or any time you want a guaranteed cloud copy.
document.getElementById('backupCloudBtn').onclick = async () => {
  showProgress('Backing up to cloud…');
  try {
    const n = await db.backup();
    showProgress(`✅ Backed up ${n} item${n === 1 ? '' : 's'} to the cloud.`, 6000);
  } catch (err) { showProgress('❌ Backup failed: ' + err.message, 6000); }
};

// Download a JSON backup of everything in the workout store — a device-owned
// copy that doesn't depend on the cloud at all.
document.getElementById('exportBtn').onclick = async () => {
  try {
    const entries = await db.getAll(STORE);
    const blob = new Blob([JSON.stringify({ app: 'gym', version: 1, exportedAt: new Date().toISOString(), entries }, null, 0)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gym-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showProgress(`✅ Exported ${entries.length} items. Save the file somewhere safe.`, 6000);
  } catch (err) { showProgress('❌ Export failed: ' + err.message, 6000); }
};

// ── Import (JSON backup, or a CSV workout export) ─────────────────────────────
document.getElementById('importBtn').onclick = () => document.getElementById('csvInput').click();

document.getElementById('csvInput').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  showProgress('Reading file…');
  try {
    const text = await file.text();
    let imported = 0;
    const trimmed = text.trimStart();
    if (file.name.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // JSON backup produced by Export above.
      const data = JSON.parse(text);
      const entries = Array.isArray(data) ? data : (data.entries || []);
      for (const { key, value } of entries) {
        if (!key || value == null) continue;
        await db.set(STORE, key, value);
        imported++;
      }
      showProgress(`✅ Imported ${imported} items from backup.`, 4000);
    } else {
      // CSV workout export (common tracker columns supported).
      const sessions = parseWorkoutCSV(text);
      for (const s of sessions) {
        const existing = await db.get(STORE, 'session-' + s.id);
        if (!existing || !existing.date || existing.date === 'Invalid Date') {
          await db.set(STORE, 'session-' + s.id, s);
          imported++;
        }
      }
      showProgress(`✅ Imported ${imported} workouts.`, 4000);
    }
    db.backup();   // make sure the imported data reaches the cloud too
    renderHistory(); renderDashboard(); renderStats();
  } catch (err) {
    showProgress('❌ Import failed: ' + err.message, 6000);
  }
  e.target.value = '';
};

// Parse a workout CSV export. Understands the common column layout (title,
// start/end time, exercise_title, weight_kg, reps, set_type, rpe) used by
// mainstream trackers, TSV or comma-delimited.
function parseWorkoutCSV(text) {
  const rows   = parseCSV(text);
  if (rows.length < 2) throw new Error('Empty or invalid CSV');
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g,'_'));
  const data   = rows.slice(1).map(row => {
    const obj = {};
    header.forEach((h,i) => obj[h] = (row[i]||'').trim());
    return obj;
  }).filter(r => r.title || r.exercise_title);

  const workouts = {};
  data.forEach(row => {
    const wKey = (row.title||'Workout') + '|||' + (row.start_time||'');
    if (!workouts[wKey]) {
      const start = row.start_time || '';
      const end   = row.end_time   || '';
      let duration = 0;
      if (start && end) {
        try { duration = Math.round((new Date(end) - new Date(start)) / 1000); } catch(_) {}
      }
      workouts[wKey] = {
        id:        stableId(wKey),
        title:     row.title || 'Workout',
        date:      extractDateStr(start) || new Date().toISOString().slice(0,10),
        startTime: start,
        endTime:   end,
        duration,
        exercises: {},
      };
    }

    const exName = row.exercise_title || 'Unknown';
    if (!workouts[wKey].exercises[exName]) {
      workouts[wKey].exercises[exName] = {
        id: uid(), name: exName,
        category: guessCategory(exName),
        notes: row.exercise_notes || '',
        sets: [],
      };
    }

    workouts[wKey].exercises[exName].sets.push({
      id:     uid(),
      type:   row.set_type || 'normal',
      weight: parseFloat(row.weight_kg)       || 0,
      reps:   parseInt(row.reps)              || 0,
      rpe:    row.rpe ? parseFloat(row.rpe)   : null,
      done:   true,
    });
  });

  return Object.values(workouts).map(w => ({
    ...w,
    exercises: Object.values(w.exercises),
  }));
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/bench|chest|fly|pec|push.?up|dip/.test(n))                      return 'Chest';
  if (/deadlift|row|pull.?up|chin|lat|pulldown|face.?pull/.test(n))    return 'Back';
  if (/shoulder|press.*over|overhead|lateral|delt|arnold/.test(n))     return 'Shoulders';
  if (/curl|bicep/.test(n))                                             return 'Biceps';
  if (/tricep|pushdown|skull|close.?grip|extension/.test(n))           return 'Triceps';
  if (/squat|leg.?press|hack|lunge|split|sissy/.test(n))               return 'Quads';
  if (/leg.?curl|hamstring|romanian|rdl|good.?morning/.test(n))        return 'Hamstrings';
  if (/hip.?thrust|glute|kickback|abduct/.test(n))                     return 'Glutes';
  if (/calf|calves/.test(n))                                            return 'Calves';
  if (/plank|crunch|ab|core|oblique|dragon|pallof|leg.?raise/.test(n)) return 'Core';
  if (/run|cardio|bike|cycle|row.*machine|stair|rope/.test(n))         return 'Cardio';
  return 'Back'; // fallback
}

// Delimiter-detecting parser — handles TSV and CSV
function parseCSV(text) {
  const firstLine = text.split('\n')[0];
  const tabs   = (firstLine.match(/\t/g)  || []).length;
  const commas = (firstLine.match(/,/g)   || []).length;
  return tabs > commas ? parseTSV(text) : parseCommaCSV(text);
}

function parseTSV(text) {
  return text
    .split('\n')
    .map(line => line.replace(/\r$/, '').split('\t'))
    .filter(row => row.some(f => f.trim() !== ''));
}

function parseCommaCSV(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuote = false;
      else field += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || (c === '\r' && text[i+1] === '\n')) {
        if (c === '\r') i++;
        row.push(field); field = '';
        if (row.some(f => f !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field || row.length) { row.push(field); if (row.some(f => f !== '')) rows.push(row); }
  return rows;
}

// Keep the Coach tab flush below the real page header (its height varies with
// font + safe-area, so a hardcoded offset overlapped it — see #secCoach CSS).
function syncHeaderHeight() {
  // The main tabs no longer have a title header (the coach anchors straight to
  // the safe area), so this only measures a header if one exists. Kept as a safe
  // no-op for the detail screens that still carry their own .page-header.
  const el = document.querySelector('#mainApp > .page-header');
  if (!el) return;
  const h = Math.ceil(el.getBoundingClientRect().height);
  if (h) document.documentElement.style.setProperty('--hdr-h', h + 'px');
}
syncHeaderHeight();
addEventListener('resize', syncHeaderHeight);
addEventListener('load', syncHeaderHeight);
if (window.visualViewport) visualViewport.addEventListener('resize', syncHeaderHeight);

// ── App chrome ────────────────────────────────────────────────────────────────
// This is a standalone app now — there's no hub to go "back" to. Hide the back
// button when installed; in a browser tab keep it as a plain history-back.
(function fixChrome() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const homeBtn = document.getElementById('homeBtn');
  if (!homeBtn) return;
  if (standalone) {
    homeBtn.style.display = 'none';
  } else {
    homeBtn.onclick = () => history.back();
  }
})();

// Track workout title edits for autosave
document.getElementById('awTitle').addEventListener('input', e => {
  if (activeSession) { activeSession.title = e.target.value; saveSoon(); }
});

// ════════════════════════════════════════════════════════════════════════════
//  AI COACH
// ════════════════════════════════════════════════════════════════════════════
let coachThread = null;   // [{role, text, routine?}]
let coachBusy = false;
let lastCoachSend = null; // {text, forceTool} — for one-tap Retry after an error

// Coach API key: workout-store key, falling back to any key previously saved
// under the (now-removed) habits store so it carries over seamlessly.
async function coachGetKey() {
  return (await db.get('workout', 'anthropic-key')) || (await db.get('habits', 'anthropic-key')) || '';
}

// The coach can run if the user pasted a key OR is logged in (the Edge Function
// proxy serves logged-in users). Only when neither holds do we hard-stop 'nokey'.
async function coachHasTransport() {
  if (await coachGetKey()) return true;
  try { return !!(await supabase.auth.getSession())?.data?.session?.access_token; } catch (_) { return false; }
}

async function loadCoachThread() {
  if (!coachThread) coachThread = (await db.get('workout', 'coach-thread')) || [];
  return coachThread;
}
function persistCoachThread() { db.set('workout', 'coach-thread', coachThread); }

// ── Coach memory: the persistent athlete profile the coach reads & writes ──────
async function getCoachProfile() { return (await db.get(STORE, 'coach-profile')) || null; }
// Computed bodyweight snapshot for the coach context (latest + trend).
async function getCoachBodyStats() { try { return bodyStats(await getBodyLog()); } catch (_) { return null; } }

// Merge the model's set_coach_profile input into the stored profile. Fields are
// merged (only what changed is sent); array fields replace. A supplied bodyweight
// is also written to the weigh-in log so the weight chart stays in sync.
async function coachSetProfile(input) {
  const cur = (await db.get(STORE, 'coach-profile')) || {};
  const merged = { ...cur };
  const str = v => (typeof v === 'string' ? v.trim() : '');
  for (const k of ['goal', 'experience', 'equipment', 'notes']) if (str(input?.[k])) merged[k] = str(input[k]);
  const dpw = parseInt(input?.daysPerWeek);
  if (dpw > 0) merged.daysPerWeek = Math.min(14, dpw);
  const bw = Number(input?.bodyweightKg);
  if (bw > 0) { merged.bodyweightKg = bw; try { await logBodyweight(bw); } catch (_) {} }
  for (const k of ['injuries', 'dislikes', 'preferences']) {
    if (Array.isArray(input?.[k])) {
      const arr = input[k].map(str).filter(Boolean);
      if (arr.length) merged[k] = arr;
    }
  }
  merged.updatedAt = new Date().toISOString();
  await db.set(STORE, 'coach-profile', merged);
  const items = [];
  if (merged.goal) items.push(`Goal: ${merged.goal}`);
  if (merged.experience) items.push(`Experience: ${merged.experience}`);
  if (merged.daysPerWeek) items.push(`${merged.daysPerWeek} day(s)/week`);
  if (merged.equipment) items.push(`Equipment: ${merged.equipment}`);
  if (merged.injuries?.length) items.push(`Avoid: ${merged.injuries.join('; ')}`);
  if (merged.preferences?.length) items.push(`Prefers: ${merged.preferences.join('; ')}`);
  if (merged.bodyweightKg) items.push(`Bodyweight: ${merged.bodyweightKg}kg`);
  return { text: "Saved to your profile — I'll remember that.",
           summary: { title: 'Updated your coach profile', items } };
}

// ── Coach memory strip (top of the Coach tab) ────────────────────────────────
async function renderCoachMemory() {
  const el = document.getElementById('coachMem');
  if (!el) return;
  const p = await getCoachProfile();
  const parts = [];
  if (p) {
    if (p.goal)             parts.push(p.goal);
    if (p.experience)       parts.push(p.experience);
    if (p.daysPerWeek)      parts.push(`${p.daysPerWeek}d/wk`);
    if (p.injuries?.length) parts.push('avoid ' + p.injuries.join(', '));
    if (p.bodyweightKg)     parts.push(`${p.bodyweightKg}kg`);
  }
  if (parts.length) {
    el.innerHTML =
      `<span class="coach-mem-ic">${icon('notebook-pen', { size: 16 })}</span>` +
      `<span class="coach-mem-txt"><b>Remembers you:</b> ${esc(parts.join(' · '))}</span>` +
      `<span class="coach-mem-edit">Edit</span>`;
  } else {
    el.innerHTML =
      `<span class="coach-mem-ic">${icon('notebook-pen', { size: 16 })}</span>` +
      `<span class="coach-mem-txt">Set your goals, kit &amp; injuries so I can tailor everything to you.</span>` +
      `<span class="coach-mem-edit">Set up</span>`;
  }
}

// ── Coach profile sheet (view/edit the persistent profile directly) ──────────
let cpDays = 0;
let cpInjuries = [];
function renderCpInjuries() {
  const wrap = document.getElementById('cpInjTags');
  wrap.innerHTML = cpInjuries.map((t, i) =>
    `<span class="cp-tag">${esc(t)} <button type="button" data-i="${i}" aria-label="Remove">✕</button></span>`).join('');
  wrap.querySelectorAll('button').forEach(b =>
    b.onclick = () => { cpInjuries.splice(+b.dataset.i, 1); renderCpInjuries(); });
}
async function openCoachProfile() {
  const p = (await getCoachProfile()) || {};
  document.getElementById('cpGoal').value  = p.goal || '';
  document.getElementById('cpEquip').value = p.equipment || '';
  document.getElementById('cpBw').value    = p.bodyweightKg || '';
  cpDays = p.daysPerWeek || 0;
  document.getElementById('cpDaysVal').textContent = cpDays || '—';
  document.querySelectorAll('#cpExp button').forEach(b =>
    b.classList.toggle('on', b.dataset.v === (p.experience || '')));
  cpInjuries = Array.isArray(p.injuries) ? [...p.injuries] : [];
  renderCpInjuries();
  document.getElementById('coachProfileModal').classList.add('open');
  syncScrollLock();
}
function closeCoachProfile() {
  document.getElementById('coachProfileModal').classList.remove('open');
  syncScrollLock();
}
async function saveCoachProfileSheet() {
  const goal      = document.getElementById('cpGoal').value.trim();
  const equipment = document.getElementById('cpEquip').value.trim();
  const bw        = parseFloat(document.getElementById('cpBw').value);
  const expBtn    = document.querySelector('#cpExp button.on');

  const next = { ...((await getCoachProfile()) || {}) };
  if (goal) next.goal = goal; else delete next.goal;
  if (equipment) next.equipment = equipment; else delete next.equipment;
  if (expBtn) next.experience = expBtn.dataset.v; else delete next.experience;
  if (cpDays > 0) next.daysPerWeek = cpDays; else delete next.daysPerWeek;
  if (bw > 0) { next.bodyweightKg = +bw.toFixed(1); try { await logBodyweight(+bw.toFixed(1)); } catch (_) {} }
  next.injuries = cpInjuries.slice();
  if (!next.injuries.length) delete next.injuries;
  next.updatedAt = new Date().toISOString();

  await db.set(STORE, 'coach-profile', next);
  closeCoachProfile();
  renderCoachMemory();
}

// The Coach tab is a direct Q&A chat. Proactive coach content (the daily pick +
// data-driven observations) lives on the Home screen (renderDashCoach) instead.
async function renderCoach() {
  await loadCoachThread();
  renderCoachMemory();
  const thread = document.getElementById('coachThread');
  thread.innerHTML = '';
  if (!coachThread.length) {
    thread.innerHTML = `<div class="coach-empty">Ask me anything — training, form, programming, progression, or “what should I train today?”.<br><br>I also post a daily pick and observations on your <strong>Home</strong> screen.</div>`;
    return;
  }
  coachThread.forEach(m => thread.appendChild(renderCoachMessage(m)));
  scrollCoachDown();
}

// ── Coach findings (generated from your data — no API key needed) ─────────────
let _coachFindings = [];

function generateCoachFindings(sessions) {
  const out = [];
  if (!sessions.length) return out;
  const { rows } = weeklySetsByCategory(sessions);
  const byCat = {}; rows.forEach(r => byCat[r.cat] = r.perWk);
  const stats = buildExerciseStatsMap(sessions);

  // 1) Push : pull balance
  const push = (byCat.Chest || 0) + (byCat.Shoulders || 0) + (byCat.Triceps || 0);
  const pull = (byCat.Back || 0) + (byCat.Biceps || 0);
  if (push > 0 && pull > 0) {
    const ratio = push / pull;
    if (ratio > 1.3 || ratio < 0.77) {
      const heavy = ratio > 1 ? 'push' : 'pull';
      const r = ratio > 1 ? ratio : 1 / ratio;
      const denom = Math.max(push, pull);
      out.push({
        severity: 'warn', eyebrow: 'Imbalance', metric: `${r.toFixed(1)} : 1`,
        body: `Your ${heavy} volume is running ahead of the other side. Left unchecked that skews posture and holds the lagging side back — add a set or two to ${heavy === 'push' ? 'back and biceps' : 'chest and shoulders'}.`,
        evidence: { type: 'bars', bars: [
          { label: 'Push', pct: (push / denom) * 100, color: CATEGORY_COLORS.Chest, under: ratio < 1 },
          { label: 'Pull', pct: (pull / denom) * 100, color: CATEGORY_COLORS.Back,  under: ratio > 1 },
        ] },
        actions: [
          { label: 'Suggest a fix', kind: 'primary', prompt: `My push-to-pull working-set ratio is about ${r.toFixed(1)}:1 (${heavy}-dominant). Suggest one concrete change to a routine to rebalance it.`, force: 'suggest_routine_edit' },
          { label: 'Explain', kind: 'ghost', prompt: `Why does a ${r.toFixed(1)}:1 push-to-pull ratio matter, and how should I fix it?` },
        ],
        key: 'find-balance',
      });
    }
  }

  // 2) Progressing — the biggest est-1RM riser
  let prog = null;
  for (const [name, m] of stats) {
    if (m.series.length < 3) continue;
    const first = m.series[0], last = m.series[m.series.length - 1];
    if (last > first && (!prog || last - first > prog.gain)) prog = { name, m, gain: last - first, first, last };
  }
  if (prog) {
    out.push({
      severity: 'good', eyebrow: 'Progressing', metric: `+${Math.round(prog.gain)} kg`,
      body: `${prog.name} is climbing — top set went from ${fmtKg(prog.first)} kg to ${fmtKg(prog.last)} kg over ${prog.m.series.length} sessions. Whatever you're doing, keep it.`,
      evidence: { type: 'spark', vals: prog.m.series },
      actions: [
        { label: 'Open lift', kind: 'open', exercise: prog.name },
        { label: 'Explain', kind: 'ghost', prompt: `How is my ${prog.name} progressing, and what should I do to keep it moving?` },
      ],
      key: 'find-progress',
    });
  }

  // 3) Stalling — a frequent lift flat over its last 4 sessions
  let stall = null;
  for (const [name, m] of stats) {
    if (m.series.length < 4) continue;
    const recent = m.series.slice(-4);
    const max = Math.max(...recent), min = Math.min(...recent);
    if (max > 0 && (max - min) / max < 0.03 && (!stall || m.count > stall.m.count)) stall = { name, m, n: recent.length };
  }
  if (stall && (!prog || stall.name !== prog.name)) {
    out.push({
      severity: 'stalling', eyebrow: 'Stalling', metric: `${stall.n} sessions flat`,
      body: `${stall.name} hasn't moved in ${stall.n} sessions. A small load bump, an extra set, or a short deload usually breaks a plateau like this.`,
      evidence: { type: 'spark', vals: stall.m.series.slice(-6) },
      actions: [
        { label: 'Suggest a change', kind: 'primary', prompt: `My ${stall.name} has stalled for ${stall.n} sessions. Suggest one concrete change to progress it.`, force: 'suggest_routine_edit' },
        { label: 'Open lift', kind: 'open', exercise: stall.name },
        { label: 'Dismiss', kind: 'dismiss' },
      ],
      key: 'find-stall',
    });
  }
  return out;
}

const _SEV_COLOR = { warn: 'var(--red)', good: 'var(--green)', stalling: 'var(--amber)', tip: 'var(--blue)' };

function coachEvidence(ev) {
  if (ev.type === 'bars') {
    return `<div class="cf-bars">${ev.bars.map(b => `
      <div class="cf-bar-row">
        <span class="cf-bar-label">${esc(b.label)}</span>
        <div class="cf-bar-track"><div class="cf-bar-fill" style="width:${Math.round(b.pct)}%;background:${b.color};opacity:${b.under ? 0.55 : 1}"></div></div>
      </div>`).join('')}</div>`;
  }
  if (ev.type === 'spark') {
    return `<div class="cf-spark">${sparklineSVG(ev.vals, { w: 120, h: 46, stroke: 2, dot: true })}</div>`;
  }
  return '';
}

function coachFindingCard(f, fi) {
  const color = _SEV_COLOR[f.severity] || 'var(--blue)';
  const actions = (f.actions || []).map((a, ai) =>
    `<button class="cf-btn ${a.kind === 'primary' ? 'cf-btn-primary' : 'cf-btn-ghost'}" data-fi="${fi}" data-ai="${ai}">${esc(a.label)}</button>`).join('');
  return `
    <div class="coach-finding" data-fi="${fi}" style="border-left-color:${color}">
      <div class="cf-head">
        <span class="cf-eyebrow" style="color:${color}">${esc(f.eyebrow)}</span>
        <span class="cf-metric">${esc(f.metric || '')}</span>
      </div>
      <div class="cf-body">${esc(f.body)}</div>
      ${f.evidence ? coachEvidence(f.evidence) : ''}
      ${actions ? `<div class="cf-actions">${actions}</div>` : ''}
    </div>`;
}

// ── Coach's pick for today (proactive, once-per-day AI suggestion) ────────────
// Generated on the Home screen (renderDashCoach) — the coach reviews ALL the
// user's data on its own and surfaces its single highest-value suggestion for
// today: an altered session, a split swap, a routine tweak, or an observation.
// One API call per calendar day (cached in 'coach-daily'); needs an API key;
// dismissible for the day.
let _dailyBusy = false;

async function generateDailySuggestion(today) {
  try {
    const system = await assembleContext({
      loadSessions: loadSessionsCanonical, getTemplates, getAllExercises, getStreakSettings,
      getProfile: getCoachProfile, getBodyStats: getCoachBodyStats, getNutritionToday,
    });
    const day = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
    const prompt = `PROACTIVE DAILY REVIEW (${day}). I haven't asked a specific question — you're reviewing my whole app on your own. Read across my ATHLETE PROFILE, TRAINING BALANCE, RECOVERY/READINESS, PROGRESSION SIGNALS, recent sessions and saved routines, and give me ONE highest-value, data-backed suggestion for today in 2–3 sentences. If a specific session would serve me best, draft it — and where my data warrants it (a muscle under-recovered or over-volume, a lagging group, a stalled lift), alter my usual plan or propose swapping the split rather than repeating what I always do. Cite the number or mechanism behind it. Do NOT call any tool that changes my data — no logging workouts, no adding exercises, no editing my profile.`;
    const result = await callCoach({
      apiMessages: [{ role: 'user', content: prompt }],
      system, forceTool: false, getKey: coachGetKey,
    });
    if (!result || result.error) return null;

    const out = { date: today, text: result.text || '' };
    const tool = result.tool;
    if (tool?.name === 'draft_routine') {
      try { out.routine = await validateRoutine(tool.input, { getAllExercises, guessCategory }); } catch (_) {}
    } else if (tool?.name === 'draft_split') {
      try {
        const days = Array.isArray(tool.input?.days) ? tool.input.days : [];
        const routines = [];
        for (const d of days) { try { routines.push(await validateRoutine(d, { getAllExercises, guessCategory })); } catch (_) {} }
        if (routines.length) out.split = { name: String(tool.input?.splitName || 'Training split').slice(0, 60), routines };
      } catch (_) {}
    } else if (tool?.name === 'suggest_routine_edit') {
      out.suggestion = tool.input;
    }
    if (!out.text && !out.routine && !out.split && !out.suggestion) return null;
    if (!out.text) {
      out.text = out.routine ? `Here's what I'd train today — “${out.routine.name}”.`
               : out.split ? `I'd reshape your week — “${out.split.name}”.`
               : out.suggestion?.rationale || 'Here’s a change worth making.';
    }
    return out;
  } catch (_) { return null; }
}

// Today's cached daily pick (null if none / dismissed / not today).
async function getCachedDaily() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const d = await db.get(STORE, 'coach-daily');
    if (d && d.date === today && d.dismissedDate !== today &&
        (d.text || d.routine || d.split || d.suggestion)) return d;
  } catch (_) {}
  return null;
}

// Ensure today's proactive pick exists (generate once/day if a key is set).
// Returns the daily object or null. `onReady` fires after a fresh generation so
// the Home coach section can refresh in place without blocking first paint.
async function ensureDailySuggestion(onReady) {
  const cached = await getCachedDaily();
  if (cached) return cached;
  if (_dailyBusy) return null;
  if (!(await coachGetKey())) return null;                // no proactive AI without a key
  const today = new Date().toISOString().slice(0, 10);
  const existing = await db.get(STORE, 'coach-daily');
  if (existing?.dismissedDate === today) return null;     // dismissed for today
  if (existing?.date === today) return null;              // already generated (and empty)
  _dailyBusy = true;
  const daily = await generateDailySuggestion(today);
  _dailyBusy = false;
  if (!daily) {
    // Mark today attempted so a failure/empty result doesn't re-fire the API on
    // every subsequent dashboard render. A fresh pick comes tomorrow.
    await db.set(STORE, 'coach-daily', { date: today });
    return null;
  }
  await db.set(STORE, 'coach-daily', daily);
  if (onReady) onReady(daily);
  return daily;
}

function renderDailyCard(daily) {
  const card = document.createElement('div');
  card.className = 'coach-daily';
  card.id = 'coachDailyCard';
  card.innerHTML = `
    <div class="coach-daily-head">
      <span class="coach-daily-eyebrow">${icon('bot', { size: 14 })} Coach's pick for today</span>
      <button class="coach-daily-x" aria-label="Dismiss" title="Dismiss">${icon('x', { size: 15 })}</button>
    </div>
    <div class="coach-daily-body">${esc(daily.text || '')}</div>`;
  if (daily.routine)    card.appendChild(renderRoutineCard(daily.routine));
  if (daily.split)      card.appendChild(renderSplitCard(daily.split));
  if (daily.suggestion) card.appendChild(renderSuggestionCard(daily.suggestion));
  card.querySelector('.coach-daily-x').onclick = async () => {
    const d = (await db.get(STORE, 'coach-daily')) || { date: daily.date };
    d.dismissedDate = new Date().toISOString().slice(0, 10);
    await db.set(STORE, 'coach-daily', d);
    renderDashboard();   // re-render Home so the section reflows
  };
  return card;
}

// Switch to the Coach tab and run a prompt there (used by Home action buttons).
function askCoachFromHome(prompt, force) {
  document.querySelector('.tab[data-tab="Coach"]').click();
  setTimeout(() => sendCoach(prompt, force || false), 60);
}

// ── Weekly review — rule-based, no API needed (this-week vs last-week + balance)
function computeWeeklyReview(sessions) {
  const now = new Date();
  const monday = new Date(now); monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((now.getDay() + 6) % 7));   // back to Monday
  const monMs = monday.getTime();
  const prevMonMs = monMs - 7 * 86400000;

  let cntThis = 0, cntPrev = 0, volThis = 0, pbThis = 0;
  for (const s of sessions) {
    const t = new Date(s.date || s.startTime || 0).getTime();
    if (isNaN(t)) continue;
    if (t >= monMs) {
      cntThis++;
      pbThis += (s.pbs || []).length;
      for (const ex of s.exercises || []) for (const st of ex.sets || [])
        if (st.done) volThis += (st.weight || 0) * (st.reps || 0);
    } else if (t >= prevMonMs) { cntPrev++; }
  }
  if (!cntThis && !cntPrev) return null;   // nothing this or last week — skip the card

  let note = '';
  try {
    const rows = weeklySetsByCategory(sessions, 4).rows || [];
    const low  = rows.filter(r => r.status === 'low').map(r => r.cat);
    const high = rows.filter(r => r.status === 'high').map(r => r.cat);
    if (low.length)  note = `<b>${esc(low[0])}</b> is under 10 sets/wk — add a set or two to bring it up.`;
    else if (high.length) note = `<b>${esc(high[0])}</b> is over 20 sets/wk — you could trim it without losing progress.`;
  } catch (_) {}
  if (!note) {
    note = cntThis >= cntPrev
      ? `On track — <b>${cntThis}</b> session${cntThis === 1 ? '' : 's'} logged this week.`
      : `Down from <b>${cntPrev}</b> last week — a session or two keeps the streak alive.`;
  }
  return { sessions: cntThis, tonnes: +(volThis / 1000).toFixed(1), pbs: pbThis, note, delta: cntThis - cntPrev };
}

function renderWeeklyCard(wk) {
  const card = document.createElement('div');
  card.className = 'dash-weekly';
  card.innerHTML = `
    <span class="dw-eyebrow">${icon('chart-line', { size: 13 })} Weekly review</span>
    <div class="dw-grid">
      <div class="dw-stat"><div class="dw-n ${wk.delta >= 0 ? 'up' : ''}">${wk.sessions}</div><div class="dw-k">sessions</div></div>
      <div class="dw-stat"><div class="dw-n">${wk.tonnes}t</div><div class="dw-k">volume</div></div>
      <div class="dw-stat"><div class="dw-n ${wk.pbs ? 'up' : ''}">${wk.pbs}</div><div class="dw-k">PBs</div></div>
    </div>
    <div class="dw-note">${wk.note}</div>
    <button class="dw-cta">${icon('bot', { size: 15 })} Ask for a full review</button>`;
  card.querySelector('.dw-cta').onclick = () =>
    askCoachFromHome('Give me a full weekly review: what went well, what lagged, and the single most important change for next week — cite my numbers.', false);
  return card;
}

// ── Home "Your coach" section — proactive picks + observations, base of ops ───
// This is where the coach talks TO the user (daily pick + data-driven findings).
// The Coach tab itself is reserved for the user asking direct questions.
async function renderDashCoach(sessions) {
  const el = document.getElementById('dashCoach');
  if (!el) return;
  const dismissed = (await db.get(STORE, 'suggestions-dismissed')) || [];
  const findings = generateCoachFindings(sessions).filter(f => !dismissed.includes(f.key));
  _coachFindings = findings;

  const cachedDaily = await getCachedDaily();
  const weekly = computeWeeklyReview(sessions);
  const hasKey = !!(await coachGetKey());
  // Prompt to unlock the AI coach: shown only when there's no key AND nothing
  // else to show yet, so the user learns why there are no AI picks and how to fix
  // it. (Rule-based observations still appear without a key.)
  const needsKeyHint = !hasKey && !cachedDaily && !findings.length && sessions.length > 0;

  if (!findings.length && !cachedDaily && !needsKeyHint && !weekly) { el.innerHTML = ''; }
  else {
    el.innerHTML = `
      <div class="dash-coach-head">
        <span class="dash-coach-title">${icon('bot', { size: 17 })} Your coach</span>
        <button class="dash-coach-open">Ask →</button>
      </div>
      <div class="dash-coach-cards"></div>`;
    el.querySelector('.dash-coach-open').onclick = () => document.querySelector('.tab[data-tab="Coach"]').click();
    const cards = el.querySelector('.dash-coach-cards');
    if (cachedDaily) cards.appendChild(renderDailyCard(cachedDaily));
    if (weekly)      cards.appendChild(renderWeeklyCard(weekly));
    cards.insertAdjacentHTML('beforeend', findings.map((f, i) => coachFindingCard(f, i)).join(''));
    if (needsKeyHint) {
      const hint = document.createElement('div');
      hint.className = 'coach-finding';
      hint.style.borderLeftColor = 'var(--purple)';
      hint.innerHTML = `
        <div class="cf-head"><span class="cf-eyebrow" style="color:var(--purple)">AI coach</span></div>
        <div class="cf-body">Add your Anthropic API key to unlock proactive, data-driven picks here each day — an altered session, a split swap, or an observation from your training.</div>
        <div class="cf-actions"><button class="cf-btn cf-btn-primary" id="dashCoachKey">Add API key</button></div>`;
      cards.appendChild(hint);
      hint.querySelector('#dashCoachKey').onclick = async () => {
        document.getElementById('coachKeyInput').value = await coachGetKey();
        document.getElementById('coachKeyModal').classList.add('open');
      };
    }
    wireFindingButtons(cards);
    refreshIcons();
  }

  // Kick off today's AI pick in the background (only while actually viewing Home,
  // so a background dashboard re-render off-tab doesn't fire the API); refresh the
  // section in place when it lands.
  if (activeTab === 'Dashboard') {
    ensureDailySuggestion(() => { if (activeTab === 'Dashboard') renderDashCoach(sessions); });
  }
}

// Wire finding action buttons (shared by Home; findings live in _coachFindings).
function wireFindingButtons(root) {
  root.querySelectorAll('.cf-btn').forEach(btn => {
    btn.onclick = async () => {
      const f = _coachFindings[+btn.dataset.fi];
      const a = f?.actions?.[+btn.dataset.ai];
      if (!a) return;
      if (a.kind === 'dismiss') {
        await dismissSuggestion(f.key);
        renderDashboard();
        return;
      }
      if (a.kind === 'open') { openExerciseDetail(a.exercise); return; }
      askCoachFromHome(a.prompt, a.force || false);
    };
  });
}

function scrollCoachDown() {
  const t = document.getElementById('coachThread');
  requestAnimationFrame(() => { t.scrollTop = t.scrollHeight; });
}

function renderCoachMessage(m) {
  const wrap = document.createElement('div');
  wrap.style.display = 'contents';
  if (m.text) {
    const b = document.createElement('div');
    b.className = 'coach-msg ' + (m.role === 'user' ? 'user' : 'bot') + (m.error ? ' err' : '');
    b.textContent = m.text;
    // Truncated answer: a hairline note so the user knows to ask for the rest.
    if (m.incomplete) {
      const note = document.createElement('div');
      note.className = 'coach-cut';
      note.textContent = '⚠︎ cut off — ask me to continue';
      b.appendChild(note);
    }
    wrap.appendChild(b);
  }
  if (m.routine) wrap.appendChild(renderRoutineCard(m.routine));
  if (m.split)   wrap.appendChild(renderSplitCard(m.split));
  if (m.action)  wrap.appendChild(renderActionCard(m.action));
  if (m.suggestion) wrap.appendChild(renderSuggestionCard(m.suggestion));
  return wrap;
}

// ── Coach routine-improvement suggestion (analyse → apply with one tap) ───────
function describeOp(op) {
  const n = esc(op.newExercise || ''), e = esc(op.exercise || '');
  if (op.action === 'replace')  return `Swap <b>${e}</b> → <b>${n}</b>`;
  if (op.action === 'add')      return `Add <b>${n}</b> (${op.sets || 3}×${op.reps || 10})`;
  if (op.action === 'remove')   return `Remove <b>${e}</b>`;
  if (op.action === 'set_reps') return `<b>${e}</b> → ${op.sets ? op.sets + '×' : ''}${op.reps || ''} reps`;
  return esc(op.action || '');
}

function renderSuggestionCard(sug) {
  const card = document.createElement('div');
  card.className = 'coach-suggestion';
  const ops = (sug.operations || []).map(describeOp).join('<br>');
  card.innerHTML = `
    <div class="coach-sugg-head">${icon('zap', { size: 15 })} Suggested change · ${esc(sug.routine || '')}</div>
    <div class="coach-sugg-body">${ops || '—'}</div>
    <div class="coach-routine-btns">
      <button class="cr-start cs-apply">✓ Apply to routine</button>
      <button class="cr-save cs-dismiss">Dismiss</button>
    </div>`;
  card.querySelector('.cs-apply').onclick = async ev => {
    const btn = ev.currentTarget; btn.disabled = true;
    const ok = await applyRoutineEdit(sug);
    btn.textContent = ok ? '✓ Applied' : "Couldn't find that routine";
    if (ok) card.querySelector('.cs-dismiss')?.remove();
  };
  card.querySelector('.cs-dismiss').onclick = () => card.remove();
  return card;
}

async function applyRoutineEdit(sug) {
  const templates = await getTemplates();
  const wanted = String(sug?.routine || '').toLowerCase();
  const t = templates.find(x => x.name.toLowerCase() === wanted)
         || templates.find(x => x.name.toLowerCase().includes(wanted) && wanted);
  if (!t) return false;
  t.exercises ||= [];
  const findEx = name => {
    const n = String(name || '').toLowerCase();
    return t.exercises.find(e => e.name.toLowerCase() === n)
        || t.exercises.find(e => n && e.name.toLowerCase().includes(n));
  };
  const catOf = (name, cat) => CATEGORIES.includes(cat) ? cat : guessCategory(name || '');
  for (const op of (sug.operations || [])) {
    if (op.action === 'replace' && op.newExercise) {
      const ex = findEx(op.exercise);
      if (ex) { ex.name = op.newExercise; ex.category = catOf(op.newExercise, op.category);
                ensureExercisesInRepo([{ name: ex.name, category: ex.category }]); }
    } else if (op.action === 'add' && op.newExercise) {
      const sets = Math.max(1, op.sets || 3), reps = op.reps || 10;
      const category = catOf(op.newExercise, op.category);
      t.exercises.push({ name: op.newExercise, category, restTime: 90,
        sets: Array.from({ length: sets }, () => ({ weight: 0, reps, type: 'normal' })) });
      ensureExercisesInRepo([{ name: op.newExercise, category }]);
    } else if (op.action === 'remove') {
      const ex = findEx(op.exercise);
      if (ex) t.exercises = t.exercises.filter(e => e !== ex);
    } else if (op.action === 'set_reps') {
      const ex = findEx(op.exercise);
      if (ex) {
        const n = Math.max(1, op.sets || ex.sets?.length || 3), reps = op.reps || ex.sets?.[0]?.reps || 10;
        ex.sets = Array.from({ length: n }, (_, k) => ({ ...(ex.sets?.[k] || { weight: 0, type: 'normal' }), reps }));
      }
    }
  }
  await db.set(STORE, 'templates', templates);
  renderDashboard();
  return true;
}

// Confirmation card for an action the coach performed (add exercises / log workouts).
function renderActionCard(action) {
  const card = document.createElement('div');
  card.className = 'coach-action';
  card.innerHTML = `
    <div class="coach-action-head">${icon('circle-check', { size: 16 })} ${esc(action.title)}</div>
    ${action.items?.length ? `<ul class="coach-action-list">${action.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}`;
  return card;
}

// ── Coach actions (executed client-side; the model just requests them) ────────
async function coachAddExercises(input) {
  const reqs = (Array.isArray(input?.exercises) ? input.exercises : [])
    .map(e => ({
      name: String(e?.name || '').trim(),
      category: CATEGORIES.includes(e?.category) ? e.category : guessCategory(String(e?.name || '')),
    }))
    .filter(e => e.name);
  const before = ((await db.get(STORE, 'exercises-custom')) || []).length;
  await ensureExercisesInRepo(reqs);
  const added = ((await db.get(STORE, 'exercises-custom')) || []).length - before;
  if (activeTab === 'Library') renderLibrary();
  return {
    text: added ? `Done — added ${added} exercise${added === 1 ? '' : 's'} to your library.`
                : `Those are already in your library.`,
    summary: { title: `Added ${added} exercise${added === 1 ? '' : 's'} to your library`,
               items: reqs.map(e => `${e.name} · ${e.category}`) },
  };
}

async function coachLogWorkouts(input) {
  const wos = Array.isArray(input?.workouts) ? input.workouts : [];
  const saved = [];
  for (const w of wos) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(w?.date || '') ? w.date : new Date().toISOString().slice(0, 10);
    const dur  = Math.max(0, Math.round((parseFloat(w?.durationMin) || 0) * 60));
    const exercises = (Array.isArray(w?.exercises) ? w.exercises : []).map(e => {
      const name = String(e?.name || '').trim() || 'Exercise';
      const category = CATEGORIES.includes(e?.category) ? e.category : guessCategory(name);
      const sets = (Array.isArray(e?.sets) ? e.sets : []).map(s => ({
        id: uid(), type: ['warmup', 'dropset'].includes(s?.type) ? s.type : 'normal',
        weight: Math.max(0, Number(s?.weight) || 0), reps: Math.max(0, parseInt(s?.reps) || 0), done: true,
      }));
      return { id: uid(), name, category, logType: exLogType(name, category), notes: '', restTime: 60,
               sets: sets.length ? sets : [{ id: uid(), type: 'normal', weight: 0, reps: 0, done: true }] };
    });
    if (!exercises.length) continue;
    const session = {
      id: uid(), title: String(w?.title || 'Workout').slice(0, 60), date,
      startTime: `${date}T12:00:00`, endTime: `${date}T12:00:00`, duration: dur,
      exercises, pbs: [],
    };
    await db.set(STORE, 'session-' + session.id, session);
    await ensureExercisesInRepo(exercises);
    saved.push(`${session.title} · ${fmtDate(date)}`);
  }
  renderDashboard();
  renderHistory();   // reflect coach-backfilled sessions on the History list…
  renderStats();     // …and on the calendar/stats immediately
  if (saved.length) db.backup();
  return {
    text: saved.length ? `Done — logged ${saved.length} workout${saved.length === 1 ? '' : 's'} to your history.`
                       : `I couldn't log those — no exercises were provided.`,
    summary: { title: `Logged ${saved.length} workout${saved.length === 1 ? '' : 's'}`, items: saved },
  };
}

function renderRoutineCard(routine) {
  const card = document.createElement('div');
  card.className = 'coach-routine';
  card.innerHTML = `
    <div class="coach-routine-name">${esc(routine.name)}</div>
    ${routine.exercises.map(e => `
      <div class="coach-routine-ex"><b>${esc(e.name)}</b><span>${e.sets.length}×${e.sets[0]?.reps ?? ''}${e.category === 'Cardio' ? ' min' : ''}</span></div>
    `).join('')}
    <div class="coach-routine-btns">
      <button class="cr-start">${icon('play', { size: 15 })} Start workout</button>
      <button class="cr-save">${icon('plus', { size: 15 })} Save as routine</button>
    </div>`;
  card.querySelector('.cr-start').onclick = () => { startEmptyWorkout(routine); };
  card.querySelector('.cr-save').onclick  = () => saveTemplate(routine.name, routine.exercises);
  return card;
}

// A full multi-day split: each day previewed, saved as routines in one tap.
function renderSplitCard(split) {
  const card = document.createElement('div');
  card.className = 'coach-routine coach-split';
  const routines = split.routines || [];
  card.innerHTML = `
    <div class="coach-routine-name">${icon('layout-dashboard', { size: 15 })} ${esc(split.name)} · ${routines.length} days</div>
    ${routines.map(r => `
      <div class="coach-split-day">
        <div class="coach-split-day-name">${esc(r.name)}</div>
        <div class="coach-split-day-ex">${r.exercises.map(e => esc(e.name)).join(' · ')}</div>
      </div>
    `).join('')}
    <div class="coach-routine-btns">
      <button class="cr-save cs-save-all">${icon('plus', { size: 15 })} Save all ${routines.length} routines</button>
    </div>`;
  card.querySelector('.cs-save-all').onclick = async ev => {
    const btn = ev.currentTarget; btn.disabled = true;
    const templates = await getTemplates();
    for (const r of routines) {
      templates.push({
        id: uid(), name: r.name,
        exercises: r.exercises.map(e => ({
          name: e.name, category: e.category, restTime: e.restTime ?? 60, logType: resolveLogType(e),
          sets: e.sets.map(s => ({ weight: s.weight, reps: s.reps, distance: s.distance || 0, duration: s.duration || 0, type: s.type })),
        })),
      });
    }
    await db.set(STORE, 'templates', templates);
    db.backup();
    renderDashboard();
    btn.textContent = `✓ Saved ${routines.length} routines`;
  };
  return card;
}

const COACH_ERRORS = {
  nokey:       'The coach isn\'t set up yet — add your Anthropic API key (tap 🔑 below) or deploy the coach service.',
  unavailable: 'The coach service is unavailable right now. Add your own API key (🔑) as a fallback, or try again shortly.',
  auth:        'That API key was rejected (401). Tap 🔑 to update it.',
  ratelimit:   'Rate limited — wait a moment and try again.',
  network:     'Network error — check your connection and try again.',
  toolarge:    'That request was too large. Try a shorter message.',
  empty:       'The coach didn\'t send anything back that time. Give it another go.',
  api:         'The AI service returned an error. Try again shortly.',
};
// Errors worth a one-tap retry (transient / no user action needed).
const COACH_RETRYABLE = new Set(['unavailable', 'ratelimit', 'network', 'empty', 'api']);

async function sendCoach(text, forceTool = false) {
  if (coachBusy) return;
  text = text.trim();
  if (!text) return;
  lastCoachSend = { text, forceTool };
  await loadCoachThread();

  const available = await coachHasTransport();
  const thread = document.getElementById('coachThread');
  if (thread.querySelector('.coach-empty') || thread.querySelector('.coach-findings')) thread.innerHTML = '';

  // user bubble
  const userMsg = { role: 'user', text };
  coachThread.push(userMsg);
  thread.appendChild(renderCoachMessage(userMsg));
  persistCoachThread();
  document.getElementById('coachInput').value = '';
  scrollCoachDown();

  if (!available) {
    pushCoachError('nokey');
    return;
  }

  // typing indicator
  coachBusy = true;
  const typing = document.createElement('div');
  typing.className = 'coach-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  thread.appendChild(typing);
  scrollCoachDown();

  // Live streaming bubble: swap the typing dots for a growing text bubble as soon
  // as the first token arrives (tool-only replies keep the dots until the card).
  const streamMsg = document.createElement('div');
  streamMsg.className = 'coach-msg bot streaming';
  let streamText = '', streamStarted = false;
  const onDelta = chunk => {
    if (!chunk) return;
    if (!streamStarted) { streamStarted = true; typing.remove(); thread.appendChild(streamMsg); }
    streamText += chunk;
    streamMsg.textContent = streamText;
    scrollCoachDown();
  };

  try {
    const system = await assembleContext({
      loadSessions: loadSessionsCanonical, getTemplates, getAllExercises, getStreakSettings,
      getProfile: getCoachProfile, getBodyStats: getCoachBodyStats, getNutritionToday,
    });
    const apiMessages = coachThread.map(m =>
      m.role === 'assistant'
        ? { role: 'assistant', content: m.text
            || (m.routine ? `[Drafted routine: ${m.routine.name}]` : '')
            || (m.split ? `[Drafted split: ${m.split.name} — ${(m.split.routines||[]).map(r=>r.name).join(', ')}]` : '')
            || (m.action ? `[${m.action.title}]` : '')
            || '' }   // empty → dropped by sanitizeMessages (no more '…' placeholders)
        : { role: 'user', content: m.text }
    );
    const result = await callCoach({ apiMessages, system, forceTool, getKey: coachGetKey, onDelta });
    typing.remove();
    streamMsg.remove();   // re-rendered properly below (with cards/markup)

    if (result.error) { pushCoachError(result.error, true); coachBusy = false; return; }

    const botMsg = await buildCoachBotMsg(result);
    if (!botMsg) {
      // Genuinely nothing usable came back — offer a retry, never a dead "(no response)".
      pushCoachError('empty', true);
      coachBusy = false;
      return;
    }
    coachThread.push(botMsg);
    thread.appendChild(renderCoachMessage(botMsg));
    persistCoachThread();
    scrollCoachDown();
  } catch (_) {
    typing.remove();
    streamMsg.remove();
    pushCoachError('network', true);
  }
  coachBusy = false;
}

// Turn a callCoach result into a renderable assistant message, executing any tool
// the model called (draft/split/edit/log/add/profile). Returns null when the
// result carries nothing usable (caller shows a retryable error). Shared by
// sendCoach and resendCoach so the two paths never drift.
async function buildCoachBotMsg(result) {
  const botMsg = { role: 'assistant', text: result.text || '' };
  if (result.incomplete) botMsg.incomplete = true;
  const tool = result.tool;
  if (tool?.name === 'set_coach_profile') {
    const res = await coachSetProfile(tool.input);
    botMsg.action = res.summary;
    if (!botMsg.text) botMsg.text = res.text;
  } else if (tool?.name === 'draft_routine') {
    try {
      botMsg.routine = await validateRoutine(tool.input, { getAllExercises, guessCategory });
      if (!botMsg.text) botMsg.text = `Here's a routine — “${botMsg.routine.name}”:`;
    } catch (_) {
      if (!botMsg.text) botMsg.text = "I drafted something but couldn't structure it — try rephrasing.";
    }
  } else if (tool?.name === 'add_library_exercises') {
    const res = await coachAddExercises(tool.input);
    botMsg.action = res.summary;
    if (!botMsg.text) botMsg.text = res.text;
  } else if (tool?.name === 'log_workouts') {
    const res = await coachLogWorkouts(tool.input);
    botMsg.action = res.summary;
    if (!botMsg.text) botMsg.text = res.text;
  } else if (tool?.name === 'suggest_routine_edit') {
    botMsg.suggestion = tool.input;
    if (!botMsg.text) botMsg.text = tool.input?.rationale || 'Here’s a change I’d suggest:';
  } else if (tool?.name === 'draft_split') {
    try {
      const days = Array.isArray(tool.input?.days) ? tool.input.days : [];
      const routines = [];
      for (const d of days) {
        try { routines.push(await validateRoutine(d, { getAllExercises, guessCategory })); } catch (_) {}
      }
      if (routines.length) {
        botMsg.split = { name: String(tool.input?.splitName || 'Training split').slice(0, 60), routines };
        if (!botMsg.text) botMsg.text = `Here's a ${routines.length}-day split — “${botMsg.split.name}”:`;
      } else if (!botMsg.text) {
        botMsg.text = "I planned a split but couldn't structure it — try rephrasing.";
      }
    } catch (_) {
      if (!botMsg.text) botMsg.text = "I planned a split but couldn't structure it — try rephrasing.";
    }
  }
  if (!botMsg.text && !botMsg.routine && !botMsg.split && !botMsg.action && !botMsg.suggestion) return null;
  return botMsg;
}

function pushCoachError(code, allowRetry = false) {
  const msg = { role: 'assistant', text: COACH_ERRORS[code] || COACH_ERRORS.api, error: true };
  coachThread.push(msg);
  const thread = document.getElementById('coachThread');
  const el = renderCoachMessage(msg);
  thread.appendChild(el);
  // Offer a one-tap Retry for transient failures (ephemeral — not persisted).
  if (allowRetry && COACH_RETRYABLE.has(code) && lastCoachSend) {
    const retry = document.createElement('button');
    retry.className = 'coach-retry';
    retry.innerHTML = `${icon('refresh-cw', { size: 14 })} Retry`;
    retry.onclick = () => {
      retry.remove();
      const { text, forceTool } = lastCoachSend;
      // Drop the failed user turn's echo won't happen — resend re-adds a bubble;
      // instead re-run the same request without duplicating the user message.
      resendCoach(text, forceTool);
    };
    thread.appendChild(retry);
  }
  persistCoachThread();
  scrollCoachDown();
}

// Retry the last request WITHOUT re-appending the user's bubble (it's already in
// the thread). Mirrors sendCoach's send path but skips pushing a new user turn.
async function resendCoach(text, forceTool = false) {
  if (coachBusy) return;
  const key = await coachGetKey();
  let token = null;
  try { token = (await supabase.auth.getSession())?.data?.session?.access_token || null; } catch (_) {}
  if (!key && !token) { pushCoachError('nokey'); return; }
  const thread = document.getElementById('coachThread');
  coachBusy = true;
  const typing = document.createElement('div');
  typing.className = 'coach-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  thread.appendChild(typing);
  scrollCoachDown();

  const streamMsg = document.createElement('div');
  streamMsg.className = 'coach-msg bot streaming';
  let streamText = '', streamStarted = false;
  const onDelta = chunk => {
    if (!chunk) return;
    if (!streamStarted) { streamStarted = true; typing.remove(); thread.appendChild(streamMsg); }
    streamText += chunk; streamMsg.textContent = streamText; scrollCoachDown();
  };

  try {
    const system = await assembleContext({
      loadSessions: loadSessionsCanonical, getTemplates, getAllExercises, getStreakSettings,
      getProfile: getCoachProfile, getBodyStats: getCoachBodyStats, getNutritionToday,
    });
    const apiMessages = coachThread
      .filter(m => !m.error)
      .map(m => m.role === 'assistant'
        ? { role: 'assistant', content: m.text
            || (m.routine ? `[Drafted routine: ${m.routine.name}]` : '')
            || (m.split ? `[Drafted split: ${m.split.name}]` : '')
            || (m.action ? `[${m.action.title}]` : '') || '' }
        : { role: 'user', content: m.text });
    const result = await callCoach({ apiMessages, system, forceTool, getKey: coachGetKey, onDelta });
    typing.remove(); streamMsg.remove();
    if (result.error) { pushCoachError(result.error, true); coachBusy = false; return; }
    const botMsg = await buildCoachBotMsg(result);
    if (!botMsg) { pushCoachError('empty', true); coachBusy = false; return; }
    coachThread.push(botMsg);
    thread.appendChild(renderCoachMessage(botMsg));
    persistCoachThread();
    scrollCoachDown();
  } catch (_) {
    typing.remove(); streamMsg.remove();
    pushCoachError('network', true);
  }
  coachBusy = false;
}

// ── Coach wiring ──────────────────────────────────────────────────────────────
document.getElementById('coachSend').onclick = () => sendCoach(document.getElementById('coachInput').value);
document.getElementById('coachInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sendCoach(e.target.value); }
});
document.querySelectorAll('.coach-chip[data-prompt]').forEach(chip => {
  // data-force may be "1" (force draft_routine) or a specific tool name.
  chip.onclick = () => sendCoach(chip.dataset.prompt, chip.dataset.force || false);
});
document.getElementById('coachClearBtn').onclick = async () => {
  if (!confirm('Clear the coach chat?')) return;
  coachThread = [];
  await db.set('workout', 'coach-thread', []);
  renderCoach();
};
document.getElementById('coachKeyBtn').onclick = async () => {
  document.getElementById('coachKeyInput').value = await coachGetKey();
  document.getElementById('coachKeyModal').classList.add('open');
};
document.getElementById('coachKeyCancel').onclick = () => document.getElementById('coachKeyModal').classList.remove('open');
document.getElementById('coachKeyModal').addEventListener('click', e => {
  if (e.target === document.getElementById('coachKeyModal')) document.getElementById('coachKeyModal').classList.remove('open');
});
document.getElementById('coachKeySave').onclick = async () => {
  await db.set('workout', 'anthropic-key', document.getElementById('coachKeyInput').value.trim());
  document.getElementById('coachKeyModal').classList.remove('open');
  backfillCustomRepRanges(); // key just added — retry any exercises that had no range yet
  renderDashboard();         // a fresh key unlocks the proactive daily pick on Home
};

// ── Coach profile sheet wiring ────────────────────────────────────────────────
document.getElementById('coachMem').onclick = openCoachProfile;
document.getElementById('cpCancel').onclick = closeCoachProfile;
document.getElementById('coachProfileModal').addEventListener('click', e => {
  if (e.target === document.getElementById('coachProfileModal')) closeCoachProfile();
});
document.querySelectorAll('#cpExp button').forEach(b => b.onclick = () => {
  const on = b.classList.contains('on');
  document.querySelectorAll('#cpExp button').forEach(x => x.classList.remove('on'));
  if (!on) b.classList.add('on');   // tap again to clear
});
document.getElementById('cpDaysMinus').onclick = () => {
  cpDays = Math.max(0, cpDays - 1);
  document.getElementById('cpDaysVal').textContent = cpDays || '—';
};
document.getElementById('cpDaysPlus').onclick = () => {
  cpDays = Math.min(14, (cpDays || 0) + 1);
  document.getElementById('cpDaysVal').textContent = cpDays;
};
function addCpInjury() {
  const inp = document.getElementById('cpInjInput');
  const v = inp.value.trim();
  if (!v) return;
  cpInjuries.push(v); inp.value = ''; renderCpInjuries();
}
document.getElementById('cpInjAdd').onclick = addCpInjury;
document.getElementById('cpInjInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addCpInjury(); }
});
document.getElementById('cpSave').onclick = saveCoachProfileSheet;

// ── Init ──────────────────────────────────────────────────────────────────────
// Wait for the cloud restore BEFORE the first render / seeding, so a reinstalled
// app (empty IndexedDB) shows its real history instead of looking wiped — and so
// seedMyRoutinesOnce sees the restored `my-routines-seeded` flag and doesn't
// re-seed. Cap the wait so we never hang offline; if the pull lands after the
// cap, re-render then. A brief "restoring…" note reassures during the wait.
if (document.getElementById('recentList')) {
  document.getElementById('recentList').innerHTML =
    `<div style="display:flex;align-items:center;gap:6px;justify-content:center;color:var(--text-muted);font-size:0.8rem;padding:6px 0 12px">${icon('refresh-cw', { size: 13 })} Restoring your data…</div>` + skeletonCards(3);
}
try { await Promise.race([restore, new Promise(r => setTimeout(r, 12000))]); } catch (_) {}

await loadExOverrides();   // library edits (exercise types/categories) before any render
await loadExAliases();     // exercise identity merges — before any history render
await seedMyRoutinesOnce();
await fixIncompletePushDayOnce();
await checkForAbandonedSession();
refreshIcons();   // paint the static tab-bar / header / chip icon placeholders

// Account panel (Progress → Data & backup) — auth lives in Arc now.
{
  const emailEl = document.getElementById('acctEmail');
  if (emailEl && session?.user?.email) emailEl.textContent = session.user.email;
  document.getElementById('signOutBtn')?.addEventListener('click', async () => {
    await supabase.auth.signOut();   // getSession() is null on reload → auth gate shows
    location.reload();
  });
}

renderDashboard();
renderHistory();
backfillCustomRepRanges(); // background — fills in AI rep ranges for any custom exercise missing one

// If the cloud pull finished AFTER the cap (slow network), refresh once it lands.
restore.then(n => { if (n) { renderDashboard(); renderHistory(); renderStats(); } }).catch(() => {});

autoBackupIfStale();   // mirror local → cloud on open, throttled to ~6h
