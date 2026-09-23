# ARC — Brand & Design System

> The single source of truth for how the app looks, sounds, and feels. Read this
> before building or restyling any feature. It doubles as the design-system
> reference — the tokens and rules here already match what's implemented in
> `styles.css`, `workout/index.html`, and `shared/icons.js`.

---

## 0. The three levers (locked)

These are decided and implemented. Change any of them here and it propagates
through the doc and the app:

| Lever | Locked choice | Notes |
|---|---|---|
| **Name** | **ARC** | Shipped: `<title>`, PWA install name, in-app header, manifests. |
| **Look** | **Slate & Mist, four pillars** | Cool graphite surfaces, soft mist-blue primary; each pillar (Train, Progress, Fuel, Coach) owns a hue and a shape. See §5. |
| **Coach voice** | **Technical & precise — explain the why** | Backs every call with the mechanism/number behind it. |

The name is live everywhere. The palette moved from the old blue-tinted
near-black to **neutral charcoal** (iOS system-gray tones) so the accent, not
the background, carries the colour.

---

## 1. The name

**ARC.**

- **What it means.** The arc of a rep's path. The arc of progress over months.
  An *electric* arc — energy, charge, the neon-blue glow that runs through the
  UI. Three letters, sharp, abstract, premium. Easy to say, impossible to
  mistake, ages well.
