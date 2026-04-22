# Plan: LLM Productivity MCP Stack

Self-hosted, client-agnostic MCP server stack for LLM-powered web search, document extraction, and Google Workspace integration.

## Context

- **Target machine**: Home Ubuntu server (RTX 3090 24GB VRAM, 64GB DDR4, MicroK8s)
- **Search**: SearXNG (self-hosted, private, free) with Brave Search API fallback
- **Content extraction**: Docling (IBM, GPU-accelerated) for documents + Readability/Turndown for HTML
- **Google Workspace**: [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) — Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Chat, Tasks, Contacts
- **Token budget**: Server-side enforcement (configurable per call, default 20k tokens)
- **Use case**: Financial tables, tax sheets, balance sheets, annual plans, slide decks, investor relations documents
- **Clients**: Claude Code, OpenCode, Codex, Continue, Cursor — any MCP-compatible client
- **Existing tools**: Playwright MCP (configured separately per client)

---

## Architecture

```
LLM Client (Claude Code / OpenCode / Codex / Cursor / Continue)
    │
    │ stdio (MCP protocol)
    │
    ├──► searxng-mcp (Node.js, ~3MB)
    │    ├─ 3 tools: search, fetch, search_and_fetch
    │    ├─ Token budget enforcement (server-side)
    │    │
    │    ├─ Search: SearXNG → Brave API fallback
    │    │   ├──► SearXNG (K8s pod, port 30888)
    │    │   └──► Brave Search API (fallback, optional)
    │    │
    │    └─ Content extraction:
    │        ├─ HTML → Readability + Turndown (in-process, ~50ms)
    │        └─ PDF/DOCX/PPTX/XLSX/images → Docling REST API
    │            └──► docling-serve (K8s pod, GPU, port 30501)
    │
    └──► workspace-mcp (Python, community)
         ├─ Gmail, Calendar, Drive, Docs, Sheets, Slides
         ├─ Forms, Chat, Tasks, Contacts
         └─ OAuth 2.0/2.1 → Google APIs (direct, no intermediary)
```

**Key design decisions:**
- **Hybrid routing**: HTML in-process (fast), documents via Docling GPU (accurate). Avoids sending 90%+ of web results through slow GPU pipeline.
- **Two separate MCP servers**: Search/extraction is custom-built; Google Workspace uses a proven community server (2.1k stars, MIT). No point rebuilding what already works.
- **Client-agnostic**: Both servers use stdio transport. One config per client, works everywhere.

---

## Tool Overlap & Guidance

Google Workspace MCP includes a Custom Search tool. To avoid confusion with searxng-mcp's web search:

**Recommendation:** Launch workspace-mcp with explicit service list, omitting search:
```
uvx workspace-mcp --tools gmail drive calendar docs sheets slides forms chat tasks contacts
```

All client configs in `client-configs/` already use this approach.

**When to use which:**
| Need | Use |
|------|-----|
| Web search (Google, DuckDuckGo, Brave, etc.) | `searxng_search` |
| Fetch and extract a web page or document | `searxng_fetch` |
| Research a topic (search + fetch combined) | `searxng_search_and_fetch` |
| Read/send email | workspace-mcp Gmail tools |
| Check/create calendar events | workspace-mcp Calendar tools |
| Read/edit Google Docs, Sheets, Slides | workspace-mcp Docs/Sheets/Slides tools |
| Manage Drive files | workspace-mcp Drive tools |
| JS-heavy SPAs needing browser rendering | Playwright MCP (separate) |

---

## Execution Order

Phases are **not strictly linear** — some can be parallelized:

```
Track A (K8s infra — needs home server):     Track B (independent):
  Phase 1: Prepare MicroK8s                    Phase 7: Google Workspace MCP setup
  Phase 2: Deploy SearXNG                        (any machine with browser for OAuth)
  Phase 3: Deploy Docling
  Phase 4: Build MCP server
  Phase 5: Caching & Logging
  Phase 6: Token Budget Strategy
         │                                           │
         └──────────── Both merge ──────────────────┘
                           │
                    Phase 8: Register with clients
                    Phase 9: Verification
```

