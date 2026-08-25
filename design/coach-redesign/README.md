# Coach redesign — design canvas source

Hi-fi mockups for the AI Coach expansion, matching Arc's dark palette
(bg `#0c0c0d`, surface `#1c1c1e`, blue `#38bdf8`, Google Sans, 16px radius).

Artboards (each renders as one frame on the canvas):
- **Main.dc.html** — the chat: streaming reply, routine card with a "Why"
  rationale, the new "Remembers you" memory strip, chips + composer.
- **Profile.dc.html** — the athlete-profile sheet (goal, experience, days/week,
  equipment, injuries, bodyweight) that backs `set_coach_profile`.
- **Home.dc.html** — Home coach section: daily pick + the new weekly-review card.
- **States.dc.html** — card/state library: error+retry (replaces "(no response)"),
  truncated-answer note, empty state, action-confirmed, split, suggestion cards.
- **canvas.json** — layout/manifest.

## Published canvas
https://claude.ai/code/artifact/dd6d274b-27fa-464f-a8c0-d33bc6dd524e

## Regenerate / edit
Edit the `.dc.html` files, then re-seed a fresh canvas with the `design` skill
(`/design`) and republish to the same URL. The seeded output HTML is gitignored
(it embeds a ~2 MB editor payload).
