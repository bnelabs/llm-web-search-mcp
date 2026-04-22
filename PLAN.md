# Plan: Self-Hosted SearXNG + Docling MCP for LLM Web Search

## Context

You want a self-hosted, **client-agnostic** web search MCP server that works with any MCP-compatible client (Claude Code, OpenCode, Continue, Cursor, etc.):
- **Target machine**: Home Ubuntu server (RTX 3090 24GB VRAM, 64GB DDR4)
- **Search**: SearXNG (self-hosted, private, free)
- **Content extraction**: Docling (IBM, high-accuracy) for documents + Turndown for HTML → all output as Markdown
- **Token budget**: configurable per-client (your current setup: 262k max, 230k target) — enforced server-side
- **Use case**: Financial tables, tax sheets, balance sheets, annual plans, slide decks, investor relations documents, complex multi-format docs
- **Existing tools**: Playwright MCP (configured separately per client)

### Why Docling for Document Processing

Your use case (financial documents, complex tables) rules out lightweight Node.js parsers:

| Challenge | Node.js parsers (pdf-parse, mammoth, SheetJS) | Docling |
|-----------|-----------------------------------------------|---------|
| Multi-level table headers | Flattens, loses context | Preserves hierarchy with TableFormer ML model |
| Merged cells in balance sheets | Misaligns columns | Structural detection handles merges |
| Scanned PDF financial statements | No OCR | Built-in RapidOCR + EasyOCR |
| PPTX investor decks | Not supported | Full support with layout analysis |
| Reading order in multi-column PDFs | Often wrong | ML-based reading order detection |
| PDF tables without borders | Fails | Geometric + ML detection, doesn't need lines |
| Benchmark accuracy (overall) | ~0.6-0.7 | **0.882** |
| Benchmark table accuracy | ~0.4 (pdf-parse) | **High** (TableFormer model) |

Docling handles: **PDF, DOCX, PPTX, XLSX, HTML, images, CSV, LaTeX, plain text** — one tool for everything.

### Resource Impact on Server (64GB RAM, RTX 3090)

| Component | Idle RAM | Peak RAM | GPU VRAM | % of System |
|-----------|----------|----------|----------|-------------|
| SearXNG (K8s pod) | ~150MB | ~300MB | 0 | 0.5% |
| Docling-serve (K8s pod, GPU) | ~2GB | ~4-8GB | ~2-4GB | 6-12% RAM, 8-16% VRAM |
| MCP server (Node.js) | ~30MB | ~80MB | 0 | 0.1% |
| **Total** | **~2.2GB** | **~8.4GB** | **~4GB** | **~13% RAM, ~16% VRAM** |

Comfortable on 64GB. The 3090 provides **~6x speedup** for Docling's ML models vs CPU-only. With GPU, a complex 5-page PDF processes in seconds rather than minutes.

---

## Architecture Overview

```
LLM Client (Claude Code / OpenCode / Cursor / etc.)
    │
    │ stdio (MCP protocol)
    │
┌───▼──────────────────────────────┐
│  searxng-mcp (Node.js)           │
│  Token budget enforcement        │
│  3 tools: search, fetch, both    │
│                                  │
│  Content routing:                │
│  ├─ HTML → Readability+Turndown  │  (fast, in-process)
│  └─ PDF/DOCX/PPTX/XLSX/images   │
│      → Docling REST API ─────────┼──► docling-serve (K8s pod, GPU)
│        POST /v1/convert/source   │    Port 30501
│        Returns Markdown          │
│                                  │
│  Search:                         │
│  └─ SearXNG JSON API ───────────┼──► searxng (K8s pod)
│     GET /search?format=json      │    Port 30888
└──────────────────────────────────┘
```

**Key design: Hybrid routing**
- **HTML pages** (90%+ of web search results): handled in-process by Readability + Turndown — fast, no network hop
- **Documents** (PDF, DOCX, PPTX, XLSX, images): routed to Docling REST API — high accuracy, GPU-accelerated
- This avoids sending every HTML page through Docling (slow, overkill) while getting best accuracy for documents

