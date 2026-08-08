import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wire the `resources/list` handler. Call AFTER `registerAllTools`; the
 * `resources: {}` capability is already declared in `makeServer` (without it
 * the SDK throws "Server does not support resources" at startup).
 *
 * The server advertises the `resources` capability but exposes none yet:
 * several connectors (Smithery, ChatGPT's custom-connector UI, the MCP
 * Inspector) probe `resources/list` defensively at session-init, and
 * `{resources: []}` lets them complete without a `-32601 Method not found`
 * warning. When we add real resources, fill this handler in (mirroring how
 * `registerPrompts` wires `prompts/list` + `prompts/get`).
 */
export function registerResources(server: Server): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));
}
