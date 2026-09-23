// ARC icon set. Core glyphs (tabs, train, fuel, PB, streak, common actions) are
// custom-drawn on the 24px grid in the house duotone style; utility glyphs
// (arrows, chevrons, grips…) are Lucide (https://lucide.dev · ISC licensed).
// Names stay Lucide's so call sites never change. Only the icons actually used across the two apps are bundled, so the whole
// pack (~400 KB) never has to ship. Kept as inline SVG bodies so icons can be
// embedded directly in template strings (no post-render pass required) *and*
// dropped into static markup via `<i data-lucide="name">` + renderIcons().
export const ICON_BODIES = {
  'dumbbell': '<rect x="5" y="6.5" width="3" height="11" rx="1.5"/><rect x="16" y="6.5" width="3" height="11" rx="1.5"/><path d="M8 12h8M2.8 9.5v5M21.2 9.5v5"/>',
  'house': '<path d="M4 10.2 12 4l8 6.2V19a1 1 0 0 1-1 1h-4v-5a3 3 0 0 0-6 0v5H5a1 1 0 0 1-1-1z"/>',
  'chart-line': '<path d="M4 4v14a2 2 0 0 0 2 2h14"/><path d="M8 16c3.5 0 6-2.5 7.5-5.5S18.5 7 20 7"/>',
  'bot': '<path d="M11 4h2a7 7 0 0 1 0 14H4v-7a7 7 0 0 1 7-7z"/><path d="M12 8.2c.25 1.45 1.1 2.3 2.6 2.6-1.5.3-2.35 1.15-2.6 2.6-.25-1.45-1.1-2.3-2.6-2.6 1.5-.3 2.35-1.15 2.6-2.6z"/>',
  'library': '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  'book-open': '<path d="M12 7v13"/><path d="M12 7C10 5.5 7 5 4 5.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-13c-3-.5-6 0-8 1.5z"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'timer': '<circle cx="12" cy="13" r="8"/><path d="M10 2.5h4M12 13V9"/>',
  'target': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  'check': '<path d="M20 6 9 17l-5-5"/>',
  'ellipsis': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  'info': '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  'repeat': '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  'arrow-up-down': '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
  'trash-2': '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l.9 12.1A1.5 1.5 0 0 0 8.4 20.5h7.2a1.5 1.5 0 0 0 1.5-1.4L18 7"/>',
  'send': '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  'key': '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  'flame': '<path d="M12 21a6 6 0 0 1-6-6c0-3 1.5-5 3-6.5 0 2 1 3 2 3.5 0-3 1-5.5 3.5-8 .5 3 4.5 6 4.5 11a6 6 0 0 1-6 6z"/>',
  'trophy': '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5v1A3 3 0 0 0 7.4 10M17 6h2.5v1a3 3 0 0 1-2.9 3M12 14v4M8 20h8"/>',
  'download': '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  'upload': '<path d="M12 3v12"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/>',
  'zap': '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'pencil': '<path d="M15 4.5 19.5 9 9 19.5H4.5V15z"/><path d="m12.5 7 4.5 4.5"/>',
  'grip-horizontal': '<circle cx="12" cy="9" r="1"/><circle cx="19" cy="9" r="1"/><circle cx="5" cy="9" r="1"/><circle cx="12" cy="15" r="1"/><circle cx="19" cy="15" r="1"/><circle cx="5" cy="15" r="1"/>',
  'grip-vertical': '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
  'corner-up-left': '<path d="M20 20v-7a4 4 0 0 0-4-4H4"/><path d="M9 14 4 9l5-5"/>',
  'calendar': '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  'circle-check': '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.7 2.7L16.2 9.5"/>',
  'scale': '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M8 11a4 4 0 0 1 8 0M12 11l1.6-2.4"/>',
  'hammer': '<path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
  'search': '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  'play': '<path d="M8 5.8v12.4a1 1 0 0 0 1.52.85l10-6.2a1 1 0 0 0 0-1.7l-10-6.2A1 1 0 0 0 8 5.8z"/>',
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'notebook-pen': '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>',
  'list-plus': '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M16 19H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>',
  'refresh-cw': '<path d="M19.5 12a7.5 7.5 0 0 1-13.3 4.8M4.5 12a7.5 7.5 0 0 1 13.3-4.8"/><path d="M18.5 3.5v3.8h-3.8M5.5 20.5v-3.8h3.8"/>',
  'award': '<path d="m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"/><circle cx="12" cy="8" r="6"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  'trending-up': '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  'trending-down': '<path d="M16 17h6v-6"/><path d="m22 17-8.5-8.5-5 5L2 7"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'utensils': '<path d="M3.5 11h17a8.5 8.5 0 0 1-17 0z"/><path d="M9.5 7.5c-.8-.9-.2-1.7.4-2.5s.8-1.6 0-2.5M14.5 7.5c-.8-.9-.2-1.7.4-2.5s.8-1.6 0-2.5"/>',
  'moon': '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  'plus-circle': '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
};

