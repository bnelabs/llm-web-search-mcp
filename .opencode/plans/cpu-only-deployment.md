# Plan: LLM Web Search MCP Stack — CPU-only Deployment

Self-hosted, client-agnostic MCP server stack for LLM-powered web search and document extraction.

## Context

- **Target machine**: Ubuntu server (i9-12900KF, 62GB RAM, RTX 3090 24GB — fully consumed by llama-server)
- **GPU**: Not available for this stack (24GB used by llama-server at 98%)
- **Search**: SearXNG (self-hosted, private) with Brave Search API fallback
- **Document extraction**: Docling MCP (official IBM, CPU, runs on i9-12900KF)
- **Google Workspace**: [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) (community, stdio)
- **Container runtime**: Docker + MicroK8s registry (localhost:32000)
- **MicroK8s**: v1.35.0 with dns, hostpath-storage, helm3, ingress, metrics-server addons
- **Node.js**: v22.22.2 / npm 10.9.7
- **Python**: 3.12.3 (uv to be installed)
- **Use case**: Financial tables, tax sheets, balance sheets, annual plans, slide decks, investor relations documents
- **Clients**: Claude Code, OpenCode, Codex, Continue, Cursor — any MCP-compatible client

---

## Architecture

```
LLM Client (Claude Code / OpenCode / Codex / Cursor / Continue)
    │
    │ stdio (MCP protocol)
    │
    ├──► searxng-mcp (Node.js, local process)
    │    ├─ 3 tools: searxng_search, searxng_fetch, searxng_search_and_fetch
    │    ├─ Token budget enforcement (server-side)
    │    │
    │    ├─ Search: SearXNG → Brave API fallback
    │    │   ├──► SearXNG (K8s pod, NodePort :30888)
    │    │   └──► Brave Search API (fallback, optional)
    │    │
    │    └─ Content extraction:
    │        ├─ HTML → Readability + Turndown (in-process, ~50ms)
    │        └─ PDF/DOCX/PPTX/XLSX/images → Docling MCP (HTTP)
    │            └──► docling-mcp (K8s pod, NodePort :30501, streamable-http)
    │
    └──► workspace-mcp (Python, local process, uvx)
         └─ Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Chat, Tasks, Contacts
```

**Key design decisions:**
- **Single stdio server**: searxng-mcp is the only MCP server the client sees. It internally calls SearXNG (HTTP) and Docling MCP (HTTP). Client config has 1 entry, not 2.
- **CPU-only**: No GPU needed. i9-12900KF (24 threads) handles Docling inference at ~1.5-2 pages/sec.
- **Official Docling MCP**: Uses `docling-mcp` Python package (584 stars, MIT) via streamable-http transport — no custom docling-serve, no CUDA image (~1.5-2GB vs 5-10GB).
- **Hybrid routing**: HTML in-process (fast), documents via Docling MCP (accurate). 90%+ of requests stay under 200ms.
- **Client-agnostic**: searxng-mcp uses stdio. workspace-mcp uses stdio. One config per client.

---

## Tool Guidance

Google Workspace MCP includes a Custom Search tool. To avoid confusion with searxng-mcp:

**Recommendation:** Launch workspace-mcp with explicit service list, omitting search:
```
uvx workspace-mcp --tools gmail drive calendar docs sheets slides forms chat tasks contacts
```

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
| JS-heavy SPAs (Angular, React, Vue) | Playwright MCP (separate) |

---

## Resource Impact on Server (62GB RAM, i9-12900KF)

| Component | Idle RAM | Peak RAM | GPU VRAM | % of System |
|-----------|----------|----------|----------|-------------|
| SearXNG (K8s pod) | ~150MB | ~300MB | 0 | 0.5% |
| Docling MCP (K8s pod) | ~500MB | ~2GB | 0 | 0.8% |
| searxng-mcp (Node.js) | ~30MB | ~80MB | 0 | 0.1% |
| workspace-mcp (Python) | ~50MB | ~100MB | 0 | 0.2% |
| **Total** | **~730MB** | **~2.5GB** | 0 | **~4%** |
| **Available headroom** | | **~46.5GB free** | | |

Docling CPU performance benchmarks (16-core CPU baseline):
- Standard pipeline (no OCR): ~1.5 pages/sec
- Standard pipeline (with OCR): ~1.2 pages/sec
- Your i9-12900KF (24 threads) should match or exceed these

---

## Execution Order

```
Phase 0: Install prerequisites (uv, Node.js deps)
Phase 1: Deploy SearXNG to MicroK8s
Phase 2: Build & deploy Docling MCP to MicroK8s
Phase 3: Build searxng-mcp server
Phase 4: Configure clients
Phase 5: Verification
```

---

