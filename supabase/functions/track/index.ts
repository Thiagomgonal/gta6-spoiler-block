// Receives the extension's daily usage report and stores it via record_usage().
//
// The extension holds no Supabase key: this function is public (verify_jwt is
// off) and is the only door to the database. It accepts requests only from the
// extension's origin (fixed by the manifest key) and only a tiny, strictly
// shaped JSON body.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SECRET_KEY = Deno.env.get("STATS_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGINS = new Set(
  (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.startsWith("chrome-extension://")),
);

const MAX_BODY_BYTES = 200;
const MAX_HIDDEN_PER_DAY = 20000;
const REPORT_WINDOW_DAYS = 2;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

type Usage = { id: string; day: string; hidden: number };

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function utcDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

// Reads at most `limit` bytes, whether or not the client sent Content-Length.
async function readBody(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > limit || !request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseUsage(raw: string): Usage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const { id, day, hidden, ...extra } = data as Record<string, unknown>;
  if (Object.keys(extra).length > 0) return null;
  if (typeof id !== "string" || !UUID_V4.test(id)) return null;
  if (typeof day !== "string" || !ISO_DAY.test(day)) return null;
  if (day < utcDay(-REPORT_WINDOW_DAYS) || day > utcDay()) return null;
  if (typeof hidden !== "number" || !Number.isInteger(hidden) || hidden < 0 || hidden > MAX_HIDDEN_PER_DAY) return null;

  return { id, day, hidden };
}

// New-style secret keys (sb_secret_...) go in the apikey header only; legacy
// JWT keys are also sent as a bearer token.
function authHeaders(): HeadersInit {
  return SECRET_KEY.startsWith("sb_")
    ? { apikey: SECRET_KEY }
    : { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` };
}

async function recordUsage({ id, day, hidden }: Usage): Promise<boolean> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_usage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ p_install_id: id, p_day: day, p_hidden: hidden }),
  });
  if (!response.ok) console.error("record_usage failed", response.status, await response.text());
  return response.ok;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });

  const headers = corsHeaders(origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return new Response(null, { status: 405, headers });

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return new Response(null, { status: 415, headers });
  }
  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === null) return new Response(null, { status: 413, headers });

  const usage = parseUsage(body);
  if (!usage) return new Response(null, { status: 400, headers });

  const ok = await recordUsage(usage);
  return new Response(null, { status: ok ? 204 : 500, headers });
});
