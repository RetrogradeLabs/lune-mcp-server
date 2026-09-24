import {
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/server";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type { KyInstance, Options as KyOptions } from "ky";
import { z } from "zod";

import {
  analyticsEnabled,
  attributeFromEnvelope,
  captureMcp,
  clientHeaderFor,
  type McpAnalyticsContext,
  type McpServerLike,
} from "../analytics.js";
import { fetchMcpContext } from "../api/mcp-context.js";
import {
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from "../json.js";
import {
  fixedReleases,
  isReleased,
  PUBLIC_RELEASES,
  PUBLIC_VIEW,
  type ReleaseSource,
  type Releases,
} from "../releases.js";
import { PAPER_TOOLS, callPaperTool } from "./papers.js";
import { GUIDANCE_TOOLS, callGuidanceTool } from "./guidance.js";
import { FIGURE_TOOLS, callFigureTool } from "./figures.js";
import { wireContent } from "../tool-result.js";
import type { ToolCallResult, ToolDef } from "./_shared.js";

// Workspace access rides source="workspace" on corpus tools; the API resolves
// the active workspace and ordinary credentials get 400, so none register here.
const ALL_TOOLS: readonly ToolDef[] = [
  ...PAPER_TOOLS,
  ...FIGURE_TOOLS,
  ...GUIDANCE_TOOLS,
];

const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

function projectedInputSchema(
  tool: ToolDef,
  includeWorkspace: boolean,
): z.ZodTypeAny {
  if (includeWorkspace) return tool.inputSchema;

  return tool.externalInputSchema ?? tool.inputSchema;
}

function jsonSchema(schema: z.ZodTypeAny): JsonObject {
  // SAFETY: zod emits JSON, but its nominal schema type lacks JsonObject's index
  // signature.
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
  }) as JsonObject;
}

function allowAdditiveOutputFields(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(allowAdditiveOutputFields);

  if (!isJsonObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      child === undefined || (key === "additionalProperties" && child === false)
        ? []
        : [[key, allowAdditiveOutputFields(child)]],
    ),
  );
}

