/**
 * Reading a tool result the way an agent reads it.
 *
 * A tool that declares an `outputSchema` answers on TWO channels: the canonical
 * `structuredContent` and a text mirror carrying `JSON.stringify` of the same
 * value, which is what a client that predates structured output parses. So the
 * assertion a test wants is about those bytes, not about the in-process object:
 * `wireJson` returns the mirror only after checking the two channels agree,
 * which makes one read stronger than either channel alone, and the shape is
 * declared by annotating the parse at the call site (usually with the
 * projector's own return type, so a projector change fails the build).
 */
import type {
  CallToolResult,
  ContentBlock,
  HandlerResultTypeMap,
} from "@modelcontextprotocol/server";

import type { ToolCallResult } from "../../src/tool-result.js";

type AnyToolResult = ToolCallResult | CallToolResult;

function isTextBlock(
  block: ContentBlock | { type: "text"; text: string },
): block is { type: "text"; text: string } {
  return block.type === "text";
}

/** The text a tool result puts in front of the model. */
export function toolText(result: AnyToolResult): string {
  const [first] = result.content;

  if (!first) throw new Error("tool result carried no content block");

  if (!isTextBlock(first)) {
    throw new Error(`leading content block is ${first.type}, not text`);
  }

  return first.text;
}

/**
 * The JSON a tool result carries, as the bytes both channels send. Parse it with
 * an annotated binding (`const x: Shape = JSON.parse(wireJson(res))`) rather
 * than asserting on `structuredContent`.
 */
export function wireJson(result: AnyToolResult): string {
  const text = toolText(result);
  const structured = result.structuredContent;

  if (structured !== undefined && text !== JSON.stringify(structured)) {
    throw new Error(
      "the text mirror and structuredContent disagree: " +
        `${text} vs ${JSON.stringify(structured)}`,
    );
  }

  return text;
}

/**
 * Narrow what a registered `tools/call` handler returns.
 *
 * The SDK types the result as a union with `InputRequiredResult`, because a
 * server MAY answer a tool call by elicitating more input. No Lune tool does,
 * so a test that got one has found a real regression and should say so rather
 * than assert the case away.
 */
function hasContentBlocks(
  result: HandlerResultTypeMap["tools/call"],
): result is CallToolResult {
  // Not `"content" in result`: `CallToolResult` carries an index signature, so
  // the `in` operator cannot discriminate the union. The array is the evidence.
  return Array.isArray(result["content"]);
}

export function callResult(
  result: HandlerResultTypeMap["tools/call"],
): CallToolResult {
  if (!hasContentBlocks(result)) {
    throw new Error("tools/call answered with an input-required result");
  }

  return result;
}
