import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { search } from "./search.js";
import { convertDocument, convertDocumentFast, FastConvertResult } from "./docling.js";
import { extractHtml } from "./extractor.js";
import { validateUrl } from "./security.js";
import { LruCache } from "./cache.js";
import { estimateTokens, truncateToTokenLimit } from "./tokens.js";

const fetchCache = new LruCache<string>({ maxSize: 50, ttlMinutes: 15 });

function fetchKey(url: string, maxTokens: number, quality: string): string {
  return `${quality}:${maxTokens}:${url}`;
}

// FIFO docling semaphore: one conversion in-flight. Replaces the earlier
// module-global resolver pattern, which leaked pending promises when 3+
// callers queued concurrently (the 2nd waiter's resolver was overwritten
// by the 3rd, so the 2nd never resolved).
type Waiter = () => void;
const doclingWaiters: Waiter[] = [];
let doclingInFlight = false;

async function withDoclingSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  if (doclingInFlight) {
    await new Promise<void>((resolve) => doclingWaiters.push(resolve));
  }
  doclingInFlight = true;
  try {
    return await fn();
  } finally {
    doclingInFlight = false;
    const next = doclingWaiters.shift();
    if (next) next();
  }
}

function log(level: "info" | "warn" | "error", tool: string, details: Record<string, unknown>) {
  const entry = {
    level,
    tool,
    timestamp: new Date().toISOString(),
    ...details,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

type ExtractQuality = "auto" | "fast" | "accurate";

async function convertPdf(url: string, quality: ExtractQuality): Promise<string> {
  // Force-accurate: skip straight to docling. LLM asked for it (tables,
  // scanned docs, financial content). No fast-path attempt.
  if (quality === "accurate") {
    return await withDoclingSemaphore(() => convertDocument(url));
  }

  // Fast-only or auto: try PyMuPDF4LLM first.
  let fast: FastConvertResult;
  try {
    fast = await convertDocumentFast(url);
  } catch (err) {
    if (quality === "fast") throw err;
    log("warn", "searxng_fetch", { url, fastPathError: err instanceof Error ? err.message : String(err) });
    return await withDoclingSemaphore(() => convertDocument(url));
  }

  // In fast mode we return whatever pymupdf produced, empty or not.
  if (quality === "fast") {
    log("info", "searxng_fetch", { url, path: "fast", pages: fast.pages, avg: fast.avgCharsPerPage });
    return fast.markdown;
  }

  // Auto: accept fast result unless it looks scanned / near-empty.
  if (!fast.looksScanned && fast.chars > 0) {
    log("info", "searxng_fetch", { url, path: "fast", pages: fast.pages, avg: fast.avgCharsPerPage });
    return fast.markdown;
  }

  log("info", "searxng_fetch", {
    url,
    path: "fast->accurate",
    reason: fast.chars === 0 ? "empty" : "scanned",
    pages: fast.pages,
    avg: fast.avgCharsPerPage,
  });
  return await withDoclingSemaphore(() => convertDocument(url));
}

async function fetchUrl(url: string, maxTokens: number, quality: ExtractQuality): Promise<string> {
  const validation = await validateUrl(url);
  if (!validation.valid) {
    return `[URL rejected: ${validation.reason}]`;
  }

  const cached = fetchCache.get(fetchKey(url, maxTokens, quality));
  if (cached) {
    log("info", "searxng_fetch", { url, cache: "hit" });
    return cached;
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate",
    },
  });

  if (!response.ok) {
    return `[Failed to fetch: HTTP ${response.status}]`;
  }

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();

  const isDocument = contentType.includes("pdf") ||
    contentType.includes("docx") ||
    contentType.includes("pptx") ||
    contentType.includes("xlsx") ||
    contentType.includes("image") ||
    contentType.includes("csv") ||
    contentType.includes("latex");

  if (isDocument) {
    try {
      const contentLength = response.headers.get("content-length");
      const size = contentLength ? parseInt(contentLength) : body.length;
      if (size > 50 * 1024 * 1024) {
        return `[File too large: ${(size / 1024 / 1024).toFixed(0)}MB, limit is 50MB.]`;
      }

      const markdown = await convertPdf(url, quality);
      const tokens = estimateTokens(markdown);

      if (tokens > maxTokens) {
        const truncated = truncateToTokenLimit(markdown, maxTokens);
        fetchCache.set(fetchKey(url, maxTokens, quality), truncated);
        log("info", "searxng_fetch", { url, cache: "miss", tokens, truncated: true });
        return truncated;
      }

      fetchCache.set(fetchKey(url, maxTokens, quality), markdown);
      log("info", "searxng_fetch", { url, cache: "miss", tokens });
      return markdown;
    } catch (err) {
      log("error", "searxng_fetch", { url, error: err instanceof Error ? err.message : String(err) });
      return `[Document conversion unavailable. The converter may be starting up — try again shortly.]`;
    }
  }

  // HTML extraction
  try {
    const extracted = extractHtml(body, url);

    if (extracted.isBotProtected) {
      return `[This page is behind bot protection (Cloudflare/similar). Use Playwright MCP to fetch with full browser rendering.]`;
    }

    if (extracted.isPaywalled) {
      const truncated = truncateToTokenLimit(extracted.markdown, maxTokens);
      return `[Paywalled content — only preview/summary available.]\n\n${truncated}`;
    }

    if (extracted.isSpa) {
      const partial = truncateToTokenLimit(extracted.markdown, maxTokens);
      return `[Content may be incomplete — this page appears to require JavaScript rendering. Use Playwright MCP to fetch full content.]\n\n${partial}`;
    }

    const markdown = truncateToTokenLimit(extracted.markdown, maxTokens);
    fetchCache.set(fetchKey(url, maxTokens, quality), markdown);
    log("info", "searxng_fetch", { url, cache: "miss", tokens: estimateTokens(markdown) });
    return markdown;
  } catch (err) {
    log("error", "searxng_fetch", { url, error: err instanceof Error ? err.message : String(err) });
    return `[Failed to extract content: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

async function searchAndFetch(
  query: string,
  maxResults: number = 3,
  maxTokensPerResult: number = 4000,
  totalTokenBudget: number = 20000,
  categories?: string[],
  timeRange?: string,
  language?: string,
  quality: ExtractQuality = "auto",
): Promise<string> {
  const results = await search(query, { maxResults, categories, timeRange, language });
  if (results.length === 0) {
    return `No search results for "${query}".`;
  }

  log("info", "searxng_search_and_fetch", { query, resultsCount: results.length, budget: totalTokenBudget, quality });

  const budgetPerResult = Math.min(maxTokensPerResult, Math.floor(totalTokenBudget / results.length));

  // Parallel fetches. HTML is in-process (trivial concurrency); PDF calls
  // serialize on the docling semaphore anyway. Running them concurrently cuts
  // wall-clock for mixed batches without concurrent CPU load on docling.
  const fetched = await Promise.all(
    results.map((r) =>
      fetchUrl(r.url, budgetPerResult, quality)
        .then((content) => ({ ok: true as const, r, content }))
        .catch((err) => ({ ok: false as const, r, err: err instanceof Error ? err.message : String(err) })),
    ),
  );

  const responses: string[] = [];
  let totalTokens = 0;
  for (const item of fetched) {
    if (!item.ok) {
      responses.push(`[${item.r.title}] — Failed to fetch: ${item.err}`);
      continue;
    }
    if (totalTokens >= totalTokenBudget) {
      responses.push(`[${item.r.title}] — Budget exhausted, skipping.`);
      continue;
    }
    const tokens = estimateTokens(item.content);
    totalTokens += tokens;
    responses.push(`[${item.r.title}](${item.r.url})\n${item.content}`);
  }

  return responses.join("\n\n---\n\n");
}

const QUALITY_SCHEMA = z
  .enum(["auto", "fast", "accurate"])
  .optional()
  .default("auto")
  .describe(
    'Document extraction quality. "auto" (default): PyMuPDF4LLM with fallback to docling for scanned docs. "fast": PyMuPDF4LLM only. "accurate": docling for best table / layout quality (use for financial or scanned content).',
  );

const server = new McpServer({
  name: "searxng-mcp",
  version: "1.1.0",
});

server.tool(
  "searxng_search",
  "Search the web using SearXNG (or Brave Search as fallback). Returns title, URL, and snippet for each result. Results are cached for 10 minutes.",
  {
    query: z.string().describe("Search query"),
    max_results: z.number().optional().default(5).describe("Maximum number of results (1-20)"),
    categories: z.array(z.string()).optional().describe("Search categories: general, images, videos, news, etc."),
    time_range: z.string().optional().describe("Time range: day, week, month, year"),
    language: z.string().optional().describe("Language code (e.g., en, de, ja)"),
  },
  async ({ query, max_results, categories, time_range, language }) => {
    const results = await search(query, { maxResults: max_results, categories, timeRange: time_range, language });

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No results found for "${query}".` }] };
    }

    const text = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}\n   [Source: ${r.engine}]`)
      .join("\n\n");

    log("info", "searxng_search", { query, count: results.length });
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "searxng_fetch",
  "Fetch a URL and extract its content as Markdown. Handles HTML pages, PDFs, DOCX, PPTX, XLSX, images, and CSV files. Token-limited output.",
  {
    url: z.string().describe("URL to fetch and extract"),
    max_tokens: z.number().optional().default(4000).describe("Maximum output tokens (content truncated after this limit)"),
    extract_quality: QUALITY_SCHEMA,
  },
  async ({ url, max_tokens, extract_quality }) => {
    const content = await fetchUrl(url, max_tokens, extract_quality as ExtractQuality);
    log("info", "searxng_fetch", { url, tokens: estimateTokens(content), quality: extract_quality });
    return { content: [{ type: "text", text: content }] };
  },
);

server.tool(
  "searxng_search_and_fetch",
  "Search the web and automatically fetch content from the top results with token budget enforcement. Ideal for research tasks.",
  {
    query: z.string().describe("Search query"),
    max_results: z.number().optional().default(3).describe("Maximum number of results to fetch"),
    max_tokens_per_result: z.number().optional().default(4000).describe("Max tokens per individual result"),
    total_token_budget: z.number().optional().default(20000).describe("Total token budget across all results"),
    categories: z.array(z.string()).optional().describe("Search categories"),
    time_range: z.string().optional().describe("Time range: day, week, month, year"),
    language: z.string().optional().describe("Language code"),
    extract_quality: QUALITY_SCHEMA,
  },
  async ({ query, max_results, max_tokens_per_result, total_token_budget, categories, time_range, language, extract_quality }) => {
    const content = await searchAndFetch(
      query,
      max_results,
      max_tokens_per_result,
      total_token_budget,
      categories,
      time_range,
      language,
      extract_quality as ExtractQuality,
    );
    return { content: [{ type: "text", text: content }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[info] searxng-mcp server started on stdio");
}

main().catch((err) => {
  console.error("[error] Failed to start searxng-mcp:", err);
  process.exit(1);
});