function outputJsonSchema(schema: z.ZodTypeAny): JsonObject {
  const projected = allowAdditiveOutputFields(jsonSchema(schema));

  // SAFETY: `jsonSchema` returns an object, and the projection above rebuilds an
  // object from an object (it only drops keys), so the result is still one.
  return projected as JsonObject;
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
  // SAFETY: _meta came from decoded JSON-RPC; every field still gets type,
  // length, and charset checks.
  const metadata = (ctx?.mcpReq as { _meta?: JsonObject } | undefined)?._meta;

  const limits = {
    traceparent: 256,
    tracestate: 512,
    baggage: 4096,
  } satisfies Record<string, number>;

  return Object.fromEntries(
    Object.entries(limits).flatMap(([name, maxLength]) => {
      const value = metadata?.[name];

      const valid =
        isJsonString(value) &&
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

const FIGURE_NAMES = new Set(FIGURE_TOOLS.map((t) => t.name));

export function getAllToolDefinitions(): readonly ToolDef[] {
  return ALL_TOOLS;
}

/** A tool this credential was not released has no scope to demand: it is unknown. */
export function requiredScopeForTool(
  name: string,
  releases: Releases,
): ToolDef["requiredScope"] {
  const tool = TOOLS_BY_NAME.get(name);

  return tool && isReleased(tool.release, releases)
    ? tool.requiredScope
    : undefined;
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
 *
 * `releases` drops every tool whose release the credential lacks. Unlike the
 * workspace selector this is an access decision: `dispatchToolCall` refuses the
 * same tools, and the API refuses their routes.
 */
export function listToolsResponse(
  includeWorkspace = true,
  releases: Releases = PUBLIC_RELEASES,
) {
  return {
    tools: ALL_TOOLS.flatMap((t) =>
      isReleased(t.release, releases)
        ? [toolListEntry(t, includeWorkspace)]
        : [],
    ),
  };
}

function toolListEntry(t: ToolDef, includeWorkspace: boolean): ToolListEntry {
  const schema = projectedInputSchema(t, includeWorkspace);
  // The MCP spec mandates JSON Schema 2020-12 here: draft-7 makes strict
  // clients (Claude Desktop) drop the whole list as "no tools available".
  const inputSchema = jsonSchema(schema);

  const outputSchema = t.outputSchema
    ? outputJsonSchema(t.outputSchema)
    : undefined;

  // Assigned in declaration order, not spread: the serialized entry stays
  // byte-identical and optional keys stay absent, not undefined-valued.
  const entry: ToolListEntry = {
    name: t.name,
    // MCP 2025-06-18 spec + OpenAI Apps SDK: human-readable display name
    // and behavioral hints required for App-directory submission.
    title: t.title,
    description: t.description,
    inputSchema,
  };

  if (outputSchema) entry.outputSchema = outputSchema;
  entry.annotations = t.annotations;

  // `_meta` passthrough (e.g. `anthropic/alwaysLoad` on entry tools).
  if (t.meta) entry._meta = t.meta;

  return entry;
}

/** One `tools/list` entry. Optional keys are absent, never undefined, because the
 *  MCP spec distinguishes an omitted field from a present null. */
type ToolListEntry = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: ToolDef["annotations"];
  _meta?: JsonObject;
};

async function dispatchToolCall(
  api: KyInstance,
  name: string,
  args: JsonValue,
  includeWorkspace = true,
  releases: Releases = PUBLIC_RELEASES,
): Promise<ToolCallResult> {
  const definition = TOOLS_BY_NAME.get(name);

  if (!definition || !isReleased(definition.release, releases)) {
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
  // SAFETY: safeParse validated cloned JSON-RPC arguments; ZodTypeAny alone
  // erases that JSON type.
  const parsedArgs = input.data as JsonValue;

  if (PAPER_NAMES.has(name)) {
    result = await callPaperTool(api, name, parsedArgs);
  } else if (FIGURE_NAMES.has(name)) {
    result = await callFigureTool(api, name, parsedArgs);
  } else if (GUIDANCE_NAMES.has(name)) {
    result = await callGuidanceTool(api, name, parsedArgs);
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
  inputSchema: jsonSchema(GET_MORE_TOOLS_SCHEMA),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

type ErrorFacts = {
  $mcp_error_type: string;
  $mcp_error_message: string;
  $mcp_error_status?: string;
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
function errorFacts(result: ToolCallResult): ErrorFacts {
  const text = result.content.map((c) => c.text).join("\n");
  const status = /(?:^|\s)http_status=(\d{3})(?:\s|$)/.exec(text)?.[1];
  const errorType = /(?:^|\s)error_type=([a-z0-9_]+)(?:\s|$)/.exec(text)?.[1];

  const facts: ErrorFacts = {
    $mcp_error_type: errorType ?? "tool_error",
    $mcp_error_message: text,
  };

  if (status) facts.$mcp_error_status = status;

  return facts;
}

/**
 * Whether the caller's credential is workspace-scoped (the managed Lune
 * Workspace session PAT, which carries an active workspace). Any failure
 * (anonymous discovery, a non-workspace credential's 401/403, or an API hiccup)
 * resolves to false, so the workspace surface is hidden by default and never
 * leaked. Failing closed here just hides the workspace option; the API enforces
 * workspace access regardless.
 */
async function isWorkspaceCredential(
  makeClient: () => KyInstance,
): Promise<boolean> {
  try {
    return (await fetchMcpContext(makeClient())).workspace === true;
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
  server: McpServerLike,
  makeClient: () => KyInstance,
  analyticsContext?: () => McpAnalyticsContext,
  releases: ReleaseSource = fixedReleases(PUBLIC_VIEW),
): void {
  // X-Lune-Client is how API-side analytics tells claude-code from cursor from
  // the CLI; unconditional, because an absent header reads as `api_direct`.
  const taggedClient = (ctx?: ServerContext): KyInstance => {
    // Statements, not a conditional spread: `ky.extend` reads a
    // present-but-undefined option as "delete the inherited one".
    const options: KyOptions = {
      headers: {
        "X-Lune-Client": clientHeaderFor(server),
        ...traceContextHeaders(ctx),
      },
    };

    const signal = ctx?.mcpReq.signal;

    if (signal) options.signal = signal;

    return makeClient().extend(options);
  };

  // `setRequestHandler` infers a wide response union (ServerResult |
  // InputRequiredResult), so the cast satisfies the overload, not runtime.
  server.setRequestHandler(
    "tools/list",
    // Credential-aware: the workspace surface is advertised only to a
    // workspace-scoped credential; external clients never see that option.
    async (_req, ctx) => {
      attributeFromEnvelope(server, ctx);
      // Asked first: on stdio it may refresh the answer the context reads below.
      const { listed } = await releases();
      const contextWorkspace = analyticsContext?.()?.workspaceCredential;

      const response = listToolsResponse(
        contextWorkspace ??
          (await isWorkspaceCredential(() => taggedClient(ctx))),
        listed,
      );

      // Gated on the principal's opt-out, never on `captureEnabled`: that also
      // goes false on a spent event budget, which must not move the tool list.
      if (!analyticsEnabled() || analyticsContext?.()?.captureOptOut === true) {
        // SAFETY: ToolDefs hold draft-2020-12 object schemas; zod types the
        // export only as generic JSON.
        return response as ListToolsResult;
      }

      const tools = [...response.tools, GET_MORE_TOOLS_DEF];
      // Fires per REQUEST (the HTTP handler builds a server per request), so a
      // de-dup flag here is dead code; repeat lists spend the analytics budget.
      captureMcp("$mcp_tools_list", server, analyticsContext?.(), {
        $mcp_listed_tool_names: tools.map((tool) => tool.name),
      });

      // SAFETY: same entries as above plus `GET_MORE_TOOLS_DEF`, whose schema
      // comes from the same `jsonSchema` helper.
      return { tools } as ListToolsResult;
    },
  );

  /**
   * The free-text capability an agent asked for, for `$mcp_missing_capability`.
   * Anything that is not a string is not an intent: recording `[object Object]`
   * would pollute the intent clustering, so it reports as absent.
   */
  function capabilityIntent(args: JsonObject): string {
    const raw = args.capability;

    return isJsonString(raw) ? raw.slice(0, 500) : "";
  }

  server.setRequestHandler(
    "tools/call",
    async (
      req: CallToolRequest,
      ctx: ServerContext,
    ): Promise<CallToolResult> => {
      attributeFromEnvelope(server, ctx);
      const name = req.params.name;
      // SAFETY: transport decoded arguments as JSON; dispatchToolCall validates
      // the tool schema before handlers see them.
      const args = (req.params.arguments ?? {}) as JsonObject;

      if (name === "get_more_tools" && analyticsEnabled()) {
        // Bad args resolve to an isError result, never a thrown protocol error:
        // this tool exists to listen, so a malformed request is itself signal.
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
          };
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
        };
      }

      const api = taggedClient(ctx);
      const started = Date.now();

      try {
        const { callable } = await releases();
        const sourceWasSupplied = Object.hasOwn(args, "source");

        const includeWorkspace = sourceWasSupplied
          ? (analyticsContext?.()?.workspaceCredential ??
            (await isWorkspaceCredential(() => taggedClient(ctx))))
          : true;

        const result = await dispatchToolCall(
          api,
          name,
          args,
          includeWorkspace,
          callable,
        );

        if (analyticsEnabled()) {
          const properties: JsonObject = {
            $mcp_tool_name: name,
            $mcp_duration_ms: Date.now() - started,
            $mcp_is_error: result.isError === true,
          };

          if (result.isError === true) {
            Object.assign(properties, errorFacts(result));
          }

          captureMcp(
            "$mcp_tool_call",
            server,
            analyticsContext?.(),
            properties,
          );
        }

        const { attachments: _attachments, ...wire } = result;

        // SAFETY: dispatcher output passed its schema; our alias only widens
        // the SDK content discriminants, and `attachments` is our own field.
        return {
          ...wire,
          content: wireContent(result),
        } as CallToolResult;
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