- **How to write it.** `ARC` in the wordmark (all caps). In running text, "Arc"
  is fine. Never "A.R.C." (it's not an acronym) and never lowercase in the logo.
- **Tagline (pick one, all on-brand):**
  - **Train with intent.** ← recommended
  - Every rep, measured.
  - Strength, sharpened.

**Why not the others** (kept for reference): *VOLT* leans harder into the
electric theme but is widely used; *FORGE* is warmer/craftsman but less
electric; *APEX* is competitive-premium but common in fitness; *TEMPO* is calm
and disciplined but softer than the app's edge.

---

## 2. Brand personality

ARC is **the quiet professional** — a high-end tool, not a hype machine.

**Five adjectives:** Precise · Confident · Minimal · Fast · Honest.

**It is:** focused, data-forward, respectful of your time, quietly premium.
**It is not:** loud, gamified, cluttered, "bro," salesy, or cute.

The feeling on open: *this is a serious instrument for serious training.* Black
canvas, one electric accent, numbers that matter, nothing shouting for
attention.

---

## 3. Voice & tone (incl. the AI Coach)

**Voice = technical & precise — always explain the why.** Short sentences. Say
the useful thing, name the mechanism or number behind it, then stop. Never hype
for its own sake; let a real PB speak for itself. The user is an experienced
lifter — don't over-explain the basics, do surface the reasoning a good coach
would.

| Do | Don't |
|---|---|
| "Triceps lag chest 3:1 by set volume — add overhead extensions; the long head only loads at full stretch." | "OMG your triceps need some LOVE 💪🔥 let's gooo!!!" |
| "New best: 100 kg × 8 → est. 1RM ~127 kg, up 6% since May." | "AMAZING WORK SUPERSTAR!!!" |
| "Quads at 22 sets/wk vs 9 for hamstrings — that imbalance raises knee-strain risk. Rebalance toward hinges." | "Time to crush it champ!" |
| "No session in 6 days — strength holds ~10 days, so you've lost nothing yet." | "We've missed you! Don't give up 🥺" |

**Rules of thumb**
- Second person ("you"), present tense, active voice.
- **Explain the why in one clause** — the mechanism, the ratio, the trade-off.
  Precision *is* the encouragement.
- Numbers over adjectives. "+12 kg since May," not "great progress."
- At most **one** emoji per surface, and only where it carries meaning
  (🏆 PB, 🔥 streak). Prefer a Lucide icon to an emoji everywhere else.
- British English (kg, "programme" is fine, "colour" in copy).
- Errors are calm and instructive: *"That API key was rejected (401). Tap the
  key to update it."* — never blame, never panic.

**Coach persona:** an experienced strength coach with a sports-science bent —
reads your numbers, spots the imbalance, and tells you the mechanism behind the
fix. Confident and precise, never vague, never padded. Every routine change is
specific, actionable, and justified by what's in your data.

---

## 4. Logo & app mark

**Primary mark:** the **mist dumbbell** — a chunky, diagonal dumbbell in a soft
mist-blue gradient on a graphite tile (see `workout/icon.png`; source
`design/icon.svg.html`, rendered to 512×512 PNG).

**Construction rules**
- Glyph sits inside the **maskable safe zone** (~80% centre) so iOS/Android
  corner-rounding never clips it.
- Gradient runs bottom-left → top-right: `#8ea8bd → #c3d3e0`.
- Depth from a soft dark drop shadow only — **no glow**.
- Background: graphite `linear-gradient(#1e2227 → #121417)` with a faint
  mist wash top-right.

**Wordmark:** `ARC` set in Google Sans **Bold**, tight tracking (`-0.02em`),
optionally with the electric-sky as a subtle left-to-right gradient on the
letters. Lockup = mark left, wordmark right, with the mark's height ≈ cap
height × 1.4.

**Don't:** recolour the mark arbitrarily, add a flame/heart/generic swoosh, put
it on a pure-white or busy background, or stretch/skew it.

---

## 5. Colour system — Slate & Mist, four pillars

**Cool graphite canvas, soft desaturated accents, no glow.** The base is a
slightly blue-biased charcoal; accents sit at ~30% saturation so nothing reads
as neon. Source mockups: `design/palette-study.html`.

### Surfaces
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#131518` | Canvas |
| `--surface` | `#1c1f23` | Cards, sheets, tab bar |
| `--surface2` | `#262a2f` | Inputs, chips, nested |
| `--text` | `#e8eaed` | Primary text |
| `--text-muted` | `#979ca4` | Secondary text |
| `--border` | `rgba(255,255,255,0.10)` | Hairlines |

### Pillars — hue + form
Colour says **which** pillar; shape says **what kind of thing** it is.

| Pillar | Token (alias) | Hex | Form |
|---|---|---|---|
| **Train** — workouts, routines, split | `--blue` (`--train`) | `#9fb8cc` | The one raised, tinted hero per screen (`.next-card`, coach routine cards). Primary buttons. |
| **Progress** — streaks, charts, trends | `--teal` (`--prog`) | `#8fc2bb` | Open data: numbers on the canvas, hairlines, no box. |
| **Fuel & body** — calories, bodyweight | `--orange` (`--fuel`) | `#d6b48e` | Soft sand wash, no border. |
| **Coach** — anything the AI says | `--purple` (`--coach`) | `#b3aad6` | A voice: lavender wash, speech corner (`20px 20px 20px 6px`), no border. |

Ink on filled accents: `--on-accent #142029` (blue), `--on-warm #2a1f12`,
`--on-green #10231a` — never pure black.

### Semantic signals (meaning only)
| Meaning | Token | Hex |
|---|---|---|
| PB / trophies / warm-up | `--amber` | `#d8b774` |
| Success / set done | `--green` | `#93c2a4` |
| Destructive / error | `--red` | `#d88685` |

### Rules
- **One raised thing per screen.** Only the Train hero gets a gradient + shadow.
- **Colour marks, never floods** — labels, icons, data lines, hero tint.
- **Lists are rows with dividers**, not a box per item (`.workout-card`).
- **The coach is lavender everywhere** — Home cards, chat, workout notes, summary.
- Every accent has an `--x-rgb` triplet; use `rgba(var(--x-rgb),a)`, never literals.
- Motion: `--ease` (`cubic-bezier(.2,.8,.2,1)`), ~180–240 ms.
- `CATEGORY_COLORS` (muscle groups) are softened to match; they're data viz, not brand.
- Re-theming: update both `:root` blocks, `manifest.json` ×2 and both `theme-color` metas.

---

## 6. Typography

- **Typeface:** **Google Sans** (loaded from the Google Fonts v1 CSS API),
  falling back to `Product Sans, Roboto, -apple-system, system-ui`. Geometric,
  friendly-but-precise, unmistakably modern.
- **One weight hierarchy, three weights only** (`styles.css` tokens):
  | Token | Weight | Use |
  |---|---|---|
  | `--fw-regular` | 400 | Body copy, secondary text |
  | `--fw-medium` | 500 | Labels, tabs, chips, buttons |
  | `--fw-bold` | 700 | Titles, headings, emphasis, numbers-that-matter |
- **Tracking:** tighten large/bold headings slightly (`-0.3px`…`-0.5px`); leave
  body at default. UPPERCASE micro-labels get **+0.06em** letter-spacing.
- **Numbers are first-class.** Stats, weights, PBs and timers use bold, often
  tabular (`font-variant-numeric: tabular-nums`) so digits don't jitter.
- Minimum input font-size **16px** (iOS zoom guard) — non-negotiable.

---

## 7. Iconography

- **Lucide**, line style, `stroke-width: 2`, `currentColor` (inherits text/accent
  colour). Vendored subset in `shared/icons.js` — add new ones there, don't pull
  a CDN.
- Line icons everywhere for chrome and actions. **Emoji only** for the two
  reward signifiers (🏆 PB, 🔥 streak) and nowhere else.
- Consistent sizes: 20–24px in nav/buttons, 15–17px inline with text, 12–14px as
  tiny adornments. Vertical-align tuned so icons sit on the text baseline.

---

## 8. UI principles (how ARC is built)

1. **Black-first, glow-second.** Near-black canvas; the accent glows out of it.
   Depth comes from **hairline borders + subtle gradients**, not from lightening
   fills or heavy shadows.
2. **One primary action per screen.** It's the only gradient/glow button.
   Everything else is quiet (ghost/outline/`--surface2`).
3. **Content over chrome.** No decorative panels. Every pixel earns its place —
   if it's not data, an action, or a label, cut it.
4. **Frosted, floating system chrome.** The tab bar is translucent + blurred
   (`backdrop-filter`), anchored to the bottom edge through the safe area.
5. **Motion is quick and physical.** 150–300ms, ease-out. Press states scale
   ~0.98. Skeleton shimmer while data loads. Nothing bounces or lingers.
6. **Gestures reward mastery, taps are always available.** Swipe a set to
   delete/drop, long-press to reorder — but there's always a visible tap path
   too (the "…" menu, the set-number tap).
7. **The workout is a focused surface.** Full-screen overlay, locked background,
   keyboard-aware. When you're training, nothing else exists.
8. **Never lose data, always reassure.** Local-first + cloud + exportable file.
   When something's syncing/restoring, say so; when it's saved, don't nag.

---

## 9. Naming & microcopy conventions

- **Features get plain, confident names:** "Coach," "Routines," "Library,"
  "Backup & restore," "Improve my routines." No cutesy sub-brands.
- **Sentence case** for buttons and labels ("Back up to cloud now"), **Title
  Case** only for screen titles and the wordmark.
- **Verbs on buttons** ("Restore from cloud," "Add exercise," "Finish"), nouns
  on tabs ("Stats," "Coach," "Library").
- **Counts are specific:** "Restored 452 items — 447 workouts." Not "Done!"
- **Empty states teach the next step:** "No history yet. Restore from cloud, or
  import a backup, in Stats." — never a dead end.

---

## 10. Applications & checklist

When shipping anything new, it's on-brand if:

- [ ] Near-black surface with a **hairline border**; one electric-sky primary
      action, everything else neutral.
- [ ] Google Sans, weights 400/500/700 only; numbers bold, tabular where they
      change.
- [ ] Lucide line icons (from `shared/icons.js`); at most one meaningful emoji.
- [ ] Copy is direct, second-person, numbers over adjectives, ≤1 emoji.
- [ ] Motion 150–300ms ease-out; press-scale on the primary action.
- [ ] Works keyboard-open and offline; nothing can leak the background behind an
      overlay; data changes are reflected in the cloud.
- [ ] Touch targets ≥ 44px; inputs ≥ 16px; safe areas respected top and bottom.

---

## 11. The ARC name — shipped

The rename is live. `workout/index.html` `<title>`, `apple-mobile-web-app-title`,
and the in-app `#mainTitle` header all read **ARC**; `workout/manifest.json`
`name`/`short_name` are **ARC**; the Dashboard tab title resolves to "ARC" in
`app.js`. The root hub is retired, so only the `workout/` app was renamed. The
icon wordmark still uses the dumbbell mark (see §4) — swap in an "ARC" wordmark
lockup there whenever the icon art is next revised.
