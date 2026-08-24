/**
 * MCP analytics: env gating (the published stdio binary must never emit), the
 * PostHog wire shape ($mcp_* contract), client-attribution headers, the HTTP
 * transport's identity helper, and the analytics-gated `get_more_tools`
 * roadmap tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KyInstance } from "ky";

vi.mock("ky", () => ({
  default: {
    post: vi.fn(() => Promise.resolve()),
    create: vi.fn(),
  },
}));

import ky from "ky";
import {
  analyticsEnabled,
  captureMcp,
  claimMcpAnalyticsBudget,
  clientHeaderFor,
  clientInfoFromEnvelope,
  flushAnalytics,
  initAnalytics,
  resetAnalyticsForTests,
  sanitizeAnalyticsText,
  setServerClientInfo,
  setServerInfo,
  setTransportMode,
  withAnalyticsContext,
} from "../../src/analytics.js";
import { analyticsIdentityOf } from "../../src/transport/streamableHttp.js";
import { registerPrompts } from "../../src/prompts.js";
import { registerResources } from "../../src/resources.js";
import { registerAllTools } from "../../src/tools/index.js";

const kyPost = vi.mocked(ky.post);

beforeEach(() => {
  resetAnalyticsForTests();
  kyPost.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function lastPayload(): Record<string, unknown> {
  const call = kyPost.mock.calls.at(-1)!;
  return (call[1] as { json: Record<string, unknown> }).json;
}

/**
 * A `Server` stand-in whose registered handlers are looked up by METHOD NAME.
 * The v2 SDK registers on a method string, so keying on it (rather than on the
 * order `registerAllTools` / `registerResources` / `registerPrompts` happened to
 * call `setRequestHandler`) is what keeps these tests failing on the behaviour
 * under test: with a positional lookup, a reordering silently routes `tools/call`
 * into the `tools/list` assertions instead of failing on the thing being pinned.
 */
type RecordedHandler = (req: unknown, ctx?: unknown) => Promise<unknown>;

function recordingServer(extras: Record<string, unknown> = {}) {
  const handlers = new Map<string, RecordedHandler>();
  const server = {
    ...extras,
    setRequestHandler: (method: unknown, fn: unknown) => {
      handlers.set(method as string, fn as RecordedHandler);
    },
  };
  const handler = (method: string): RecordedHandler => {
    const found = handlers.get(method);
    if (!found) throw new Error(`no handler registered for ${method}`);
    return found;
  };
  return { server, handler };
}

describe("initAnalytics gating", () => {
  it("stays disabled without LUNE_POSTHOG_KEY (local installs emit nothing)", () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "");
    initAnalytics();
    expect(analyticsEnabled()).toBe(false);
    captureMcp("$mcp_tool_call", {}, undefined, {});
    expect(kyPost).not.toHaveBeenCalled();
  });

  it("enables capture when the deployment sets the key", () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    expect(analyticsEnabled()).toBe(true);
  });
});

