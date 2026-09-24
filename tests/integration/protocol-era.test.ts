/**
 * Both protocol eras are served from ONE `createMcpHandler` mount.
 *
 * `2026-07-28` deleted the `initialize` handshake and the protocol session, so
 * modern clients negotiate through `server/discover` and carry their identity in
 * a per-request `_meta` envelope, while 2025-era clients keep their handshake
 * through the handler's stateless legacy fallback. The four groups below pin
 * the parts that no other suite covers:
 *
 *   - era routing: what each era's requests get back, and that the mandatory
 *     modern `Mcp-Method` header is enforced;
 *   - the cache hints the modern codec emits, one of which (`tools/list`) is
 *     an access decision rather than a tuning knob;
 *   - per-request attribution: every request builds its own server instance, so
 *     the envelope's `clientInfo` cannot bleed between principals, and the three
 *     handlers that used to inherit identity from `oninitialized` still report it;
 *   - the analytics context, which is entered at the Express layer and has to
 *     survive the whole adapter chain to reach `captureMcp`.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";
import http from "node:http";
import type { Server as HttpServer } from "node:http";
import { makeServer } from "../../src/server.js";
import { makeClient } from "../../src/api/client.js";
import { buildHttpApp } from "../../src/transport/streamableHttp.js";
import {
  flushAnalytics,
  initAnalytics,
  resetAnalyticsForTests,
} from "../../src/analytics.js";
import { isJsonString, type JsonObject } from "../../src/json.js";
import { jsonRpcObject } from "../support/http.js";
import {
  jsonNumber,
  jsonObject,
  jsonObjects,
  jsonString,
  jsonStrings,
  parseJsonObject,
} from "../support/json.js";
import { portOf } from "../support/net.js";

const MODERN_ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "claude-code",
    version: "2.1.121",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function handler() {
  return createMcpHandler(() =>
    makeServer(() => makeClient("lune_test_token")),
  );
}

async function post(
  body: JsonObject,
  extraHeaders: Record<string, string> = {},
) {
  const res = await handler().fetch(
    new Request("https://mcp.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer lune_test_token",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  );

  return { status: res.status, text: await res.text() };
}

/**
 * Modern requests MUST carry Mcp-Method; absence is a hard -32020.
 * `MCP-Protocol-Version` is OPTIONAL alongside a `_meta` envelope claim (the
 * claim is what classifies the era), so `versionHeader: false` builds the
 * conforming header-less shape.
 */
function modernHeaders(method: string, name?: string, versionHeader = true) {
  if (versionHeader && name !== undefined) {
    return {
      "Mcp-Method": method,
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Name": name,
    };
  }

  if (versionHeader) {
    return {
      "Mcp-Method": method,
      "MCP-Protocol-Version": "2026-07-28",
    };
  }

  if (name !== undefined) return { "Mcp-Method": method, "Mcp-Name": name };

  return { "Mcp-Method": method };
}

function resultOf(raw: string) {
  return jsonObject(jsonRpcObject(raw).result, "JSON-RPC result");
}

describe("protocol era serving", () => {
  it("advertises 2026-07-28 via server/discover", async () => {
    const r = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: MODERN_ENVELOPE },
      },
      modernHeaders("server/discover"),
    );

    expect(r.status).toBe(200);
    const result = resultOf(r.text);
    expect(
      jsonStrings(result.supportedVersions, "supportedVersions"),
    ).toContain("2026-07-28");
  });

  it("serves a modern tools/list with resultType complete", async () => {
    const r = await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { _meta: MODERN_ENVELOPE },
      },
      modernHeaders("tools/list"),
    );

    expect(r.status).toBe(200);
    const result = resultOf(r.text);
    expect(result.resultType).toBe("complete");
    expect(jsonObjects(result.tools, "tools").length).toBeGreaterThan(10);
  });

  it("rejects a modern request that omits the Mcp-Method header", async () => {
    const r = await post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: { _meta: MODERN_ENVELOPE },
      },
      { "MCP-Protocol-Version": "2026-07-28" },
    );

    expect(r.status).toBe(400);
    expect(r.text).toContain("-32020");
  });

  it("still answers a legacy initialize", async () => {
    const r = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "old", version: "1" },
      },
    });

    expect(r.status).toBe(200);
    expect(r.text).toContain("2025-06-18");
  });

  it("keeps the alwaysLoad entry tools un-deferred on the modern path", async () => {
    const r = await post(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
        params: { _meta: MODERN_ENVELOPE },
      },
      modernHeaders("tools/list"),
    );

    const tools = jsonObjects(resultOf(r.text).tools, "tools");

    for (const name of [
      "search_papers",
      "search_papers_many",
      "search_research_guidance",
    ]) {
      expect(tools.find((tool) => tool.name === name)?._meta).toMatchObject({
        "anthropic/alwaysLoad": true,
      });
    }
  });
});

