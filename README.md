# LLM Web Search MCP

Self-hosted, client-agnostic MCP server stack for LLM-powered web search and document extraction.

## What's Included

**One MCP server, one stack:**

| Server | What it does | Tech |
|--------|-------------|------|
| **searxng-mcp** (custom) | Web search + document extraction with token budgets | Node.js, SearXNG, Docling MCP (CPU) |
| **[workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp)** (community) | Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Chat, Tasks, Contacts | Python, OAuth 2.0/2.1 |

Both use **stdio transport** — works with Claude Code, OpenCode, Codex, Continue, Cursor, or any MCP client.

## Architecture

```
LLM Client (any MCP-compatible)
    │
    │ stdio (MCP protocol)
    │
    ├──► searxng-mcp (Node.js, local)
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
    │            └──► docling-mcp (K8s pod, NodePort :30501)
    │
    └──► workspace-mcp (Python, local, uvx)
         └─ 12 Google Workspace services via OAuth
```

## Key Features

- **Privacy-first**: SearXNG is self-hosted, no commercial search API dependency
- **Document-aware**: Docling MCP (IBM) — 0.882 accuracy on financial tables
- **Token-conscious**: Server-side budget enforcement (configurable per call)
- **Resilient**: Brave Search fallback, K8s health checks, structured error handling
- **Client-agnostic**: Ready-to-use configs in `client-configs/` for 5 clients
- **CPU-only**: No GPU needed — runs on i9-12900KF at ~1.5 pages/sec

## Infrastructure

Runs on a home Ubuntu server with MicroK8s:
- SearXNG pod (NodePort :30888) — web search
- Docling MCP pod (NodePort :30501) — document extraction (CPU)
- searxng-mcp (local Node.js process) — MCP server
- workspace-mcp (local Python process, uvx) — Google Workspace

Total footprint: ~2.5GB RAM (~4% of 62GB system), **0% GPU VRAM**.

## Quick Links

- **[Full deployment plan](.opencode/plans/cpu-only-deployment.md)** — architecture, deployment steps, verification
- **[K8s manifests](k8s/)** — SearXNG and Docling MCP deployments
- **[Client configs](client-configs/)** — Claude Code, OpenCode, Codex, Continue, Cursor

## Status

Implementation complete. Deploy to MicroK8s and configure your MCP client.

## License

MIT
