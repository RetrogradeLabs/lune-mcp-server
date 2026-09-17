import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { makeServer } from "../server.js";
import { extractTokenStdio } from "../auth/token.js";
import { makeClient } from "../api/client.js";

/**
 * The three collaborators `runStdio` wires together. Each defaults to the real
 * implementation, so production calls `runStdio()` unchanged and a test can
 * hand in a double without replacing a module.
 */
export interface StdioDeps {
  serve?: typeof serveStdio;
  buildServer?: typeof makeServer;
  buildClient?: typeof makeClient;
}

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
export async function runStdio(deps: StdioDeps = {}): Promise<void> {
  const serve = deps.serve ?? serveStdio;
  const buildServer = deps.buildServer ?? makeServer;
  const buildClient = deps.buildClient ?? makeClient;
  const token = extractTokenStdio();
  serve(() => buildServer(() => buildClient(token)));
}