/**
 * `2026-07-28` requires `ttlMs` and `cacheScope` on every cacheable result and
 * the SDK defaults both conservatively (`ttlMs: 0`, `cacheScope: "private"`),
 * so what is worth pinning is the non-default hints `makeServer` configures:
 * one per cacheable method this server actually serves.
 */
describe("2026-07-28 cache hints", () => {
  async function cacheHintOf(method: string, id: number) {
    const r = await post(
      { jsonrpc: "2.0", id, method, params: { _meta: MODERN_ENVELOPE } },
      modernHeaders(method),
    );

    // Assert the status first: an error response has no `result`, and
    // destructuring one throws a TypeError out of the helper instead.
    expect(r.status, r.text).toBe(200);
    const result = resultOf(r.text);

    return {
      ttlMs: jsonNumber(result.ttlMs, "ttlMs"),
      cacheScope: jsonString(result.cacheScope, "cacheScope"),
    };
  }

  it("marks tools/list private, because it varies by credential", async () => {
    const { ttlMs, cacheScope } = await cacheHintOf("tools/list", 20);
    // It branches on the workspace probe and the credential's releases, so no
    // MCP-aware cache may hold it across principals (none acts on it today).
    expect(cacheScope).toBe("private");
    // The non-zero TTL is the other half: it stops a client re-paying the
    // workspace probe every session, and is bounded because every axis can flip.
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(60_000);
  });

  it.each([
    ["prompts/list", 21],
    ["server/discover", 23],
  ])(
    "marks %s private, because a per-credential release shapes it",
    async (method, id) => {
      // A released credential gets the figure prompt and the instructions that
      // name the figure tools; an unreleased one gets neither.
      const { ttlMs, cacheScope } = await cacheHintOf(method, id);
      expect(cacheScope).toBe("private");
      expect(ttlMs).toBeGreaterThan(0);
    },
  );

  it("marks resources/list public, because it is identical for every caller", async () => {
    const { ttlMs, cacheScope } = await cacheHintOf("resources/list", 22);
    expect(cacheScope).toBe("public");
    expect(ttlMs).toBeGreaterThan(0);
  });

  it("advertises no resource for as long as resources/list is cached public", async () => {
    // `public` is sound ONLY while the handler is the empty `{resources: []}`
    // stub; scope and list are read off ONE response, so this cannot drift.
    const r = await post(
      {
        jsonrpc: "2.0",
        id: 24,
        method: "resources/list",
        params: { _meta: MODERN_ENVELOPE },
      },
      modernHeaders("resources/list"),
    );

    const result = resultOf(r.text);
    const cacheScope = jsonString(result.cacheScope, "cacheScope");
    const resources = jsonObjects(result.resources, "resources");
    expect(
      cacheScope !== "public" || resources.length === 0,
      `resources/list advertises ${resources.length} resource(s) while ` +
        `cached "${cacheScope}": a caller-varying list needs ` +
        `cacheScope "private" in server.ts, set in the same diff as the handler`,
    ).toBe(true);
  });
});

/**
 * A PostHog stand-in: `captureMcp` posts to `${LUNE_POSTHOG_HOST}/i/v0/e/`, so
 * pointing the host at a local recorder exercises the real ky emitter and the
 * real property assembly instead of a mocked module.
 */
