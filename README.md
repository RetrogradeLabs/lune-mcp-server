# @retrograde-labs/lune-mcp-server

<!-- mcp-name: com.luneresearch/lune -->

Official Model Context Protocol server for [Lune Research](https://luneresearch.com).

Exposes 12 tools for searching, retrieving, and subscribing to academic papers across security, ML, NLP, CV, and systems venues. Two transports:

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

## License

MIT