---

## Implementation Plan

### Error Handling & Resilience

Every external call can fail. The MCP server must handle failures gracefully — never crash, always return useful feedback to the LLM client.

**Timeouts:**
| Call | Timeout | Rationale |
|------|---------|-----------|
| SearXNG search | 10s | Search should be fast; if SearXNG hangs, fail early |
| HTTP GET (HTML fetch) | 15s | Most pages load in <5s; 15s covers slow servers |
| Docling conversion | 60s | Complex PDFs with TableFormer can take 30s+; 60s is generous |
| HEAD request (content-type) | 5s | Quick probe; fall back to GET if it fails |

**Failure behavior per tool:**
- `searxng_search`: If SearXNG is unreachable → return `{ error: "Search service unavailable", results: [] }`. The LLM can retry or adjust.
- `searxng_fetch`: If URL returns 404/5xx → return `[Failed to fetch: HTTP {status}]`. If Docling is down and the URL is a document → return `[Document conversion unavailable — Docling service is not running. Try fetching an HTML page instead.]`
- `searxng_search_and_fetch`: Partial success is OK — return results that succeeded, note failures inline: `[Failed: {url} — {reason}]`

**Retry policy:** No automatic retries. The LLM client can retry if needed — retries at the MCP server level add latency and complexity without clear benefit.

**Content-Type detection strategy:**
1. First: check URL extension (`.pdf`, `.docx`, `.xlsx`, `.pptx`) — fast, no network call
2. If ambiguous: send GET request with streaming, read `Content-Type` header from response
3. If `Content-Type` header is missing or `application/octet-stream`: fall back to URL extension, then default to HTML pipeline
4. Skip HEAD requests entirely — too many servers block them or return wrong types

### Security: URL Validation

`searxng_fetch` accepts arbitrary URLs, creating an SSRF attack surface. Validate before fetching:

**Block list:**
- Private IP ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`
- Link-local: `169.254.0.0/16` (AWS/cloud metadata endpoint)
- IPv6 loopback and link-local
- Non-HTTP(S) schemes: block `file://`, `ftp://`, `gopher://`, `data:`, etc.

**Allow only:** `http://` and `https://` schemes pointing to public IP addresses.

**Implementation:** Resolve DNS first, check the resolved IP against the block list, then fetch. This prevents DNS rebinding attacks where a hostname resolves to a private IP.

### Phase 1: Prepare MicroK8s

MicroK8s is already installed on the server. Ensure required addons are enabled:

```bash
# Check current addons
microk8s status

# Enable required addons (if not already)
microk8s enable dns               # CoreDNS for service discovery
microk8s enable hostpath-storage  # Persistent storage
microk8s enable gpu               # NVIDIA GPU support for Docling
```

The `gpu` addon is critical — it enables the NVIDIA device plugin so Docling pods can request GPU resources.

### Phase 2: Deploy SearXNG on MicroK8s

**Step 1: Create namespace and ConfigMap for SearXNG settings**

Create `/home/komedihp/searxng/k8s/namespace.yaml`:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: searxng
```

Create `/home/komedihp/searxng/k8s/settings.yml`:
```yaml
use_default_settings: true

general:
  instance_name: "searxng-mcp"

search:
  safe_search: 0
  formats:
    - html
    - json

server:
  secret_key: "<generate with: openssl rand -hex 32>"
  limiter: false
  public_instance: false
  image_proxy: false

ui:
  static_use_hash: true

engines:
  - name: google
    engine: google
    shortcut: g
    disabled: false
  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg
    disabled: false
  - name: brave
    engine: brave
    shortcut: br
    disabled: false
  - name: wikipedia
    engine: wikipedia
    shortcut: wp
    disabled: false
  - name: stackoverflow
    engine: stackoverflow
    shortcut: so
    disabled: false
  - name: github
    engine: github
    shortcut: gh
    disabled: false
  - name: arxiv
    engine: arxiv
    shortcut: ax
    disabled: false
