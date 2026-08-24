/**
 * The transport-agnostic MCP tool-result shape. Lives at the package root (not
 * under `tools/_shared.ts`) because both the tool layer AND the cross-cutting
 * error mapper (`errors.ts`) depend on it: routing it through a tools-internal
 * `_`-private file would make a non-tools module reach into tools internals.
 */
export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  /**
   * MCP 2026-07-28 permits any JSON value here. When a tool declares an
   * `outputSchema`, successful output must match it. We also return the JSON as
   * text so older clients keep working.
   */
  structuredContent?: JSONValue;
  isError?: boolean;
}
import type { JSONValue } from "@modelcontextprotocol/server";
