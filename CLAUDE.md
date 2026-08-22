## Agent delegation

All UI work happens on a branch called ui-work, never on main.
At session start, if not already on ui-work: git checkout -b ui-work

For each UI change:
1. ui-designer produces a spec. STOP. Wait for my approval.
2. ui-implementer builds the approved spec only.
3. ui-verifier checks it.
4. Commit to ui-work with a clear one-line message. One commit per change.
5. Return to step 1 for the next change. Do not summarise yet.

When I say "summarise" or "what did you do", run change-reporter.

Never merge to main. Never push. Never squash. I decide what ships.
Do not delegate single-line CSS tweaks - just do those.
