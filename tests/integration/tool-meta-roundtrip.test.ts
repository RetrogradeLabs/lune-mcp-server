/**
 * End-to-end: the `anthropic/alwaysLoad` hint on the entry tools must survive a
 * real MCP SDK client round-trip (server serialize -> JSON-RPC -> client zod
 * parse), not just our local `listToolsResponse()`. The hint is what keeps
 * `search_papers` / `search_papers_many` / `search_research_guidance`
 * un-deferred in Claude Code so their full descriptions (with the "use Lune, not
 * web_search" trigger) are in context from turn 1. If a future SDK started
 * stripping unrecognized-looking `_meta`, the unit test on `listToolsResponse()`
 * would still pass while real clients silently lost the hint; this catches that.
 *
 * `Tool._meta` is a first-class field in the MCP 2025-11-25 schema, and
 * `anthropic/alwaysLoad` is a format-valid, non-reserved key, so a conformant
 * client MUST preserve (or ignore), never reject it.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeServer } from "../../src/server.js";

const ENTRY_TOOLS = ["search_papers", "search_papers_many", "search_research_guidance"];

describe("alwaysLoad _meta survives the SDK client round-trip", () => {
  it("a real SDK client parses _meta['anthropic/alwaysLoad'] on exactly the entry tools", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    // The makeClient factory is never invoked for tools/list (served locally).
    const server = makeServer(() => ({}) as never);
    await server.connect(serverT);
    const client = new Client({ name: "roundtrip-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientT);

    try {
      const { tools } = await client.listTools();
      // The full catalog parses (no tool rejected over the added _meta).
      expect(tools.length).toBe(16);

      const flagged = tools
        .filter((t) => (t._meta as Record<string, unknown> | undefined)?.["anthropic/alwaysLoad"] === true)
        .map((t) => t.name)
        .sort();
      expect(flagged).toEqual([...ENTRY_TOOLS].sort());

      // And nothing else leaks a _meta.
      for (const t of tools) {
        if (!ENTRY_TOOLS.includes(t.name)) expect(t._meta).toBeUndefined();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