async function startEventRecorder(): Promise<{
  url: string;
  events: JsonObject[];
  close: () => Promise<void>;
}> {
  const events: JsonObject[] = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      events.push(parseJsonObject(raw, "analytics event"));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });

  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  return {
    url: `http://127.0.0.1:${portOf(server)}`,
    events,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("per-request attribution and the analytics context", () => {
  let recorder: Awaited<ReturnType<typeof startEventRecorder>>;
  let appServer: HttpServer;
  let port: number;

  const IDENTITY = { distinctId: "user-analytics-probe", personless: false };

  function properties(event: string): JsonObject | undefined {
    const match = recorder.events.filter((e) => e.event === event).at(-1);

    if (!match) return undefined;

    return jsonObject(match.properties, `${event}.properties`);
  }

  const CLAUDE_CODE = { name: "claude-code", version: "2.1.121" };

  /**
   * One request through the real Express app. `clientInfo: null` sends a modern
   * envelope WITHOUT that key, which the SDK accepts (it requires `_meta`
   * itself, not each member); `era: "legacy"` sends no envelope at all.
   */
  async function call(
    id: number,
    method: string,
    opts: {
      params?: JsonObject;
      clientInfo?: { name: string; version: string } | null;
      era?: "modern" | "legacy";
      versionHeader?: boolean;
    } = {},
  ): Promise<number> {
    const {
      params = {},
      clientInfo = CLAUDE_CODE,
      era = "modern",
      versionHeader = true,
    } = opts;

    const envelope =
      clientInfo === null
        ? {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          }
        : {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": clientInfo,
          };

    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer lune_analytics_probe_token",
      "mcp-session-id": "client-supplied-session",
    });

    if (era === "modern") {
      const name = isJsonString(params.name) ? params.name : undefined;

      for (const [header, value] of Object.entries(
        modernHeaders(method, name, versionHeader),
      )) {
        headers.set(header, value);
      }
    }

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: era === "modern" ? { ...params, _meta: envelope } : params,
      }),
    });

    await res.text();
    await flushAnalytics(2000);

    return res.status;
  }

  const searchCall = (query: string) => ({
    params: { name: "search_papers", arguments: { query } },
  });

  beforeAll(async () => {
    // The tool's upstream call must fail fast without leaving the machine; the
    // analytics assertions only need the call to have reached a tool handler.
    recorder = await startEventRecorder();
    vi.stubEnv("LUNE_API_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_protocol_era_test");
    vi.stubEnv("LUNE_POSTHOG_HOST", recorder.url);
    initAnalytics();

    const app = buildHttpApp({
      credentialProbe: async () => ({
        status: "valid",
        identity: IDENTITY,
        captureAllowed: true,
        workspaceCredential: false,
      }),
    });

    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    port = portOf(appServer);
  });

  afterEach(() => {
    recorder.events.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await recorder.close();
    resetAnalyticsForTests();
    vi.unstubAllEnvs();
  });

  it("carries the request's analytics context all the way to a tool call event", async () => {
    // The context is entered at the Express layer and must survive the adapter,
    // the per-request instance and the await chain. Dropping it is silent.
    const status = await call(1, "tools/call", searchCall("analytics context"));
    expect(status).toBe(200);

    const event = recorder.events.find((e) => e.event === "$mcp_tool_call");
    expect(event?.distinct_id).toBe(IDENTITY.distinctId);
    expect(event?.properties).toMatchObject({
      $mcp_tool_name: "search_papers",
      $mcp_client_name: "claude-code",
      $mcp_client_version: "2.1.121",
      $mcp_protocol_version: "2026-07-28",
    });
    // The session header reaches PostHog only through the per-principal digest,
    // so what this one owns is that the property survives the adapter chain.
    const props = properties("$mcp_tool_call");

    if (!props) throw new Error("analytics recorder saw no tool call event");
    expect(props.$session_id).toEqual(expect.any(String));
    expect(props.$session_id).not.toBe("client-supplied-session");
  });

  it("reads the protocol revision off a header-less modern request", async () => {
    // `MCP-Protocol-Version` is optional once `_meta` carries the claim, and
    // that claim is what the SDK classifies on. Header-first reports nothing.
    const status = await call(6, "tools/call", {
      ...searchCall("header-less modern"),
      versionHeader: false,
    });

    expect(status).toBe(200);
    expect(properties("$mcp_tool_call")).toMatchObject({
      $mcp_protocol_version: "2026-07-28",
      $mcp_client_name: "claude-code",
    });
  });

  it("does not leak one client's identity into the next request", async () => {
    // `setServerClientInfo` keys off the server object, so "one stamp per
    // request" holds only because every request builds its own instance.
    await call(2, "tools/call", {
      ...searchCall("first client"),
      clientInfo: { name: "cursor", version: "3" },
    });
    expect(properties("$mcp_tool_call")).toMatchObject({
      $mcp_client_name: "cursor",
      $mcp_client_version: "3",
    });

    // A different client must replace the identity, not merge with it.
    await call(3, "tools/call", {
      ...searchCall("second client"),
      clientInfo: { name: "vscode", version: "9" },
    });
    expect(properties("$mcp_tool_call")).toMatchObject({
      $mcp_client_name: "vscode",
      $mcp_client_version: "9",
    });

    // A request naming NO client must report none, not inherit the last one:
    // inheriting is cross-principal attribution leakage.
    for (const [id, era] of [
      [4, "modern"],
      [5, "legacy"],
    ] as const) {
      await call(id, "tools/call", {
        ...searchCall(`anonymous ${era}`),
        clientInfo: null,
        era,
      });
      const props = properties("$mcp_tool_call");
      expect(props?.$mcp_tool_name).toBe("search_papers");
      expect(props?.$mcp_client_name).toBeUndefined();
      expect(props?.$mcp_client_version).toBeUndefined();
    }
  });

  it.each([
    ["$mcp_tools_list", "tools/list", {}],
    ["$mcp_resources_list", "resources/list", {}],
    ["$mcp_prompts_list", "prompts/list", {}],
    ["$mcp_prompt_get", "prompts/get", { name: "literature_review" }],
  ])(
    "attributes %s from the request envelope",
    async (event, method, params) => {
      // These four make no upstream API call, so they never carried
      // `X-Lune-Client`: the envelope is their only source of client identity.
      await call(6, method, { params });
      expect(properties(event)).toMatchObject({
        $mcp_client_name: "claude-code",
        $mcp_client_version: "2.1.121",
      });
    },
  );
});

