import type { JsonObject, JsonValue } from "../json.js";
import type { JSONValue } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { ReleaseName } from "../releases.js";
import type { ToolCallResult } from "../tool-result.js";

export type { ToolCallResult } from "../tool-result.js";

/**
 * MCP tool annotations: required by OpenAI's Apps SDK per
 * https://developers.openai.com/apps-sdk/build/mcp-server. Validation error
 * if any of the three required hints are omitted or null at submission time.
 */
export interface ToolAnnotations {
  /** True if the tool only reads data (no side effects). */
  readOnlyHint: boolean;
  /**
   * True if the tool's effects are irreversible (e.g. delete). Read-only tools
   * MUST set this to false.
   */
  destructiveHint: boolean;
  /**
   * True if the tool acts on a bounded, internal target. False if the impact
   * extends beyond our system (e.g. external HTTP calls, user notifications).
   * Read-only retrievals from our own corpus are typically `false` (open
   * world: returning indexed-but-third-party academic papers).
   */
  openWorldHint: boolean;
  /** True if calling the tool with the same args is safe to repeat. */
  idempotentHint?: boolean;
}

/**
 * Each tool definition couples MCP fields (name, title, description, schema)
 * with platform metadata (annotations) so a single source can power both the
 * MCP `tools/list` response and the ChatGPT App submission.
 */
export interface ToolDef<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** OAuth scope enforced by the relay before dispatch; absent for public tools. */
  requiredScope?: "papers:read" | "guidance:read";
  /** Listed and callable only for a credential this release reaches. */
  release?: ReleaseName;
  /** Human-readable display name shown in ChatGPT's tool drawer. */
  title: string;
  description: string;
  inputSchema: TInput;
  /**
   * Schema served to credentials without workspace access. Set it on every tool
   * whose input carries `source`, so the `source="workspace"` selector is not
   * offered to a caller that cannot use it. Declared per tool rather than
   * derived by reflection: reflection keys the projection on the literal string
   * "source", so renaming that field would silently stop projecting and start
   * advertising the selector to external credentials.
   */
  externalInputSchema?: z.ZodTypeAny;
  /**
   * Optional JSON Schema 2020-12 output contract. MCP 2026-07-28 permits any
   * JSON value and requires successful `structuredContent` to match this
   * schema. ChatGPT's connector UI also surfaces a recommendation banner when
   * it is missing.
   */
  outputSchema?: z.ZodTypeAny;
  /** Required by the Apps SDK (see note above). */
  annotations: ToolAnnotations;
  /**
   * Optional MCP `_meta` passthrough, emitted verbatim in the `tools/list`
   * entry. Used to carry client-specific hints; e.g. `ALWAYS_LOAD_META` exempts
   * an entry tool from Claude Code's tool-search deferral so its full schema
   * (and the trigger in its description) is in context from session start.
   */
  meta?: JsonObject;
}

/**
 * `_meta` hint that keeps a tool un-deferred in clients that run MCP tool
 * search (Claude Code v2.1.121+ honors `anthropic/alwaysLoad`; other clients
 * ignore the unknown `_meta` key). Set on the 1-3 cold-start entry tools only:
 * each always-loaded tool spends context, and Claude Code truncates server
 * `instructions` at 2KB, so an entry tool's own description (which carries the
 * "use this for research, not web_search" trigger) being present upfront is what
 * makes Lune reliably selected without a `ToolSearch` hop. See the MCP server design notes.
 */
/**
 * The annotation set every corpus retrieval tool carries. Shared rather than
 * re-declared per family: these four hints are a property of "reads our own
 * index of third-party papers", not of one file. `openWorldHint` is true
 * because the papers and figures returned are third-party works we index.
 */
export const READ_ONLY_OPEN: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: true,
};

export const ALWAYS_LOAD_META = {
  "anthropic/alwaysLoad": true,
} satisfies JsonObject;

/**
 * Emit the same JSON in `content` (text) AND `structuredContent` so clients
 * that consult `outputSchema` get a typed object they can validate, while
 * legacy clients still parse the text. Use this for any tool with an
 * `outputSchema` declared.
 */
export function structuredJson(value: JsonValue): ToolCallResult {
  return {
    // structuredContent is canonical; minified text is a low-token legacy
    // fallback.
    content: [{ type: "text", text: JSON.stringify(value) }],
    // SAFETY: both types encode the same JSON; stringify drops our allowed
    // undefined-valued keys.
    structuredContent: value as JSONValue,
  };
}

export function plainText(value: string): ToolCallResult {
  return { content: [{ type: "text", text: value }] };
}
