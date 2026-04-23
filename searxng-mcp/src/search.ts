import { searchSearXNG } from "./searxng.js";
import { searchBrave } from "./brave.js";
import { searchTavily } from "./tavily.js";
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
// free re-queries during multi-turn research without re-hitting upstream.
// Primary defense against "looks like a bot" to upstream engines.
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

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    // Strip common tracking params + trailing slash; keep host+path+meaningful query.
    for (const p of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "ref_src"]) {
      url.searchParams.delete(p);
    }
    let s = `${url.protocol}//${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
    const q = url.searchParams.toString();
    if (q) s += `?${q}`;
    return s.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

function mergeDedupe(...lists: SearchResult[][]): SearchResult[] {
  // Round-robin interleave across lists, deduping by normalized URL. Each
  // source gets fair representation in the top-N instead of the first
  // source monopolizing slice(0, maxResults). When URLs collide we keep
  // the longer snippet (Tavily's cleaned content usually beats Bing's).
  const seen = new Map<string, SearchResult>();
  const order: string[] = [];
  const maxLen = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      const r = list[i];
      if (!r) continue;
      const k = normalizeUrl(r.url);
      const prev = seen.get(k);
      if (prev) {
        if ((r.snippet?.length ?? 0) > (prev.snippet?.length ?? 0)) {
          seen.set(k, r);
        }
        continue;
      }
      seen.set(k, r);
      order.push(k);
    }
  }
  return order.map((k) => seen.get(k)!);
}

export async function search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const maxResults = options.maxResults || 5;
  const key = cacheKey(query, options);

  const cached = searchCache.get(key);
  if (cached) return cached;

  // Fan out SearXNG + Tavily in parallel. Both tolerate empty responses and
  // never throw to us — they degrade to []. Tavily is a no-op when the API
  // key isn't set, so the pipeline works unchanged without it.
  const [searxngRaw, tavilyRaw] = await Promise.all([
    searchSearXNG(query, options)
      .then((rs) => rs.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        engine: r.engine || "SearXNG",
      })))
      .catch((err) => {
        console.error(`[warn] SearXNG search failed: ${err instanceof Error ? err.message : String(err)}`);
        return [] as SearchResult[];
      }),
    searchTavily(query, maxResults)
      .then((rs) => rs.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        engine: "Tavily",
      }))),
  ]);

  // Tavily leads: its snippets are pre-cleaned and longer than Bing's. When
  // Tavily returns fewer than maxResults (or is disabled/keyless), Bing
  // fills the remainder. Without this, the post-merge slice would throw
  // away Tavily entirely whenever Bing returned >= maxResults first.
  const merged = mergeDedupe(tavilyRaw, searxngRaw);

  if (merged.length > 0) {
    const trimmed = merged.slice(0, maxResults);
    searchCache.set(key, trimmed);
    return trimmed;
  }

  // Last-ditch: Brave Search API (separate from the SearXNG brave engine we disabled).
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
    console.error(`[error] All search sources failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
