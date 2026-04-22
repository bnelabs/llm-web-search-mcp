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

interface SearxngRawResponse {
  results: SearxngRawResult[];
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
  return data.results.slice(0, options.maxResults || 5).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content ?? "",
    engine: r.engine,
  }));
}
