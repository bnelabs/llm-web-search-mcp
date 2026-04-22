import { searchSearXNG, SearxngResult } from "./searxng.js";
import { searchBrave, BraveResult } from "./brave.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export async function search(query: string, options: { maxResults?: number; categories?: string[]; timeRange?: string; language?: string } = {}): Promise<SearchResult[]> {
  const maxResults = options.maxResults || 5;

  // Try SearXNG first
  try {
    const results = await searchSearXNG(query, options);
    return results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      engine: r.engine || "SearXNG",
    }));
  } catch (err) {
    console.error(`[warn] SearXNG search failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fall back to Brave
  try {
    const results = await searchBrave(query, maxResults);
    return results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      engine: "Brave",
    }));
  } catch (err) {
    console.error(`[error] Brave search also failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
