/**
 * Unit coverage for the MCP result wrappers in `src/tools/_shared.ts`.
 */
import { describe, expect, it } from "vitest";
import { jsonText, plainText, structuredJson } from "../../src/tools/_shared.js";

describe("jsonText", () => {
  it("wraps a JSON-serialisable value as a pretty-printed text block", () => {
    const r = jsonText({ a: 1, b: ["x"] });
    expect(r.content).toEqual([
      { type: "text", text: JSON.stringify({ a: 1, b: ["x"] }, null, 2) },
    ]);
    // jsonText is the legacy wrapper: no structuredContent.
    expect(r.structuredContent).toBeUndefined();
  });

  it("serialises primitives too", () => {
    expect(jsonText("hello").content[0]!.text).toBe('"hello"');
    expect(jsonText(7).content[0]!.text).toBe("7");
  });
});

describe("structuredJson", () => {
  it("emits the value in both content text and structuredContent", () => {
    const value = { results: [{ paper_id: "p1" }] };
    const r = structuredJson(value);
    expect(JSON.parse(r.content[0]!.text)).toEqual(value);
    expect(r.structuredContent).toEqual(value);
  });
});

describe("plainText", () => {
  it("wraps a raw string with no structuredContent", () => {
    const r = plainText("# Heading\nbody");
    expect(r.content).toEqual([{ type: "text", text: "# Heading\nbody" }]);
    expect(r.structuredContent).toBeUndefined();
  });
});
