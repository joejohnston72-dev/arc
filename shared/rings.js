// ARC rings — the one progress shape used across the app and in the app icon.
// Every ring shares one construction: round caps, a 10% white track, filling
// clockwise from 12 o'clock. Segmented rings COUNT things (sessions this week);
// continuous rings MEASURE amounts (kcal, sets, rest time).
//
// A complete week ring switches to the four pillar hues — Train, Progress,
// Fuel, Coach — which is exactly the app icon (design/week-ring-study.html).

const TRACK = 'rgba(255,255,255,0.10)';
export const PILLAR_HUES = ['var(--train)', 'var(--prog)', 'var(--fuel)', 'var(--coach)'];

const pt = (c, r, a) => [+(c + r * Math.cos(a * Math.PI / 180)).toFixed(2), +(c + r * Math.sin(a * Math.PI / 180)).toFixed(2)];
function arcD(c, r, a0, a1) {
  const [x0, y0] = pt(c, r, a0), [x1, y1] = pt(c, r, a1);
  return `M${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

// Segmented ring: `total` segments, the first `done` lit in `color`.
// complete → pillar hues; animate → segments draw in one after another.
export function weekRing(done, total, { size = 48, stroke = 4.5, color = 'var(--train)', complete = false, animate = false, label = '' } = {}) {
  const n = Math.max(1, Math.min(total, 14));
  const c = 24, r = 24 - stroke / 2 - 0.5, gap = 10;              // visual gap in degrees
  const cap = stroke / r * 180 / Math.PI, step = 360 / n;
  const paths = Array.from({ length: n }, (_, i) => {
    const a0 = -90 + i * step + (gap + cap) / 2, a1 = -90 + (i + 1) * step - (gap + cap) / 2;
    const lit = complete || i < done;
    const col = complete ? PILLAR_HUES[i % 4] : lit ? color : TRACK;
    const anim = animate && lit ? ` pathLength="1" class="ring-draw" style="animation-delay:${(i * 0.14).toFixed(2)}s"` : '';
    const track = anim ? `<path d="${arcD(c, r, a0, a1)}" stroke="${TRACK}"/>` : '';
    return `${track}<path d="${arcD(c, r, a0, a1)}" stroke="${col}"${anim}/>`;
  }).join('');
  return `<span class="ring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 48 48" width="${size}" height="${size}" fill="none" stroke-width="${stroke}" stroke-linecap="round" aria-hidden="true">${paths}</svg>${label ? `<span class="ring-lbl">${label}</span>` : ''}</span>`;
}

// Continuous ring: pct 0–1 in `color`.
export function meterRing(pct, { size = 30, stroke = 3.5, color = 'var(--train)', label = '', cls = '' } = {}) {
  const r = 15 - stroke / 2 - 0.25, C = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, pct || 0));
  return `<span class="ring${cls ? ' ' + cls : ''}" style="width:${size}px;height:${size}px"><svg viewBox="0 0 30 30" width="${size}" height="${size}" fill="none" stroke-width="${stroke}" aria-hidden="true">`
    + `<circle cx="15" cy="15" r="${r.toFixed(2)}" stroke="${TRACK}"/>`
    + (p > 0 ? `<circle class="ring-val" cx="15" cy="15" r="${r.toFixed(2)}" stroke="${color}" stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(C * (1 - p)).toFixed(2)}" transform="rotate(-90 15 15)"/>` : '')
    + `</svg>${label ? `<span class="ring-lbl" style="color:${color}">${label}</span>` : ''}</span>`;
}
