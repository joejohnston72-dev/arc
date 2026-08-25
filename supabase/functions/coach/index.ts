// Arc AI Coach — Anthropic streaming proxy (Supabase Edge Function).
//
// Why this exists: the app used to call api.anthropic.com directly from the
// browser with a key each user pasted in. That path has no server-side control
// over the model/prompt, forces every user to bring their own key, and — with no
// streaming — was the main source of the coach's "(no response)" failures.
//
// This function holds ONE Anthropic key server-side (the ANTHROPIC_API_KEY
// secret), verifies the caller is a logged-in Arc user (Supabase JWT — enforced
// by the platform's verify_jwt, on by default), and streams Anthropic's SSE
// straight back to the browser. The client (workout/coach.js) prefers this proxy
// and falls back to a user-pasted key when it is not deployed/configured.
//
// Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase functions deploy coach
// (verify_jwt stays ON so only authenticated Arc users can spend the key.)

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const key = Deno.env.get('ANTHROPIC_API_KEY');
  // No server key configured → tell the client so it can fall back to a
  // user-pasted key instead of surfacing a hard error.
  if (!key) return json({ error: 'proxy_unconfigured' }, 501);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  // Clamp max_tokens into a sane band; default generous so long splits/answers
  // don't truncate (a common cause of empty replies before).
  const wantedMax = Number(payload.max_tokens) || 4096;
  const max_tokens = Math.min(Math.max(wantedMax, 256), 8192);

  const body = {
    model: typeof payload.model === 'string' ? payload.model : DEFAULT_MODEL,
    max_tokens,
    system: payload.system,
    tools: payload.tools,
    tool_choice: payload.tool_choice,
    messages: payload.messages,
    stream: true,
  };

  // One retry on transient upstream errors (rate limit / overloaded), before any
  // bytes are streamed. Once we start piping the stream we don't retry.
  let res: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (_e) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      return json({ error: 'upstream_unreachable' }, 502);
    }
    if ((res.status === 429 || res.status === 529) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    break;
  }

  if (!res || !res.ok) {
    let detail = '';
    try {
      detail = (await res!.json())?.error?.message ?? '';
    } catch {
      try { detail = await res!.text(); } catch { /* ignore */ }
    }
    return json({ error: 'upstream', status: res?.status ?? 0, detail }, res?.status ?? 502);
  }

  // Pipe Anthropic's SSE straight through to the browser.
  return new Response(res.body, {
    headers: {
      ...CORS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  });
});
