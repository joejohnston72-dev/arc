import { supabase }                     from '../shared/supabase.js';
import db, { initialSync }              from '../shared/db.js';
import { EXERCISES, CATEGORIES, CATEGORY_COLORS } from './exercises.js';
import { resolveCues } from './cues.js';
import { ROUTINE_LIBRARY } from './routineLibrary.js';
import { MY_ROUTINES } from './myRoutines.js';
import { buildRecords, detectPBs, absorbSet, e1RM,
         getStreakSettings, saveStreakSettings, computeStreak, computeMilestones } from './achievements.js';
import { lifetimeTotals, weeklyVolumeHTML, muscleBalanceHTML,
         exerciseFrequency, progressionHTML, monthlyViewHTML } from './stats.js';
import { assembleContext, callCoach, validateRoutine } from './coach.js';
import { resolveRepRange, fetchAIRepRange } from './repRanges.js';
import { icon, renderIcons } from '../shared/icons.js';

// Paint any static/dynamic `<i data-lucide>` placeholders. Cheap + idempotent,
// so it's safe to call after every render that may inject new icon markup.
const refreshIcons = () => renderIcons(document);

// ── Auth guard ────────────────────────────────────────────────────────────────
const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.href = '../'; throw new Error('unauthenticated'); }

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

// ── Exercise tracking types ───────────────────────────────────────────────────
// Which fields a set records. 'time' is stored in set.duration (seconds),
// 'distance' in set.distance (km). weight/reps as before.
const LOGTYPES = {
  weighted:   { cols: ['weight', 'reps'],     head: ['kg', 'Reps'],  label: 'Weight & reps' },
  bodyweight: { cols: ['reps'],               head: ['Reps'],        label: 'Reps only (bodyweight)' },
  duration:   { cols: ['time'],               head: ['Time'],        label: 'Time / hold' },
  cardio:     { cols: ['distance', 'time'],   head: ['km', 'Time'],  label: 'Distance & time (cardio)' },
};
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
let restFiredChime = false;

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
    if (activeTab === 'Library')   { renderLibrary();   }
    if (activeTab === 'Stats')     { renderStats(); renderHistory(); }
    if (activeTab === 'Coach')     { renderCoach();     }
  };
});