**Track B can start immediately** — Google Workspace MCP only needs Python 3.10+, a browser for OAuth, and a Google Cloud project. No K8s dependency.

---

## Why Docling for Document Processing

Financial documents rule out lightweight Node.js parsers:

| Challenge | Node.js parsers (pdf-parse, mammoth, SheetJS) | Docling |
|-----------|-----------------------------------------------|---------|
| Multi-level table headers | Flattens, loses context | Preserves hierarchy with TableFormer ML |
| Merged cells in balance sheets | Misaligns columns | Structural detection handles merges |
| Scanned PDF financial statements | No OCR | Built-in RapidOCR + EasyOCR |
| PPTX investor decks | Not supported | Full support with layout analysis |
| Reading order in multi-column PDFs | Often wrong | ML-based reading order detection |
| PDF tables without borders | Fails | Geometric + ML detection |
| Benchmark accuracy (overall) | ~0.6-0.7 | **0.882** |
| Benchmark table accuracy | ~0.4 (pdf-parse) | **High** (TableFormer model) |

Docling handles: **PDF, DOCX, PPTX, XLSX, HTML, images, CSV, LaTeX, plain text**.

### Resource Impact on Server (64GB RAM, RTX 3090)

| Component | Idle RAM | Peak RAM | GPU VRAM | % of System |
|-----------|----------|----------|----------|-------------|
| SearXNG (K8s pod) | ~150MB | ~300MB | 0 | 0.5% |
| Docling-serve (K8s pod, GPU) | ~2GB | ~4-8GB | ~2-4GB | 6-12% RAM, 8-16% VRAM |
| searxng-mcp (Node.js) | ~30MB | ~80MB | 0 | 0.1% |
| workspace-mcp (Python) | ~50MB | ~100MB | 0 | 0.2% |
| **Total** | **~2.2GB** | **~8.5GB** | **~4GB** | **~13% RAM, ~16% VRAM** |

---

## Implementation Plan

### Error Handling & Resilience

Every external call can fail. The MCP server must handle failures gracefully — never crash, always return useful feedback.

**Timeouts:**
| Call | Timeout | Rationale |
|------|---------|-----------|
| SearXNG search | 10s | Search should be fast; if SearXNG hangs, fail early |
| HTTP GET (HTML fetch) | 15s | Most pages load in <5s; 15s covers slow servers |
| Docling conversion | 60s | Complex PDFs with TableFormer can take 30s+; 60s is generous |

**Search fallback chain:**

```
Search request
  → try SearXNG (localhost:30888, 10s timeout)
  → if timeout/unreachable/5xx → try Brave Search API
  → if both fail → return error to LLM client
```

