import { searchSearXNG, SearxngResult } from "./searxng.js";
import { searchBrave, BraveResult } from "./brave.js";
import { LruCache } from "./cache.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export interface SearchOptions {
  maxResults?: number;
  categories?: string[];
  timeRange?: string;
  language?: string;
}

// Cache by normalized query + options. Size 100 / 10 min TTL gives the LLM
// free re-queries during multi-turn research without re-hitting engines. This
// is the main defense against "looks like a bot" upstream: repeated identical
// queries don't leave the box.
const searchCache = new LruCache<SearchResult[]>({ maxSize: 100, ttlMinutes: 10 });

function cacheKey(query: string, options: SearchOptions): string {
  return JSON.stringify({
    q: query.trim().toLowerCase(),
    n: options.maxResults ?? 5,
    c: (options.categories ?? []).slice().sort(),
    t: options.timeRange ?? "",
    l: options.language ?? "",
  });
}

export async function search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const maxResults = options.maxResults || 5;
  const key = cacheKey(query, options);

  const cached = searchCache.get(key);
  if (cached) return cached;

  // Try SearXNG first
  try {
    const results = await searchSearXNG(query, options);
    const mapped: SearchResult[] = results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      engine: r.engine || "SearXNG",
    }));
    if (mapped.length > 0) {
      searchCache.set(key, mapped);
      return mapped;
    }
  } catch (err) {
    console.error(`[warn] SearXNG search failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fall back to Brave (the external API, separate from the disabled SearXNG brave engine)
  try {
    const results = await searchBrave(query, maxResults);
    const mapped: SearchResult[] = results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      engine: "Brave",
    }));
    if (mapped.length > 0) searchCache.set(key, mapped);
    return mapped;
  } catch (err) {
    console.error(`[error] Brave search also failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