## Error Handling & Resilience

**Timeouts:**
| Call | Timeout | Rationale |
|------|---------|-----------|
| SearXNG search | 10s | Search should be fast |
| HTTP GET (HTML fetch) | 15s | Most pages load in <5s |
| Docling conversion | 120s | CPU conversion of complex PDFs can take 60-90s |

**Search fallback chain:**
```
Search request
  → try SearXNG (K8s Service, 10s timeout)
  → if timeout/unreachable/5xx → try Brave Search API
  → if both fail → return error to LLM client
```

- `BRAVE_API_KEY` env var — optional. If unset, fallback is disabled.
- Brave free tier: 2,000 queries/month (sufficient for outage-only fallback)
- Fallback does NOT activate on 0 results

**Failure behavior per tool:**
- `searxng_search`: SearXNG → Brave → `{ error: "Search service unavailable", results: [] }`
- `searxng_fetch`: HTTP errors → `[Failed to fetch: HTTP {status}]`. Docling down → `[Document conversion unavailable. Docling MCP pod may be starting up — try again in 30s.]`
- `searxng_search_and_fetch`: Partial success OK — return what succeeded, note failures inline

**Content-Type detection:**
1. Check URL extension (`.pdf`, `.docx`, `.xlsx`, `.pptx`) — fast, no network call
2. If ambiguous: GET with streaming, read `Content-Type` header
3. Missing/octet-stream: fall back to extension, then default HTML pipeline

**Download size limit:**
- Hard cap: **50MB** per URL. Stream and abort if exceeded.

**Concurrent Docling requests:**
- Semaphore (max 1 in-flight). Wait up to 60s, then fail with estimated remaining time.

**Stale search results (404 handling):**
- Redistribute token budget to remaining results on 404/410.

**Character encoding:**
- Read `Content-Type` charset → HTML `<meta charset>` → UTF-8 fallback.

---

## Web Content Edge Cases

**Paywalled content:** Detect keywords ("subscribe", "sign in"), short content with login links, known paywall domains. Return preview + hint.

**Cloudflare / bot protection:** Realistic headers. Detect challenge signatures. Return hint to use Playwright MCP.

**Cookie consent / GDPR banners:** Strip DOM elements with `id`/`class` containing: `cookie`, `consent`, `gdpr`, `privacy-banner`, `cc-banner`, `onetrust`.

**SPA detection:** Extracted text < 100 chars AND raw HTML > 50KB → hint to use Playwright MCP.

---

## Security: URL Validation

`searxng_fetch` accepts arbitrary URLs — SSRF risk. Validate before fetching:

