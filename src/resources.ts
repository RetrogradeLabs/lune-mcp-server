import {
  ResourceNotFoundError,
  type Server,
} from "@modelcontextprotocol/server";
import {
  analyticsEnabled,
  attributeFromEnvelope,
  captureMcp,
  type McpAnalyticsContext,
} from "./analytics.js";

/**
 * Wire the resource discovery handlers. The `resources: {}` capability is already
 * declared in `makeServer` (without it the SDK throws "Server does not support
 * resources" at startup).
 *
 * The server advertises the `resources` capability but exposes none yet:
 * several connectors (Smithery, ChatGPT's custom-connector UI, the MCP
 * Inspector) probe `resources/list` defensively at session-init, and
 * empty lists let them complete without `-32601 Method not found`
 * warning. When we add real resources, fill this handler in (mirroring how
 * `registerPrompts` wires `prompts/list` + `prompts/get`) AND revisit the
 * `resources/list` cache hint in `server.ts`: `cacheScope: "public"` is sound
 * only while an empty list is identical for every caller, so the first
 * per-principal resource (a workspace document, most likely) has to flip that
 * hint to `private` in the same diff. `protocol-era.test.ts` enforces the
 * coupling rather than trusting this paragraph: it fails on a non-empty list
 * while the hint is still public.
 */
export function registerResources(
  server: Server,
  analyticsContext?: () => McpAnalyticsContext,
): void {
  // No upstream API call here either, so the request envelope is the only
  // source of client identity for the `$mcp_resources_list` event.
  server.setRequestHandler("resources/list", async (_req, ctx) => {
    attributeFromEnvelope(server, ctx);
    if (analyticsEnabled()) {
      captureMcp("$mcp_resources_list", server, analyticsContext?.(), {});
    }
    return { resources: [] };
  });
  server.setRequestHandler("resources/templates/list", async (_req, ctx) => {
    attributeFromEnvelope(server, ctx);
    return { resourceTemplates: [] };
  });
  server.setRequestHandler("resources/read", async (req, ctx) => {
    attributeFromEnvelope(server, ctx);
    throw new ResourceNotFoundError(req.params.uri);
  });
}
