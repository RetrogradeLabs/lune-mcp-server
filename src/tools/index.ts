import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { KyInstance } from "ky";
import { z } from "zod";

import { PAPER_TOOLS, callPaperTool } from "./papers.js";
import { GUIDANCE_TOOLS, callGuidanceTool } from "./guidance.js";
import { SUBS_TOOLS, callSubsTool } from "./subscriptions.js";
import type { ToolCallResult, ToolDef } from "./_shared.js";

const ALL_TOOLS: readonly ToolDef[] = [
  ...PAPER_TOOLS,
  ...GUIDANCE_TOOLS,
  ...SUBS_TOOLS,
];

const PAPER_NAMES = new Set(PAPER_TOOLS.map((t) => t.name));
const GUIDANCE_NAMES = new Set(GUIDANCE_TOOLS.map((t) => t.name));
const SUBS_NAMES = new Set(SUBS_TOOLS.map((t) => t.name));

export function getAllToolDefinitions(): readonly ToolDef[] {
  return ALL_TOOLS;
}

/** Render every zod schema as JSON Schema for `tools/list`. */
export function listToolsResponse() {
  return {
    tools: ALL_TOOLS.map((t) => {
      // MCP spec mandates JSON Schema 2020-12 for `inputSchema` /
      // `outputSchema`. Older `draft-7` output triggers stricter clients
      // (Claude Desktop) to reject the tool list with no actionable error,
      // leading to "no tools available" in the connector UI. zod 4 ships
      // native JSON-Schema export.
      const inputSchema = z.toJSONSchema(t.inputSchema, {
        target: "draft-2020-12",
      }) as Record<string, unknown>;
      const outputSchema = t.outputSchema
        ? (z.toJSONSchema(t.outputSchema, {
            target: "draft-2020-12",
          }) as Record<string, unknown>)
        : undefined;
      return {
        name: t.name,
        // MCP 2025-06-18 spec + OpenAI Apps SDK: human-readable display name
        // and behavioral hints required for App-directory submission.
        title: t.title,
        description: t.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        annotations: t.annotations,
      };
    }),
  };
}

async function dispatchToolCall(
  api: KyInstance,
  name: string,
  args: unknown,
): Promise<ToolCallResult> {
  if (PAPER_NAMES.has(name)) return callPaperTool(api, name, args);
  if (GUIDANCE_NAMES.has(name)) return callGuidanceTool(api, name, args);
  if (SUBS_NAMES.has(name)) return callSubsTool(api, name, args);
  throw new Error(`unknown tool: ${name}`);
}

export { dispatchToolCall };

/**
 * Wire `tools/list` and `tools/call` request handlers onto the given server.
 * `makeClient` is called per request so each tool invocation sees the latest
 * Bearer token (HTTP transport rotates tokens mid-session).
 */
export function registerAllTools(server: Server, makeClient: () => KyInstance): void {
  // The SDK's setRequestHandler infers a wide union for the response type
  // (ServerResult | TaskResult); cast to satisfy the overload while still
  // returning a valid ServerResult shape at runtime.
  server.setRequestHandler(
    ListToolsRequestSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async () => listToolsResponse() as any,
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: { params: { name: string; arguments?: Record<string, unknown> } }) => {
      const api = makeClient();
      const name = req.params.name;
      const args = req.params.arguments ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await dispatchToolCall(api, name, args)) as any;
    },
  );

  // Empty `resources/list` + `prompts/list` handlers. The server doesn't
  // advertise either capability (only `tools` is in the capabilities map),
  // but several connectors (Smithery, ChatGPT's custom-connector UI, and
  // the MCP Inspector) probe these methods defensively at session-init.
  // Returning `{resources: []}` / `{prompts: []}` lets them complete without
  // surfacing a `MCP error -32601: Method not found` warning to the user.
  // When we add real resources or prompts later, we'll need to also flip
  // the matching capabilities flag in `server.ts`.
  server.setRequestHandler(
    ListResourcesRequestSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async () => ({ resources: [] }) as any,
  );
  server.setRequestHandler(
    ListPromptsRequestSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async () => ({ prompts: [] }) as any,
  );
}
