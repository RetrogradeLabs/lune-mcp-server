# @retrograde-labs/lune-mcp-server

<!-- mcp-name: com.luneresearch/lune -->

The official [Lune Research](https://luneresearch.com) MCP server. It gives an
AI agent a literature habit: full-text search over top-tier venues, citation
trails, figure design references, and a curated corpus of research best
practices.

Every answer your agent gives can rest on a paper it actually read, quoted by
title, authors and venue, instead of on recall.

## Install

**Hosted (recommended).** One endpoint, OAuth in the browser, no token to paste
or rotate:

```
https://mcp.luneresearch.com
```

Claude Code:

```bash
claude mcp add lune --transport http https://mcp.luneresearch.com
```

Cursor, Codex, ChatGPT, Claude, Perplexity, Manus and the rest have their own
wording for "add a custom connector". The
[Install page](https://luneresearch.com/dashboard/install) carries a
copy-pasteable recipe for each, and
[the docs](https://luneresearch.com/docs/mcp) explain the flow.

**Local stdio.** For clients that only speak stdio, run the package directly
and hand it a personal access token:

```json
{
  "mcpServers": {
    "lune": {
      "command": "npx",
      "args": ["-y", "@retrograde-labs/lune-mcp-server"],
      "env": { "LUNE_API_KEY": "lune_your_personal_access_token" }
    }
  }
}
```

Mint a token at
[Settings -> Credentials](https://luneresearch.com/dashboard/settings/credentials).
The server reads `LUNE_API_KEY` from the environment and writes diagnostics to
stderr, never stdout, so JSON-RPC framing stays intact.

## Tools

Fourteen tools. `search_*` finds candidates, `get_*` retrieves something you
already have a handle on, and `list_*` browses. A fifteenth, `get_more_tools`,
is offered alongside them so an agent can report a capability Lune is missing;
it is not there if you opt out of analytics.

**Finding papers**

| Tool                    | What it does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `search_papers`         | Hybrid vector + BM25 search over the corpus                       |
| `search_papers_many`    | Many query variants in one call, merged by reciprocal rank fusion |
| `search_related_papers` | The nearest neighbours of a paper you already have                |
| `list_conferences`      | Indexed venues, optionally filtered by category                   |
| `get_conference_papers` | One venue's papers, paginated                                     |

**Reading them**

| Tool                  | What it does                            |
| --------------------- | --------------------------------------- |
| `get_paper_fulltext`  | Parsed full text, as markdown or JSON   |
| `get_paper_citations` | The citation graph, in either direction |

**Working across many at once**

| Tool                  | What it does                                                           |
| --------------------- | ---------------------------------------------------------------------- |
| `extract_from_papers` | Pull the same structured fields out of a set of papers                 |
| `verify_claims`       | Fact-check claims against the corpus, returning a quote per claim      |
| `gather_evidence`     | Judge whether the evidence is sufficient yet, and name what is missing |

**Designing figures**

| Tool                       | What it does                                                               |
| -------------------------- | -------------------------------------------------------------------------- |
| `search_figure_references` | Published figures matching a composition, with the design analysis of each |
| `get_paper_figures`        | Every extracted figure from one paper, with captions and analysis          |

**Doing the work well**

| Tool                        | What it does                                       |
| --------------------------- | -------------------------------------------------- |
| `search_research_guidance`  | The curated methodology and reproducibility corpus |
| `get_research_guidance_doc` | The full text of one guidance document             |

## Prompts

Seven guided workflows, which MCP clients surface as slash commands. Each one
runs a multi-tool sequence grounded in the corpus, so a common research task is
one command instead of an orchestration you have to think about.

| Prompt                  | What it does                                                                       | Arguments                          |
| ----------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| `/literature_review`    | Survey a topic: the foundational work, the recent work, and the gaps between them  | `topic` (+ `venues`, `since_year`) |
| `/find_related_work`    | Read your abstract, then find the prior work to cite and distinguish yourself from | `abstract` (+ `venues`)            |
| `/compare_papers`       | Build a comparison table across papers, read out of their full text                | `topic` (+ `columns`)              |
| `/verify_draft`         | Fact-check a draft against the corpus, with a verbatim quote per claim             | `draft`                            |
| `/trace_citations`      | Trace a paper's lineage: what it stands on, what stands on it                      | `paper`                            |
| `/design_figure`        | Study how the target venue draws this kind of figure, then plan and draft yours    | `figure` (+ `venue`, `role`)       |
| `/research_methodology` | Grounded advice on experiment design, ablations, evaluation, rebuttals, venues     | `question`                         |

## Authentication and scopes

Both transports accept a Lune personal access token (`lune_*`); the hosted
transport also accepts an OAuth access token, which is what the one-click client
installs use. Send either as `Authorization: Bearer ...`.

Tools declare the scope they need, and a token is only ever granted what you
give it. `papers:read` covers the corpus, full text, citations and figures,
`guidance:read` covers the research-guidance corpus, and `account:read` reads
your identity and quota. A call made without the scope fails with both the scope
it wanted and the scopes you hold, so the agent can say what to fix rather than
guess.

Revoking a token or an app on the
[Credentials page](https://luneresearch.com/dashboard/settings/credentials)
takes effect immediately.

## Transports

| Transport       | Where                                  | Protocol                    |
| --------------- | -------------------------------------- | --------------------------- |
| Streamable HTTP | `https://mcp.luneresearch.com`         | MCP 2026-07-28 and 2025-era |
| stdio           | `npx @retrograde-labs/lune-mcp-server` | MCP 2026-07-28 and 2025-era |

The hosted transport is stateless per request: the credential arrives on every
call, so a client that has been idle for hours keeps working without
re-initializing.

## Links

- [Documentation](https://luneresearch.com/docs/mcp)
- [Install recipes for every client](https://luneresearch.com/dashboard/install)
- [Quotas and billing](https://luneresearch.com/docs/concepts/quotas-and-billing)
- [Troubleshooting](https://luneresearch.com/docs/troubleshooting)

## Support

Bug reports and feature requests go to
[the issue tracker](https://github.com/RetrogradeLabs/lune-mcp-server/issues).
For anything account-related, or to report a security issue, see
[SECURITY.md](SECURITY.md) and the
[documentation](https://luneresearch.com/docs/mcp).

## License

MIT