describe("captureMcp wire shape", () => {
  beforeEach(() => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
  });

  it("captures an OAuth subject against the real user id with person processing", () => {
    const server = {};
    captureMcp(
      "$mcp_tool_call",
      server,
      {
        identity: { distinctId: "user-123", personless: false },
        sessionId: "session-1",
        protocolVersion: "2025-06-18",
        clientUserAgent: "claude-code/2.1.0",
      },
      {
        $mcp_tool_name: "search_papers",
      },
    );
    const payload = lastPayload();
    expect(payload.api_key).toBe("phc_test");
    expect(payload.event).toBe("$mcp_tool_call");
    expect(payload.distinct_id).toBe("user-123");
    const props = payload.properties as Record<string, unknown>;
    expect(props.$mcp_tool_name).toBe("search_papers");
    expect(props.$mcp_source).toBe("posthog_mcp_analytics");
    expect(props.$process_person_profile).toBeUndefined();
    expect(props.$session_id).toBe("session-1");
    expect(props.$mcp_protocol_version).toBe("2025-06-18");
    expect(props.$mcp_client_user_agent).toBe("claude-code/2.1.0");
    expect(props.$geoip_disable).toBe(true);
  });

  it("captures a PAT subject personless (no fabricated person profiles)", () => {
    captureMcp(
      "$mcp_tool_call",
      {},
      { identity: { distinctId: "credential:abcdef", personless: true } },
      {},
    );
    const payload = lastPayload();
    expect(payload.distinct_id).toBe("credential:abcdef");
    const props = payload.properties as Record<string, unknown>;
    expect(props.$process_person_profile).toBe(false);
  });

  it("suppresses benchmark and otherwise disabled request contexts", () => {
    captureMcp(
      "$mcp_tool_call",
      {},
      {
        identity: { distinctId: "benchmark", personless: true },
        captureEnabled: false,
      },
      {},
    );
    expect(kyPost).not.toHaveBeenCalled();
  });

  it("bounds one identity to one thousand MCP events per UTC day", () => {
    for (let index = 0; index < 1_000; index += 1) {
      expect(claimMcpAnalyticsBudget("one-identity")).toBe(true);
    }
    expect(claimMcpAnalyticsBudget("one-identity")).toBe(false);
  });

  it("never throws into a tool call, even when the transport throws synchronously", () => {
    kyPost.mockImplementationOnce(() => {
      throw new Error("sync transport failure");
    });
    expect(() =>
      captureMcp("$mcp_tool_call", {}, undefined, { $mcp_tool_name: "x" }),
    ).not.toThrow();
  });

  it("stamps client name/version once the initialize handshake recorded them", () => {
    const server = {};
    setServerInfo(server, { name: "lune-research", version: "2.0.2" });
    setServerClientInfo(server, { name: "claude-code", version: "2.1.0" });
    captureMcp(
      "$mcp_initialize",
      server,
      { identity: { distinctId: "u", personless: false } },
      {},
    );
    const props = lastPayload().properties as Record<string, unknown>;
    expect(props.$mcp_client_name).toBe("claude-code");
    expect(props.$mcp_client_version).toBe("2.1.0");
    expect(props.$mcp_server_name).toBe("lune-research");
    expect(props.$mcp_server_version).toBe("2.0.2");
  });

  it("redacts sensitive free text before it reaches the wire", () => {
    captureMcp(
      "$mcp_missing_capability",
      {},
      { identity: { distinctId: "credential:x", personless: true } },
      {
        $mcp_intent:
          "Email alice@example.com, token=lune_private_value, Authorization: Bearer secret-value",
      },
    );
    const props = lastPayload().properties as Record<string, unknown>;
    expect(props.$mcp_intent).toBe(
      "Email [email redacted], token=[redacted], Authorization: [redacted]",
    );
  });
});

describe("sanitizeAnalyticsText", () => {
  it("normalizes control characters, redacts credentials, and caps length", () => {
    const value = sanitizeAnalyticsText(
      `private_key=secret\u0000 ${"x".repeat(800)}`,
      120,
    );
    expect(value).not.toContain("secret");
    expect(value).not.toContain("\u0000");
    expect(value.length).toBeLessThanOrEqual(120);
  });

  it.each([
    "access_token",
    "refresh-token",
    "client_secret",
    "AWS_SECRET_ACCESS_KEY",
    "NEXT_PUBLIC_API_KEY",
  ])("redacts compound sensitive assignment key %s", (key) => {
    expect(sanitizeAnalyticsText(`${key}=private-value`)).toBe(
      `${key}=[redacted]`,
    );
  });
});

