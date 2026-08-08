import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { KyInstance } from "ky";
import { z } from "zod";

import { PAPER_TOOLS, callPaperTool } from "./papers.js";
import { GUIDANCE_TOOLS, callGuidanceTool } from "./guidance.js";
import type { ToolCallResult, ToolDef } from "./_shared.js";

// Workspace retrieval is NOT a separate tool family: it rides the corpus tools'
// `source="workspace"` selector (search_papers / get_paper_fulltext /
// extract_from_papers / verify_claims / gather_evidence in papers.ts), which the
// API resolves to the caller's active workspace. So there is nothing to register
// here, and external (non-workspace) credentials simply get a 400 if they ask
// for source="workspace".
const ALL_TOOLS: readonly ToolDef[] = [...PAPER_TOOLS, ...GUIDANCE_TOOLS];

const PAPER_NAMES = new Set(PAPER_TOOLS.map((t) => t.name));
const GUIDANCE_NAMES = new Set(GUIDANCE_TOOLS.map((t) => t.name));

export function getAllToolDefinitions(): readonly ToolDef[] {
  return ALL_TOOLS;
}

/**
 * Render every zod schema as JSON Schema for `tools/list`.
 *
 * `includeWorkspace` gates the workspace surface: when false (a non-workspace
 * credential, see `isWorkspaceCredential`), the `source` selector is stripped
 * from every tool that has it. That selector's enum + describe are the ONLY
 * workspace mention in the catalog (descriptions are corpus-only), so dropping it
 * hides the workspace capability entirely from external clients. It stays a
 * cosmetic / discovery gate, the API independently enforces workspace access
 * server-side (`require_active_workspace`), so a hand-crafted source="workspace"
 * from a non-workspace credential still 400/403s.
 */
export function listToolsResponse(includeWorkspace = true) {
  return {
    tools: ALL_TOOLS.map((t) => {
      let schema = t.inputSchema;
      if (!includeWorkspace) {
        const shape = (schema as { shape?: Record<string, unknown> }).shape;
        if (shape && "source" in shape) {
          schema = (schema as z.ZodObject<z.ZodRawShape>).omit({
            source: true,
          });
        }
      }
      // MCP spec mandates JSON Schema 2020-12 for `inputSchema` /
      // `outputSchema`. Older `draft-7` output triggers stricter clients
      // (Claude Desktop) to reject the tool list with no actionable error,
      // leading to "no tools available" in the connector UI. zod 4 ships
      // native JSON-Schema export.
      const inputSchema = z.toJSONSchema(schema, {
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
        // `_meta` passthrough (e.g. `anthropic/alwaysLoad` on entry tools).
        ...(t.meta ? { _meta: t.meta } : {}),
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
  throw new Error(`unknown tool: ${name}`);
}

export { dispatchToolCall };

/**
 * Whether the caller's credential is workspace-scoped (the managed Lune
 * Workspace session PAT, which carries an active workspace). Reads the cheap,
 * DB-free `/account/mcp-context` endpoint with the request's bearer. Any failure
 * (anonymous discovery, a non-workspace credential's 401/403, or an API hiccup)
 * resolves to false, so the workspace surface is hidden by default and never
 * leaked. Called once per `tools/list` (session start), so a SHORT timeout + no
 * retry bounds it: the default client's 30s timeout (and its 2x 5xx retry, ~90s)
 * on this cosmetic gate would otherwise stall tool discovery for every client if
 * the account endpoint hangs. Failing closed here just hides the workspace
 * option; the API enforces workspace access regardless.
 */
async function isWorkspaceCredential(
  makeClient: () => KyInstance,
): Promise<boolean> {
  try {
    const r = await makeClient()
      .get("account/mcp-context", { timeout: 2500, retry: 0 })
      .json<{ workspace?: boolean }>();
    return r?.workspace === true;
  } catch {
    return false;
  }
}

/**
 * Wire `tools/list` and `tools/call` request handlers onto the given server.
 * `makeClient` is called per request so each tool invocation sees the latest
 * Bearer token (HTTP transport rotates tokens mid-session). The `resources`
 * and `prompts` capabilities are wired separately (`registerResources`,
 * `registerPrompts`) so each MCP capability is registered by one function.
 */
export function registerAllTools(
  server: Server,
  makeClient: () => KyInstance,
): void {
  // The SDK's setRequestHandler infers a wide union for the response type
  // (ServerResult | TaskResult); cast to satisfy the overload while still
  // returning a valid ServerResult shape at runtime.
  server.setRequestHandler(
    ListToolsRequestSchema,
    // Credential-aware: the workspace surface is advertised ONLY to a
    // workspace-scoped credential (the dashboard Workspace agent); external
    // clients never see the `source="workspace"` option.
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return listToolsResponse(await isWorkspaceCredential(makeClient)) as any;
    },
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req: {
      params: { name: string; arguments?: Record<string, unknown> };
    }) => {
      const api = makeClient();
      const name = req.params.name;
      const args = req.params.arguments ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await dispatchToolCall(api, name, args)) as any;
    },
  );
}