// Duotone fill layer (the "B" direction): a closed shape under the line work,
// painted in currentColor at a faint opacity (--icon-fill). Icons without an
// entry are line-only.
export const ICON_FILLS = {
  'house': '<path d="M4 10.2 12 4l8 6.2V19a1 1 0 0 1-1 1h-4v-5a3 3 0 0 0-6 0v5H5a1 1 0 0 1-1-1z"/>',
  'calendar': '<path d="M6.5 5h11a3 3 0 0 1 3 3v2h-17V8a3 3 0 0 1 3-3z"/>',
  'chart-line': '<path d="M8 16c3.5 0 6-2.5 7.5-5.5S18.5 7 20 7v10H8z"/>',
  'bot': '<path d="M11 4h2a7 7 0 0 1 0 14H4v-7a7 7 0 0 1 7-7z"/>',
  'book-open': '<path d="M12 7C10 5.5 7 5 4 5.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-13c-3-.5-6 0-8 1.5z"/>',
  'dumbbell': '<rect x="5" y="6.5" width="3" height="11" rx="1.5"/><rect x="16" y="6.5" width="3" height="11" rx="1.5"/>',
  'play': '<path d="M8 5.8v12.4a1 1 0 0 0 1.52.85l10-6.2a1 1 0 0 0 0-1.7l-10-6.2A1 1 0 0 0 8 5.8z"/>',
  'timer': '<path d="M12 13V5a8 8 0 0 1 8 8z"/>',
  'circle-check': '<circle cx="12" cy="12" r="9"/>',
  'trophy': '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/>',
  'flame': '<path d="M12 21a6 6 0 0 1-6-6c0-3 1.5-5 3-6.5 0 2 1 3 2 3.5 0-3 1-5.5 3.5-8 .5 3 4.5 6 4.5 11a6 6 0 0 1-6 6z"/>',
  'utensils': '<path d="M3.5 11h17a8.5 8.5 0 0 1-17 0z"/>',
  'scale': '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/>',
  'search': '<circle cx="11" cy="11" r="6.5"/>',
  'pencil': '<path d="M15 4.5 19.5 9 9 19.5H4.5V15z"/>',
  'trash-2': '<path d="M6 7h12l-.9 12.1a1.5 1.5 0 0 1-1.5 1.4H8.4a1.5 1.5 0 0 1-1.5-1.4z"/>',
  'info': '<circle cx="12" cy="12" r="10"/>',
  'target': '<circle cx="12" cy="12" r="6"/>',
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>',
  'award': '<circle cx="12" cy="8" r="6"/>',
  'zap': '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  'key': '<circle cx="7.5" cy="15.5" r="5.5"/>',
  'plus-circle': '<circle cx="12" cy="12" r="10"/>',
  'moon': '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/>',
  'send': '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/>',
  'notebook-pen': '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/>',
};

// Return an inline <svg> string for `name`. Safe to drop straight into a
// template literal. `size`/`stroke` are numbers; `cls` adds extra classes.
export function icon(name, { size = 20, cls = '', stroke = 1.5 } = {}) {
  const body = ICON_BODIES[name];
  if (!body) return '';
  const fill = ICON_FILLS[name] ? `<g class="fl">${ICON_FILLS[name]}</g>` : '';
  return `<svg class="lc${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" `
    + `fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" `
    + `stroke-linejoin="round" aria-hidden="true" focusable="false">${fill}${body}</svg>`;
}

// Fill any `<i data-lucide="name">` placeholders inside `root` with their SVG.
// Optional data-size / data-stroke override the defaults. Idempotent.
export function renderIcons(root = document) {
  root.querySelectorAll('[data-lucide]:not([data-lucide-done])').forEach(el => {
    const svg = icon(el.dataset.lucide, {
      size:   el.dataset.size   ? +el.dataset.size   : 20,
      stroke: el.dataset.stroke ? +el.dataset.stroke : 1.5,
    });
    if (!svg) return;
    el.innerHTML = svg;
    el.dataset.lucideDone = '1';
  });
}