describe("request-scoped analytics context", () => {
  it("keeps concurrent captures bound to the request that produced them", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    let releaseIdentified!: () => void;
    let releasePersonless!: () => void;
    const identifiedGate = new Promise<void>((resolve) => {
      releaseIdentified = resolve;
    });
    const personlessGate = new Promise<void>((resolve) => {
      releasePersonless = resolve;
    });
    const identified = withAnalyticsContext(
      {
        identity: { distinctId: "verified-user", personless: false },
        sessionId: "session-a",
      },
      async () => {
        await identifiedGate;
        captureMcp("$mcp_tool_call", {}, undefined, {
          $mcp_tool_name: "identified_call",
        });
      },
    );
    const personless = withAnalyticsContext(
      {
        identity: { distinctId: "credential:hash", personless: true },
        sessionId: "session-b",
      },
      async () => {
        await personlessGate;
        captureMcp(
          "$mcp_tool_call",
          {},
          {
            identity: { distinctId: "verified-user", personless: false },
            protocolVersion: "2025-06-18",
          },
          {
            $mcp_tool_name: "personless_call",
          },
        );
      },
    );
    releasePersonless();
    await personless;
    releaseIdentified();
    await identified;

    const payloads = kyPost.mock.calls.map(
      (call) =>
        (call[1] as { json: Record<string, unknown> }).json as {
          distinct_id: string;
          properties: Record<string, unknown>;
        },
    );
    const byTool = new Map(
      payloads.map((payload) => [payload.properties.$mcp_tool_name, payload]),
    );
    expect(byTool.get("identified_call")).toMatchObject({
      distinct_id: "verified-user",
      properties: { $session_id: "session-a" },
    });
    expect(byTool.get("personless_call")).toMatchObject({
      distinct_id: "credential:hash",
      properties: {
        $session_id: "session-b",
        $mcp_protocol_version: "2025-06-18",
        $process_person_profile: false,
      },
    });
  });
});

