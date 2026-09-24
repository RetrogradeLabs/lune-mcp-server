# Security policy

## Supported versions

Security fixes target the current `main` branch and the latest published Lune
MCP server, CLI, plugin, and web deployment. Older npm and MCP Registry versions
are immutable. Upgrade to the latest release before reporting a problem that is
already fixed there.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Email
`support@luneresearch.com` with the subject `Security report`. That covers
everything: the MCP server and its npm package, the CLI, the plugin, the hosted
service, the OAuth flow, and account data.

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
