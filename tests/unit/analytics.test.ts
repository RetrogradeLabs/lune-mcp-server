/**
 * MCP analytics: env gating (the published stdio binary must never emit), the
 * PostHog wire shape ($mcp_* contract), client-attribution headers, the HTTP
 * transport's identity helper, and the analytics-gated `get_more_tools`
 * roadmap tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ky, { type KyInstance } from "ky";
import {
  createFakeServer,
  type FakeServerExtras,
} from "../support/fake-server.js";
import {
  isJsonNumber,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../../src/json.js";
import {
  type AnalyticsDelivery,
  analyticsEnabled,
  captureMcp,
  claimMcpAnalyticsBudget,
  clientHeaderFor,
  clientInfoFromEnvelope,
  flushAnalytics,
  initAnalytics as initAnalyticsWithDelivery,
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
import { TOOL_RESPONSE_CACHE } from "../../src/cache.js";

const kyPost = vi.fn<AnalyticsDelivery>(() => Promise.resolve());

const initAnalytics = () => initAnalyticsWithDelivery(kyPost);

beforeEach(async () => {
  resetAnalyticsForTests();
  kyPost.mockClear();
  await TOOL_RESPONSE_CACHE.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The JSON body of the most recent captured PostHog request, and its properties
 * bag. Every assertion below reads through these two, so the one place ky's
 * loosely-typed options are decoded is here.
 */
function lastPayload(): JsonObject {
  const call = kyPost.mock.calls.at(-1);

  if (!call) throw new Error("expected an analytics delivery");
  const body: JsonValue = call[1].json;

  return isJsonObject(body) ? body : {};
}

function lastProperties(): JsonObject {
  const props = lastPayload()["properties"];

  return isJsonObject(props) ? props : {};
}

function deliveredPayloads(): JsonObject[] {
  return kyPost.mock.calls.map((call) => call[1].json);
}

function eventPayload(event: string): JsonObject {
  const payload = deliveredPayloads().find(
    (candidate) => candidate.event === event,
  );

  if (!payload) throw new Error(`expected ${event} analytics payload`);

  return payload;
}

function eventProperties(event: string): JsonObject {
  const properties = eventPayload(event).properties;

  if (!isJsonObject(properties)) {
    throw new Error(`expected ${event} analytics properties`);
  }

  return properties;
}

function fakeKy(): KyInstance {
  return ky.create({
    prefix: "https://api.example.test/",
    retry: 0,
    fetch: async () =>
      new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
  });
}

interface ToolsListResult {
  tools: Array<{ name: string }>;
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type?: string; text: string }>;
}

