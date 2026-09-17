/**
 * The transport-agnostic MCP tool-result shape. Lives at the package root (not
 * under `tools/_shared.ts`) because both the tool layer AND the cross-cutting
 * error mapper (`errors.ts`) depend on it: routing it through a tools-internal
 * `_`-private file would make a non-tools module reach into tools internals.
 */
export interface TextContentBlock {
  type: "text";
  text: string;
}

/** A base64 image block. Valid on both protocol eras (`ImageContentSchema`). */
export interface ImageContentBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCallResult {
  content: TextContentBlock[];
  /**
   * Non-text blocks appended after `content` when the result crosses the wire
   * (`dispatchToolCall`). A separate field rather than a union inside
   * `content`: every producer and every reader here handles text, and widening
   * `content` would make `content[0].text` stop compiling at ~40 call sites to
   * serve the one tool that attaches anything. Used by
   * `search_figure_references` under `include_images`.
   */
  attachments?: ImageContentBlock[];
  /**
   * MCP 2026-07-28 permits any JSON value here. When a tool declares an
   * `outputSchema`, successful output must match it. We also return the JSON as
   * text so older clients keep working.
   */
  structuredContent?: JSONValue;
  isError?: boolean;
}

import type { JSONValue } from "@modelcontextprotocol/server";

/**
 * Every block the result puts on the wire: text first, then attachments.
 *
 * The one place the two are combined, so `ToolCallResult` stays text-typed for
 * its ~40 readers while the transport still sees the image blocks.
 */
export function wireContent(
  result: ToolCallResult,
): Array<TextContentBlock | ImageContentBlock> {
  return result.attachments?.length
    ? [...result.content, ...result.attachments]
    : result.content;
}