- **Block**: private IPs (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`), link-local (`169.254.0.0/16`), IPv6 loopback
- **Block**: non-HTTP schemes (`file://`, `ftp://`, `gopher://`, `data:`)
- **Allow only**: `http://` and `https://` to public IPs
- **Implementation**: Resolve DNS first, check resolved IP, then fetch (prevents DNS rebinding)

---

## Phase 0: Install Prerequisites

### Install uv (Python package manager)
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc
uv --version
```

### Verify MicroK8s addons
```bash
microk8s status
# Should show: dns, hostpath-storage enabled
# gpu addon is already enabled — leave it, doesn't hurt
```

---

## Phase 1: Deploy SearXNG to MicroK8s

**Manifests:** `k8s/searxng/`
- `namespace.yaml` — K8s namespace (already exists)
- `deployment.yaml` — Deployment + NodePort Service (port 30888) — needs version pinning + PVC
- `settings.yml` — SearXNG config (engines, JSON output, no rate limiter) — needs secret key

**Steps:**

1. Generate secret key:
```bash
SECRET=$(openssl rand -hex 32)
sed -i "s|secret_key: \".*\"|secret_key: \"$SECRET\"|" k8s/searxng/settings.yml
```

2. Deploy:
```bash
microk8s kubectl apply -f k8s/searxng/namespace.yaml
microk8s kubectl -n searxng create configmap searxng-settings \
  --from-file=settings.yml=k8s/searxng/settings.yml --dry-run=client -o yaml | \
  microk8s kubectl apply -f -
microk8s kubectl apply -f k8s/searxng/deployment.yaml
microk8s kubectl -n searxng get pods -w
```

3. Verify:
```bash
curl -s "http://localhost:30888/search?q=test&format=json" | python3 -m json.tool | head -30
```

**Rollback:**
- Pod crash → `microk8s kubectl -n searxng logs -f <pod>`
- settings.yml YAML syntax error → fix and recreate ConfigMap

---

## Phase 2: Build & Deploy Docling MCP to MicroK8s

### 2a. Create Dockerfile

**File:** `k8s/docling-mcp/Dockerfile`

```dockerfile
FROM python:3.12-slim

# Install uv for package management
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && echo 'export PATH="/root/.local/bin:$PATH"' >> /root/.bashrc

ENV PATH="/root/.local/bin:$PATH"

# Install docling-mcp
RUN uv pip install --system docling-mcp

# Expose streamable-http port
EXPOSE 8000

# Run Docling MCP server
CMD ["docling-mcp-server", "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "8000"]
```

### 2b. Build and push to MicroK8s registry

```bash
# Build image
docker build -t localhost:32000/docling-mcp:1.3.4 -f k8s/docling-mcp/Dockerfile .

# Push to MicroK8s local registry
docker push localhost:32000/docling-mcp:1.3.4

# Verify
docker images localhost:32000/docling-mcp
```

Image size: ~1.5-2GB. First build takes 5-10 minutes.

### 2c. Deploy to MicroK8s

**Manifests:** `k8s/docling-mcp/`
- `namespace.yaml` — K8s namespace
- `deployment.yaml` — Deployment + NodePort Service (port 30501)
- `pvc.yaml` — Persistent volume for model cache (5GB)

**Deployment specs:**
- Image: `localhost:32000/docling-mcp:1.3.4`
- Replicas: 1
- Resources: requests 1Gi RAM / 500m CPU, limits 4Gi RAM / 2000m CPU
- No GPU resources
- Readiness probe: HTTP GET /health on port 8000
- Liveness probe: HTTP GET /health on port 8000
- PVC: `docling-models` (5GB, hostpath-storage) for model cache persistence

**Deploy:**
```bash
microk8s kubectl apply -f k8s/docling-mcp/namespace.yaml
microk8s kubectl apply -f k8s/docling-mcp/pvc.yaml
microk8s kubectl apply -f k8s/docling-mcp/deployment.yaml
microk8s kubectl -n docling-mcp get pods -w
```

### 2d. Verify

```bash
microk8s kubectl -n docling-mcp get pods
curl -s http://localhost:30501/health
```

**Rollback:**
- Pod doesn't start → `microk8s kubectl -n docling-mcp logs -f <pod>`
- Image pull fails → verify in MicroK8s registry
- Health check hangs → first request triggers model download (2-3 min). Wait and retry.

---

## Phase 3: Build searxng-mcp Server

**Location:** `/home/komedi/workspace/llm-web-search-mcp/searxng-mcp/`

**Dependencies** (~3MB runtime):
| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP protocol (stdio) |
| `zod` | Schema validation |
| `@mozilla/readability` | HTML content extraction |
| `linkedom` | HTML DOM parsing (headless) |
| `turndown` | HTML to Markdown conversion |

### Source file structure

| File | Purpose |
|------|---------|
| `src/tokens.ts` | Token estimation (4 chars = 1 token), truncation at sentence/table-row boundaries |
| `src/searxng.ts` | SearXNG JSON API client |
| `src/brave.ts` | Brave Search API client (fallback) |
| `src/search.ts` | Search orchestrator: SearXNG → Brave fallback chain |
| `src/docling.ts` | Docling MCP HTTP client (streamable-http) |
| `src/extractor.ts` | Content-type router: HTML → Readability+Turndown, documents → Docling MCP |
| `src/cache.ts` | In-memory LRU cache (URL-based, 15min TTL) |
| `src/security.ts` | URL validation, SSRF prevention, DNS rebinding protection |
| `src/index.ts` | MCP server entry point, 3 tool definitions, request routing |

### Content pipeline

```
HTTP Response
├─ text/html ──────────────── Readability → Turndown (in-process, ~50ms)
│                              └─ SPA detection: text < 100 chars AND HTML > 50KB
│
├─ application/pdf ──────────┐
├─ application/vnd.openxml ──┤ Docling MCP HTTP call (streamable-http)
├─ text/csv ─────────────────┤ POST http://docling-mcp:8000/mcp
├─ image/* ──────────────────┤ (tools/call → convert_document)
├─ text/latex ───────────────┘
├─ application/json ───────── Pretty-print → Markdown code block
├─ application/zip ────────── Extract (max 1 level, max 10 files)
└─ other ──────────────────── [Unsupported: content-type]
```

### Three MCP tools

1. **`searxng_search`** — Search only (~800 tokens for 5 results)
   - Params: `query`, `max_results` (default 5), `categories`, `time_range`, `language`

2. **`searxng_fetch`** — Fetch one URL to Markdown with token cap
   - Params: `url`, `max_tokens` (default 4000)

3. **`searxng_search_and_fetch`** — Search + auto-fetch with token budget
   - Params: `query`, `max_results` (3), `max_tokens_per_result` (4000), `total_token_budget` (20000)

### Caching
- In-memory LRU cache
- Key: `{url}:{max_tokens}`
- TTL: 15 minutes (CPU Docling is slower — cache hits save 30-90s)
- Max entries: 50 (~10MB)

### Logging
- Structured JSON lines to stderr
- Format: `{"level":"info","tool":"searxng_fetch","url":"...","cache":"hit","duration_ms":45}`

---

## Phase 4: Configure Clients

### Environment variables (searxng-mcp)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SEARXNG_URL` | `http://localhost:30888` | SearXNG NodePort service |
| `DOCLING_URL` | `http://localhost:30501/mcp` | Docling MCP NodePort + MCP endpoint |
| `BRAVE_API_KEY` | (empty) | Optional Brave Search fallback |

### Client configs

Updated configs in `client-configs/` — searxng-mcp replaces the old two-server setup:

Each config has 2 MCP server entries:
1. `searxng` → `node /path/to/searxng-mcp/dist/index.js` (stdio)
2. `google-workspace` → `uvx workspace-mcp --tools gmail drive calendar ...` (stdio)

---

## Phase 5: Verification

### SearXNG
```bash
microk8s kubectl -n searxng get pods
curl -s "http://localhost:30888/search?q=hello&format=json" | python3 -m json.tool | head -20
```

### Docling MCP
```bash
microk8s kubectl -n docling-mcp get pods
curl -s http://localhost:30501/health
```

### searxng-mcp
```bash
cd searxng-mcp && npm install && npm run build

# Test tools discovery
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js

# Test search
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"searxng_search","arguments":{"query":"test","max_results":3}}}' | node dist/index.js

# Test HTML fetch
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"searxng_fetch","arguments":{"url":"https://en.wikipedia.org/wiki/Markdown","max_tokens":2000}}}' | node dist/index.js
```

### End-to-end
1. Open MCP client (Claude Code, OpenCode, etc.)
2. Ask: "Search for recent news about AI and financial reporting"
3. Ask: "Fetch and summarize https://en.wikipedia.org/wiki/Markdown"
4. Ask: "Research quarterly earnings for Apple — search and fetch top 3 results"
5. Ask: "What's in my inbox?" (workspace-mcp Gmail)
6. Cross-client: test from 2+ clients

---

## Deployment Checklist

- [ ] Install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- [ ] Generate SearXNG secret key, update `settings.yml`
- [ ] Deploy SearXNG: `microk8s kubectl apply -f k8s/searxng/`
- [ ] Verify SearXNG: `curl -s "http://localhost:30888/search?q=test&format=json"`
- [ ] Build Docling MCP image: `docker build -t localhost:32000/docling-mcp:1.3.4 -f k8s/docling-mcp/Dockerfile .`
- [ ] Push to MicroK8s registry: `docker push localhost:32000/docling-mcp:1.3.4`
- [ ] Deploy Docling MCP: `microk8s kubectl apply -f k8s/docling-mcp/`
- [ ] Verify Docling MCP: `curl -s http://localhost:30501/health`
- [ ] Build searxng-mcp: `npm install && npm run build`
- [ ] Test searxng-mcp tools locally
- [ ] Update client configs with correct paths
- [ ] Test from 2+ MCP clients
- [ ] Configure Brave API key (optional)

---

## Critical Files

| Path | Purpose |
|------|---------|
| `k8s/searxng/namespace.yaml` | SearXNG K8s namespace |
| `k8s/searxng/deployment.yaml` | SearXNG Deployment + Service (NodePort :30888) |
| `k8s/searxng/settings.yml` | SearXNG engine config |
| `k8s/docling-mcp/Dockerfile` | Docling MCP container (CPU, streamable-http) |
| `k8s/docling-mcp/namespace.yaml` | Docling MCP K8s namespace |
| `k8s/docling-mcp/deployment.yaml` | Docling MCP Deployment + Service (NodePort :30501) |
| `k8s/docling-mcp/pvc.yaml` | Persistent volume for Docling model cache |
| `searxng-mcp/src/` | MCP server source code |
| `client-configs/*.json, *.yaml` | Per-client MCP configuration |

---

## Dependencies

**searxng-mcp (Node.js, ~3MB runtime):** `@modelcontextprotocol/sdk`, `zod`, `@mozilla/readability`, `linkedom`, `turndown`

**K8s services:**
- SearXNG (~375MB image, 128-512MB RAM)
- Docling MCP (~1.5-2GB image, 500MB-2GB RAM, CPU only)

**workspace-mcp (Python, community):** `workspace-mcp` via PyPI, Python 3.10+, `uv`/`uvx` (~50-100MB RAM)

**Docling MCP (Python):** `docling-mcp` via pip, runs via streamable-http on port 8000
