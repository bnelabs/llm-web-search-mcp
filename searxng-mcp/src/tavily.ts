const DEFAULT_ENDPOINT = "https://api.tavily.com/search";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface TavilyRawResponse {
  query?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
  answer?: string;
  response_time?: number;
}

let quotaExhaustedLoggedUntil = 0;

/**
 * Search via Tavily's LLM-optimized web search API.
 *
 * Activates only when TAVILY_API_KEY is set in the environment. On 401/403
 * (bad/missing key) or 429 (quota exhausted) the function logs a single
 * warning and returns an empty list so the caller's other sources can
 * carry the request. Never throws to the orchestrator — Tavily is always
 * additive, never load-bearing.
 */
export async function searchTavily(
  query: string,
  maxResults: number = 5,
): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  const endpoint = process.env.TAVILY_URL || DEFAULT_ENDPOINT;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: Math.min(Math.max(maxResults, 1), 10),
        search_depth: "basic", // 1 credit; "advanced" would be 2.
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      console.error("[warn] Tavily: auth failed (bad/missing TAVILY_API_KEY); skipping Tavily.");
      return [];
    }
    if (res.status === 429) {
      if (Date.now() > quotaExhaustedLoggedUntil) {
        console.error("[warn] Tavily: rate-limited or quota exhausted; skipping until it recovers.");
        quotaExhaustedLoggedUntil = Date.now() + 10 * 60 * 1000; // rate-limit the log itself to 10 min
      }
      return [];
    }
    if (!res.ok) {
      console.error(`[warn] Tavily: HTTP ${res.status}; skipping this query.`);
      return [];
    }

    const data: TavilyRawResponse = await res.json();
    const out: TavilyResult[] = [];
    for (const r of data.results ?? []) {
      if (!r.url || !r.title) continue;
      out.push({
        title: r.title,
        url: r.url,
        content: r.content ?? "",
        score: r.score,
      });
    }
    return out;
  } catch (err) {
    console.error(`[warn] Tavily: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
