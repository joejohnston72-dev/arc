# Coach proxy (Edge Function)

Streams Anthropic Messages API responses to the Arc app so the AI Coach doesn't
need a per-user API key and can stream + retry.

## One-time setup

```bash
# from repo root, with the Supabase CLI linked to project xjcnkivlkfzdycbyxxlx
supabase secrets set ANTHROPIC_API_KEY=sk-ant-api03-...   # your Anthropic key
supabase functions deploy coach                            # verify_jwt stays ON
```

- **verify_jwt is left ON** (the default): only logged-in Arc users can invoke it,
  so only your users can spend the key. The client sends the user's Supabase
  session token automatically.
- The function URL is `https://<project>.supabase.co/functions/v1/coach`
  (derived on the client from `SUPABASE_URL` in `shared/supabase.js`).

## Behaviour

- Holds the Anthropic key server-side (`ANTHROPIC_API_KEY`).
- Clamps `max_tokens` to 256–8192 (default 4096) so long answers/splits don't truncate.
- Retries transient upstream errors (429/529, network) up to twice before streaming.
- If the secret is missing it returns `{ "error": "proxy_unconfigured" }` (501),
  which the client treats as a signal to fall back to a user-pasted key.

## Fallback

The app works **without** this function: `workout/coach.js` tries the proxy first
and falls back to the direct browser call with a user-pasted key (🔑 in the Coach
tab) whenever the proxy is missing or errors. Deploying this just removes the
key-paste friction and makes the coach more reliable.