/**
 * The factory hands each per-request server an `analyticsContext` getter over
 * the same ALS store `captureMcp` reads from. `tools/list` is the one handler
 * that reads the context DIRECTLY rather than through `captureMcp`, so
 * `captureMcp`'s own fallback does not cover it: drop the getter and an
 * analytics-opted-out principal is offered the analytics-intake tool, while
 * every `tools/list` also pays the `isWorkspaceCredential` probe again.
 */
describe("the analytics context handed to each per-request server", () => {
  beforeAll(() => {
    // Reached only if the getter is missing (`contextWorkspace` then falls back
    // to the upstream probe), so keep that fallback off the network.
    vi.stubEnv("LUNE_API_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_capture_gate_test");
    vi.stubEnv("LUNE_POSTHOG_HOST", "http://127.0.0.1:1");
    initAnalytics();
  });

  afterAll(() => {
    resetAnalyticsForTests();
    vi.unstubAllEnvs();
  });

  async function listedTools(analytics: {
    captureAllowed: boolean;
    suppressAnalytics?: boolean;
  }): Promise<string[]> {
    const app = buildHttpApp({
      credentialProbe: async () => ({
        status: "valid",
        identity: { distinctId: "user-capture-gate", personless: false },
        workspaceCredential: false,
        ...analytics,
      }),
    });

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const listenPort = portOf(server);

    try {
      const res = await fetch(`http://127.0.0.1:${listenPort}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer lune_capture_gate_token",
          ...modernHeaders("tools/list"),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: MODERN_ENVELOPE },
        }),
      });

      const body = await res.text();
      const tools = jsonObjects(resultOf(body).tools, "tools");

      return tools.map((tool) => jsonString(tool.name, "tool.name"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("withholds get_more_tools from a principal who opted out of capture", async () => {
    expect(
      await listedTools({ suppressAnalytics: true, captureAllowed: false }),
    ).not.toContain("get_more_tools");
  });

  it("keeps offering it to a principal who allows capture", async () => {
    expect(await listedTools({ captureAllowed: true })).toContain(
      "get_more_tools",
    );
  });

  it("keeps offering it once the shared daily analytics budget is spent", async () => {
    // `analytics_capture_allowed` also goes false when the shared daily PostHog
    // budget runs out, and a telemetry quota must not move the tool surface.
    expect(
      await listedTools({ suppressAnalytics: false, captureAllowed: false }),
    ).toContain("get_more_tools");
  });
});

/**
 * `$session_id` is DERIVED from the session header, never echoed from it.
 *
 * `mcp-session-id` is a client-chosen string and, since the session store was
 * deleted, there is no server-minted counterpart to check it against, so
 * emitting it verbatim let any caller file its events into another principal's
 * grouping in the dashboards. Two properties have to hold at once, and a digest
 * of the header alone would satisfy neither: grouping still works within one
 * principal, and a second principal asserting the SAME header lands elsewhere.
 */
describe("$session_id is bound to the principal that asserted it", () => {
  const SHARED_SESSION = "shared-session-id";
  let recorder: Awaited<ReturnType<typeof startEventRecorder>>;
  let appServer: HttpServer;
  let port: number;

  beforeAll(async () => {
    recorder = await startEventRecorder();
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_session_binding_test");
    vi.stubEnv("LUNE_POSTHOG_HOST", recorder.url);
    initAnalytics();

    // One identity per bearer, like the API's `/account/mcp-context`;
    // `workspaceCredential` is answered here so `tools/list` needs no upstream.
    const app = buildHttpApp({
      credentialProbe: async (token) => ({
        status: "valid",
        identity: { distinctId: `user-of-${token}`, personless: false },
        captureAllowed: true,
        workspaceCredential: false,
      }),
    });

    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer.once("listening", resolve));
    port = portOf(appServer);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await recorder.close();
    resetAnalyticsForTests();
    vi.unstubAllEnvs();
  });

  /** One `tools/list` as `token`, asserting the same session header every time. */
  async function sessionIdOf(token: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-session-id": SHARED_SESSION,
        ...modernHeaders("tools/list"),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: MODERN_ENVELOPE },
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
    await flushAnalytics(2000);

    const event = recorder.events
      .filter((entry) => entry.event === "$mcp_tools_list")
      .at(-1);

    if (!event) throw new Error("analytics recorder saw no tools/list event");
    const props = jsonObject(event.properties, "$mcp_tools_list.properties");

    return jsonString(props.$session_id, "$session_id");
  }

  afterEach(() => {
    recorder.events.length = 0;
  });

  it("sends two identities asserting one session id to different groupings", async () => {
    const first = await sessionIdOf("lune_first_principal");
    const second = await sessionIdOf("lune_second_principal");
    expect(first).toEqual(expect.any(String));
    // The raw claim must never be the emitted value, or the borrowed id lands
    // in the victim's bucket whatever else is true of the two digests.
    expect(first).not.toBe(SHARED_SESSION);
    expect(second).not.toBe(SHARED_SESSION);
    expect(second).not.toBe(first);
  });

  it("keeps one identity's grouping stable across its own requests", async () => {
    // The whole point of reading the header at all: a conversation's events have
    // to land together, so the digest may not carry anything per-request.
    const first = await sessionIdOf("lune_stable_principal");
    const second = await sessionIdOf("lune_stable_principal");
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
  });
});
