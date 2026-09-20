# Tests

No build step and no test framework — plain Node scripts. Nothing here ships.

```sh
node test/unit/logic.test.mjs      # pure logic, no browser
npm i playwright && node test/run-e2e.mjs   # drives the real app in Chromium
```

## `unit/logic.test.mjs`

`workout/app.js` is one non-modular script that touches the DOM at load, so it
can't be imported. Each function under test is **sliced out of the real file** by
brace matching and evaluated with stubs. That means a test can never pass against
a stale copy — if a function is renamed the slice throws rather than silently
testing nothing.

## `e2e/`

Serves the repo over HTTP and drives it in Chromium. Two things are faked and
nothing else:

- `e2e/supabase-stub.js` is routed in over `shared/supabase.js`, so the app boots
  signed-in with no network. The real module pulls the SDK from a CDN and every
  sync call would hit Supabase.
- `sw.js` is 404'd, so a stale service-worker cache can never mask a change.

Assertions read **IndexedDB**, not the DOM, wherever the question is "what was
actually stored". Screenshots land in `test/e2e/shots/`.

Env vars: `ARC_CHROME` (path to a Chromium binary, if Playwright's bundled one
isn't present), `ARC_SHOTS` (screenshot directory).

Coverage: expanding a plan, opening and editing a routine, set/rep/rest targets,
two superset groups getting different colours, save keeping the routine's id and
its place in the plan's day order, duplicate, delete pruning the week plan,
drag-to-reorder, discarding changes, building a routine from scratch, adding a
split as its own plan, re-adding the same split, the plan menu, and the
`Full Body A`/`B` name collision between two different splits.
