const BRAVE_SEARCH_URL = "https://api.brave.com/v1/search";

export interface BraveResult {
  title: string;
  url: string;
  description: string;
}

export async function searchBrave(query: string, maxResults: number = 5): Promise<BraveResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_API_KEY not configured");
  }

  const response = await fetch(`${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${maxResults}`, {
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return (data.web?.results || [])
    .slice(0, maxResults)
    .map((r: any) => ({ title: r.title, url: r.url, description: r.description }));
}
