# Coach proxy (Edge Function)

Streams Anthropic Messages API responses to the Arc app so the AI Coach doesn't
need a per-user API key and can stream + retry.

## One-time setup

```bash
# from repo root, with the Supabase CLI linked to project xjcnkivlkfzdycbyxxlx
supabase secrets set ANTHROPIC_API_KEY=sk-ant-api03-...   # your Anthropic key
supabase secrets set ALLOWED_EMAILS=you@example.com        # who may use it (comma-separated)
supabase functions deploy coach                            # verify_jwt stays ON
```

Optional: `supabase secrets set COACH_MODEL=...` to change the model (default
`claude-sonnet-5`). The caller can no longer choose it.

- **verify_jwt is left ON** (the default), but that alone is not enough: the
  public anon key is itself a valid JWT. The function also asks Supabase Auth
  who the token belongs to and rejects anything that isn't a signed-in user.
- **Set `ALLOWED_EMAILS`.** Email sign-up is open, so without it any new account
  can spend the key. With it, only the listed accounts can.
- The function URL is `https://<project>.supabase.co/functions/v1/coach`
  (derived on the client from `SUPABASE_URL` in `shared/supabase.js`).

## Behaviour

- Holds the Anthropic key server-side (`ANTHROPIC_API_KEY`).
- Clamps `max_tokens` to 256–8192 (default 8192) so long answers/splits don't truncate.
- Retries transient upstream errors (429/529, network) up to twice before streaming.
- If the secret is missing it returns `{ "error": "proxy_unconfigured" }` (501),
  which the client treats as a signal to fall back to a user-pasted key.

## Fallback

The app works **without** this function: `workout/coach.js` tries the proxy first
and falls back to the direct browser call with a user-pasted key (🔑 in the Coach
tab) whenever the proxy is missing or errors. Deploying this just removes the
key-paste friction and makes the coach more reliable.
