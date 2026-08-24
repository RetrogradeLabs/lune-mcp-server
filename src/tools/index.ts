import {
  ProtocolError,
  ProtocolErrorCode,
  type Server,
  type ServerContext,
} from "@modelcontextprotocol/server";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type { KyInstance } from "ky";
import { z } from "zod";

import {
  analyticsEnabled,
  attributeFromEnvelope,
  captureMcp,
  clientHeaderFor,
  type McpAnalyticsContext,
} from "../analytics.js";
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
const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

function projectedInputSchema(
  tool: ToolDef,
  includeWorkspace: boolean,
): z.ZodTypeAny {
  if (includeWorkspace) return tool.inputSchema;
  const shape = (tool.inputSchema as { shape?: Record<string, unknown> }).shape;
  return shape && "source" in shape
    ? (tool.inputSchema as z.ZodObject<z.ZodRawShape>).omit({ source: true })
    : tool.inputSchema;
}

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
}

function allowAdditiveOutputFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(allowAdditiveOutputFields);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key === "additionalProperties" && child === false
        ? []
        : [[key, allowAdditiveOutputFields(child)]],
    ),
  );
}

function outputJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return allowAdditiveOutputFields(jsonSchema(schema)) as Record<
    string,
    unknown
  >;
}

const inputSchemaValidator = new Ajv2020({
  allErrors: true,
  strict: true,
  useDefaults: true,
  validateFormats: false,
});
const outputSchemaValidator = new Ajv2020({
  allErrors: true,
  strict: true,
  useDefaults: false,
  validateFormats: false,
});
const INPUT_VALIDATORS = new Map<string, ValidateFunction>();
const EXTERNAL_INPUT_VALIDATORS = new Map<string, ValidateFunction>();
const OUTPUT_VALIDATORS = new Map<string, ValidateFunction>();
for (const tool of ALL_TOOLS) {
  INPUT_VALIDATORS.set(
    tool.name,
    inputSchemaValidator.compile(jsonSchema(tool.inputSchema)),
  );
  EXTERNAL_INPUT_VALIDATORS.set(
    tool.name,
    inputSchemaValidator.compile(jsonSchema(projectedInputSchema(tool, false))),
  );
  if (tool.outputSchema) {
    OUTPUT_VALIDATORS.set(
      tool.name,
      outputSchemaValidator.compile(outputJsonSchema(tool.outputSchema)),
    );
  }
}

function traceContextHeaders(ctx?: ServerContext): Record<string, string> {
  const metadata = (
    ctx?.mcpReq as { _meta?: Record<string, unknown> } | undefined
  )?._meta;
  const limits: Record<string, number> = {
    traceparent: 256,
    tracestate: 512,
    baggage: 4096,
  };
  return Object.fromEntries(
    Object.entries(limits).flatMap(([name, maxLength]) => {
      const value = metadata?.[name];
      const valid =
        typeof value === "string" &&
        value.length <= maxLength &&
        value.split("").every((character) => {
          const code = character.charCodeAt(0);
          return code === 9 || (code >= 32 && code <= 126);
        });
      return valid ? [[name, value]] : [];
    }),
  );
}

const PAPER_NAMES = new Set(PAPER_TOOLS.map((t) => t.name));
const GUIDANCE_NAMES = new Set(GUIDANCE_TOOLS.map((t) => t.name));

export function getAllToolDefinitions(): readonly ToolDef[] {
  return ALL_TOOLS;
}

