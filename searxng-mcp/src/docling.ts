const DEFAULT_DOCLING_URL = "http://localhost:30501/mcp";

interface McpError {
  code: number;
  message: string;
}

interface McpToolResult {
  content?: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface McpResponse<T = McpToolResult> {
  jsonrpc: "2.0";
  id?: number;
  result?: T;
  error?: McpError;
}

function parseSseResponse<T>(raw: string): McpResponse<T> {
  // streamable-http frames responses as SSE; pull the last `data:` line.
  const dataLines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l.length > 0);
  if (dataLines.length === 0) {
    throw new Error(`No data frames in Docling MCP response: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(dataLines[dataLines.length - 1]) as McpResponse<T>;
}

async function postMcp(
  baseUrl: string,
  sessionId: string | null,
  body: object,
  timeoutMs: number,
): Promise<{ text: string; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(baseUrl, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Docling MCP returned ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const returnedSession = response.headers.get("mcp-session-id");
  return { text, sessionId: returnedSession ?? sessionId };
}

async function doclingSession(baseUrl: string): Promise<string> {
  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "searxng-mcp", version: "1.0.0" },
    },
  };
  const { text, sessionId } = await postMcp(baseUrl, null, initBody, 10000);
  if (!sessionId) {
    throw new Error("Docling MCP did not return mcp-session-id on initialize");
  }
  // Parse to surface any protocol-level error.
  const parsed = parseSseResponse(text);
  if (parsed.error) {
    throw new Error(`Docling MCP initialize error: ${parsed.error.message}`);
  }
  await postMcp(
    baseUrl,
    sessionId,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    5000,
  );
  return sessionId;
}

async function callDoclingTool<T = McpToolResult>(
  baseUrl: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  id: number,
  timeoutMs: number,
): Promise<T> {
  const body = {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const { text } = await postMcp(baseUrl, sessionId, body, timeoutMs);
  const parsed = parseSseResponse<McpToolResult>(text);
  if (parsed.error) {
    throw new Error(`Docling MCP error: ${parsed.error.message}`);
  }
  if (!parsed.result) {
    throw new Error("Docling MCP returned no result");
  }
  if (parsed.result.isError) {
    const msg = parsed.result.content?.[0]?.text ?? "unknown error";
    throw new Error(`Docling MCP tool ${name} failed: ${msg}`);
  }
  if (parsed.result.structuredContent) {
    return parsed.result.structuredContent as T;
  }
  const textBlock = parsed.result.content?.[0]?.text ?? "";
  return { text: textBlock } as unknown as T;
}

async function closeDoclingSession(baseUrl: string, sessionId: string): Promise<void> {
  try {
    await fetch(baseUrl, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // best-effort cleanup; Docling will GC idle sessions on its own.
  }
}

export async function convertDocument(source: string): Promise<string> {
  const baseUrl = process.env.DOCLING_URL || DEFAULT_DOCLING_URL;
  const sessionId = await doclingSession(baseUrl);
  try {
    const convertResult = await callDoclingTool<{ document_key: string; from_cache: boolean }>(
      baseUrl,
      sessionId,
      "convert_document_into_docling_document",
      { source },
      2,
      180000,
    );
    if (!convertResult.document_key) {
      throw new Error("Docling convert returned no document_key");
    }
    const exportResult = await callDoclingTool<{ markdown: string }>(
      baseUrl,
      sessionId,
      "export_docling_document_to_markdown",
      { document_key: convertResult.document_key },
      3,
      30000,
    );
    if (!exportResult.markdown) {
      throw new Error("Docling export returned no markdown");
    }
    return exportResult.markdown;
  } finally {
    await closeDoclingSession(baseUrl, sessionId);
  }
}

export interface FastConvertResult {
  markdown: string;
  pages: number;
  chars: number;
  avgCharsPerPage: number;
  looksScanned: boolean;
}

/**
 * Fast PDF conversion via PyMuPDF4LLM (+pymupdf-layout) on the same docling-mcp pod.
 * Returns structured metadata so the orchestrator can decide whether to fall
 * back to the full docling pipeline for scanned / layout-heavy docs.
 */
export async function convertDocumentFast(source: string): Promise<FastConvertResult> {
  const baseUrl = process.env.DOCLING_URL || DEFAULT_DOCLING_URL;
  const sessionId = await doclingSession(baseUrl);
  try {
    const r = await callDoclingTool<{
      markdown: string;
      pages: number;
      chars: number;
      avg_chars_per_page: number;
      looks_scanned: boolean;
    }>(
      baseUrl,
      sessionId,
      "convert_url_fast",
      { source },
      2,
      60000,
    );
    if (typeof r.markdown !== "string") {
      throw new Error("convert_url_fast returned no markdown");
    }
    return {
      markdown: r.markdown,
      pages: r.pages,
      chars: r.chars,
      avgCharsPerPage: r.avg_chars_per_page,
      looksScanned: r.looks_scanned,
    };
  } finally {
    await closeDoclingSession(baseUrl, sessionId);
  }
}
