/** A fake of both key checks: OpenAI and TypeSafe `GET /v1/models`. */
export function fakeKeyCheckFetch(opts: { openai?: number; typesafe?: number; models?: string[]; offline?: boolean } = {}) {
  const seen: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>)?.Authorization));
    if (opts.offline) throw new TypeError("fetch failed");
    const u = String(url);
    if (u.includes("api.openai.com")) {
      return new Response(JSON.stringify({ data: (opts.models ?? ["gpt-transcribe", "gpt-live-transcribe"]).map((id) => ({ id })) }), { status: opts.openai ?? 200 });
    }
    if (u.includes("api.typesafe.ai")) {
      return new Response(JSON.stringify({ data: [{ id: "jev" }] }), { status: opts.typesafe ?? 200 });
    }
    return new Response("unexpected host", { status: 404 });
  }) as typeof fetch;
  return { f, seen };
}
