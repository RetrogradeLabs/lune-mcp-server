# @retrograde-labs/lune-mcp-server

<!-- mcp-name: com.luneresearch/lune -->

The official [Lune Research](https://luneresearch.com) MCP server. It lets an
AI agent search the full text of papers from top-tier venues, follow citations,
and look up curated research-methodology guidance, so its answers can cite a
paper's title, authors and venue instead of relying on memory.

## Install

**Hosted (recommended).** Add this URL to any client that speaks Streamable
HTTP:

```
https://mcp.luneresearch.com
```

A client that supports MCP authorization signs you in through the browser, so
there is no token to paste or rotate. In Claude Code:

```bash
claude mcp add --transport http --scope user lune https://mcp.luneresearch.com
```

Then run `/mcp` inside Claude Code, choose `lune`, and sign in through the
browser tab that opens.

A client without OAuth support sends a Lune access key in the `Authorization`
header instead. Create one on the
[Credentials page](https://luneresearch.com/dashboard/settings/credentials):
open **API keys** and click **New key**. This request lists the tools, which
makes it a quick way to check a key:

```bash
curl https://mcp.luneresearch.com \
  -H "Authorization: Bearer lune_your_access_key" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Setup notes for specific apps are in the docs:
[web AI apps](https://luneresearch.com/docs/mcp/remote) such as ChatGPT, Claude
and Perplexity, and [local AI agents](https://luneresearch.com/docs/mcp/stdio)
such as Cursor, VS Code and Codex.

**Local stdio.** For clients that only speak stdio, run the package directly
and hand it an access key. It needs Node.js 22 or newer:

```json
{
  "mcpServers": {
    "lune": {
      "command": "npx",
      "args": ["-y", "@retrograde-labs/lune-mcp-server"],
      "env": { "LUNE_API_KEY": "lune_your_access_key" }
    }
  }
}
```

The server reads `LUNE_API_KEY` from the environment and writes diagnostics to
stderr, never stdout, so JSON-RPC framing stays intact.

## Tools

Twelve tools. Most follow a prefix: `search_*` finds candidates, `get_*`
retrieves something you already have a handle on, and `list_*` browses. The
hosted endpoint also offers `get_more_tools`, which an agent calls to tell Lune
about a capability it needed and could not find. The stdio package does not
include it.

**Finding papers**

| Tool                    | What it does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `search_papers`         | Hybrid vector + BM25 search over the corpus                       |
| `search_papers_many`    | Many query variants in one call, merged by reciprocal rank fusion |
| `search_related_papers` | The nearest neighbors of a paper you already have                 |
| `list_conferences`      | Indexed venues, optionally filtered by category                   |
| `get_conference_papers` | One venue's papers, paginated                                     |

**Reading them**

| Tool                  | What it does                            |
| --------------------- | --------------------------------------- |
| `get_paper_fulltext`  | Parsed full text, as markdown or JSON   |
| `get_paper_citations` | The citation graph, in either direction |

**Working across many at once**

| Tool                  | What it does                                                               |
| --------------------- | -------------------------------------------------------------------------- |
| `extract_from_papers` | Pull the same structured fields out of a set of papers                     |
| `verify_claims`       | Check each claim against the corpus, with a verbatim quote when one exists |
| `gather_evidence`     | Judge whether the evidence is sufficient yet, and name what is missing     |

**Research methodology**

| Tool                        | What it does                                       |
| --------------------------- | -------------------------------------------------- |
| `search_research_guidance`  | The curated methodology and reproducibility corpus |
| `get_research_guidance_doc` | The full text of one guidance document             |

## Prompts

Six prompts, which many MCP clients list as slash commands. Each one hands the
agent a brief for a common research task and names the tools to call, so the
task takes one command instead of a plan you have to spell out.

| Prompt                  | What it does                                                                       | Arguments                          |
| ----------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| `/literature_review`    | Survey a topic: the main themes, foundational and recent work, and open gaps       | `topic` (+ `venues`, `since_year`) |
| `/find_related_work`    | Read your abstract, then find the prior work to cite and distinguish yourself from | `abstract` (+ `venues`)            |
| `/compare_papers`       | Build a comparison table across papers, read out of their full text                | `topic` (+ `columns`)              |
| `/verify_draft`         | Check each claim in a draft, with a verbatim quote when one exists                 | `draft`                            |
| `/trace_citations`      | Trace a paper's lineage: what it stands on, what stands on it                      | `paper`                            |
| `/research_methodology` | Grounded advice on experiment design, ablations, evaluation, rebuttals, venues     | `question`                         |

## Authentication

The hosted endpoint takes one credential on every request, as
`Authorization: Bearer <credential>`. The stdio package reads an access key
from `LUNE_API_KEY` instead. The credential is one of these:

- An OAuth access token, which an MCP client obtains by signing you in through
  the browser. Hosted endpoint only.
- A Lune access key (`lune_...`), created on the
  [Credentials page](https://luneresearch.com/dashboard/settings/credentials)
  under **API keys**. Works on both transports.

An OAuth connection always bills the signed-in person's personal team, drawing
on its plan, daily allowance and credits. An access key bills the team it was
created in, so a key is how a shared team's plan pays for an agent. How requests
are counted is in
[quotas and billing](https://luneresearch.com/docs/concepts/quotas-and-billing).

### OAuth for connector builders

Most MCP clients run this flow on their own. If you are building a connector,
the details follow. [auth.md](https://luneresearch.com/auth.md) walks through
each request with `curl`.

An unauthenticated `POST https://mcp.luneresearch.com` answers `401` with this
challenge:

```http
WWW-Authenticate: Bearer resource_metadata="https://mcp.luneresearch.com/.well-known/oauth-protected-resource", scope="papers:read guidance:read account:read"
```

The protected-resource document it points to names the authorization server in
`authorization_servers[0]`. That server is `https://api.luneresearch.com`, the
authorization server for MCP connectors. It publishes RFC 8414 metadata at
`https://api.luneresearch.com/.well-known/oauth-authorization-server` and has no
OpenID Connect discovery document.

| Endpoint                       | URL                                                                   |
| ------------------------------ | --------------------------------------------------------------------- |
| Issuer                         | `https://api.luneresearch.com`                                        |
| Authorization                  | `https://api.luneresearch.com/oauth/authorize`                        |
| Token                          | `https://api.luneresearch.com/oauth/token`                            |
| Client registration (RFC 7591) | `https://api.luneresearch.com/oauth/register`                         |
| Revocation (RFC 7009)          | `https://api.luneresearch.com/oauth/revoke`                           |
| JWKS                           | `https://api.luneresearch.com/.well-known/jwks.json`                  |
| Authorization server metadata  | `https://api.luneresearch.com/.well-known/oauth-authorization-server` |
| Protected resource metadata    | `https://mcp.luneresearch.com/.well-known/oauth-protected-resource`   |

The flow:

1. Register a client. Dynamic client registration is the only way to get a
   `client_id`; there are no pre-registered client IDs. Clients are public, so
   there is no secret and the token endpoint auth method is `none`. A platform
   that cannot register on the fly can do it once by hand and keep the
   `client_id`:

   ```bash
   curl -X POST https://api.luneresearch.com/oauth/register \
     -H "Content-Type: application/json" \
     -d '{"client_name": "My connector", "redirect_uris": ["https://example.com/oauth/callback"]}'
   ```

2. Send the person to the authorization endpoint with `response_type=code`,
   `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`,
   `code_challenge_method=S256` and `resource`. PKCE with `S256` is required,
   and so are `state` and `scope`.
3. Handle the callback. After the person signs in and approves, Lune redirects
   to your `redirect_uri` with `code`, `state` and
   `iss=https://api.luneresearch.com` (RFC 9207). Check that `state` is the one
   you sent and that `iss` equals the issuer. If the person declines, the
   redirect carries `error=access_denied` with the same `state` and `iss`.
4. Exchange the code. POST `grant_type=authorization_code`, `code`,
   `redirect_uri`, `client_id`, `code_verifier` and `resource` to the token
   endpoint as `application/x-www-form-urlencoded`.
5. Call the server with `Authorization: Bearer <access_token>`. Once the token
   expires the server answers `401` with `error="invalid_token"`. To refresh,
   POST `grant_type=refresh_token` and `refresh_token` to the token endpoint.

Requirements and limits:

- Request exactly `papers:read guidance:read account:read`, the scopes the
  protected-resource document lists. Together they cover every tool.
- Send `resource=https://mcp.luneresearch.com` on both the authorization request
  and the token request. Without it the access token is bound to your
  `client_id` instead of the server, and requests on protocol version 2026-07-28
  fail with `401 invalid_token`, which the person sees as a sign-in loop. Older
  protocol versions still accept such a token, but only for a transition
  period.
- Redirect URIs must use `https`, `http` on `127.0.0.1`, `[::1]` or `localhost`,
  or a private-use scheme such as `cursor://`, and must not contain a fragment.
  The authorization request must repeat a registered URI exactly, port
  included.
- An authorization code expires after 10 minutes and works once; a failed
  exchange uses it up. Access tokens are RS256 JWTs that expire after one hour
  (`expires_in: 3600`).
- Every refresh returns a new refresh token. Store it and drop the old one. Each
  refresh token is valid for 90 days, so a connection in regular use does not
  expire. Presenting a refresh token more than 30 seconds after it was replaced
  revokes every refresh token in that chain, and the person has to connect
  again. Access tokens already issued keep working until they expire.
- To disconnect, POST `token=<refresh_token>` (form-encoded) to the revocation
  endpoint.

### Scopes

`papers:read` covers the paper corpus, full text and citations, `guidance:read`
covers the research-guidance corpus, and `account:read` reads your identity and
usage.

A credential that lacks the scope a tool needs fails differently depending on
its type. An OAuth token gets HTTP `403` with a challenge that names only the
missing scope, so the client can ask the person to approve it:

```http
WWW-Authenticate: Bearer error="insufficient_scope", error_description="The papers:read scope is required for this request.", resource_metadata="https://mcp.luneresearch.com/.well-known/oauth-protected-resource", scope="papers:read"
```

An access key gets a tool error that names the missing scope and tells the
agent to have you create a key that includes it.

### Revoking access

Revoke access keys under **API keys** and connected apps under **OAuth
clients** on the
[Credentials page](https://luneresearch.com/dashboard/settings/credentials).
OAuth connections are listed under your personal team, so select it first. A
revoked access key stops working within five minutes. Revoking an app cancels
its refresh tokens at once, but the access token it already holds keeps working
until it expires, at most an hour later.

## Transports

| Transport       | Where                                     | MCP protocol versions                                                  |
| --------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| Streamable HTTP | `https://mcp.luneresearch.com`            | 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 |
| stdio           | `npx -y @retrograde-labs/lune-mcp-server` | 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 |

About the hosted endpoint:

- `/mcp` and `/v1/mcp` answer too, for older installs. Discovery follows the
  path, so a client on `/mcp` is pointed at
  `https://mcp.luneresearch.com/.well-known/oauth-protected-resource/mcp`. A
  token bound to any of the three URLs works on all three.
- Requests are stateless. Each one carries its own credential and there is no
  session ID, so a client that has been idle for hours keeps working without
  re-initializing.
- MCP traffic is `POST` only. `GET` and `DELETE` return `405`, so there is no
  SSE stream to open, and the server sends no notifications of its own. A
  browser that opens the bare URL is redirected to the docs instead.
- Send `Accept: application/json, text/event-stream`. On older protocol
  versions, a request that leaves out either type gets `406`.
- A request with an `Origin` header gets `403` unless that origin is on the
  server's allowlist, so connect from a server or a native client rather than
  from a web page.
- JSON-RPC batches, which only older protocol versions use, may hold up to 50
  messages. A request body may be up to 1 MB.
- The Registry manifest is served at
  `https://mcp.luneresearch.com/.well-known/mcp/server.json`.

## Links

- [Connection details](https://luneresearch.com/docs/mcp#connection-details)
- [Web AI apps](https://luneresearch.com/docs/mcp/remote)
- [Local AI agents](https://luneresearch.com/docs/mcp/stdio)
- [Authentication guide for agents (auth.md)](https://luneresearch.com/auth.md)
- [Quotas and billing](https://luneresearch.com/docs/concepts/quotas-and-billing)
- [Troubleshooting](https://luneresearch.com/docs/troubleshooting)

## Support

Bug reports and feature requests go to
[the issue tracker](https://github.com/RetrogradeLabs/lune-mcp-server/issues).
For account questions, email support@luneresearch.com. To report a security
issue, follow [SECURITY.md](SECURITY.md).

## License

MIT
