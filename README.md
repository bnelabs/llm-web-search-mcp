# LLM Web Search MCP

Self-hosted, client-agnostic MCP server stack for LLM-powered web search, document extraction, and Google Workspace integration.

## What's Included

**Two MCP servers, one stack:**

| Server | What it does | Tech |
|--------|-------------|------|
| **searxng-mcp** (custom) | Web search + document extraction with token budgets | Node.js, SearXNG, Docling (GPU) |
| **[workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp)** (community) | Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Chat, Tasks, Contacts | Python, OAuth 2.0/2.1 |

Both use **stdio transport** — works with Claude Code, OpenCode, Codex, Continue, Cursor, or any MCP client.

## Architecture

```
LLM Client (any MCP-compatible)
    │
    ├──► searxng-mcp
    │    ├─ Search: SearXNG (self-hosted) → Brave API (fallback)
    │    └─ Extract: HTML in-process (~50ms) | Documents via Docling GPU
    │
    └──► workspace-mcp
         └─ 12 Google Workspace services via OAuth
```

## Key Features

- **Privacy-first**: SearXNG is self-hosted, no commercial search API dependency
- **Document-aware**: Docling (IBM) with GPU acceleration — 0.882 accuracy on financial tables vs 0.4 for typical parsers
- **Token-conscious**: Server-side budget enforcement (configurable per call)
- **Resilient**: Brave Search fallback, K8s health checks, structured error handling
- **Client-agnostic**: Ready-to-use configs in `client-configs/` for 5 clients

## Infrastructure

Runs on a home Ubuntu server with MicroK8s:
- SearXNG pod (port 30888) — web search
- Docling-serve pod (port 30501, GPU) — document extraction
- workspace-mcp (local process) — Google Workspace

Total footprint: ~13% RAM, ~16% GPU VRAM on a 64GB/RTX 3090 system.

## Quick Links

- **[Full implementation plan](PLAN.md)** — architecture, phases, deployment steps
- **[K8s manifests](k8s/)** — SearXNG and Docling deployments
- **[Client configs](client-configs/)** — Claude Code, OpenCode, Codex, Continue, Cursor

## Status

Planning phase — no implementation code yet. See [PLAN.md](PLAN.md) for the complete roadmap.

## License

MIT
