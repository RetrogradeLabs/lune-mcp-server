import type { z } from "zod";

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
 * with platform metadata (annotations + OAuth scope) so a single source can
 * power both the MCP `tools/list` response and the ChatGPT App submission.
 */
export interface ToolDef<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** Human-readable display name shown in ChatGPT's tool drawer. */
  title: string;
  description: string;
  inputSchema: TInput;
  /**
   * Optional output schema. MCP 2025-06-18 spec: when provided, MUST be a
   * JSON Schema object (`type: "object"` at the root) and the server SHOULD
   * return `structuredContent` matching the schema. ChatGPT's connector UI
   * surfaces a recommendation banner when this is missing.
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
  meta?: Record<string, unknown>;
  /** OAuth scopes the caller must hold. Aligned with API's `scopes_supported`. */
  scopes: readonly string[];
}

/**
 * `_meta` hint that keeps a tool un-deferred in clients that run MCP tool
 * search (Claude Code v2.1.121+ honors `anthropic/alwaysLoad`; other clients
 * ignore the unknown `_meta` key). Set on the 1-3 cold-start entry tools only:
 * each always-loaded tool spends context, and Claude Code truncates server
 * `instructions` at 2KB, so an entry tool's own description (which carries the
 * "use this for research, not web_search" trigger) being present upfront is what
 * makes Lune reliably selected without a `ToolSearch` hop. See `.claude/rules/mcp.md`.
 */
export const ALWAYS_LOAD_META: Record<string, unknown> = { "anthropic/alwaysLoad": true };

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  /**
   * Per MCP 2025-06-18: when a tool declares `outputSchema`, the response
   * SHOULD include `structuredContent` matching that schema. We populate
   * both fields (text + structured) so older clients that only read
   * `content` keep working.
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Wrap any JSON-serialisable response as an MCP text content block. */
export function jsonText(value: unknown): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * Emit the same JSON in `content` (text) AND `structuredContent` so clients
 * that consult `outputSchema` get a typed object they can validate, while
 * legacy clients still parse the text. Use this for any tool with an
 * `outputSchema` declared.
 */
export function structuredJson(value: Record<string, unknown>): ToolCallResult {
  return {
    // No pretty-print: the canonical channel is `structuredContent` (parsed by
    // schema-aware clients); the text mirror is a legacy fallback, so the
    // 2-space indent only inflated its token cost.
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function plainText(value: string): ToolCallResult {
  return { content: [{ type: "text", text: value }] };
}