- `BRAVE_API_KEY` env var — optional. If unset, fallback is disabled.
- Brave free tier: 2,000 queries/month (sufficient for outage-only fallback)
- Fallback does NOT activate on 0 results (that's valid, not a failure)

**Failure behavior per tool:**
- `searxng_search`: SearXNG → Brave → `{ error: "Search service unavailable", results: [] }`
- `searxng_fetch`: HTTP errors → `[Failed to fetch: HTTP {status}]`. Docling down → `[Document conversion unavailable]`
- `searxng_search_and_fetch`: Partial success OK — return what succeeded, note failures inline

**Content-Type detection:**
1. Check URL extension (`.pdf`, `.docx`, `.xlsx`, `.pptx`) — fast, no network call
2. If ambiguous: GET with streaming, read `Content-Type` header
3. Missing/octet-stream: fall back to extension, then default HTML pipeline

### Security: URL Validation

`searxng_fetch` accepts arbitrary URLs — SSRF risk. Validate before fetching:

- **Block**: private IPs (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`), link-local (`169.254.0.0/16`), IPv6 loopback
- **Block**: non-HTTP schemes (`file://`, `ftp://`, `gopher://`, `data:`)
- **Allow only**: `http://` and `https://` to public IPs
- **Implementation**: Resolve DNS first, check resolved IP against block list, then fetch (prevents DNS rebinding)

### Phase 1: Prepare MicroK8s

MicroK8s is already installed. Enable required addons:

```bash
microk8s status
microk8s enable dns               # CoreDNS for service discovery
microk8s enable hostpath-storage  # Persistent storage
microk8s enable gpu               # NVIDIA GPU support for Docling
```

The `gpu` addon enables the NVIDIA device plugin so Docling pods can request GPU resources.

**Rollback:** If `gpu` addon fails, check NVIDIA driver with `nvidia-smi`. If driver is missing, install with `sudo apt install nvidia-driver-535` (or latest). If MicroK8s itself is broken, `microk8s reset` and re-enable addons.

### Phase 2: Deploy SearXNG on MicroK8s

**Manifests:** [`k8s/searxng/`](k8s/searxng/)
- `namespace.yaml` — K8s namespace
- `deployment.yaml` — Deployment + NodePort Service (port 30888), includes readiness/liveness probes
- `settings.yml` — SearXNG config (JSON output, engines, no rate limiter)

**Deploy:**
```bash
microk8s kubectl create namespace searxng
# Generate secret key and update settings.yml first:
# sed -i "s/<generate with: openssl rand -hex 32>/$(openssl rand -hex 32)/" k8s/searxng/settings.yml
microk8s kubectl -n searxng create configmap searxng-settings \
  --from-file=settings.yml=k8s/searxng/settings.yml
microk8s kubectl apply -f k8s/searxng/
microk8s kubectl -n searxng get pods  # wait for Running
curl -s "http://localhost:30888/search?q=test&format=json" | head -20
```

**Rollback:** If SearXNG pod crashes, check logs with `microk8s kubectl -n searxng logs -f <pod>`. Common issue: settings.yml syntax error. Fix and recreate ConfigMap. If SearXNG works but Google blocks requests, add more engines or rely on Brave fallback.

### Phase 3: Deploy Docling-serve on MicroK8s (GPU-accelerated)

**Manifests:** [`k8s/docling/`](k8s/docling/)
- `namespace.yaml` — K8s namespace
- `deployment.yaml` — Deployment + NodePort Service (port 30501), GPU-enabled, readiness/liveness probes

Key decisions:
- `docling-serve-cu128` image: CUDA 12.8, pre-loaded ML models
- GPU: `nvidia.com/gpu: 1` — ~6x speedup on 3090
- `/dev/shm` mount: shared memory for ML models (prevents crashes)
- Single worker: stable for document processing
- **Pin image versions** after initial testing (`:latest` risks silent breakage)

**Deploy:**
```bash
microk8s kubectl apply -f k8s/docling/
microk8s kubectl -n docling get pods  # wait for Running (first pull ~5-10GB)
curl -s -X POST "http://localhost:30501/v1/convert/source" \
  -H "Content-Type: application/json" \
  -d '{"source": "https://en.wikipedia.org/wiki/Balance_sheet", "options": {"to_format": "markdown"}}' \
  | head -50
```

**Rollback:** If Docling fails to start with GPU:
1. Check GPU visibility: `microk8s kubectl -n docling describe pod` — look for GPU allocation events
2. If GPU not detected: verify `nvidia-smi` works on host, then `microk8s enable gpu` again
3. **Plan B (CPU-only):** Remove `nvidia.com/gpu` resource requests from deployment.yaml. Docling works without GPU — just 6x slower. Acceptable for occasional document processing while debugging GPU issues.

### Phase 4: Build the MCP Server

**Location**: `/home/komedihp/searxng-mcp/`

**Dependencies** (runtime ~3MB):
- `@modelcontextprotocol/sdk` — MCP protocol
- `zod` — schema validation
- `@mozilla/readability` + `linkedom` — HTML extraction (in-process)
- `turndown` — HTML → Markdown

No pdf-parse, no mammoth, no SheetJS — Docling handles all document formats via REST API.

**Source files:**

| File | Purpose |
|------|---------|
| `src/tokens.ts` | Token estimation (4 chars ≈ 1 token), truncation at sentence boundaries |
| `src/searxng.ts` | SearXNG JSON API client |
| `src/brave.ts` | Brave Search API client (fallback) |
| `src/search.ts` | Search orchestrator: SearXNG → Brave fallback chain |
| `src/docling.ts` | Docling REST API client |
| `src/extractor.ts` | Content-type router: HTML → in-process, documents → Docling |
| `src/index.ts` | MCP server with 3 tools |

**Content pipeline (all output → Markdown):**

```
HTTP Response
├─ text/html ──────────────── Readability → Turndown (in-process, ~50ms)
├─ application/pdf ──────────┐
├─ application/vnd.openxml ──┤ Docling REST API (GPU-accelerated)
├─ text/csv ───────���─────────┤ POST http://localhost:30501/v1/convert/source
├─ image/* ──────────────────┤
├─ text/latex ───────────────┘
├─ application/json ───────── Pretty-print → Markdown code block
├─ application/zip ────────── Extract (max 1 level, max 10 files, skip >50MB) → route each file
└─ other ──────────────────── [Unsupported: content-type] placeholder
```

**Three MCP tools:**

1. **`searxng_search`** — Search only (~800 tokens for 5 results)
   - Params: `query`, `max_results` (5), `categories`, `time_range`, `language`

2. **`searxng_fetch`** — Fetch one URL → Markdown with token cap
   - Params: `url`, `max_tokens` (4000)
   - Routes: HTML in-process; documents → Docling

3. **`searxng_search_and_fetch`** — Search + auto-fetch with budget
   - Params: `query`, `max_results` (3), `max_tokens_per_result` (4000), `total_token_budget` (20000), `categories`, `time_range`

### Phase 5: Caching & Logging

**In-memory LRU cache:**
- Key: `{url}:{max_tokens}`
- TTL: 5 minutes
- Max entries: 50 (~10MB)
- Cache hits skip fetch + conversion — instant for "search then fetch same URL" pattern

**Logging (structured, to stderr):**
- MCP uses stdio, so logs go to stderr
- Format: JSON lines — `{"level":"info","tool":"searxng_fetch","url":"...","cache":"miss","duration_ms":1234}`
- Levels: `error` (failures), `warn` (timeouts/fallbacks), `info` (tool calls, cache)

### Phase 6: Token Budget Strategy

**Server-side enforcement (hard caps):**
- `total_token_budget` default: 20,000 tokens per search_and_fetch call
- `max_tokens_per_result` default: 4,000 tokens per page
- 4-chars-per-token heuristic (intentional overestimate = safety margin)
- Truncation at sentence boundaries (text) or row boundaries (tables)

**Table handling:**
- Truncate rows, keep all columns (headers more important than trailing rows)
- Max 100 rows per table regardless of budget
- Footer: `[... N more rows, total M rows in source]`
- Multi-sheet Excel: process in order, stop when budget exhausted

**Budget math (typical session):**

| Component | Tokens |
|-----------|--------|
| System prompt + history | 10k-80k |
| `searxng_search` (5 results) | ~800 |
| `searxng_search_and_fetch` (3 pages) | ~12k-20k |
| Safety headroom (262k - 230k) | 32k |
| **Available for search** | **~40k-60k** |

### Phase 7: Google Workspace MCP (Community)

Add [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) (2.1k stars, MIT, actively maintained).

**Services:** Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Chat, Apps Script, Tasks, Contacts

**Why this server:**
- Client-agnostic (stdio + streamable-http transports)
- OAuth 2.0/2.1 with auto token refresh
- No telemetry, no SaaS — data path: your machine → Google APIs only
- Tool tiers (`core`/`extended`/`complete`) or cherry-pick services
- MIT license, fully auditable

**Setup:**

1. Install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. Google Cloud Console → create OAuth Client ID (Desktop Application)
3. Enable APIs: Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Chat, Tasks, People
4. First run (opens browser for OAuth consent):
   ```bash
   export GOOGLE_OAUTH_CLIENT_ID="<your-client-id>"
   export GOOGLE_OAUTH_CLIENT_SECRET="<your-client-secret>"
   uvx workspace-mcp --tools gmail drive calendar docs sheets slides forms chat tasks contacts
   ```
5. Credentials stored in `~/.google_workspace_mcp/credentials/` and auto-refresh

**Rollback:** If OAuth fails, re-run with `OAUTHLIB_INSECURE_TRANSPORT=1` for local dev. If a specific Google API is not enabled, the error message will name it — enable in Cloud Console and retry. workspace-mcp itself is stateless; delete `~/.google_workspace_mcp/credentials/` to start fresh.

### Phase 8: Register Both MCP Servers with Clients

Ready-to-use client configs in [`client-configs/`](client-configs/):

| File | Client |
|------|--------|
| `claude-code.json` | Claude Code (`~/.claude/settings.json` → mcpServers section) |
| `opencode.json` | OpenCode (`opencode.json`) |
| `codex.json` | Codex (`mcp.json`) |
| `continue.yaml` | Continue (`~/.continue/config.yaml`) |
| `cursor.json` | Cursor / generic (`mcp.json`) |

**Environment variables (searxng-mcp):**
- `SEARXNG_URL` — default `http://localhost:30888`
- `DOCLING_URL` — default `http://localhost:30501`
- `BRAVE_API_KEY` — optional, enables search fallback

**Environment variables (workspace-mcp):**
- `GOOGLE_OAUTH_CLIENT_ID` — required
- `GOOGLE_OAUTH_CLIENT_SECRET` — required for confidential clients

All clients discover:
- **searxng-mcp**: `searxng_search`, `searxng_fetch`, `searxng_search_and_fetch`
- **workspace-mcp**: Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Chat, Tasks, Contacts tools

### Phase 9: Verification

**Search MCP:**
1. K8s pods running: `microk8s kubectl get pods -A`
2. GPU allocated: `microk8s kubectl -n docling describe pod`
3. SearXNG responds: `curl "http://localhost:30888/search?q=hello&format=json"`
4. Docling responds: `curl -X POST "http://localhost:30501/v1/convert/source" -H "Content-Type: application/json" -d '{"source":"https://example.com"}'`
5. MCP tools visible: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js`
6. HTML extraction: fetch a web article, verify clean Markdown
7. PDF table test: fetch a financial PDF, verify table structure
8. Budget truncation: `max_tokens: 500` on a large doc
9. XLSX test: multi-sheet Excel → Markdown

**Google Workspace MCP:**
10. Server starts: `uvx workspace-mcp --tools gmail drive calendar` — no errors
11. Gmail: ask LLM to list recent emails
12. Calendar: ask LLM to show today's events
13. Drive: ask LLM to list recent files
14. Cross-client: test from 2+ clients (e.g., Claude Code + OpenCode)

---

## Critical Files

| Path | Purpose |
|------|---------|
| `k8s/searxng/namespace.yaml` | SearXNG K8s namespace |
| `k8s/searxng/deployment.yaml` | SearXNG Deployment + Service (port 30888) |
| `k8s/searxng/settings.yml` | SearXNG engine/API config |
| `k8s/docling/namespace.yaml` | Docling K8s namespace |
| `k8s/docling/deployment.yaml` | Docling Deployment + Service (port 30501, GPU) |
| `client-configs/*.json, *.yaml` | Per-client MCP configuration |
| `searxng-mcp/src/` (to be built) | MCP server source code |
| `~/.google_workspace_mcp/` | OAuth tokens (auto-managed) |

## Dependencies

**searxng-mcp (Node.js, ~3MB runtime):** `@modelcontextprotocol/sdk`, `zod`, `@mozilla/readability`, `linkedom`, `turndown`

**K8s services:** SearXNG (~500MB image, 128-512MB RAM), Docling (~5-10GB image, 2-8GB RAM, 1x GPU)

**workspace-mcp (Python, community):** `workspace-mcp` via PyPI, Python 3.10+, `uv`/`uvx` (~50-100MB RAM)