```

Create ConfigMap from the settings file:
```bash
microk8s kubectl create namespace searxng
microk8s kubectl -n searxng create configmap searxng-settings \
  --from-file=settings.yml=/home/komedihp/searxng/k8s/settings.yml
```

**Step 2: Create Deployment + Service**

Create `/home/komedihp/searxng/k8s/deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: searxng
  namespace: searxng
spec:
  replicas: 1
  selector:
    matchLabels:
      app: searxng
  template:
    metadata:
      labels:
        app: searxng
    spec:
      containers:
        - name: searxng
          image: searxng/searxng:latest
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: settings
              mountPath: /etc/searxng/settings.yml
              subPath: settings.yml
              readOnly: true
          readinessProbe:
            httpGet:
              path: /search?q=test&format=json
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 30
            timeoutSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 60
            timeoutSeconds: 5
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          securityContext:
            capabilities:
              drop: ["ALL"]
              add: ["CHOWN", "SETGID", "SETUID"]
      volumes:
        - name: settings
          configMap:
            name: searxng-settings
---
apiVersion: v1
kind: Service
metadata:
  name: searxng
  namespace: searxng
spec:
  type: NodePort
  selector:
    app: searxng
  ports:
    - port: 8080
      targetPort: 8080
      nodePort: 30888
```

**Step 3: Deploy and verify**

```bash
microk8s kubectl apply -f /home/komedihp/searxng/k8s/
microk8s kubectl -n searxng get pods  # wait for Running
curl -s "http://localhost:30888/search?q=test&format=json" | python3 -m json.tool | head -20
```

### Phase 3: Deploy Docling-serve on MicroK8s (GPU-accelerated)

**Step 1: Create namespace and deployment**

Create `/home/komedihp/docling/k8s/namespace.yaml`:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: docling
```

Create `/home/komedihp/docling/k8s/deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: docling-serve
  namespace: docling
spec:
  replicas: 1
  selector:
    matchLabels:
      app: docling-serve
  template:
    metadata:
      labels:
        app: docling-serve
    spec:
      containers:
        - name: docling-serve
          image: quay.io/docling-project/docling-serve-cu128:latest
          ports:
            - containerPort: 5001
          env:
            - name: UVICORN_WORKERS
              value: "1"
            - name: DOCLING_NUM_THREADS
              value: "4"
          resources:
            requests:
              memory: "2Gi"
              cpu: "500m"
              nvidia.com/gpu: "1"
            limits:
              memory: "8Gi"
              cpu: "2000m"
              nvidia.com/gpu: "1"
          readinessProbe:
            httpGet:
              path: /health
              port: 5001
            initialDelaySeconds: 30
            periodSeconds: 30
            timeoutSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 5001
            initialDelaySeconds: 60
            periodSeconds: 60
            timeoutSeconds: 10
          volumeMounts:
            - name: shm
              mountPath: /dev/shm
      volumes:
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: "2Gi"
---
apiVersion: v1
kind: Service
metadata:
  name: docling-serve
  namespace: docling
spec:
  type: NodePort
  selector:
    app: docling-serve
  ports:
    - port: 5001
      targetPort: 5001
      nodePort: 30501
```

Key decisions:
- **`docling-serve-cu128`** image: CUDA 12.8, pre-loaded ML models (no runtime downloads)
- **GPU requested**: `nvidia.com/gpu: 1` — uses the 3090 for ~6x speedup
- **`/dev/shm` mount**: shared memory for Chromium/ML models (prevents crashes)
- **Single worker**: stable for document processing workloads
- **NodePort 30501**: accessible from MCP server at `http://localhost:30501`
- **Image pinning**: After initial testing, pin both `searxng/searxng` and `docling-serve-cu128` to specific version tags or digests. `:latest` is fine for initial setup but risks silent breakage on updates

**Step 2: Deploy and verify**