// ── Workout start / open ──────────────────────────────────────────────────────
document.getElementById('startEmptyBtn').onclick = () => startEmptyWorkout();
document.getElementById('newRoutineBtn').onclick = () => startNewRoutine();

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
  '#libraryDetail.visible, #historyDetail.visible, #workoutSummary.visible, .modal-backdrop.open';
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
function buildSetRow(ex, ei, set) {
  const si = ex.sets.indexOf(set);
  const lt = resolveLogType(ex);
  const cfg = LOGTYPES[lt];
  const prev = ex.prevSets?.[si] ?? null;
  const tr = document.createElement('tr');
  tr.className = 'set-row'
    + (set.done ? ' done' : '')
    + (set.type === 'warmup' ? ' set-warmup' : '')
    + (set.type === 'dropset' ? ' set-dropset' : '');
  tr.dataset.ei = ei;
  tr.dataset.setId = set.id;
  tr.innerHTML = `
    <td class="set-num" title="Tap to cycle: warm-up → drop set → normal">${si + 1}</td>
    ${cfg.cols.map(c => setInputCell(c, set, ex, ei, prev)).join('')}
    <td class="set-check-cell"><button class="set-check" data-ei="${ei}" data-set-id="${set.id}">${set.done ? icon('check', { size: 16 }) : ''}</button></td>
  `;
  return tr;
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
      <div class="ex-name">${esc(ex.name)}</div>
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

// ── Delegated listeners (bound ONCE — never rebound on render) ────────────────
awBody.addEventListener('input', e => {
  const t = e.target;
  if (t.classList.contains('set-input')) {
    const { ei, setId, field } = t.dataset;
    const { ex, set } = findSet(ei, setId);
    if (!set) return;
    if (field === 'reps')          set.reps = parseInt(t.value) || 0;
    else if (field === 'distance') set.distance = parseFloat(t.value) || 0;
    else if (field === 'time')     { const m = maskTime(t.value); t.value = m.text; set.duration = m.secs; }
    else                           set[field] = parseFloat(t.value) || 0;   // weight
    (set.touched ||= {})[field] = true;
    if (field === 'weight') queueSanityCheck(ex, set, t.closest('.set-row'));
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
        row.classList.toggle('set-warmup',  set.type === 'warmup');
        row.classList.toggle('set-dropset', set.type === 'dropset');
        saveSoon();
      }
    }
    return;
  }
  // Tap the exercise name for a quick history peek (last sessions of this lift).
  const nameEl = e.target.closest('.ex-name');
  if (nameEl) { openExerciseHistorySheet(nameEl.textContent); return; }
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

function toggleSetDone(ei, setId, rowEl) {
  const { ex, set, si } = findSet(ei, setId);
  if (!set) return;
  set.done = !set.done;

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
        if (nWeight && !next.touched?.weight && set.weight) { next.weight = set.weight; nWeight.value = set.weight; }
        const target = nextRow?.querySelector('[data-field="reps"]') || nWeight;
        if (target) { target.focus({ preventScroll: true }); try { target.select(); } catch(_) {} }
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
    if (set.done && res.pbBySet.has(set.id)) showPbToast(res.pbBySet.get(set.id));
  }
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
    if (found.length) { pbs.push(...found); pbSetIds.add(set.id); pbBySet.set(set.id, found[0]); }
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
  const row = awBody.querySelector(`.set-row[data-set-id="${setId}"]`);
  row?.classList.toggle('set-dropset', set.type === 'dropset');
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

function showWorkoutSummary() {
  skipRest();
  refreshAllPBs();   // ensure the PB count reflects the final, corrected numbers
  const title = document.getElementById('awTitle').value.trim() || 'Workout';
  activeSession.title = title;

  const doneSets = activeSession.exercises.flatMap(e => e.sets.filter(s => s.done));
  const volume   = doneSets.reduce((s, set) => s + (set.weight || 0) * (set.reps || 1), 0);
  const exCount  = activeSession.exercises.length;
  const pbCount  = activeSession.pbs?.length || 0;

  document.getElementById('summaryTitle').textContent = title;
  document.getElementById('summaryDate').textContent  = new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'});
  document.getElementById('summaryStats').innerHTML = `
    <div class="stat-box"><div class="stat-val">${fmtTime(sessionSecsNow())}</div><div class="stat-label">Duration</div></div>
    <div class="stat-box"><div class="stat-val">${doneSets.length}</div><div class="stat-label">Sets</div></div>
    <div class="stat-box"><div class="stat-val">${Math.round(volume).toLocaleString()}</div><div class="stat-label">Volume kg</div></div>
    <div class="stat-box"><div class="stat-val">${pbCount ? `<span style="color:var(--amber);display:inline-flex;vertical-align:-0.15em">${icon('trophy', { size: 17 })}</span> ` + pbCount : '—'}</div><div class="stat-label">PBs</div></div>
  `;

  const warnings = finishWarnings();
  const warnIcon = `<span style="color:var(--amber);display:inline-flex;vertical-align:-0.2em;margin-right:4px">${icon('triangle-alert', { size: 15 })}</span>`;
  document.getElementById('summaryWarnings').innerHTML = warnings.length
    ? `<div class="summary-warn-box">${warnings.map(w => warnIcon + esc(w)).join('<br>')}<br><span>Check before saving, or save anyway.</span></div>`
    : '';

  document.getElementById('summaryExercises').innerHTML =
    activeSession.exercises.map(e =>
      `${esc(e.name)} — ${e.sets.filter(s=>s.done).length} sets`
    ).join('<br>');

  document.getElementById('workoutSummary').classList.add('visible');
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
}

function skipRest() {
  clearInterval(restTimer);
  restEndsAt = null;
  const bar = document.getElementById('restBar');
  bar?.classList.remove('visible', 'flash', 'done-state');
  db.set(STORE, 'active-rest', null);
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
    await initialSync.catch(() => {});   // never race the initial restore
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
  return [...EXERCISES, ...custom.map(e => ({ ...e, custom: true }))];
}

document.getElementById('awAddExBtn').onclick   = () => openExPicker();
document.getElementById('epCancel').onclick     = closeExPicker;

function openExPicker(opts = {}) {
  epFilter = 'All';
  epReplaceEi = opts.replaceEi ?? null;
  document.getElementById('epSearch').value = '';
  document.getElementById('epSearch').placeholder = epReplaceEi !== null
    ? `Replace ${activeSession.exercises[epReplaceEi].name}…`
    : 'Search exercises…';
  document.getElementById('exercisePicker').classList.add('visible');
  renderExPicker();
  setTimeout(() => document.getElementById('epSearch').focus(), 150);
}

function closeExPicker() {
  epReplaceEi = null;
  document.getElementById('exercisePicker').classList.remove('visible');
}

document.getElementById('epSearch').oninput = renderExPicker;

async function renderExPicker() {
  const q    = document.getElementById('epSearch').value.toLowerCase();
  const all  = await getAllExercises();
  const cats = ['All', ...CATEGORIES];

  const filtersEl = document.getElementById('epFilters');
  filtersEl.innerHTML = cats.map(c =>
    `<button class="ep-filter ${c === epFilter ? 'active' : ''}" data-cat="${c}">${c}</button>`
  ).join('');
  filtersEl.querySelectorAll('.ep-filter').forEach(btn => {
    btn.onclick = () => { epFilter = btn.dataset.cat; renderExPicker(); };
  });

  const filtered = all.filter(e =>
    (epFilter === 'All' || e.category === epFilter) &&
    (!q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q))
  );

  // "Often picked" replacements for the exercise being swapped out
  let oftenHTML = '';
  if (epReplaceEi !== null && !q && epFilter === 'All') {
    const prefs = (await db.get(STORE, 'replacement-prefs')) || {};
    const orig = activeSession.exercises[epReplaceEi]?.name;
    const ranked = Object.entries(prefs[orig] || {}).sort((a,b) => b[1] - a[1]).slice(0, 5);
    // Sensible fallback: same-category alternatives
    const cat = activeSession.exercises[epReplaceEi]?.category;
    const sameCat = ranked.length ? [] :
      all.filter(e => e.category === cat && e.name !== orig).slice(0, 4).map(e => [e.name, 0]);
    const picks = ranked.length ? ranked : sameCat;
    if (picks.length) {
      const lookup = Object.fromEntries(all.map(e => [e.name, e.category]));
      oftenHTML = `
        <div class="ep-often-head">${ranked.length ? 'Often picked instead' : 'Same muscle group'}</div>
        ${picks.map(([name]) => `
          <div class="ep-item ep-often" data-name="${esc(name)}" data-cat="${esc(lookup[name] || cat)}">
            <span class="ep-cat-pill" style="background:${CATEGORY_COLORS[lookup[name] || cat]||'#8e8e9a'}">${esc(lookup[name] || cat)}</span>
            <span class="ep-ex-name">${esc(name)}</span>
          </div>`).join('')}
        <div class="ep-often-sep"></div>`;
    }
  }

  const listEl = document.getElementById('epList');
  listEl.innerHTML = oftenHTML + filtered.map(e => `
    <div class="ep-item" data-name="${esc(e.name)}" data-cat="${esc(e.category)}">
      <span class="ep-cat-pill" style="background:${CATEGORY_COLORS[e.category]||'#8e8e9a'}">${esc(e.category)}</span>
      <span class="ep-ex-name">${esc(e.name)}</span>
      ${e.custom ? '<span style="font-size:0.65rem;color:var(--text-muted)">Custom</span>' : ''}
    </div>
  `).join('') + `
    <div class="ep-custom-row">
      <button class="ep-custom-btn" id="epAddCustom">+ Create custom exercise</button>
    </div>
  `;

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

  document.getElementById('epAddCustom').onclick = () => {
    closeExPicker();
    openCustomExModal();
  };
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
  renderLibraryList();
  libraryEl.classList.add('visible');
};
document.getElementById('libraryClose').onclick = () => libraryEl.classList.remove('visible');
document.getElementById('libraryDetailBack').onclick = () => libraryDetailEl.classList.remove('visible');

