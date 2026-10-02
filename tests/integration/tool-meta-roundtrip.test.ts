/**
 * End-to-end: the `anthropic/alwaysLoad` hint on the entry tools (and the
 * `anthropic/maxResultSizeChars` hint on the large-result tools) must survive a
 * real serve-then-parse round-trip (server encode -> JSON-RPC over HTTP -> the
 * SDK's own `ListToolsResult` validator), not just our local
 * `listToolsResponse()`. The hint is what keeps `search_papers` /
 * `search_papers_many` / `search_research_guidance` un-deferred in Claude Code so
 * their full descriptions (with the "use Lune, not web_search" trigger) are in
 * context from turn 1. If a future SDK started stripping unrecognized-looking
 * `_meta`, the unit test on `listToolsResponse()` would still pass while real
 * clients silently lost the hint; this catches that.
 *
 * `specTypeSchemas.ListToolsResult` is the SDK's neutral-model validator, which
 * is what a conformant client parses the result with, so a strip on either side
 * of the wire shows up here. Both eras are checked because `createMcpHandler`
 * encodes them through different seams: the modern path directly, 2025-era
 * traffic through the stateless legacy fallback.
 *
 * `Tool._meta` is a first-class field in the MCP schema and
 * `anthropic/alwaysLoad` is a format-valid, non-reserved key, so a conformant
 * client MUST preserve (or ignore), never reject it.
 */
import { describe, it, expect } from "vitest";
import {
  createMcpHandler,
  specTypeSchemas,
} from "@modelcontextprotocol/server";
import {
  ALL_RELEASES,
  answeredView,
  PUBLIC_VIEW,
  type ReleaseView,
} from "../../src/releases.js";
import { makeServer } from "../../src/server.js";
import { createFakeKy } from "../support/fake-ky.js";
import { jsonRpcObject } from "../support/http.js";

const ENTRY_TOOLS = [
  "search_papers",
  "search_papers_many",
  "search_research_guidance",
];

const INLINE_TOOLS = [
  "extract_from_papers",
  "gather_evidence",
  "get_conference_papers",
  "get_paper_citations",
  "search_papers",
  "search_papers_many",
  "search_related_papers",
  "verify_claims",
];

const KNOWN_META = new Set([
  "anthropic/alwaysLoad",
  "anthropic/maxResultSizeChars",
]);

/** Serve one `tools/list` and parse it the way a conformant client would. */
async function listTools(
  era: "modern" | "legacy",
  releases: ReleaseView = PUBLIC_VIEW,
) {
  const upstream = createFakeKy();

  const handler = createMcpHandler(() =>
    makeServer(() => upstream.ky, { releases }),
  );

  try {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });

    if (era === "modern") {
      headers.set("MCP-Protocol-Version", "2026-07-28");
      headers.set("Mcp-Method", "tools/list");
    }

    const res = await handler.fetch(
      new Request("https://mcp.test/", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params:
            era === "modern"
              ? {
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientInfo": {
                      name: "roundtrip-test",
                      version: "1.0.0",
                    },
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                }
              : {},
        }),
      }),
    );

    expect(res.status).toBe(200);
    // 2025-era responses arrive as a single SSE frame; modern ones as plain JSON.
    const raw = await res.text();
    const envelope = jsonRpcObject(raw);

    const parsed = specTypeSchemas.ListToolsResult["~standard"].validate(
      envelope.result,
    );

    if ("issues" in parsed) {
      throw new Error(
        `SDK rejected tools/list: ${JSON.stringify(parsed.issues)}`,
      );
    }

    return parsed.value.tools;
  } finally {
    await handler.close();
  }
}

describe.each(["modern", "legacy"] as const)(
  "alwaysLoad _meta survives the %s round-trip",
  (era) => {
    it("the SDK's result validator keeps _meta['anthropic/alwaysLoad'] on exactly the entry tools", async () => {
      const tools = await listTools(era);
      // The public catalog parses (no tool rejected over the added _meta).
      expect(tools.length).toBe(12);

      const flagged = tools
        .filter((t) => t._meta?.["anthropic/alwaysLoad"] === true)
        .map((t) => t.name)
        .sort();

      expect(flagged).toEqual([...ENTRY_TOOLS].sort());

      // The inline-result hint survives the trip too, and nothing else leaks.
      const inline = tools
        .filter((t) => t._meta?.["anthropic/maxResultSizeChars"] === 500_000)
        .map((t) => t.name)
        .sort();

      expect(inline).toEqual(INLINE_TOOLS);

      for (const t of tools) {
        expect(
          Object.keys(t._meta ?? {}).filter((key) => !KNOWN_META.has(key)),
        ).toEqual([]);
      }
    });

    it("the SDK's result validator accepts every tool a released credential lists", async () => {
      const tools = await listTools(era, answeredView(ALL_RELEASES));
      expect(tools.length).toBe(14);
    });
  },
);
