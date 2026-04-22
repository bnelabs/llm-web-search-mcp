import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { search } from "./search.js";
import { convertDocument } from "./docling.js";
import { extractHtml } from "./extractor.js";
import { validateUrl } from "./security.js";
import { LruCache } from "./cache.js";
import { estimateTokens, truncateToTokenLimit } from "./tokens.js";

const cache = new LruCache({ maxSize: 50, ttlMinutes: 15 });

// Semaphore for Docling requests (max 1 in-flight)
let doclingBusy = false;
let doclingResolve: (() => void) | null = null;
let doclingReject: (() => void) | null = null;

async function withDoclingSemaphore(fn: () => Promise<string>, timeoutMs = 60000): Promise<string> {
  if (doclingBusy) {
    return new Promise<string>((resolve, reject) => {
      doclingResolve = () => resolve(fn());
      doclingReject = () => reject(new Error("Docling request timed out"));

      setTimeout(() => {
        if (doclingResolve) {
          doclingResolve = null;
          doclingReject?.();
          console.error(`[error] Docling semaphore timed out after ${timeoutMs}ms`);
        }
      }, timeoutMs);
    });
  }

  doclingBusy = true;
  try {
    return await fn();
  } finally {
    doclingBusy = false;
    doclingResolve?.();
    doclingResolve = null;
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

async function fetchUrl(url: string, maxTokens: number): Promise<string> {
  // Validate URL (SSRF protection)
  const validation = await validateUrl(url);
  if (!validation.valid) {
    return `[URL rejected: ${validation.reason}]`;
  }

  // Check cache
  const cached = cache.get(url, maxTokens);
  if (cached) {
    log("info", "searxng_fetch", { url, cache: "hit" });
    return cached;
  }

  // Fetch content
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

  // Route based on content type
  const isDocument = contentType.includes("pdf") ||
    contentType.includes("docx") ||
    contentType.includes("pptx") ||
    contentType.includes("xlsx") ||
    contentType.includes("image") ||
    contentType.includes("csv") ||
    contentType.includes("latex");

  const isHtml = contentType.includes("html") || contentType.includes("text/") || isDocument === false;

  if (isDocument) {
    try {
      // Size check
      const contentLength = response.headers.get("content-length");
      const size = contentLength ? parseInt(contentLength) : body.length;
      if (size > 50 * 1024 * 1024) {
        return `[File too large: ${(size / 1024 / 1024).toFixed(0)}MB, limit is 50MB.]`;
      }

      // Use Docling MCP for document conversion
      const result = await withDoclingSemaphore(async () => {
        return convertDocument(url);
      });

      const markdown = typeof result === "string" ? result : String(result);
      const tokens = estimateTokens(markdown);

      if (tokens > maxTokens) {
        const truncated = truncateToTokenLimit(markdown, maxTokens);
        cache.set(url, maxTokens, truncated);
        log("info", "searxng_fetch", { url, cache: "miss", tokens, truncated: true });
        return truncated;
      }

      cache.set(url, maxTokens, markdown);
      log("info", "searxng_fetch", { url, cache: "miss", tokens });
      return markdown;
    } catch (err) {
      log("error", "searxng_fetch", { url, error: err instanceof Error ? err.message : String(err) });
      return `[Document conversion unavailable. Docling MCP may be starting up — try again shortly.]`;
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
    cache.set(url, maxTokens, markdown);
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
): Promise<string> {
  // Search
  const results = await search(query, { maxResults, categories, timeRange, language });
  if (results.length === 0) {
    return `No search results for "${query}".`;
  }

  log("info", "searxng_search_and_fetch", { query, resultsCount: results.length, budget: totalTokenBudget });

  // Calculate budget per result
  let budgetPerResult = Math.min(maxTokensPerResult, Math.floor(totalTokenBudget / results.length));
  const responses: string[] = [];
  let totalTokens = 0;

  for (let i = 0; i < results.length; i++) {
    if (totalTokens >= totalTokenBudget) {
      responses.push(`[${results[i].title}] — Budget exhausted, skipping.`);
      continue;
    }

    try {
      const content = await fetchUrl(results[i].url, budgetPerResult);
      const tokens = estimateTokens(content);
      totalTokens += tokens;

      responses.push(`[${results[i].title}](${results[i].url})\n${content}`);
    } catch (err) {
      responses.push(`[${results[i].title}] — Failed to fetch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return responses.join("\n\n---\n\n");
}

// Create MCP server
const server = new McpServer({
  name: "searxng-mcp",
  version: "1.0.0",
});

// Tool: searxng_search
server.tool(
  "searxng_search",
  "Search the web using SearXNG (or Brave Search as fallback). Returns title, URL, and snippet for each result.",
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
      return {
        content: [{ type: "text", text: `No results found for "${query}".` }],
      };
    }

    const text = results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}\n   [Source: ${r.engine}]`,
      )
      .join("\n\n");

    log("info", "searxng_search", { query, count: results.length });
    return { content: [{ type: "text", text }] };
  },
);

// Tool: searxng_fetch
server.tool(
  "searxng_fetch",
  "Fetch a URL and extract its content as Markdown. Handles HTML pages, PDFs, DOCX, PPTX, XLSX, images, and CSV files. Token-limited output.",
  {
    url: z.string().describe("URL to fetch and extract"),
    max_tokens: z.number().optional().default(4000).describe("Maximum output tokens (content truncated after this limit)"),
  },
  async ({ url, max_tokens }) => {
    const content = await fetchUrl(url, max_tokens);
    log("info", "searxng_fetch", { url, tokens: estimateTokens(content) });
    return { content: [{ type: "text", text: content }] };
  },
);

// Tool: searxng_search_and_fetch
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
  },
  async ({ query, max_results, max_tokens_per_result, total_token_budget, categories, time_range, language }) => {
    const content = await searchAndFetch(query, max_results, max_tokens_per_result, total_token_budget, categories, time_range, language);
    return { content: [{ type: "text", text: content }] };
  },
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[info] searxng-mcp server started on stdio");
}

main().catch((err) => {
  console.error("[error] Failed to start searxng-mcp:", err);
  process.exit(1);
});