```bash
microk8s kubectl apply -f /home/komedihp/docling/k8s/
microk8s kubectl -n docling get pods        # wait for Running (first pull ~5-10GB image)
microk8s kubectl -n docling logs -f docling-serve-xxx  # watch startup

# Test the API
curl -s -X POST "http://localhost:30501/v1/convert/source" \
  -H "Content-Type: application/json" \
  -d '{"source": "https://en.wikipedia.org/wiki/Balance_sheet", "options": {"to_format": "markdown"}}' \
  | python3 -m json.tool | head -50
```

### Phase 4: Build the MCP Server

**Location**: `/home/komedihp/searxng-mcp/`

**Dependencies**:
- `@modelcontextprotocol/sdk` — MCP TypeScript SDK
- `zod` — schema validation (required by MCP SDK)
- `@mozilla/readability` + `linkedom` — HTML article extraction (in-process, fast)
- `turndown` — HTML → Markdown conversion
- `typescript` — dev dependency

That's it. No pdf-parse, no mammoth, no SheetJS, no tesseract.js — **Docling handles all document formats** via its REST API. The MCP server stays lightweight.

**Files**:

| File | Purpose |
|------|---------|
| `src/tokens.ts` | Token estimation (4 chars ≈ 1 token), truncation at sentence boundaries |
| `src/searxng.ts` | SearXNG JSON API client (`/search?q=...&format=json`) |
| `src/docling.ts` | Docling REST API client (`POST /v1/convert/source`) |
| `src/extractor.ts` | Content-type router: HTML → in-process, everything else → Docling |
| `src/index.ts` | MCP server with 3 tools |

#### Content Pipeline (all output → Markdown)

```
HTTP Response (Content-Type detection from HEAD request)
│
├─ text/html ──────────────── In-process: Readability → Turndown → Markdown
│                              Fast (~50ms), no network hop
│                              Strips nav/ads/scripts, preserves structure
│                              Token savings: ~40-50% vs raw HTML
│
├─ application/pdf ──────────┐
├─ application/vnd.openxml ──┤
│  (docx/pptx/xlsx)          │
├─ text/csv ─────────────────┤ All routed to Docling REST API
├─ image/* ──────────────────┤ POST http://localhost:30501/v1/convert/source
│  (png/jpg/tiff)            │ GPU-accelerated, ML-based extraction
├─ application/vnd.ms-excel ─┤ Returns structured Markdown
├─ text/latex ───────────────┤
│                            │ Features:
│                            │ • TableFormer ML model for complex tables
│                            │ • RapidOCR + EasyOCR for scanned docs
│                            │ • Layout analysis for multi-column PDFs
│                            │ • Reading order detection
│                            │ • Image classification
├─ text/plain ───────────────┘
│
├─ application/json ───────── In-process: pretty-print → Markdown code block
│
├─ application/zip ────────── Extract → route each file through pipeline above
│                              Max 1 level deep (no nested archives)
│                              Max 10 files extracted
│                              Budget split proportionally by file size
│                              Skip files >50MB individually
│
└─ other ──────────────────── [Unsupported: content-type, size] placeholder
```

#### Financial Document Handling (Docling strengths)

| Document Type | What Docling Does | Why It Matters |
|---------------|-------------------|----------------|
| **Balance sheets (PDF)** | TableFormer detects table structure even without borders, handles merged cells, multi-level headers | Node.js parsers score 0.4 on table accuracy; Docling scores high |
| **Tax sheets (PDF/XLSX)** | Preserves cell relationships, handles `(negative)` notation as structure | Prevents misaligned columns that break LLM comprehension |
| **Investor decks (PPTX)** | Layout analysis extracts text + tables from slides in reading order | mammoth can't handle PPTX at all |
| **Annual plans (DOCX)** | Headings, nested lists, tables with merged cells all preserved | mammoth handles basic DOCX but fails on complex tables |
| **Excel financials (XLSX)** | Multi-sheet extraction, formula-resolved values, structured tables | SheetJS is decent here but Docling is more consistent |
| **Scanned documents** | Built-in OCR (RapidOCR + EasyOCR), no extra config | Tesseract.js requires manual setup and is less accurate |