describe("flushAnalytics", () => {
  it("waits for pending delivery", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    let release!: () => void;
    kyPost.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }) as never,
    );
    captureMcp("$mcp_initialize", {}, undefined, {});
    let flushed = false;
    const pending = flushAnalytics(1000).then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await pending;
    expect(flushed).toBe(true);
  });

  it("returns when the deadline expires", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    kyPost.mockReturnValueOnce(new Promise(() => undefined) as never);
    captureMcp("$mcp_initialize", {}, undefined, {});
    const started = Date.now();
    await flushAnalytics(10);
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe("clientHeaderFor (X-Lune-Client attribution)", () => {
  it("formats mode/client/version and sanitizes hostile client strings", () => {
    const server = {};
    setServerClientInfo(server, {
      name: "Claude Desktop (beta)",
      version: "1.0",
    });
    setTransportMode("http");
    expect(clientHeaderFor(server)).toBe("mcp-remote/Claude-Desktop-beta-/1.0");
    setTransportMode("stdio");
    expect(clientHeaderFor(server)).toBe("mcp-stdio/Claude-Desktop-beta-/1.0");
  });

  it("names the transport even when no client has identified itself", () => {
    // NOT `undefined`: with no header the API's `surface_of` reports the call
    // as `api_direct`, so dropping it does not blank attribution, it moves
    // every unidentified MCP request into the raw-API bucket. `unknown` keeps
    // the transport fact without fabricating a client name.
    setTransportMode("http");
    expect(clientHeaderFor({})).toBe("mcp-remote/unknown/0");
    setTransportMode("stdio");
    expect(clientHeaderFor({})).toBe("mcp-stdio/unknown/0");
  });

  it("falls back to the handshake identity when no envelope stamped one", () => {
    // The 2025 era has no envelope, and `serveStdio` pins ONE instance per
    // connection, so the handshake identity the SDK holds is the only client
    // name a stdio install can report. Losing it labels every local install
    // `unknown` for as long as the client ecosystem is pre-2026-07-28.
    const server = {
      getClientVersion: () => ({ name: "claude-code", version: "2.1.0" }),
    };
    setTransportMode("stdio");
    expect(clientHeaderFor(server)).toBe("mcp-stdio/claude-code/2.1.0");
  });

  it("prefers the envelope stamp over a stale handshake identity", () => {
    const server = {
      getClientVersion: () => ({ name: "handshake-client", version: "1.0" }),
    };
    setServerClientInfo(server, { name: "cursor", version: "3.2" });
    setTransportMode("http");
    expect(clientHeaderFor(server)).toBe("mcp-remote/cursor/3.2");
  });

  it("keeps attribution within the API parser's name and version bounds", () => {
    const server = {};
    setServerClientInfo(server, {
      name: "n".repeat(50),
      version: "v".repeat(40),
    });
    setTransportMode("http");
    expect(clientHeaderFor(server)).toBe(
      `mcp-remote/${"n".repeat(40)}/${"v".repeat(32)}`,
    );
  });
});

describe("clientInfoFromEnvelope (2026-07-28 client attribution)", () => {
  const modernCtx = {
    mcpReq: {
      envelope: {
        "io.modelcontextprotocol/clientInfo": {
          name: "claude-code",
          version: "2.1.121",
        },
      },
    },
  };

  it("reads the 2026-07-28 clientInfo envelope key", () => {
    expect(clientInfoFromEnvelope(modernCtx)).toEqual({
      name: "claude-code",
      version: "2.1.121",
    });
  });

  it("coerces a partial envelope rather than throwing", () => {
    const ctx = {
      mcpReq: {
        envelope: { "io.modelcontextprotocol/clientInfo": { name: "cursor" } },
      },
    };
    expect(clientInfoFromEnvelope(ctx)).toEqual({
      name: "cursor",
      version: "0",
    });
  });

  it("returns undefined on a legacy request with no envelope", () => {
    expect(clientInfoFromEnvelope({ mcpReq: {} })).toBeUndefined();
    expect(clientInfoFromEnvelope(undefined)).toBeUndefined();
  });

  it("refuses a structural name instead of attributing [object Object]", () => {
    const ctx = (clientInfo: unknown) => ({
      mcpReq: {
        envelope: { "io.modelcontextprotocol/clientInfo": clientInfo },
      },
    });
    expect(clientInfoFromEnvelope(ctx({ name: { evil: 1 } }))).toBeUndefined();
    expect(clientInfoFromEnvelope(ctx("cursor"))).toBeUndefined();
    // A numeric version is a protocol violation, but a usable identity.
    const numeric = clientInfoFromEnvelope(ctx({ name: "cursor", version: 3 }));
    expect(numeric).toEqual({ name: "cursor", version: "3" });
  });

  /**
   * Registered tool handlers plus every header set on an upstream ky client.
   * The regression these guard is SILENT (tools keep working while attribution
   * goes wrong), so they assert the value that reaches the API rather than the
   * reader in isolation.
   */
  function recordingTools(serverExtras: Record<string, unknown> = {}) {
    const stamped: (Record<string, string> | undefined)[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const recordingKy = (): KyInstance =>
      ({
        get: () => ({ json: async () => ({}) }),
        post: () => ({ json: async () => ({}) }),
        extend: ({
          headers,
          signal,
        }: {
          headers?: Record<string, string>;
          signal?: AbortSignal;
        }) => {
          stamped.push(headers);
          signals.push(signal);
          return recordingKy();
        },
      }) as unknown as KyInstance;
    const { server, handler } = recordingServer(serverExtras);
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      recordingKy,
    );
    return { handler, signals, stamped };
  }

  it("stamps X-Lune-Client on the upstream calls of a modern request", async () => {
    setTransportMode("http");
    const { handler, stamped } = recordingTools();

    await handler("tools/list")({}, modernCtx);
    await handler("tools/call")(
      { params: { name: "list_conferences", arguments: {} } },
      modernCtx,
    );

    expect(stamped).toEqual([
      { "X-Lune-Client": "mcp-remote/claude-code/2.1.121" },
      { "X-Lune-Client": "mcp-remote/claude-code/2.1.121" },
    ]);
  });

  it("stamps the transport on a legacy request that names no client", async () => {
    // The HTTP legacy leg has no envelope AND no surviving handshake instance.
    // Sending nothing here is what relabels every 2025-era MCP call as
    // `api_direct` server-side, so the header still has to name the transport.
    setTransportMode("http");
    const { handler, stamped } = recordingTools();
    await handler("tools/list")({}, { mcpReq: {} });
    expect(stamped).toEqual([{ "X-Lune-Client": "mcp-remote/unknown/0" }]);
  });

  it("stamps the stdio handshake identity on a legacy request", async () => {
    // `serveStdio` pins one instance per connection, so the identity the 2025
    // handshake gave the SDK is still readable when the envelope is absent.
    setTransportMode("stdio");
    const { handler, stamped } = recordingTools({
      getClientVersion: () => ({ name: "claude-code", version: "2.1.0" }),
    });
    await handler("tools/list")({}, { mcpReq: {} });
    expect(stamped).toEqual([
      { "X-Lune-Client": "mcp-stdio/claude-code/2.1.0" },
    ]);
  });

  it("propagates bounded W3C trace context and the cancellation signal", async () => {
    const controller = new AbortController();
    const { handler, signals, stamped } = recordingTools();
    const ctx = {
      mcpReq: {
        _meta: {
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "vendor=value",
          baggage: "unsafe=value\nInjected: true",
        },
        signal: controller.signal,
      },
    };
    await handler("tools/call")(
      { params: { name: "list_conferences", arguments: {} } },
      ctx,
    );
    expect(stamped[0]).toMatchObject({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    });
    expect(stamped[0]).not.toHaveProperty("baggage");
    expect(signals).toEqual([controller.signal]);
  });

  it.each([
    ["traceparent", "bad\u0000value"],
    ["tracestate", "café"],
    ["baggage", "emoji=😀"],
  ])("drops a non-HTTP-safe %s value", async (name, value) => {
    const { handler, stamped } = recordingTools();
    await handler("tools/call")(
      { params: { name: "list_conferences", arguments: {} } },
      { mcpReq: { _meta: { [name]: value } } },
    );
    expect(stamped[0]).not.toHaveProperty(name);
  });
});

describe("analyticsIdentityOf", () => {
  it("identifies only a verified OAuth identity", () => {
    expect(
      analyticsIdentityOf("opaque", {
        distinctId: "user-1",
        orgId: "org-1",
        scopes: ["papers:read"],
      }),
    ).toEqual({ distinctId: "user-1", personless: false });
  });

  it("hashes every unverified bearer into a stable personless identity", () => {
    // The bearer must never reach PostHog as a distinct_id.
    const first = analyticsIdentityOf("unverified.jwt.value");
    const second = analyticsIdentityOf("unverified.jwt.value");
    expect(first).toEqual(second);
    expect(first.personless).toBe(true);
    expect(first.distinctId).toMatch(/^credential:[0-9a-f]{64}$/);
    expect(first.distinctId).not.toContain("unverified.jwt.value");
  });
});

describe("get_more_tools (analytics-gated roadmap intake)", () => {
  function fakeKy(): KyInstance {
    const make = () => () =>
      ({ json: async () => ({}) }) as unknown as Promise<unknown>;
    return {
      get: make(),
      post: make(),
      extend: () => fakeKy(),
    } as unknown as KyInstance;
  }

  it("is absent from tools/list when analytics is disabled (local installs)", async () => {
    const { server, handler } = recordingServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
    );
    const res = (await handler("tools/list")({})) as {
      tools: { name: string }[];
    };
    expect(res.tools.map((t) => t.name)).not.toContain("get_more_tools");
  });

  it("is listed and records $mcp_missing_capability when enabled", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = recordingServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
      () => ({
        identity: { distinctId: "user-42", personless: false },
        sessionId: "session-42",
      }),
    );
    const res = (await handler("tools/list")({})) as {
      tools: { name: string }[];
    };
    expect(res.tools.map((t) => t.name)).toContain("get_more_tools");

    const result = (await handler("tools/call")({
      params: {
        name: "get_more_tools",
        arguments: { capability: "search preprint servers" },
      },
    })) as { content: { type: string; text: string }[] };
    expect(result.content[0]!.text).toMatch(/submitted for roadmap review/);

    const missing = kyPost.mock.calls
      .map(
        (c) =>
          (
            c[1] as {
              json: { event: string; properties: Record<string, unknown> };
            }
          ).json,
      )
      .find((p) => p.event === "$mcp_missing_capability")!;
    expect(missing).toBeDefined();
    expect(missing.properties.$mcp_intent).toBe("search preprint servers");
  });

  it("does not claim a roadmap event was stored when capture is unavailable", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = recordingServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
      () => ({ captureEnabled: false }),
    );
    const result = (await handler("tools/call")({
      params: {
        name: "get_more_tools",
        arguments: { capability: "search preprint servers" },
      },
    })) as { content: { text: string }[] };
    expect(result.content[0]!.text).toContain("No roadmap event was stored");
  });

  it("records canonical list, resource, and prompt lifecycle events", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const context = () => ({
      identity: { distinctId: "user-42", personless: false },
      sessionId: "session-42",
    });
    const { server, handler } = recordingServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
      context,
    );
    registerResources(
      server as unknown as Parameters<typeof registerResources>[0],
      context,
    );
    registerPrompts(
      server as unknown as Parameters<typeof registerPrompts>[0],
      context,
    );
    await handler("tools/list")({});
    await handler("resources/list")({});
    await handler("prompts/list")({});
    await handler("prompts/get")({
      params: { name: "verify_draft", arguments: { draft: "claim" } },
    });
    const payloads = kyPost.mock.calls.map(
      (call) =>
        (
          call[1] as {
            json: { event: string; properties: Record<string, unknown> };
          }
        ).json,
    );
    expect(payloads.map((payload) => payload.event)).toEqual(
      expect.arrayContaining([
        "$mcp_tools_list",
        "$mcp_resources_list",
        "$mcp_prompts_list",
        "$mcp_prompt_get",
      ]),
    );
    const toolsList = payloads.find(
      (payload) => payload.event === "$mcp_tools_list",
    )!;
    expect(toolsList.properties.$mcp_listed_tool_names).toContain(
      "search_papers",
    );
    const promptGet = payloads.find(
      (payload) => payload.event === "$mcp_prompt_get",
    )!;
    expect(promptGet.properties.$mcp_resource_name).toBe("verify_draft");
  });

  it("re-emits every list event per call, since no server outlives one request", async () => {
    // `createMcpHandler` builds a server per request, so the de-dup flags these
    // three handlers used to close over were always false on entry. Re-adding
    // one at module scope would be the cross-request state the stateless
    // transport deleted, so per-call emission IS the contract.
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const context = () => ({
      identity: { distinctId: "user-42", personless: false },
    });
    const { server, handler } = recordingServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
      context,
    );
    registerResources(
      server as unknown as Parameters<typeof registerResources>[0],
      context,
    );
    registerPrompts(
      server as unknown as Parameters<typeof registerPrompts>[0],
      context,
    );
    for (const method of ["tools/list", "resources/list", "prompts/list"]) {
      await handler(method)({});
      await handler(method)({});
    }
    const events = kyPost.mock.calls.map(
      (call) => (call[1] as { json: { event: string } }).json.event,
    );
    const tally = (event: string) => events.filter((e) => e === event).length;
    expect([
      tally("$mcp_tools_list"),
      tally("$mcp_resources_list"),
      tally("$mcp_prompts_list"),
    ]).toEqual([2, 2, 2]);
  });

  it("records a $mcp_tool_call with duration for real tool dispatches", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = recordingServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
      () => ({
        identity: { distinctId: "credential:deadbeef", personless: true },
      }),
    );
    await handler("tools/call")({
      params: { name: "list_conferences", arguments: {} },
    });
    const toolCall = kyPost.mock.calls
      .map(
        (c) =>
          (
            c[1] as {
              json: { event: string; properties: Record<string, unknown> };
            }
          ).json,
      )
      .find((p) => p.event === "$mcp_tool_call")!;
    expect(toolCall).toBeDefined();
    expect(toolCall.properties.$mcp_tool_name).toBe("list_conferences");
    expect(typeof toolCall.properties.$mcp_duration_ms).toBe("number");
    expect(toolCall.properties.$mcp_is_error).toBe(false);
  });

  it("records the error message and HTTP status behind a failed tool call", async () => {
    // The dashboard's "tools with the highest error rate" was a bare count:
    // without these two properties every diagnosis meant a CloudWatch dig.
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = recordingServer();
    const rejecting = (): KyInstance => {
      const boom = () => () =>
        Promise.reject(
          Object.assign(new Error("HTTPError"), {
            response: {
              status: 422,
              headers: new Headers(),
              json: async () => ({
                detail: [
                  {
                    loc: ["body", "fields", 0, "name"],
                    msg: "Value error, field name 'model_dump' is reserved",
                  },
                ],
              }),
            },
          }),
        );
      return {
        get: boom(),
        post: boom(),
        extend: () => rejecting(),
      } as unknown as KyInstance;
    };
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => rejecting(),
      () => ({
        identity: { distinctId: "credential:deadbeef", personless: true },
      }),
    );
    await handler("tools/call")({
      params: {
        name: "extract_from_papers",
        arguments: {
          paper_ids: ["3f0d3b3e-0f4a-4c1a-9f2b-1c2d3e4f5a6b"],
          fields: [{ name: "model_dump", type: "string" }],
          instruction: "pull the dump",
        },
      },
    });
    const payload = kyPost.mock.calls
      .map(
        (call) =>
          (
            call[1] as {
              json: { event: string; properties: Record<string, unknown> };
            }
          ).json,
      )
      .find((event) => event.event === "$mcp_tool_call")!;
    expect(payload.properties.$mcp_is_error).toBe(true);
    expect(payload.properties.$mcp_error_type).toBe("tool_error");
    expect(payload.properties.$mcp_error_status).toBe("422");
    expect(payload.properties.$mcp_error_message).toContain(
      "fields.0.name: field name 'model_dump' is reserved",
    );
  });

  it("records output contract drift as a model-readable tool error", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = recordingServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
      () => ({
        identity: { distinctId: "credential:deadbeef", personless: true },
      }),
    );
    const result = (await handler("tools/call")({
      params: {
        name: "extract_from_papers",
        arguments: {
          paper_ids: ["3f0d3b3e-0f4a-4c1a-9f2b-1c2d3e4f5a6b"],
          fields: [{ name: "dataset", type: "string" }],
          instruction: "extract the dataset",
        },
      },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Stop retrying");

    const payload = kyPost.mock.calls
      .map(
        (call) =>
          (
            call[1] as {
              json: { event: string; properties: Record<string, unknown> };
            }
          ).json,
      )
      .find((event) => event.event === "$mcp_tool_call")!;
    expect(payload.properties.$mcp_error_type).toBe("output_schema_violation");
    expect(payload.properties.$mcp_error_message).toContain(
      "invalid response for extract_from_papers",
    );
  });

  it("records protocol failures without exporting the thrown message", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = recordingServer();
    registerAllTools(
      server as unknown as Parameters<typeof registerAllTools>[0],
      () => fakeKy(),
      () => ({
        identity: { distinctId: "credential:x", personless: true },
      }),
    );
    await expect(
      handler("tools/call")({
        params: {
          name: "unknown_alice@example.com",
          arguments: {},
        },
      }),
    ).rejects.toThrow(/unknown tool/i);
    const payload = kyPost.mock.calls
      .map(
        (call) =>
          (
            call[1] as {
              json: { event: string; properties: Record<string, unknown> };
            }
          ).json,
      )
      .find((event) => event.event === "$mcp_tool_call")!;
    expect(payload.properties.$mcp_error_type).toBe("protocol_error");
    expect(payload.properties.$mcp_error_message).toBeUndefined();
    expect(payload.properties.$mcp_tool_name).toBe("[email redacted]");
  });
});
