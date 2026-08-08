/**
 * Unit coverage for the MCP result wrappers in `src/tools/_shared.ts`.
 */
import { describe, expect, it } from "vitest";
import { plainText, structuredJson } from "../../src/tools/_shared.js";

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