#### Three MCP Tools

1. **`searxng_search`** — Search only, returns titles + URLs + snippets (~800 tokens for 5 results)
   - Params: `query`, `max_results` (default 5), `categories`, `time_range`, `language`
   - Use case: discovery, then selectively fetch with tool 2 or Playwright

2. **`searxng_fetch`** — Fetch one URL, convert to Markdown with token cap
   - Params: `url`, `max_tokens` (default 4000)
   - Routes: HTML → in-process; documents → Docling API
   - Use case: read a specific page/document found via search

3. **`searxng_search_and_fetch`** — Search + auto-fetch top N results with total budget
   - Params: `query`, `max_results` (default 3), `max_tokens_per_result` (default 4000), `total_token_budget` (default 20000), `categories`, `time_range`
   - All fetched content converted to Markdown
   - Use case: "research this topic" — one call, budget-enforced

### Phase 5: Caching & Logging

**In-memory LRU cache:**
- Key: `{url}:{max_tokens}` — same URL with different token budgets = different cache entries
- TTL: 5 minutes — web content changes, stale cache is worse than a re-fetch
- Max entries: 50 — keeps memory usage under ~10MB even with large pages
- Scope: per MCP server process (no shared state needed)
- Cache hits skip both fetch and conversion — instant response for the common "search then fetch same URL" pattern

**Logging (structured, to stderr):**
- MCP protocol uses stdio, so all logging goes to stderr (visible in client logs)
- Log levels: `error` (failures), `warn` (timeouts, fallbacks), `info` (tool calls, cache hits/misses)
- Format: JSON lines — `{"level":"info","tool":"searxng_fetch","url":"...","cache":"miss","duration_ms":1234}`
- No sensitive data in logs (no request bodies, no full content)

### Phase 6: Token Budget Strategy

**Server-side enforcement (hard caps):**
- `total_token_budget` default: 20,000 tokens (~80k chars) per search_and_fetch call
- `max_tokens_per_result` default: 4,000 tokens (~16k chars) per page
- Truncation at sentence boundaries (for text) or row boundaries (for tables)
- 4-chars-per-token heuristic intentionally overestimates = built-in safety margin

**Table-specific budget handling:**
- Tables from Docling come as Markdown tables
- If a table exceeds the per-result token budget: truncate rows, keep all columns (column headers are more important than trailing rows)
- Add `[... N more rows, total M rows in source]` footer
- For multi-sheet Excel: process sheets in order, stop when budget exhausted, note remaining sheets
- Max 100 rows per Markdown table regardless of token budget — tables beyond this size are unhelpful for LLMs. Add `[... N more rows]` footer

**Budget math for a typical session:**

| Component | Tokens |
|-----------|--------|
| System prompt + conversation history | 10k–80k |
| `searxng_search` (5 results) | ~800 |
| `searxng_search_and_fetch` (3 pages, default) | ~12k–20k |
| Safety headroom (262k - 230k) | 32k |
| **Available for search within 230k cap** | ~40k–60k |

**For heavy document analysis** (e.g., a 50-page annual report):
- Use `searxng_fetch` with `max_tokens: 15000` for a single important document
- Or use `searxng_search_and_fetch` with `total_token_budget: 40000` for deep research
- The LLM can make multiple calls, adjusting budgets based on what it's found so far

**Recommended LLM workflow (any client):**
1. `searxng_search` first (cheap) → see what's out there
2. `searxng_fetch` for specific promising URLs (controlled cost)
3. `searxng_search_and_fetch` for broad research (one-shot, budget-capped)
4. Playwright MCP only for JS-heavy SPAs that need browser rendering

### Phase 7: Register with MCP Clients

The server uses **stdio transport** (standard MCP protocol) — works with any MCP client. Configure per client:

