/**
 * Unit coverage for the tool-registration layer (`src/tools/index.ts`).
 *
 * Exercises `getAllToolDefinitions`, the `dispatchToolCall` router (all four
 * branches), and `registerAllTools` (every `setRequestHandler` wiring plus
 * the handler bodies themselves: tools/list, tools/call, and the empty
 * resources/prompts probes).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KyInstance } from "ky";
import {
  dispatchToolCall,
  getAllToolDefinitions,
  listToolsResponse,
  registerAllTools,
} from "../../src/tools/index.js";
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";

beforeEach(async () => {
  await TOOL_RESPONSE_CACHE.clear();
});

/** Records every verb call and returns a thenable `{ json }` matcher. */
function fakeKy(response: unknown = {}): KyInstance {
  const make = () => () => ({ json: async () => response }) as unknown as Promise<unknown>;
  return {
    get: make(),
    post: make(),
    delete: make(),
    put: make(),
  } as unknown as KyInstance;
}

/** ky double whose verbs throw a ky-shaped HTTPError with the given status. */
function erroringKy(status: number, body: unknown): KyInstance {
  const make = () => () =>
    ({
      json: async () => {
        throw {
          response: {
            status,
            headers: new Headers(),
            json: async () => body,
          },
        };
      },
    }) as unknown as Promise<unknown>;
  return {
    get: make(),
    post: make(),
    delete: make(),
    put: make(),
  } as unknown as KyInstance;
}

describe("getAllToolDefinitions", () => {
  it("returns the union of paper, guidance, and subscription tools", () => {
    const defs = getAllToolDefinitions();
    expect(defs.length).toBe(12);
    const names = defs.map((d) => d.name);
    expect(names).toContain("search_papers");
    expect(names).toContain("search_research_guidance");
    expect(names).toContain("check_for_conference_updates");
  });

  it("every definition carries the platform metadata fields", () => {
    for (const d of getAllToolDefinitions()) {
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.annotations).toBeTypeOf("object");
      expect(Array.isArray(d.scopes)).toBe(true);
    }
  });
});

describe("dispatchToolCall", () => {
  it("routes paper-tool names to the paper handler", async () => {
    const r = await dispatchToolCall(fakeKy({ results: [] }), "search_papers", {
      query: "x",
    });
    expect(r.content[0]!.type).toBe("text");
  });

  it("routes guidance-tool names to the guidance handler", async () => {
    const r = await dispatchToolCall(
      fakeKy({ results: [] }),
      "search_research_guidance",
      { query: "ablation" },
    );
    expect(r.structuredContent).toEqual({ results: [] });
  });

  it("routes subscription-tool names to the subscription handler", async () => {
    const r = await dispatchToolCall(
      fakeKy([]),
      "list_conference_update_subscriptions",
      {},
    );
    expect(r.structuredContent).toEqual({ subscriptions: [] });
  });

  it("throws for an unknown tool name", async () => {
    await expect(
      dispatchToolCall(fakeKy(), "definitely_not_a_tool", {}),
    ).rejects.toThrow(/unknown tool/);
  });
});

describe("registerAllTools", () => {
  /** Captures handlers keyed by the schema object passed to setRequestHandler. */
  function captureServer(): {
    server: { setRequestHandler: (schema: unknown, handler: unknown) => void };
    handlers: Map<unknown, (req: unknown) => Promise<unknown>>;
  } {
    const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
    return {
      server: {
        setRequestHandler: (schema, handler) => {
          handlers.set(schema, handler as (req: unknown) => Promise<unknown>);
        },
      },
      handlers,
    };
  }

  it("wires four request handlers onto the server", () => {
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
    );
    expect(handlers.size).toBe(4);
  });

  it("the tools/list handler returns the full tool catalog", async () => {
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
    );
    // The first registered handler is tools/list.
    const [listToolsHandler] = [...handlers.values()];
    const res = (await listToolsHandler!({})) as ReturnType<typeof listToolsResponse>;
    expect(res.tools.map((t) => t.name).sort()).toEqual(
      listToolsResponse().tools.map((t) => t.name).sort(),
    );
  });

  it("the tools/call handler builds a client per request and dispatches", async () => {
    const { server, handlers } = captureServer();
    const makeClient = vi.fn(() => fakeKy({ results: [] }));
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      makeClient,
    );
    const callHandler = [...handlers.values()][1]!;
    const res = (await callHandler({
      params: { name: "search_papers", arguments: { query: "x" } },
    })) as { content: Array<{ type: string }> };
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(res.content[0]!.type).toBe("text");
  });

  it("the tools/call handler returns an isError result on a 429 (does not crash the session)", async () => {
    // End-to-end through the registered tools/call handler: an upstream 429
    // must come back as a resolved { isError: true } tool result, never a
    // thrown JSON-RPC error. A throw here would surface to the client as a
    // protocol error the model never sees (and could abort the turn).
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => erroringKy(429, { error: "rate_limited", retry_after_seconds: 1 }),
    );
    const callHandler = [...handlers.values()][1]!;
    const res = (await callHandler({
      params: { name: "search_papers", arguments: { query: "x" } },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/rate limited/i);
    expect(res.content[0]!.text).toContain("retry_after_seconds=1");
  });

  it("the tools/call handler returns an isError result on a 402 with buy-credits guidance", async () => {
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () =>
        erroringKy(402, {
          error: "out_of_credits",
          buy_credits_url: "https://lune/dashboard/settings/billing",
        }),
    );
    const callHandler = [...handlers.values()][1]!;
    const res = (await callHandler({
      params: { name: "search_papers", arguments: { query: "x" } },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Quota exhausted");
    expect(res.content[0]!.text).toContain("buy_credits_url=");
  });

  it("the tools/call handler defaults missing arguments to an empty object", async () => {
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy([]),
    );
    const callHandler = [...handlers.values()][1]!;
    const res = (await callHandler({
      params: { name: "list_conference_update_subscriptions" },
    })) as { structuredContent: unknown };
    expect(res.structuredContent).toEqual({ subscriptions: [] });
  });

  it("the resources/list and prompts/list handlers return empty arrays", async () => {
    const { server, handlers } = captureServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
    );
    const values = [...handlers.values()];
    const resourcesHandler = values[2]!;
    const promptsHandler = values[3]!;
    expect(await resourcesHandler({})).toEqual({ resources: [] });
    expect(await promptsHandler({})).toEqual({ prompts: [] });
  });
});
