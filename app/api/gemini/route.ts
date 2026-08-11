// Server-side proxy for the "Extract with AI" read. The browser posts the
// Gemini request body (contents + generationConfig) built in lib/ai.ts; this
// route only attaches GEMINI_API_KEY and forwards it, so the key never ships
// inside the page bundle.

export const runtime = 'nodejs';

// gemini-2.5-flash was retired in 2026; the first model that is not "unknown"
// to the API wins. Quota and bad-key failures look the same for every model,
// so only a retired/unknown model is worth retrying on the next one.
const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];

const fail = (status: number, message: string) =>
  Response.json({ error: { message } }, { status });

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return fail(
      500,
      'GEMINI_API_KEY is not set on the server - add it to .env.local and restart (free key at aistudio.google.com/apikey).',
    );
  }

  let body: string;
  try {
    body = JSON.stringify(await req.json());
  } catch {
    return fail(400, 'Malformed request body.');
  }

  let last = { status: 502, data: { error: { message: 'Gemini request failed.' } } as unknown };
  for (const model of MODELS) {
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body,
        },
      );
    } catch (err) {
      return fail(502, `Could not reach Gemini: ${(err as Error).message}`);
    }

    const data = await res.json().catch(() => null);
    if (res.ok) return Response.json(data);

    const message = (data as { error?: { message?: string } } | null)?.error?.message ?? '';
    last = { status: res.status, data: data ?? { error: { message: `HTTP ${res.status}` } } };
    if (!/no longer available|not found/i.test(message)) break;
  }
  return Response.json(last.data, { status: last.status });
}