**Claude Code** (`~/.claude/settings.json`):
```json
"mcpServers": {
  "searxng": {
    "command": "node",
    "args": ["/home/komedihp/searxng-mcp/dist/index.js"]
  }
}
```

**OpenCode** (`opencode.json` or config):
```json
{
  "mcpServers": {
    "searxng": {
      "command": "node",
      "args": ["/home/komedihp/searxng-mcp/dist/index.js"]
    }
  }
}
```

**Continue** (`~/.continue/config.yaml`):
```yaml
mcpServers:
  - name: searxng
    command: node
    args:
      - /home/komedihp/searxng-mcp/dist/index.js
```

**Cursor / Generic MCP client** (`mcp.json` or equivalent):
```json
{
  "searxng": {
    "command": "node",
    "args": ["/home/komedihp/searxng-mcp/dist/index.js"]
  }
}
```

All clients will discover the same 3 tools:
- `searxng_search`
- `searxng_fetch`
- `searxng_search_and_fetch`

### Phase 8: Verification

1. **MicroK8s pods**: `microk8s kubectl get pods -A` — searxng and docling-serve both Running
2. **GPU allocation**: `microk8s kubectl -n docling describe pod` — verify GPU attached
3. **SearXNG API**: `curl "http://localhost:30888/search?q=hello&format=json"` returns results
4. **Docling API**: `curl -X POST "http://localhost:30501/v1/convert/source" -H "Content-Type: application/json" -d '{"source":"https://example.com"}'` returns markdown
5. **MCP tools/list**: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js` shows 3 tools
6. **Client integration**: restart your MCP client, verify the 3 tools appear
7. **HTML test**: fetch a web article, verify clean Markdown output
8. **PDF table test**: fetch a PDF with financial tables, verify table structure preserved
9. **Budget test**: fetch a large document with `max_tokens: 500`, confirm truncation
10. **XLSX test**: fetch an Excel file, verify multi-sheet Markdown output

---

## Critical Files

- `/home/komedihp/searxng/k8s/namespace.yaml` — SearXNG K8s namespace
- `/home/komedihp/searxng/k8s/deployment.yaml` — SearXNG Deployment + NodePort Service (port 30888)
- `/home/komedihp/searxng/k8s/settings.yml` — SearXNG engine/API config (mounted as ConfigMap)
- `/home/komedihp/docling/k8s/namespace.yaml` — Docling K8s namespace
- `/home/komedihp/docling/k8s/deployment.yaml` — Docling-serve Deployment + NodePort Service (port 30501, GPU-enabled)
- `/home/komedihp/searxng-mcp/src/index.ts` — MCP server (3 tools)
- `/home/komedihp/searxng-mcp/src/tokens.ts` — Token estimation + truncation
- `/home/komedihp/searxng-mcp/src/searxng.ts` — SearXNG API client
- `/home/komedihp/searxng-mcp/src/docling.ts` — Docling REST API client
- `/home/komedihp/searxng-mcp/src/extractor.ts` — Content-type router (HTML in-process, docs → Docling)
- Per-client MCP config (varies by client — see Phase 6)

## Dependencies Summary

### MCP Server (Node.js — lightweight)

| Package | Size | Purpose |
|---------|------|---------|
| `@modelcontextprotocol/sdk` | ~2MB | MCP protocol |
| `zod` | ~500KB | Schema validation |
| `@mozilla/readability` | ~100KB | HTML article extraction |
| `linkedom` | ~500KB | Lightweight DOM |
| `turndown` | ~50KB | HTML → Markdown |
| `typescript` (dev) | ~60MB | Build only |
| **Runtime total** | **~3MB** | |

### K8s Services (containers)

| Service | Image | Size | RAM | GPU |
|---------|-------|------|-----|-----|
| SearXNG | `searxng/searxng:latest` | ~500MB | 128-512MB | None |
| Docling | `quay.io/docling-project/docling-serve-cu128:latest` | ~5-10GB | 2-8GB | 1x GPU (3090) |
