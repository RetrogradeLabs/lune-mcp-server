# Security policy

## Supported versions

Security fixes target the current `main` branch and the latest published Lune
MCP server, CLI, plugin, and web deployment. Older npm and MCP Registry versions
are immutable. Upgrade to the latest release before reporting a problem that is
already fixed there.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use the private
[GitHub Security Advisory form](https://github.com/RetrogradeLabs/lune-mcp-server/security/advisories/new)
for the public MCP package, or email `support@luneresearch.com` with the subject
`Security report` for anything else: the hosted service, the API, the OAuth
flow, or account data.

Include the affected URL, package version or commit, reproduction steps, impact,
and any proof-of-concept material needed to confirm the issue. Remove real user
data, access tokens, cookies, private papers, and credentials from the report.

We will acknowledge a report within two business days, confirm severity and
next steps after triage, and coordinate disclosure after a fix is available.
Please give us a reasonable remediation window before publishing details.

## Scope

Reports about authentication, authorization, tenant isolation, OAuth audience
or redirect handling, MCP tool or resource access, prompt or output injection,
credential exposure, billing bypasses, and ingestion of malicious documents are
in scope. Automated scanning without exploitation is welcome when it identifies
a concrete, reproducible risk.

Do not degrade the service, access another person's data, exhaust paid provider
capacity, or retain data beyond what is needed to demonstrate the issue.