export function requiredScopeForTool(name: string): ToolDef["requiredScope"] {
  return TOOLS_BY_NAME.get(name)?.requiredScope;
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
      const schema = projectedInputSchema(t, includeWorkspace);
      // MCP spec mandates JSON Schema 2020-12 for `inputSchema` /
      // `outputSchema`. Older `draft-7` output triggers stricter clients
      // (Claude Desktop) to reject the tool list with no actionable error,
      // leading to "no tools available" in the connector UI. zod 4 ships
      // native JSON-Schema export.
      const inputSchema = jsonSchema(schema);
      const outputSchema = t.outputSchema
        ? outputJsonSchema(t.outputSchema)
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
  includeWorkspace = true,
): Promise<ToolCallResult> {
  const definition = TOOLS_BY_NAME.get(name);
  if (!definition) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Unknown tool: ${name}`,
    );
  }

  const inputValidator = (
    includeWorkspace ? INPUT_VALIDATORS : EXTERNAL_INPUT_VALIDATORS
  ).get(name)!;
  const validatedArgs = structuredClone(args);
  const jsonInputValid = inputValidator(validatedArgs);
  const input = definition.inputSchema.safeParse(validatedArgs);
  if (!jsonInputValid || !input.success) {
    const issues = !jsonInputValid
      ? (inputValidator.errors ?? []).slice(0, 5).map((issue) => {
          const path = issue.instancePath
            .replace(/^\//, "")
            .replaceAll("/", ".");
          return `${path || "arguments"}: ${issue.message ?? "is invalid"}`;
        })
      : (input.success ? [] : input.error.issues).slice(0, 5).map((issue) => {
          const path = issue.path.map(String).join(".") || "arguments";
          return `${path}: ${issue.message}`;
        });
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `Invalid arguments for ${name}:`,
            ...issues,
            "Correct the named arguments before retrying.",
          ].join("\n"),
        },
      ],
    };
  }

  let result: ToolCallResult;
  if (PAPER_NAMES.has(name)) {
    result = await callPaperTool(api, name, input.data);
  } else if (GUIDANCE_NAMES.has(name)) {
    result = await callGuidanceTool(api, name, input.data);
  } else {
    throw new Error(`Tool ${name} has no registered handler`);
  }

  const outputValidator = OUTPUT_VALIDATORS.get(name);
  if (outputValidator && result.isError !== true) {
    if (!outputValidator(result.structuredContent)) {
      const issue = outputValidator.errors?.[0];
      const path =
        issue?.instancePath.replace(/^\//, "").replaceAll("/", ".") ||
        "structuredContent";
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Lune returned an invalid response for ${name} at ${path}. ` +
              "Stop retrying this tool and report the problem. " +
              "error_type=output_schema_violation",
          },
        ],
      };
    }
  }
  return result;
}

export { dispatchToolCall };

/**
 * Roadmap intake, registered ONLY when analytics is enabled (the remote
 * deployment): an agent that needs a capability Lune lacks invokes this, and
 * the request lands as `$mcp_missing_capability`, a direct unmet-demand
 * signal. Local stdio installs never see the tool (analytics is never
 * initialized there), so the published tool surface is unchanged for them.
 */
const GET_MORE_TOOLS_SCHEMA = z.object({
  capability: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Describe the missing capability generically in one or two sentences. " +
        "Do not include user text, names, emails, credentials, or draft content.",
    ),
});

