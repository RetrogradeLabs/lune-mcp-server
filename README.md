# @retrograde-labs/lune-mcp-server

<!-- mcp-name: com.luneresearch/lune -->

[![npm](https://img.shields.io/npm/v/@retrograde-labs/lune-mcp-server.svg)](https://www.npmjs.com/package/@retrograde-labs/lune-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-com.luneresearch/lune-blue)](https://registry.modelcontextprotocol.io/v0.1/servers?search=com.luneresearch/lune)

Official [Model Context Protocol](https://modelcontextprotocol.io/) server for [Lune Research](https://luneresearch.com). Twelve tools for searching, retrieving, and subscribing to academic papers across security, ML, NLP, CV, and systems venues.

Two transports:

- **stdio**: run locally via `npx @retrograde-labs/lune-mcp-server`. Reads `LUNE_API_KEY` from the environment.
- **Streamable HTTP**: hosted at `https://mcp.luneresearch.com/mcp`. Pass your PAT or OAuth token as `Authorization: Bearer ...`.

Get a token at [luneresearch.com/dashboard/credentials](https://luneresearch.com/dashboard/credentials).

## Quick start

The fastest path is the [dashboard installer](https://luneresearch.com/dashboard/install): pick your AI app, click a button, and you're done. Manual installs follow.

### Claude Code

```sh
claude mcp add lune --transport http \
  https://mcp.luneresearch.com/mcp \
  --header "Authorization: Bearer <YOUR_TOKEN>"
```

### Claude Desktop, Cursor, VS Code, OpenCode, Codex, Gemini CLI, Windsurf, Zed

See the dashboard installer for per-client recipes verified against each client's official docs. The schemas vary subtly (e.g. VS Code uses `type: "http"`, Cursor omits `type`, Gemini CLI uses `httpUrl`, Zed uses `context_servers`).

## Tools

| Tool | Description |
|------|-------------|
| `search_papers` | Hybrid vector + BM25 search across the corpus |
| `get_paper` | Fetch metadata for a paper |
| `get_paper_fulltext` | Parsed full text (markdown or JSON) |
| `get_paper_citations` | Citation graph (cited_by or cites) |
| `list_conferences` | Indexed venues, optionally by category |
| `get_conference_papers` | Paginated papers for a venue |
| `search_research_guidance` | Curated reproducibility / methodology corpus |
| `get_research_guidance_doc` | Full text of a guidance document |
| `list_conference_update_subscriptions` | Active conference update subscriptions |
| `subscribe_to_conference_updates` | Start receiving updates for a conference |
| `unsubscribe_from_conference_updates` | Stop receiving updates for a conference |
| `check_for_conference_updates` | Pull new papers since the last check |

## Authentication

The hosted Streamable HTTP transport at `mcp.luneresearch.com/mcp` supports both:

- **OAuth 2.1 + Dynamic Client Registration**, advertised via `https://mcp.luneresearch.com/.well-known/oauth-protected-resource`. Authorization server is `api.luneresearch.com`. Clients (Claude Desktop, ChatGPT custom connectors) handle the flow automatically.
- **Personal Access Tokens** (`lune_*`), passed as `Authorization: Bearer ...`. Mint at [luneresearch.com/dashboard/credentials](https://luneresearch.com/dashboard/credentials).

## MCP Registry

Published as `com.luneresearch/lune` at [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/v0.1/servers?search=com.luneresearch/lune). DNS-authenticated under the `luneresearch.com` namespace.

## Development

```sh
pnpm install
pnpm dev:watch        # tsup --watch
pnpm test
pnpm typecheck
```

Tests are unit + integration (`tests/`); no live network calls.

The hosted variant runs on ECS Fargate behind ALB. The npm-distributed binary (`lune-mcp`) is the same image entrypoint defaulting to stdio.

## Releases

The npm package is built with [tsup](https://tsup.egoist.dev/). Version is stamped into the bundle at build time from `package.json` via `tsup.config.ts`'s `define`; the same version is asserted at `serverInfo.version` in the MCP `initialize` response and at `/health`.

## License

[MIT](./LICENSE) © Retrograde Labs
