// Stats & charts — pure inline-SVG, no libraries.
// All functions take the array of saved session objects and return HTML strings.
import { CATEGORY_COLORS, muscleContributions } from './exercises.js';
import { e1RM, ymd } from './achievements.js';

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const dateOf = s => new Date((s.date || (s.startTime || '').slice(0, 10) || '1970-01-01') + 'T12:00:00');
const workingSets = ex => (ex.sets || []).filter(st => st.done && st.type !== 'warmup');

function mondayOf(d) {
  const x = new Date(d); x.setHours(12, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return ymd(x);
}

const fmtDur = secs => {
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

// ── Monthly view (workouts / time / weight + trained-day calendar) ────────────
// year, monthIndex are 0-based month. Returns HTML with nav buttons
// (#monthPrev / #monthNext) the caller re-wires each render.
export function monthlyViewHTML(sessions, year, monthIdx) {
  const inMonth = sessions.filter(s => {
    const d = dateOf(s);
    return d.getFullYear() === year && d.getMonth() === monthIdx;
  });

  let secs = 0, volume = 0, setCount = 0;
  const trained = {};    // dayOfMonth -> volume (drives the heat shading)
  const workedDay = {};  // dayOfMonth -> true if ANY set was logged (so bodyweight/
                         // cardio-only days still light up, even at 0 kg volume)
  for (const s of inMonth) {
    secs += s.duration || 0;
    const day = dateOf(s).getDate();
    // A session with any completed set, or any exercise at all, counts as trained.
    const hasWork = (s.exercises || []).some(ex => (ex.sets || []).some(st => st.done))
                 || (s.exercises || []).length > 0;
    if (hasWork) workedDay[day] = true;
    for (const ex of s.exercises || []) {
      for (const st of ex.sets || []) {
        if (!st.done) continue;
        setCount++;
        const v = (st.weight || 0) * (st.reps || 1);
        volume += v;
        trained[day] = (trained[day] || 0) + v;
      }
    }
  }

  const monthName = new Date(year, monthIdx, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const now = new Date();
  const isCurrentOrFuture = year > now.getFullYear() || (year === now.getFullYear() && monthIdx >= now.getMonth());

  // Calendar grid, Monday-first
  const firstDow = (new Date(year, monthIdx, 1).getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  const maxVol = Math.max(1, ...Object.values(trained));
  const todayDay = (now.getFullYear() === year && now.getMonth() === monthIdx) ? now.getDate() : -1;

  const pad = n => String(n).padStart(2, '0');
  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += `<div class="cal-cell cal-empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const vol = trained[d] || 0;
    const worked = !!workedDay[d];
    // Shade by volume where there is some; a worked-but-zero-volume day (all
    // bodyweight/cardio) still gets a baseline fill so it reads as trained.
    const intensity = worked ? (vol ? 0.35 + 0.65 * (vol / maxVol) : 0.35) : 0;
    const cls = 'cal-cell cal-clickable' + (worked ? ' cal-trained' : '') + (d === todayDay ? ' cal-today' : '');
    const style = worked ? `style="--i:${intensity.toFixed(2)}"` : '';
    const dateStr = `${year}-${pad(monthIdx + 1)}-${pad(d)}`;
    cells += `<div class="${cls}" data-date="${dateStr}" ${style}><span>${d}</span></div>`;
  }

  return `
    <div class="stats-card month-card">
      <div class="month-nav">
        <button class="month-nav-btn" id="monthPrev">‹</button>
        <span class="month-title">${monthName}</span>
        <button class="month-nav-btn" id="monthNext" ${isCurrentOrFuture ? 'disabled' : ''}>›</button>
      </div>
      <div class="month-totals">
        <div class="month-stat"><div class="month-stat-val">${inMonth.length}</div><div class="month-stat-lbl">Workouts</div></div>
        <div class="month-stat"><div class="month-stat-val">${fmtDur(secs)}</div><div class="month-stat-lbl">Time</div></div>
        <div class="month-stat"><div class="month-stat-val">${(volume/1000).toFixed(1)}t</div><div class="month-stat-lbl">Lifted</div></div>
      </div>
      <div class="cal-dow">${['M','T','W','T','F','S','S'].map(d => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      ${inMonth.length ? `<div class="month-foot">${setCount.toLocaleString()} sets · ${Math.round(volume).toLocaleString()} kg total</div>` : `<div class="month-foot">No workouts logged this month.</div>`}
    </div>`;
}

// ── Lifetime totals ───────────────────────────────────────────────────────────
export function lifetimeTotals(sessions) {
  let volume = 0, sets = 0, secs = 0;
  for (const s of sessions) {
    secs += s.duration || 0;
    for (const ex of s.exercises || []) {
      for (const st of ex.sets || []) {
        if (!st.done) continue;
        sets++;
        volume += (st.weight || 0) * (st.reps || 1);
      }
    }
  }
  return { workouts: sessions.length, hours: secs / 3600, volume, sets };
}

// ── Weekly volume (stacked by muscle group) ───────────────────────────────────
export function weeklyVolumeHTML(sessions, weeksBack = 12) {
  const weeks = []; // oldest → newest
  const start = new Date(); start.setDate(start.getDate() - 7 * (weeksBack - 1));
  for (let i = 0; i < weeksBack; i++) {
    const d = new Date(start); d.setDate(d.getDate() + 7 * i);
    weeks.push(mondayOf(d));
  }
  const byWeek = Object.fromEntries(weeks.map(w => [w, {}]));

  for (const s of sessions) {
    const wk = mondayOf(dateOf(s));
    if (!(wk in byWeek)) continue;
    for (const ex of s.exercises || []) {
      const cat = ex.category || 'Other';
      for (const st of workingSets(ex)) {
        byWeek[wk][cat] = (byWeek[wk][cat] || 0) + (st.weight || 0) * (st.reps || 1);
      }
    }
  }

  const totals = weeks.map(w => Object.values(byWeek[w]).reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1);

  const W = 340, H = 150, pad = 4, bw = (W - pad * 2) / weeksBack;
  let svg = '';
  weeks.forEach((w, i) => {
    let y = H - 18;
    const entries = Object.entries(byWeek[w]).sort((a, b) => b[1] - a[1]);
    for (const [cat, vol] of entries) {
      const h = (vol / max) * (H - 30);
      y -= h;
      svg += `<rect x="${pad + i * bw + 1}" y="${y}" width="${bw - 2}" height="${h}" rx="1.5" fill="${CATEGORY_COLORS[cat] || '#979ca4'}"/>`;
    }
    // week label: show every ~4th
    if (i % 4 === 0 || i === weeksBack - 1) {
      const lbl = new Date(w + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      svg += `<text x="${pad + i * bw + bw / 2}" y="${H - 5}" font-size="8" fill="var(--text-muted)" text-anchor="middle">${lbl}</text>`;
    }
  });

  const thisWeekVol = Math.round(totals[totals.length - 1]);
  return `
    <div class="stats-card">
      <div class="stats-card-title">Weekly volume <span class="stats-card-sub">this week: ${thisWeekVol.toLocaleString()} kg</span></div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${svg}</svg>
    </div>`;
}

// ── Weekly set targets: where the band actually comes from ───────────────────
// The hypertrophy dose-response work (Schoenfeld's volume meta-analyses; the
// MEV/MAV/MRV landmarks popularised by Israetel) puts the productive range for a
// trained lifter at roughly 10 sets/week minimum effective volume, 12–18 for most
// of the gains, and 20+ before recovery starts losing. That's the source of the
// old flat 10–20 band.
//
// The catch: that literature counts DIRECT hard sets, and we count EFFECTIVE sets
// — direct plus fractional carryover from compounds (see muscleContributions). For
// the muscles that soak up carryover from everything else you do — triceps off
// every press, biceps off every row, glutes and hamstrings off every squat and
// hinge — a flat 10–20 reads high, and a perfectly normal push/pull/legs week gets
// flagged as overreaching. So those groups carry a lower band: same evidence,
// adjusted for the fact that their number already includes work done elsewhere.
// Muscles that get little or no carryover (chest, back, calves) keep 10–20.
export const MUSCLE_BANDS = {
  Chest: [10, 20], Back: [10, 20], Calves: [8, 16],
  Quads: [8, 18], Hamstrings: [8, 16], Glutes: [8, 16],
  Shoulders: [8, 18], Triceps: [6, 14], Biceps: [6, 14], Core: [6, 16],
};
const DEFAULT_BAND = [10, 20];
export const bandFor = cat => MUSCLE_BANDS[cat] || DEFAULT_BAND;

// ── Muscle balance (effective sets over trailing N weeks vs the per-muscle band) ─
// Average working sets per muscle group per week over the window, shared by the
// Stats muscle-balance chart and the AI Coach's analysis.
//
// Sets are attributed across muscles, not just the exercise's primary `category`:
// a compound counts as a full (direct) set for its primary muscle and a fractional
// (indirect) set for the muscles it also loads (see muscleContributions). Each row
// carries both `directPerWk` and `indirectPerWk`; `perWk` is their sum — the
// effective-set total the band is judged against. Keeping the two apart is what
// lets the UI distinguish a muscle that's genuinely under-trained from one that's
// quietly getting worked by compounds (and a true zero-carryover gap like calves,
// which never picks up any indirect volume, from a false under-trained signal).
// Memoised: this walks every session in the window and is called from the Home
// hero, the chooser, the Stats chart, the coach context builder and the routine
// analyser — up to half a dozen times per render off the same data. The fingerprint
// is cheap (window + session count + newest session identity + the hour, so the
// rolling cutoff still moves) and element identity is stable even though
// loadSessions() hands out a fresh array each call.
let _wsbcCache = null;
export function weeklySetsByCategory(sessions, weeksBack = 4) {
  const key = `${weeksBack}|${sessions?.length || 0}|${Math.floor(Date.now() / 3600000)}`;
  if (_wsbcCache && _wsbcCache.key === key && _wsbcCache.head === sessions?.[0]) return _wsbcCache.val;
  const val = computeWeeklySetsByCategory(sessions, weeksBack);
  _wsbcCache = { key, head: sessions?.[0], val };
  return val;
}

function computeWeeklySetsByCategory(sessions, weeksBack) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7 * weeksBack);
  const perCat = {};   // muscle -> { direct, indirect }
  let cardioMin = 0;
  const bump = (muscle, key, n) => { (perCat[muscle] ||= { direct: 0, indirect: 0 })[key] += n; };
  for (const s of sessions) {
    if (dateOf(s) < cutoff) continue;
    for (const ex of s.exercises || []) {
      if (ex.category === 'Cardio') {
        cardioMin += workingSets(ex).reduce((a, st) => a + (st.reps || 0), 0);
        continue;
      }
      const n = workingSets(ex).length;
      if (!n) continue;
      for (const c of muscleContributions(ex)) {
        bump(c.muscle, c.primary ? 'direct' : 'indirect', n * c.frac);
      }
    }
  }
  const rows = Object.entries(perCat)
    .map(([cat, v]) => {
      const perWk = (v.direct + v.indirect) / weeksBack;
      const [lo, hi] = bandFor(cat);
      return {
        cat, perWk, lo, hi,
        directPerWk: v.direct / weeksBack,
        indirectPerWk: v.indirect / weeksBack,
        status: perWk < lo ? 'low' : perWk > hi ? 'high' : 'ok',
      };
    })
    .sort((a, b) => b.perWk - a.perWk);
  return { rows, weeksBack, cardioMinPerWk: cardioMin / weeksBack };
}

export function muscleBalanceHTML(sessions, weeksBack = 4) {
  const { rows } = weeklySetsByCategory(sessions, weeksBack);
  if (!rows.length) return '';

  const maxScale = Math.max(24, ...rows.map(r => r.perWk));
  const anyIndirect = rows.some(r => r.indirectPerWk > 0.05);
  const rowHTML = rows.map(r => {
    const color = CATEGORY_COLORS[r.cat] || '#979ca4';
    const directPct = Math.min(100, (r.directPerWk / maxScale) * 100);
    const indirectPct = Math.min(100 - directPct, (r.indirectPerWk / maxScale) * 100);
    // Tooltip spells out the split so the number isn't a black box: e.g. Glutes
    // reading 12.5 might be "3.0 direct + 9.5 from compounds" — clearly not a gap.
    const breakdown = r.indirectPerWk > 0.05
      ? `${r.directPerWk.toFixed(1)} direct + ${r.indirectPerWk.toFixed(1)} from compounds`
      : `${r.directPerWk.toFixed(1)} direct`;
    // The shaded band is this muscle's own target range, not a global 10–20 — see
    // MUSCLE_BANDS for why they differ.
    const loPct = Math.min(100, (r.lo / maxScale) * 100);
    const hiPct = Math.min(100, (r.hi / maxScale) * 100);
    return `
      <div class="mb-row" title="${esc(r.cat)}: ${r.perWk.toFixed(1)} sets/wk (${breakdown}) · target ${r.lo}–${r.hi}">
        <span class="mb-cat">${esc(r.cat)}</span>
        <div class="mb-track">
          <div class="mb-band" style="left:${loPct}%;width:${Math.max(0, hiPct - loPct)}%"></div>
          <div class="mb-fill" style="width:${directPct}%;background-color:${color}${indirectPct > 0 ? ';border-radius:5px 0 0 5px' : ''}"></div>
          ${indirectPct > 0 ? `<div class="mb-fill mb-indirect" style="left:${directPct}%;width:${indirectPct}%;background-color:${color}"></div>` : ''}
        </div>
        <span class="mb-val mb-${r.status}">${r.perWk.toFixed(1)}</span>
      </div>`;
  }).join('');

  const legend = anyIndirect
    ? `<div class="mb-legend"><span class="mb-lg mb-lg-solid"></span>direct<span class="mb-lg mb-lg-hatch"></span>from compounds</div>`
    : '';

  return `
    <div class="stats-card">
      <div class="stats-card-title">Muscle balance <span class="stats-card-sub">effective sets/week, last ${weeksBack} wks · band = that muscle's target</span></div>
      ${rowHTML}
      ${legend}
    </div>`;
}

// ── Per-exercise progression ──────────────────────────────────────────────────
// All exercises seen in history, most-frequent first.
export function exerciseFrequency(sessions) {
  const freq = {};
  for (const s of sessions) for (const ex of s.exercises || []) {
    if (!workingSets(ex).length) continue;
    (freq[ex.name] ||= { name: ex.name, category: ex.category, n: 0 }).n++;
  }
  return Object.values(freq).sort((a, b) => b.n - a.n);
}

export function progressionHTML(sessions, exName) {
  const points = [];
  for (const s of sessions) {
    const ex = (s.exercises || []).find(e => e.name === exName);
    if (!ex) continue;
    const sets = workingSets(ex).filter(st => (st.weight || 0) > 0);
    if (!sets.length) continue;
    const top = sets.reduce((a, b) => (b.weight > a.weight ? b : a));
    points.push({
      t: dateOf(s).getTime(),
      top: top.weight,
      est: e1RM(top.weight, top.reps || 1),
    });
  }
  points.sort((a, b) => a.t - b.t);
  if (points.length < 2) {
    return `<div class="stats-empty">Need at least 2 logged sessions of ${esc(exName)} to chart progression.</div>`;
  }

  const W = 340, H = 160, padL = 30, padR = 8, padT = 10, padB = 20;
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const ys = points.flatMap(p => [p.top, p.est]);
  const yMin = Math.min(...ys) * 0.92, yMax = Math.max(...ys) * 1.06;
  const X = t => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
  const Y = v => padT + (1 - (v - yMin) / Math.max(1, yMax - yMin)) * (H - padT - padB);
  const path = key => points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ');

  // y gridlines: 3 ticks
  let grid = '';
  for (let i = 0; i <= 2; i++) {
    const v = yMin + ((yMax - yMin) * i) / 2;
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,0.07)"/>` +
            `<text x="${padL - 4}" y="${Y(v) + 3}" font-size="8" fill="var(--text-muted)" text-anchor="end">${Math.round(v)}</text>`;
  }
  const d0 = new Date(t0).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  const d1 = new Date(t1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  const dots = points.map(p => `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.top).toFixed(1)}" r="2.4" fill="var(--teal)"/>`).join('');

  const last = points[points.length - 1], first = points[0];
  const delta = last.top - first.top;

  return `
    <div class="stats-card">
      <div class="stats-card-title">${esc(exName)}
        <span class="stats-card-sub">${delta >= 0 ? '+' : ''}${Math.round(delta * 10) / 10} kg top set since ${d0}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
        ${grid}
        <path d="${path('est')}" fill="none" stroke="var(--amber)" stroke-width="1.4" stroke-dasharray="3 3" opacity="0.8"/>
        <path d="${path('top')}" fill="none" stroke="var(--teal)" stroke-width="2"/>
        ${dots}
        <text x="${padL}" y="${H - 6}" font-size="8" fill="var(--text-muted)">${d0}</text>
        <text x="${W - padR}" y="${H - 6}" font-size="8" fill="var(--text-muted)" text-anchor="end">${d1}</text>
      </svg>
      <div class="stats-legend">
        <span><i style="background:var(--teal)"></i>Top set kg</span>
        <span><i style="background:var(--amber)"></i>Est. 1RM</span>
      </div>
    </div>`;
}
