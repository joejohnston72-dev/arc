# UX rebuild — design canvas source

Hi-fi mockups for the app-wide UX fixes, matching Arc's dark palette
(bg `#0c0c0d`, surface `#1c1c1e`, surface2 `#2c2c2e`, text `#f5f5f7`,
muted `#98989f`, blue `#38bdf8`, Google Sans, 16px radius) and the
vendored Lucide paths from `shared/icons.js`.

Artboards (each renders as one frame on the canvas):
- **Main.dc.html** — Today, rebuilt on three visual layers: the ACTIVE PLAN
  hero with routines as tap-to-start rows (replaces "Next in your split" and
  the `computeNextTemplate` hero ranking), one paged coach card, and history
  demoted to flat rows so it stops mimicking coach cards.
- **LibraryPlans.dc.html** — Library's Plans segment: plan cards with an
  ACTIVE badge, routines expanding underneath with edit / duplicate / delete
  on the row, "Set active" on an inactive plan.
- **LibraryExercises.dc.html** — Library's Exercises segment, with a create
  button beside the search field (custom exercises no longer need an active
  workout).
- **RoutineBuilder.dc.html** — the dedicated routine editor: name, plan
  assignment, draggable exercise list, sets x reps targets, per-group
  superset rails. Saves in place, keeping the routine id.
- **CoachStates.dc.html** — the single coach card in four states (AI daily
  pick, weekly review, warning finding, queue cleared), replacing the stacked
  daily pick + weekly review + N findings on Today.
- **CoachChat.dc.html** — Coach tab: multi-line composer flush to the tab bar,
  key/clear moved into the header.
- **Supersets.dc.html** — per-group superset colours (A purple, B orange,
  C green, D amber; blue and red stay reserved for primary/destructive).
- **canvas.json** — layout/manifest.

## Published canvas
https://claude.ai/artifact/5GTDoGaWjcqEHjkikMxnzb

## Regenerate / edit
Edit the `.dc.html` files, then re-seed a fresh canvas with the `design`
skill and republish the same path to keep the URL. The seeded output
(`arc-ux-rebuild.html`, ~2.5 MB) is gitignored — it is a build artifact.
