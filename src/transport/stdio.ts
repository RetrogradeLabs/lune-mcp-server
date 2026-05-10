import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeServer } from "../server.js";
import { extractTokenStdio } from "../auth/token.js";
import { makeClient } from "../api/client.js";

/**
 * Run the MCP server over stdio. The Bearer token is captured once at process
 * startup (since stdio is single-tenant: one process per agent invocation).
 */
export async function runStdio(): Promise<void> {
  const token = extractTokenStdio();
  const server = makeServer(() => makeClient(token));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
