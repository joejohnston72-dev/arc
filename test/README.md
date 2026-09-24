# Tests

No build step and no test framework — plain Node scripts. Nothing here ships.

```sh
npm i --no-save playwright && node test/run-e2e.mjs   # drives the real app in Chromium
```

## `e2e/`

Serves the repo over HTTP and drives it in Chromium. Two things are faked and
nothing else, both by the harness's own server:

- `e2e/supabase-stub.js` is served in place of `shared/supabase.js`, so the app
  boots signed-in with no network. The real module pulls the SDK from a CDN and
  every sync call would hit Supabase.
- `sw.js` is 404'd, so a stale service-worker cache can never mask a change.

Assertions read **IndexedDB**, not the DOM, wherever the question is "what was
actually stored". Screenshots land in `test/e2e/shots/` (git-ignored).

Env vars: `ARC_CHROME` (path to a Chromium binary, if Playwright's bundled one
isn't present), `ARC_SHOTS` (screenshot directory).

Coverage:
- `supersets` — two superset groups in one workout get different rail colours
  and letters, the exercise menu names the group, ungrouping re-letters.
- `coach-chat` — the composer is a textarea in the app font, Return adds a line
  and Cmd/Ctrl+Return sends, it grows then caps, no dead strip above the tab
  bar, the keyboard layout, key/clear reachable in the header.
- `affordance` — the streak tile opens its settings directly and Today updates
  on save, history date/duration say "Edit", the un-merge control is a 32px
  target, the dead `.tab-badge` rule is gone.
