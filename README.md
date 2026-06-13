# @retrograde-labs/lune-mcp-server

<!-- mcp-name: com.luneresearch/lune -->

Official Model Context Protocol server for [Lune Research](https://luneresearch.com).

Exposes 16 tools and 6 guided research workflows (prompts) for searching, retrieving, comparing, fact-checking, and subscribing to academic papers across security, ML, NLP, CV, and systems venues. Two transports:

- **stdio**: run locally via `npx @retrograde-labs/lune-mcp-server`. Reads `LUNE_API_KEY` from the environment.
- **Streamable HTTP**: hosted at `https://mcp.luneresearch.com/mcp`. Pass your PAT or OAuth token as `Authorization: Bearer ...`.

## Quick start (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "lune-research": {
      "command": "npx",
      "args": ["-y", "@retrograde-labs/lune-mcp-server"],
      "env": {
        "LUNE_API_KEY": "lune_your_personal_access_token"
      }
    }
  }
}
```

Get your token at https://luneresearch.com/dashboard/credentials.

## Tools

| Tool | Description |
|------|-------------|
| `search_papers` | Hybrid vector + BM25 search across the corpus |
| `search_papers_many` | Run many query variants in one call, RRF-merged |
| `search_related_papers` | Semantically nearest papers to a given paper |
| `get_paper_fulltext` | Parsed full text (markdown or JSON) |
| `get_paper_citations` | Citation graph (cited_by or cites) |
| `list_conferences` | Indexed venues, optionally by category |
| `get_conference_papers` | Paginated papers for a venue |
| `extract_from_papers` | Structured field extraction across many papers |
| `verify_claims` | Fact-check claims against the corpus with quotes |
| `search_research_guidance` | Curated reproducibility / methodology corpus |
| `get_research_guidance_doc` | Full text of a guidance document |
| `list_subscriptions` | Active conference subscriptions |
| `subscribe_conference` | Follow a conference for new-paper updates |
| `unsubscribe_conference` | Stop following a conference |
| `get_subscription_updates` | New papers across every subscription |

## Prompts

Reusable research workflows, surfaced by MCP clients as slash commands (e.g. `/literature_review`). Each runs a guided, multi-tool sequence grounded in the corpus, so common research tasks are one command instead of hand-orchestrating the tools.

| Prompt | What it does | Key arguments |
|--------|--------------|---------------|
| `/literature_review` | Survey a topic and synthesise themes, foundational vs recent work, and open gaps | `topic` (+ optional `venues`, `since_year`) |
| `/find_related_work` | From your abstract, find and organise prior work to cite and distinguish your contribution from | `abstract` (+ optional `venues`) |
| `/compare_papers` | Build a structured comparison table across papers, read from full text | `topic` (+ optional `columns`) |
| `/verify_draft` | Fact-check a draft or list of claims against the corpus, with a verbatim quote per claim | `draft` |
| `/trace_citations` | Trace a paper's lineage: its foundations, what built on it, and adjacent work | `paper` |
| `/research_methodology` | Grounded advice on experiment design, ablations, evaluation, rebuttals, or venue choice | `question` |

## License

MIT
