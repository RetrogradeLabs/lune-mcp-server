import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { makeServer } from "../server.js";
import { extractTokenStdio } from "../auth/token.js";
import { makeClient } from "../api/client.js";

/**
 * Run the MCP server over stdio. The Bearer token is captured once at process
 * startup (stdio is single-tenant: one process per agent invocation).
 *
 * `serveStdio` serves both protocol eras from the one factory: a 2026-07-28
 * peer negotiates through `server/discover`, a 2025-era peer through
 * `initialize`, and the connection stays pinned to whichever it opened with.
 * It resolves as soon as the wiring is done; the process stays alive because
 * the stdio transport holds stdin open.
 */
export async function runStdio(): Promise<void> {
  const token = extractTokenStdio();
  serveStdio(() => makeServer(() => makeClient(token)));
}