/**
 * A `Server` stand-in whose registered handlers are looked up by METHOD NAME.
 * The v2 SDK registers on a method string, so keying on it (rather than on the
 * order `registerAllTools` / `registerResources` / `registerPrompts` happened to
 * call `setRequestHandler`) is what keeps these tests failing on the behaviour
 * under test: with a positional lookup, a reordering silently routes `tools/call`
 * into the `tools/list` assertions instead of failing on the thing being pinned.
 */
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
    const props = lastProperties();
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
    const props = lastProperties();
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
    const props = lastProperties();
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
    const props = lastProperties();
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

    const payloads = deliveredPayloads();

    const byTool = new Map(
      payloads.map((payload) => {
        const properties = isJsonObject(payload.properties)
          ? payload.properties
          : {};

        return [properties.$mcp_tool_name, payload];
      }),
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
      }),
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
    kyPost.mockReturnValueOnce(new Promise<void>(() => undefined));
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
    // NOT `undefined`: with no header the API's `surface_of` reads the call as
    // `api_direct`, so dropping it moves MCP traffic into the raw-API bucket.
    setTransportMode("http");
    expect(clientHeaderFor({})).toBe("mcp-remote/unknown/0");
    setTransportMode("stdio");
    expect(clientHeaderFor({})).toBe("mcp-stdio/unknown/0");
  });

  it("falls back to the handshake identity when no envelope stamped one", () => {
    // The 2025 era has no envelope and `serveStdio` pins ONE instance per
    // connection, so the handshake identity is all a stdio install can report.
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
    const ctx = (clientInfo: JsonValue) => ({
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
  function recordingTools(serverExtras: FakeServerExtras = {}) {
    const stamped: (Record<string, string> | undefined)[] = [];
    const signals: (AbortSignal | undefined)[] = [];

    const recordingKy = (): KyInstance =>
      ky.create({
        prefix: "https://api.example.test/",
        retry: 0,
        fetch: async (input) => {
          const request = input instanceof Request ? input : new Request(input);
          const headers: Record<string, string> = {};
          const client = request.headers.get("X-Lune-Client");

          if (client) headers["X-Lune-Client"] = client;

          for (const name of ["traceparent", "tracestate", "baggage"]) {
            const value = request.headers.get(name);

            if (value) headers[name] = value;
          }

          stamped.push(headers);
          signals.push(request.signal);

          const body = new URL(request.url).pathname.endsWith("/conferences")
            ? "[]"
            : "{}";

          return new Response(body, {
            headers: { "content-type": "application/json" },
          });
        },
      });

    const { server, handler } = createFakeServer(serverExtras);
    registerAllTools(server, recordingKy);

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
    // The HTTP legacy leg has no envelope AND no surviving handshake instance,
    // so the header is all that keeps 2025-era calls out of `api_direct`.
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
    const propagated = signals[0];

    if (!propagated) throw new Error("expected an upstream abort signal");
    expect(propagated.aborted).toBe(false);
    controller.abort();
    expect(propagated.aborted).toBe(true);
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
  it("is absent from tools/list when analytics is disabled (local installs)", async () => {
    const { server, handler } = createFakeServer();
    registerAllTools(server, () => fakeKy());
    const res = await handler<ToolsListResult>("tools/list")({});
    expect(res.tools.map((t) => t.name)).not.toContain("get_more_tools");
  });

  it("is listed and records $mcp_missing_capability when enabled", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = createFakeServer();
    registerAllTools(
      server,
      () => fakeKy(),
      () => ({
        identity: { distinctId: "user-42", personless: false },
        sessionId: "session-42",
      }),
    );
    const res = await handler<ToolsListResult>("tools/list")({});
    expect(res.tools.map((t) => t.name)).toContain("get_more_tools");

    const result = await handler<ToolCallResult>("tools/call")({
      params: {
        name: "get_more_tools",
        arguments: { capability: "search preprint servers" },
      },
    });

    expect(result.content[0]!.text).toMatch(/submitted for roadmap review/);

    expect(eventProperties("$mcp_missing_capability").$mcp_intent).toBe(
      "search preprint servers",
    );
  });

  it("does not claim a roadmap event was stored when capture is unavailable", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = createFakeServer();
    registerAllTools(
      server,
      () => fakeKy(),
      () => ({ captureEnabled: false }),
    );

    const result = await handler<ToolCallResult>("tools/call")({
      params: {
        name: "get_more_tools",
        arguments: { capability: "search preprint servers" },
      },
    });

    expect(result.content[0]!.text).toContain("No roadmap event was stored");
  });

  it("records canonical list, resource, and prompt lifecycle events", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();

    const context = () => ({
      identity: { distinctId: "user-42", personless: false },
      sessionId: "session-42",
    });

    const { server, handler } = createFakeServer();
    registerAllTools(server, () => fakeKy(), context);
    registerResources(server, context);
    registerPrompts(server, context);
    await handler("tools/list")({});
    await handler("resources/list")({});
    await handler("prompts/list")({});
    await handler("prompts/get")({
      params: { name: "verify_draft", arguments: { draft: "claim" } },
    });
    const payloads = deliveredPayloads();
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
    );

    if (!toolsList || !isJsonObject(toolsList.properties)) {
      throw new Error("expected tools-list properties");
    }

    expect(toolsList.properties.$mcp_listed_tool_names).toContain(
      "search_papers",
    );

    const promptGet = payloads.find(
      (payload) => payload.event === "$mcp_prompt_get",
    );

    if (!promptGet || !isJsonObject(promptGet.properties)) {
      throw new Error("expected prompt-get properties");
    }

    expect(promptGet.properties.$mcp_resource_name).toBe("verify_draft");
  });

  it("re-emits every list event per call, since no server outlives one request", async () => {
    // `createMcpHandler` builds a server per request, so the de-dup flags these
    // handlers closed over were always false: per-call emission IS the rule.
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();

    const context = () => ({
      identity: { distinctId: "user-42", personless: false },
    });

    const { server, handler } = createFakeServer();
    registerAllTools(server, () => fakeKy(), context);
    registerResources(server, context);
    registerPrompts(server, context);

    for (const method of ["tools/list", "resources/list", "prompts/list"]) {
      await handler(method)({});
      await handler(method)({});
    }

    const events = deliveredPayloads().map((payload) => payload.event);
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
    const { server, handler } = createFakeServer();
    registerAllTools(
      server,
      () => fakeKy(),
      () => ({
        identity: { distinctId: "credential:deadbeef", personless: true },
      }),
    );
    await handler("tools/call")({
      params: { name: "list_conferences", arguments: {} },
    });
    const properties = eventProperties("$mcp_tool_call");
    expect(properties.$mcp_tool_name).toBe("list_conferences");
    expect(isJsonNumber(properties.$mcp_duration_ms)).toBe(true);
    expect(properties.$mcp_is_error).toBe(false);
  });

  it("records the error message and HTTP status behind a failed tool call", async () => {
    // The dashboard's "tools with the highest error rate" was a bare count:
    // without these two properties every diagnosis meant a CloudWatch dig.
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = createFakeServer();

    const rejecting = (): KyInstance =>
      ky.create({
        prefix: "https://api.example.test/",
        retry: 0,
        fetch: async () =>
          new Response(
            JSON.stringify({
              detail: [
                {
                  loc: ["body", "fields", 0, "name"],
                  msg: "Value error, field name 'model_dump' is reserved",
                },
              ],
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      });

    registerAllTools(
      server,
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
    const properties = eventProperties("$mcp_tool_call");
    expect(properties.$mcp_is_error).toBe(true);
    expect(properties.$mcp_error_type).toBe("tool_error");
    expect(properties.$mcp_error_status).toBe("422");
    expect(properties.$mcp_error_message).toContain(
      "fields.0.name: field name 'model_dump' is reserved",
    );
  });

  it("records output contract drift as a model-readable tool error", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = createFakeServer();
    registerAllTools(
      server,
      () => fakeKy(),
      () => ({
        identity: { distinctId: "credential:deadbeef", personless: true },
      }),
    );

    const result = await handler<ToolCallResult>("tools/call")({
      params: {
        name: "extract_from_papers",
        arguments: {
          paper_ids: ["3f0d3b3e-0f4a-4c1a-9f2b-1c2d3e4f5a6b"],
          fields: [{ name: "dataset", type: "string" }],
          instruction: "extract the dataset",
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Stop retrying");

    const properties = eventProperties("$mcp_tool_call");
    expect(properties.$mcp_error_type).toBe("output_schema_violation");
    expect(properties.$mcp_error_message).toContain(
      "invalid response for extract_from_papers",
    );
  });

  it("records protocol failures without exporting the thrown message", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const { server, handler } = createFakeServer();
    registerAllTools(
      server,
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
    const properties = eventProperties("$mcp_tool_call");
    expect(properties.$mcp_error_type).toBe("protocol_error");
    expect(properties.$mcp_error_message).toBeUndefined();
    expect(properties.$mcp_tool_name).toBe("[email redacted]");
  });
});
