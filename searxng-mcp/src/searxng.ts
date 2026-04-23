const DEFAULT_SEARXNG_URL = "http://localhost:30888";

export interface SearxngResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

interface SearxngRawResult {
  title: string;
  url: string;
  content?: string;
  engine?: string;
}

interface SearxngInfobox {
  infobox?: string;
  id?: string;
  content?: string;
  engine?: string;
  engines?: string[];
  urls?: Array<{ title?: string; url: string }>;
}

interface SearxngRawResponse {
  results: SearxngRawResult[];
  infoboxes?: SearxngInfobox[];
  number_of_results?: number;
  query: string;
}

export async function searchSearXNG(
  query: string,
  options: {
    maxResults?: number;
    categories?: string[];
    timeRange?: string;
    language?: string;
    url?: string;
  } = {},
): Promise<SearxngResult[]> {
  const baseUrl = options.url || process.env.SEARXNG_URL || DEFAULT_SEARXNG_URL;
  const params = new URLSearchParams({
    q: query,
    format: "json",
    pages: String(options.maxResults || 5),
  });

  if (options.categories?.length) {
    params.set("categories", options.categories.join(","));
  }
  if (options.timeRange) {
    params.set("time_range", options.timeRange);
  }
  if (options.language) {
    params.set("language", options.language);
  }

  const response = await fetch(`${baseUrl}/search?${params}`, {
    signal: AbortSignal.timeout(10000),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`SearXNG returned ${response.status}: ${response.statusText}`);
  }

  const data: SearxngRawResponse = await response.json();
  const max = options.maxResults || 5;

  const results: SearxngResult[] = data.results.slice(0, max).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content ?? "",
    engine: r.engine,
  }));

  // Wikipedia (and other knowledge-panel engines) land in `infoboxes`, not
  // `results`. Surface the best one as a synthetic first result when the
  // main result list didn't already include a Wikipedia link for the same
  // topic. Without this, "What is X?" queries that only Wikipedia answered
  // would look empty to callers.
  const infobox = data.infoboxes?.[0];
  if (infobox && infobox.content) {
    const primaryUrl = infobox.urls?.[0]?.url ?? "";
    const hasSameUrl = primaryUrl && results.some((r) => r.url === primaryUrl);
    if (!hasSameUrl) {
      results.unshift({
        title: infobox.infobox ?? "Knowledge panel",
        url: primaryUrl,
        snippet: infobox.content,
        engine: infobox.engine ?? (infobox.engines ?? ["infobox"])[0],
      });
    }
  }

  return results.slice(0, max);
}