function renderLibraryList() {
  document.getElementById('libraryList').innerHTML = ROUTINE_LIBRARY.map(split => `
    <div class="split-card" data-split="${split.id}">
      <div class="split-name">${esc(split.name)}</div>
      <div class="split-tagline">${esc(split.tagline)}</div>
      <div class="split-meta">${esc(split.meta)}</div>
    </div>
  `).join('');
  document.querySelectorAll('.split-card').forEach(card => {
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
async function renderDashboard() {
  const recentEl0 = document.getElementById('recentList');
  if (recentEl0 && !recentEl0.children.length) recentEl0.innerHTML = skeletonCards(2);
  const templates = await getTemplates();
  const tmplEl = document.getElementById('templatesList');
  document.getElementById('routinesEmpty').style.display = templates.length ? 'none' : '';
  document.getElementById('routinesHint').style.display = templates.length ? '' : 'none';
  tmplEl.innerHTML = templates.map(t => `
    <div class="template-card" data-tid="${t.id}">
      <div>
        <div class="tc-name">${esc(t.name)}</div>
        <div class="tc-ex">${t.exercises.map(e=>esc(e.name)).join(' · ')}</div>
      </div>
    </div>
  `).join('');
  const deleteTemplate = async id => {
    const t = templates.find(x => x.id === id);
    if (!confirm(`Delete routine "${t?.name || ''}"? This can't be undone.`)) return;
    const ts = (await getTemplates()).filter(x => x.id !== id);
    await db.set(STORE, 'templates', ts);
    db.backup();
    renderDashboard();
  };
  tmplEl.querySelectorAll('.template-card').forEach(card => {
    const tid = card.dataset.tid;
    // Long-press guards deletion so routines can't be lost with a stray tap.
    let holdTimer = null, held = false, sx = 0, sy = 0;
    const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; card.classList.remove('tc-holding'); };
    card.addEventListener('pointerdown', e => {
      held = false; sx = e.clientX; sy = e.clientY;
      card.classList.add('tc-holding');
      holdTimer = setTimeout(() => { held = true; card.classList.remove('tc-holding'); deleteTemplate(tid); }, 550);
    });
    card.addEventListener('pointermove', e => {
      if (holdTimer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancelHold();
    });
    card.addEventListener('pointerup', cancelHold);
    card.addEventListener('pointercancel', cancelHold);
    card.addEventListener('click', () => {
      if (held) { held = false; return; } // long-press already handled it
      const t = templates.find(x => x.id === tid);
      startEmptyWorkout(t);
    });
  });

  const sessions = await loadSessions();
  renderStreakChip(sessions);

  const recentEl = document.getElementById('recentList');
  if (!sessions.length) {
    recentEl.innerHTML = `<div class="empty-state">No workouts yet.<br>Tap Start Empty Workout, or restore from cloud in Stats.</div>`;
    return;
  }
  recentEl.innerHTML = sessions.slice(0,5).map(s => workoutCard(s)).join('');
  recentEl.querySelectorAll('.workout-card').forEach(card => {
    card.onclick = () => openHistoryDetail(card.dataset.sid);
  });
}

function workoutCard(s) {
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
      <div class="wc-exercises">${exList}${more}</div>
    </div>`;
}

// ── Stats tab ─────────────────────────────────────────────────────────────────
let statsExercise = null;
let statsMonth = null; // { y, m } — defaults to current month
async function renderStats() {
  const el = document.getElementById('statsBody');
  if (el && !el.children.length) el.innerHTML = statsSkeleton();
  const sessions = await loadSessions();
  if (!sessions.length) {
    el.innerHTML = `<div class="empty-state">No workouts yet — stats appear after your first logged session.</div>`;
    return;
  }
  const chrono = [...sessions].reverse(); // oldest → newest for charts

  const totals = lifetimeTotals(sessions);
  const settings = await getStreakSettings();
  const streak = computeStreak(sessions, settings);
  const miles = computeMilestones(sessions, streak.weeks);
  const pbTotal = sessions.reduce((a, s) => a + (s.pbs?.length || 0), 0);
  const trophies = miles.earned.length + pbTotal;

  const freq = exerciseFrequency(sessions);
  if (!statsExercise && freq.length) statsExercise = freq[0].name;

  const now = new Date();
  if (!statsMonth) statsMonth = { y: now.getFullYear(), m: now.getMonth() };

  el.innerHTML = `
    ${monthlyViewHTML(sessions, statsMonth.y, statsMonth.m)}

    <div class="stats-totals">
      <div class="stat-box"><div class="stat-val">${totals.workouts}</div><div class="stat-label">Workouts</div></div>
      <div class="stat-box"><div class="stat-val">${totals.hours.toFixed(0)}h</div><div class="stat-label">Trained</div></div>
      <div class="stat-box"><div class="stat-val">${(totals.volume/1000).toFixed(1)}t</div><div class="stat-label">Lifted</div></div>
      <div class="stat-box"><div class="stat-val"><span style="color:var(--amber);display:inline-flex;vertical-align:-0.15em">${icon('flame', { size: 17 })}</span> ${streak.weeks}</div><div class="stat-label">Wk streak</div></div>
      <div class="stat-box"><div class="stat-val"><span style="color:var(--amber);display:inline-flex;vertical-align:-0.15em">${icon('trophy', { size: 17 })}</span> ${trophies}</div><div class="stat-label">Trophies</div></div>
    </div>

    ${miles.earned.length ? `
      <div class="stats-card">
        <div class="stats-card-title">Milestones</div>
        <div class="milestone-wrap">${miles.earned.map(m => `<span class="milestone-chip"><span style="color:var(--amber);display:inline-flex;vertical-align:-0.18em">${icon(MILESTONE_ICONS[m.icon] || 'award', { size: 14 })}</span> ${esc(m.label)}</span>`).join('')}</div>
      </div>` : ''}

    ${weeklyVolumeHTML(chrono)}
    ${muscleBalanceHTML(chrono)}

    <div class="stats-card">
      <div class="stats-card-title">Exercise progression</div>
      <select class="form-input" id="statsExSelect" style="margin-bottom:10px">
        ${freq.slice(0, 40).map(f => `<option ${f.name === statsExercise ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
      </select>
      <div id="statsProgression"></div>
    </div>
  `;

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
      statsExercise ? progressionHTML(chrono, statsExercise) : '';
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
  const q = (document.getElementById('histSearch')?.value || '').trim().toLowerCase();
  if (q) {
    sessions = sessions.filter(s =>
      (s.title || '').toLowerCase().includes(q) ||
      (s.exercises || []).some(e => (e.name || '').toLowerCase().includes(q)));
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
  return `${fmtKg(st.weight)} kg × ${st.reps} reps`;
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
  return inp('weight', st.weight || '', 'kg', '0.5', 'decimal') + inp('reps', st.reps || '', 'reps', '1', 'numeric');
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
async function renderLibrary() {
  const q      = document.getElementById('libSearch').value.toLowerCase();
  const libEl0 = document.getElementById('libraryList2');
  if (libEl0 && !libEl0.children.length && !q)
    libEl0.innerHTML = Array.from({ length: 8 }, () =>
      `<div class="skeleton" style="height:44px;margin-bottom:8px;border-radius:10px"></div>`).join('');
  const all    = await getAllExercises();
  const filtered = all.filter(e => !q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q));

  const el = document.getElementById('libraryList2');
  const groups = {};
  filtered.forEach(e => (groups[e.category] = groups[e.category] || []).push(e));

  el.innerHTML = Object.entries(groups).map(([cat, exs]) => `
    <div class="section-heading" style="margin-top:12px">${cat}</div>
    ${exs.map(e => `
      <div class="lib-item" data-cue="${esc(e.name)}">
        <span class="ex-cat-dot" style="background:${CATEGORY_COLORS[cat]||'#8e8e9a'}"></span>
        <span class="lib-name">${esc(e.name)}</span>
        ${resolveCues(e.name) ? `<span class="lib-cue-hint">${icon('info', { size: 12 })} form</span>` : ''}
        ${e.custom ? '<span class="lib-custom-badge">Custom</span>' : ''}
      </div>
    `).join('')}
  `).join('');

  el.querySelectorAll('.lib-item').forEach(item => {
    item.onclick = () => showCues(item.dataset.cue);
  });
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

// Coach API key: workout-store key, falling back to any key previously saved
// under the (now-removed) habits store so it carries over seamlessly.
async function coachGetKey() {
  return (await db.get('workout', 'anthropic-key')) || (await db.get('habits', 'anthropic-key')) || '';
}

async function loadCoachThread() {
  if (!coachThread) coachThread = (await db.get('workout', 'coach-thread')) || [];
  return coachThread;
}
function persistCoachThread() { db.set('workout', 'coach-thread', coachThread); }

async function renderCoach() {
  await loadCoachThread();
  const thread = document.getElementById('coachThread');
  thread.innerHTML = '';
  if (!coachThread.length) {
    thread.innerHTML = `<div class="coach-empty">👋 I'm your training coach.<br>Ask me to draft a routine, plan today's session, review your progress, or answer any form/technique question.</div>`;
  } else {
    coachThread.forEach(m => thread.appendChild(renderCoachMessage(m)));
  }
  scrollCoachDown();
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
  nokey:     'Add your Anthropic API key to use the coach — tap 🔑 below.',
  auth:      'That API key was rejected (401). Tap 🔑 to update it.',
  ratelimit: 'Rate limited — wait a moment and try again.',
  network:   'Network error — check your connection and try again.',
  toolarge:  'That request was too large. Try a shorter message.',
  api:       'The AI service returned an error. Try again shortly.',
};

async function sendCoach(text, forceTool = false) {
  if (coachBusy) return;
  text = text.trim();
  if (!text) return;
  await loadCoachThread();

  const key = await coachGetKey();
  const thread = document.getElementById('coachThread');
  if (thread.querySelector('.coach-empty')) thread.innerHTML = '';

  // user bubble
  const userMsg = { role: 'user', text };
  coachThread.push(userMsg);
  thread.appendChild(renderCoachMessage(userMsg));
  persistCoachThread();
  document.getElementById('coachInput').value = '';
  scrollCoachDown();

  if (!key) {
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

  try {
    const system = await assembleContext({
      loadSessions, getTemplates, getAllExercises, getStreakSettings,
    });
    const apiMessages = coachThread.map(m =>
      m.role === 'assistant'
        ? { role: 'assistant', content: m.text
            || (m.routine ? `[Drafted routine: ${m.routine.name}]` : '')
            || (m.split ? `[Drafted split: ${m.split.name} — ${(m.split.routines||[]).map(r=>r.name).join(', ')}]` : '')
            || '…' }
        : { role: 'user', content: m.text }
    );
    const result = await callCoach({ apiMessages, system, forceTool, getKey: coachGetKey });
    typing.remove();

    if (result.error) { pushCoachError(result.error); coachBusy = false; return; }

    const botMsg = { role: 'assistant', text: result.text || '' };
    const tool = result.tool;
    if (tool?.name === 'draft_routine') {
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
    if (!botMsg.text && !botMsg.routine && !botMsg.split && !botMsg.action && !botMsg.suggestion) botMsg.text = '(no response)';
    coachThread.push(botMsg);
    thread.appendChild(renderCoachMessage(botMsg));
    persistCoachThread();
    scrollCoachDown();
  } catch (_) {
    typing.remove();
    pushCoachError('network');
  }
  coachBusy = false;
}

function pushCoachError(code) {
  const msg = { role: 'assistant', text: COACH_ERRORS[code] || COACH_ERRORS.api, error: true };
  coachThread.push(msg);
  document.getElementById('coachThread').appendChild(renderCoachMessage(msg));
  persistCoachThread();
  scrollCoachDown();
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
};

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
try { await Promise.race([initialSync, new Promise(r => setTimeout(r, 12000))]); } catch (_) {}

await seedMyRoutinesOnce();
await fixIncompletePushDayOnce();
await checkForAbandonedSession();
refreshIcons();   // paint the static tab-bar / header / chip icon placeholders
renderDashboard();
renderHistory();
backfillCustomRepRanges(); // background — fills in AI rep ranges for any custom exercise missing one

// If the cloud pull finished AFTER the cap (slow network), refresh once it lands.
initialSync.then(n => { if (n) { renderDashboard(); renderHistory(); renderStats(); } }).catch(() => {});

autoBackupIfStale();   // mirror local → cloud on open, throttled to ~6h
