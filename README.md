# @retrograde-labs/lune-mcp-server

<!-- mcp-name: com.luneresearch/lune -->

Official Model Context Protocol server for [Lune Research](https://luneresearch.com).

Exposes 12 tools and 6 guided research workflows (prompts) for searching, retrieving, comparing, and fact-checking academic papers across security, ML, NLP, CV, and systems venues, plus retrieval over your own uploaded workspace documents. Two transports:

- **stdio**: run locally via `npx @retrograde-labs/lune-mcp-server`. Reads `LUNE_API_KEY` from the environment.
- **Streamable HTTP**: hosted at `https://mcp.luneresearch.com`. Pass your PAT or OAuth token as `Authorization: Bearer ...`.

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

Get your token at https://luneresearch.com/dashboard/settings/credentials.

## Tools

| Tool                        | Description                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `search_papers`             | Hybrid vector + BM25 search across the corpus                   |
| `search_papers_many`        | Run many query variants in one call, RRF-merged                 |
| `search_related_papers`     | Semantically nearest papers to a given paper                    |
| `get_paper_fulltext`        | Parsed full text (markdown or JSON)                             |
| `get_paper_citations`       | Citation graph (cited_by or cites)                              |
| `list_conferences`          | Indexed venues, optionally by category                          |
| `get_conference_papers`     | Paginated papers for a venue                                    |
| `extract_from_papers`       | Structured field extraction across many papers                  |
| `verify_claims`             | Fact-check claims against the corpus with quotes                |
| `gather_evidence`           | Judge evidence sufficiency for a task, with gaps + next queries |
| `search_research_guidance`  | Curated reproducibility / methodology corpus                    |
| `get_research_guidance_doc` | Full text of a guidance document                                |

## Prompts

Reusable research workflows, surfaced by MCP clients as slash commands (e.g. `/literature_review`). Each runs a guided, multi-tool sequence grounded in the corpus, so common research tasks are one command instead of hand-orchestrating the tools.

| Prompt                  | What it does                                                                                    | Key arguments                               |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `/literature_review`    | Survey a topic and synthesise themes, foundational vs recent work, and open gaps                | `topic` (+ optional `venues`, `since_year`) |
| `/find_related_work`    | From your abstract, find and organise prior work to cite and distinguish your contribution from | `abstract` (+ optional `venues`)            |
| `/compare_papers`       | Build a structured comparison table across papers, read from full text                          | `topic` (+ optional `columns`)              |
| `/verify_draft`         | Fact-check a draft or list of claims against the corpus, with a verbatim quote per claim        | `draft`                                     |
| `/trace_citations`      | Trace a paper's lineage: its foundations, what built on it, and adjacent work                   | `paper`                                     |
| `/research_methodology` | Grounded advice on experiment design, ablations, evaluation, rebuttals, or venue choice         | `question`                                  |

## Debugging with MCP Inspector

The repository pins MCP Inspector 2.3.0 and checks in a read-only server
configuration for both protocol eras. Node 24 from `.nvmrc` satisfies the
Inspector requirement.

With a PAT in `LUNE_API_KEY`, this builds the stdio server and opens the
Inspector catalog with the PAT available to local processes. Select
`lune-stdio-modern` to exercise 2026-07-28:

```bash
export LUNE_API_KEY=lune_xxxxxxxxxxxxxxxxxxxxxxxx
bun run mcp:inspect
```

With no `LUNE_API_KEY`, the same command opens the server catalog without an
environment override. Select `lune-remote-modern`; Inspector starts OAuth when
you connect. The launcher never passes an empty `-e` assignment.

The printed URL contains a one-time Inspector token. Open that URL instead of
typing the port manually. The Inspector stays on loopback with authentication
enabled.

The hosted-server mnemonic opens the same catalog without building stdio:

```bash
bun run mcp:inspect:remote
```

The web, CLI, and TUI clients share OAuth state on disk. After signing in once,
the CLI can check the hosted server without opening another browser:

```bash
bun run mcp:inspect:remote:check
```

The local stdio checks use a non-production test token and a deliberately dead
API URL. They validate connection, version negotiation, and the tool catalog
without consuming quota:

```bash
bun run mcp:inspect:check
bun run mcp:inspect:check:legacy
bun run mcp:inspect:tui
```

The local and remote configs at `apps/mcp/inspector.*.config.json` pin
`protocolEra` explicitly. Inspector defaults to the legacy era, so an
unconfigured launch does not prove 2026-07-28 behavior. During debugging, pin
Protocol beside Console for stdio or Network for HTTP. Test invalid tool
arguments, missing prompt arguments, both protocol eras, and expired OAuth
tokens as well as successful calls.

Run the frozen official 2026-07-28 server requirements with:

```bash
bun run mcp:conformance
```

The conformance harness binds only `127.0.0.1` and injects a local test token.
Its baseline names individual checks for diagnostic capabilities Lune does not
advertise, such as image tools and readable resources. Every applicable check
still gates the run, and a stale baseline entry fails when support is added.
Never write diagnostics to stdout on stdio. The server and its cache write
diagnostics to stderr so JSON-RPC framing stays intact.

## License

MIT