export const GET_MORE_TOOLS_DEF = {
  name: "get_more_tools",
  title: "Request a missing capability",
  description:
    "Call this when the research task needs something Lune's tools cannot do " +
    "yet (a data source, a filter, an analysis). The request is recorded for " +
    "the roadmap; omit private details. It does not add tools to this session.",
  inputSchema: z.toJSONSchema(GET_MORE_TOOLS_SCHEMA, {
    target: "draft-2020-12",
  }) as Record<string, unknown>,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

/**
 * The two failure facts PostHog's MCP views read off an errored call
 * (`$mcp_error_message`, `$mcp_error_status`). `toToolError` already renders the
 * agent-facing prose plus a machine-readable `k=v` footer, so read them back out
 * of the result instead of threading a second error channel through every tool
 * handler. Emitting neither is what left "extract_from_papers: 100% error rate"
 * as a bare count with no reason attached; `captureMcp` sanitises and truncates
 * the text on the way out.
 */
function errorFacts(result: ToolCallResult): Record<string, unknown> {
  const text = result.content.map((c) => c.text).join("\n");
  const status = /(?:^|\s)http_status=(\d{3})(?:\s|$)/.exec(text)?.[1];
  const errorType = /(?:^|\s)error_type=([a-z0-9_]+)(?:\s|$)/.exec(text)?.[1];
  return {
    $mcp_error_type: errorType ?? "tool_error",
    $mcp_error_message: text,
    ...(status ? { $mcp_error_status: status } : {}),
  };
}

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
  analyticsContext?: () => McpAnalyticsContext,
): void {
  // Attach client attribution (X-Lune-Client) to every upstream call; the
  // header is how API-side analytics distinguishes claude-code vs cursor vs
  // CLI usage without any client-side telemetry. Unconditional because its
  // absence is what makes the API read the call as `api_direct`, so an
  // unidentified client still has to say which transport it came in on.
  const taggedClient = (ctx?: ServerContext): KyInstance =>
    makeClient().extend({
      headers: {
        "X-Lune-Client": clientHeaderFor(server),
        ...traceContextHeaders(ctx),
      },
      ...(ctx?.mcpReq.signal ? { signal: ctx.mcpReq.signal } : {}),
    });
  // The SDK's setRequestHandler infers a wide union for the response type
  // (ServerResult | InputRequiredResult); cast to satisfy the overload while
  // still returning a valid ServerResult shape at runtime.
  server.setRequestHandler(
    "tools/list",
    // Credential-aware: the workspace surface is advertised ONLY to a
    // workspace-scoped credential (the dashboard Workspace agent); external
    // clients never see the `source="workspace"` option.
    async (_req, ctx) => {
      attributeFromEnvelope(server, ctx);
      const contextWorkspace = analyticsContext?.()?.workspaceCredential;
      const response = listToolsResponse(
        contextWorkspace ??
          (await isWorkspaceCredential(() => taggedClient(ctx))),
      );
      // Gated on the principal's OPT-OUT, never on `captureEnabled`: that also
      // goes false when the shared daily event budget is spent, and a telemetry
      // quota must not decide which tools an agent is offered. Under a spent
      // budget the tool stays listed and `captureMcp` drops the event, which is
      // the same thing that happens to every other event in that window.
      if (!analyticsEnabled() || analyticsContext?.()?.captureOptOut === true) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return response as any;
      }
      const tools = [...response.tools, GET_MORE_TOOLS_DEF];
      // Fires per REQUEST: the HTTP handler builds a server per request, so a
      // de-dup flag scoped here would never be true. Repeat lists therefore
      // spend the `claimMcpAnalyticsBudget` allowance (`.claude/rules/mcp.md`),
      // and the cure for that is not cross-request state.
      captureMcp("$mcp_tools_list", server, analyticsContext?.(), {
        $mcp_listed_tool_names: tools.map((tool) => tool.name),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { tools } as any;
    },
  );

  /**
   * The free-text capability an agent asked for, for `$mcp_missing_capability`.
   * Anything that is not a string is not an intent: recording `[object Object]`
   * would pollute the intent clustering, so it reports as absent.
   */
  function capabilityIntent(args: Record<string, unknown>): string {
    const raw = args.capability;
    return typeof raw === "string" ? raw.slice(0, 500) : "";
  }

  server.setRequestHandler(
    "tools/call",
    async (
      req: { params: { name: string; arguments?: Record<string, unknown> } },
      ctx: ServerContext,
    ) => {
      attributeFromEnvelope(server, ctx);
      const name = req.params.name;
      const args = req.params.arguments ?? {};
      if (name === "get_more_tools" && analyticsEnabled()) {
        // Graceful on bad args (an isError result, not a thrown protocol
        // error): this meta tool exists to LISTEN, so a malformed request is
        // itself signal and must never read as a server fault to the agent.
        const parsed = GET_MORE_TOOLS_SCHEMA.safeParse(args);
        const captured = captureMcp(
          "$mcp_missing_capability",
          server,
          analyticsContext?.(),
          {
            $mcp_intent: parsed.success
              ? parsed.data.capability
              : capabilityIntent(args),
            $mcp_is_error: !parsed.success,
          },
        );
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  "get_more_tools needs a `capability` string describing " +
                  "what you were trying to do.",
              },
            ],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any;
        }
        return {
          content: [
            {
              type: "text",
              text:
                "Lune cannot do this yet. " +
                (captured
                  ? "The request was submitted for roadmap review. "
                  : "No roadmap event was stored. ") +
                "Continue with the existing tools.",
            },
          ],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      }
      const api = taggedClient(ctx);
      const started = Date.now();
      try {
        const sourceWasSupplied =
          typeof args === "object" &&
          args !== null &&
          Object.hasOwn(args, "source");
        const includeWorkspace = sourceWasSupplied
          ? (analyticsContext?.()?.workspaceCredential ??
            (await isWorkspaceCredential(() => taggedClient(ctx))))
          : true;
        const result = await dispatchToolCall(
          api,
          name,
          args,
          includeWorkspace,
        );
        if (analyticsEnabled()) {
          captureMcp("$mcp_tool_call", server, analyticsContext?.(), {
            $mcp_tool_name: name,
            $mcp_duration_ms: Date.now() - started,
            $mcp_is_error: result.isError === true,
            ...(result.isError === true ? errorFacts(result) : {}),
          });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return result as any;
      } catch (e) {
        if (analyticsEnabled()) {
          captureMcp("$mcp_tool_call", server, analyticsContext?.(), {
            $mcp_tool_name: name,
            $mcp_duration_ms: Date.now() - started,
            $mcp_is_error: true,
            $mcp_error_type: "protocol_error",
          });
        }
        throw e;
      }
    },
  );
}
