/**
 * The transport-agnostic MCP tool-result shape. Lives at the package root (not
 * under `tools/_shared.ts`) because both the tool layer AND the cross-cutting
 * error mapper (`errors.ts`) depend on it: routing it through a tools-internal
 * `_`-private file would make a non-tools module reach into tools internals.
 */
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
