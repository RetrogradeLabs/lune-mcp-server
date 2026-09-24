/**
 * Coverage for `buildHttpApp` (used standalone in tests) and
 * `startHttpServer`'s bind callback, plus the `/v1/mcp` alias path and the
 * duplicated `mcp-session-id` header branch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import { initAnalytics, resetAnalyticsForTests } from "../../src/analytics.js";
import type { JsonObject } from "../../src/json.js";
import {
  buildHttpApp,
  startHttpServer,
  hostIsAllowed,
  originIsAllowed,
  type AnalyticsCredentialProbe,
} from "../../src/transport/streamableHttp.js";
import { jsonRpcObject, rawRequest } from "../support/http.js";
import {
  fetchJsonObject,
  jsonObject,
  jsonObjects,
  jsonString,
  parseJsonObject,
} from "../support/json.js";
import { portOf } from "../support/net.js";

describe("buildHttpApp standalone", () => {
  let server: HttpServer;
  let port: number;

  beforeAll(async () => {
    // buildHttpApp returns an un-bound express app; bind it ourselves.
    const app = buildHttpApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = portOf(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves /health from an app built without a port binding", async () => {
    vi.stubEnv("LUNE_BUILD_ID", "");

    try {
      const r = await fetch(`http://localhost:${port}/health`);
      expect(r.status).toBe(200);
      const body = await fetchJsonObject(r);
      expect(body.status).toBe("ok");
      expect(body.build_id).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exposes the deployed build id when the task definition provides one", async () => {
    vi.stubEnv("LUNE_BUILD_ID", "abc123");

    try {
      const r = await fetch(`http://localhost:${port}/health`);
      const body = await fetchJsonObject(r);
      expect(body.build_id).toBe("abc123");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps MCP available when the optional analytics probe is unavailable", async () => {
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();

    const isolatedApp = buildHttpApp({
      credentialProbe: async () => ({ status: "indeterminate" }),
    });

    const isolatedServer = isolatedApp.listen(0);
    await new Promise<void>((resolve) =>
      isolatedServer.once("listening", resolve),
    );
    const isolatedPort = portOf(isolatedServer);

    try {
      const response = await rawRequest(
        isolatedPort,
        "POST",
        "/mcp",
        {
          accept: "application/json, text/event-stream",
          authorization: "Bearer opaque-test-token",
        },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        },
      );

      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) =>
        isolatedServer.close(() => resolve()),
      );
      resetAnalyticsForTests();
      vi.unstubAllEnvs();
    }
  });

  it("rejects a credential the analytics probe reports invalid, with a refresh challenge", async () => {
    // The probe is the identity authority, so an API 401 there means the bearer
    // is dead and the client must see `invalid_token` to refresh-and-retry.
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();

    const isolatedApp = buildHttpApp({
      credentialProbe: async () => ({ status: "invalid" }),
    });

    const isolatedServer = isolatedApp.listen(0);
    await new Promise<void>((resolve) =>
      isolatedServer.once("listening", resolve),
    );
    const isolatedPort = portOf(isolatedServer);

    try {
      const response = await fetch(`http://localhost:${isolatedPort}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer revoked-opaque-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/list",
          params: {},
        }),
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        'error="invalid_token"',
      );
      expect(await response.json()).toMatchObject({
        id: 7,
        error: { code: -32001 },
      });
    } finally {
      await new Promise<void>((resolve) =>
        isolatedServer.close(() => resolve()),
      );
      resetAnalyticsForTests();
      vi.unstubAllEnvs();
    }
  });

  it("re-probes every request instead of caching a credential verdict", async () => {
    // A revoked credential has to stop passing on its NEXT request, so no cache
    // here; counted at the route because that is where the decision is made.
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    let probes = 0;

    const isolatedApp = buildHttpApp({
      credentialProbe: async (token) => {
        probes += 1;

        return { status: token === "live-token" ? "valid" : "invalid" };
      },
    });

    const isolatedServer = isolatedApp.listen(0);
    await new Promise<void>((resolve) =>
      isolatedServer.once("listening", resolve),
    );
    const isolatedPort = portOf(isolatedServer);

    const call = (token: string) =>
      rawRequest(
        isolatedPort,
        "POST",
        "/mcp",
        {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      );

    try {
      expect((await call("revoked-token")).status).toBe(401);
      expect((await call("live-token")).status).toBe(200);
      expect((await call("live-token")).status).toBe(200);
      expect(probes).toBe(3);
    } finally {
      await new Promise<void>((resolve) =>
        isolatedServer.close(() => resolve()),
      );
      resetAnalyticsForTests();
      vi.unstubAllEnvs();
    }
  });

  it("refuses a JSON-RPC batch longer than the cap, before any upstream call", async () => {
    // Arrays are 2025-era only, and one POST buys one probe plus one analytics
    // claim while every element emits its own event: uncapped, a 40x amplifier.
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    let probes = 0;

    const isolatedApp = buildHttpApp({
      credentialProbe: async () => {
        probes += 1;

        return { status: "valid" };
      },
    });

    const isolatedServer = isolatedApp.listen(0);
    await new Promise<void>((resolve) =>
      isolatedServer.once("listening", resolve),
    );
    const isolatedPort = portOf(isolatedServer);

    const batch = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        jsonrpc: "2.0",
        id: i + 1,
        method: "prompts/list",
        params: {},
      }));

    const call = (n: number) =>
      rawRequest(
        isolatedPort,
        "POST",
        "/mcp",
        {
          accept: "application/json, text/event-stream",
          authorization: "Bearer live-token",
        },
        batch(n),
      );

    try {
      const over = await call(51);
      expect(over.status).toBe(400);
      expect(parseJsonObject(over.body)).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600 },
      });
      // Rejected ahead of the auth work, so the flood never buys the 2.5s
      // `account/mcp-context` call that every accepted POST pays for.
      expect(probes).toBe(0);

      // The cap is a ceiling on abuse, not a ban: a batch AT the limit is still
      // served in full, which also proves the probe counter counts real probes.
      const atCap = await call(50);
      expect(atCap.status).toBe(200);
      expect(probes).toBe(1);
      expect(atCap.body.match(/"jsonrpc"/g)).toHaveLength(50);
    } finally {
      await new Promise<void>((resolve) =>
        isolatedServer.close(() => resolve()),
      );
      resetAnalyticsForTests();
      vi.unstubAllEnvs();
    }
  });

  it("closes the MCP handler when its bound server closes", async () => {
    // The handler owns the modern leg's in-flight exchanges, so one that
    // outlives its server is a leak per app, and the suite builds one per file.
    const app = buildHttpApp();
    const closeSpy = vi.spyOn(app.locals.mcpHandler, "close");
    const bound = app.listen(0);
    await new Promise<void>((resolve) => bound.once("listening", resolve));
    await new Promise<void>((resolve) => bound.close(() => resolve()));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("serves protected-resource metadata for the /v1/mcp alias path", async () => {
    const r = await fetch(
      `http://localhost:${port}/.well-known/oauth-protected-resource/v1/mcp`,
    );

    expect(r.status).toBe(200);
    const body = await fetchJsonObject(r);
    expect(body.resource).toBe("https://mcp.luneresearch.com/v1/mcp");
  });

  it("serves the JSON-RPC endpoint at the bare root path", async () => {
    const r = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });

    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer\s/);
  });

  it("rejects POST /v1/mcp without Authorization (alias shares the handler)", async () => {
    const r = await fetch(`http://localhost:${port}/v1/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });

    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer\s/);
  });

  it("GET /v1/mcp declines the standalone stream with 405", async () => {
    const r = await fetch(`http://localhost:${port}/v1/mcp`, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });

    expect(r.status).toBe(405);
  });

  it("tolerates a repeated mcp-session-id header", async () => {
    // Node comma-joins duplicate inbound headers (only set-cookie is arrayed),
    // so the pair arrives as one stale id and is served like any other.
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: [
        ["content-type", "application/json"],
        ["accept", "application/json, text/event-stream"],
        ["authorization", "Bearer fake"],
        ["mcp-session-id", "first-id"],
        ["mcp-session-id", "second-id"],
      ],
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    expect(r.status).toBe(200);
  });

  it("serves a stale session id on POST and declines its GET stream with 405", async () => {
    // POSTs are served with the id ignored (a 404 tells the managed-agents
    // client its session died); the optional GET stream is declined with 405.
    const post = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        accept: "application/json, text/event-stream",
        authorization: "Bearer fake",
        "mcp-session-id": "gone-123",
      },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );

    expect(post.status).toBe(200);

    const get = await fetch(`http://localhost:${port}/mcp`, {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": "gone-123" },
    });

    expect(get.status).toBe(405);
  });

  it("rejects POST /mcp from a disallowed Origin with 403 (before any tool runs)", async () => {
    const r = await rawRequest(
      port,
      "POST",
      "/mcp",
      { authorization: "Bearer fake", origin: "https://evil.example.com" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );

    expect(r.status).toBe(403);
    expect(r.body).toMatch(/origin not allowed/);
  });

  it("rejects POST /mcp with a spoofed/rebound Host with 403", async () => {
    const r = await rawRequest(
      port,
      "POST",
      "/mcp",
      { host: "attacker.example.com", authorization: "Bearer fake" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );

    expect(r.status).toBe(403);
    expect(r.body).toMatch(/host not allowed/);
  });

  it("admits an allowlisted Origin through the guard (then 401 on auth)", async () => {
    // claude.ai is allowlisted, so the request reaches the handler and dies on
    // the fake token: the origin guard does not block legitimate browsers.
    const r = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        origin: "https://claude.ai",
        accept: "application/json, text/event-stream",
      },
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    );

    expect(r.status).toBe(401);
  });
});

describe("startHttpServer", () => {
  it("binds to an OS-assigned port and logs the bound port", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const server = startHttpServer(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    // The listen callback runs synchronously after `listening`; give it a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Lune MCP HTTP listening on :\d+/),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logSpy.mockRestore();
  });
});

describe("host/origin allowlist", () => {
  it("allows the configured host and loopback, rejects others", () => {
    expect(hostIsAllowed("mcp.luneresearch.com")).toBe(true);
    expect(hostIsAllowed("localhost:8787")).toBe(true);
    expect(hostIsAllowed("127.0.0.1:3000")).toBe(true);
    expect(hostIsAllowed("attacker.example.com")).toBe(false);
    expect(hostIsAllowed(undefined)).toBe(false);
  });

  it("allows absent and allowlisted origins, rejects others", () => {
    expect(originIsAllowed(undefined)).toBe(true);
    expect(originIsAllowed("https://claude.ai")).toBe(true);
    expect(originIsAllowed("https://evil.example.com")).toBe(false);
    expect(originIsAllowed(["https://claude.ai", "x"])).toBe(false);
  });
});

describe("per-credential releases on the hosted transport", () => {
  const RELEASED: AnalyticsCredentialProbe = {
    status: "valid",
    workspaceCredential: false,
    releases: { figures: true },
  };

  const UNRELEASED: AnalyticsCredentialProbe = {
    status: "valid",
    workspaceCredential: false,
  };

  const INDETERMINATE: AnalyticsCredentialProbe = { status: "indeterminate" };

  /** A 2026-07-28 request names its era in `_meta` and its method in a header. */
  const MODERN = {
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {
          name: "release-test",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
    headers: {
      "mcp-method": "server/discover",
      "mcp-protocol-version": "2026-07-28",
    },
  };

  /** Every name only a released credential may learn. */
  const RELEASED_ONLY =
    /search_figure_references|get_paper_figures|design_figure/;

  interface HostedApp {
    ask(
      method: string,
      params?: JsonObject,
      options?: { headers?: Record<string, string>; token?: string },
    ): Promise<JsonObject>;
    close(): Promise<void>;
  }

  /**
   * One app whose probe gives `probes` in order, the last one repeating, so a
   * test can follow one credential across requests on the same task.
   */
  async function hostedApp(
    ...probes: AnalyticsCredentialProbe[]
  ): Promise<HostedApp> {
    // A released tool call must reach the upstream fetch and fail there, fast,
    // rather than leave the machine.
    vi.stubEnv("LUNE_API_BASE_URL", "http://127.0.0.1:9");
    let answered = 0;

    const app = buildHttpApp({
      credentialProbe: async () => {
        const probe = probes[Math.min(answered, probes.length - 1)]!;
        answered += 1;

        return probe;
      },
    });

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));

    return {
      async ask(method, params = {}, options = {}) {
        const response = await rawRequest(
          portOf(server),
          "POST",
          "/mcp",
          {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${options.token ?? "lune_release_probe_token"}`,
            ...options.headers,
          },
          { jsonrpc: "2.0", id: 1, method, params },
        );

        expect(response.status).toBe(200);

        return jsonRpcObject(response.body);
      },
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        vi.unstubAllEnvs();
      },
    };
  }

  /** One JSON-RPC exchange against an app whose probe answers `probe`. */
  async function exchange(
    probe: AnalyticsCredentialProbe,
    method: string,
    params: JsonObject = {},
    headers: Record<string, string> = {},
  ): Promise<JsonObject> {
    const hosted = await hostedApp(probe);

    try {
      return await hosted.ask(method, params, { headers });
    } finally {
      await hosted.close();
    }
  }

  /** The tool names one answer lists. */
  function toolNames(answer: JsonObject): string[] {
    const result = jsonObject(answer.result, "tools/list result");

    return jsonObjects(result.tools, "tools").map((tool) =>
      jsonString(tool.name, "tools[].name"),
    );
  }

  async function names(
    probe: AnalyticsCredentialProbe,
    method: "tools/list" | "prompts/list",
  ): Promise<string[]> {
    const result = jsonObject((await exchange(probe, method)).result, method);
    const key = method === "tools/list" ? "tools" : "prompts";

    return jsonObjects(result[key], key).map((item) =>
      jsonString(item.name, `${key}[].name`),
    );
  }

  /** What each era opens with: a 2025 `initialize` and a 2026 `server/discover`. */
  async function openings(probe: AnalyticsCredentialProbe) {
    const initialize = jsonObject(
      (
        await exchange(probe, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "release-test", version: "1.0.0" },
        })
      ).result,
      "initialize result",
    );

    const discover = jsonObject(
      (await exchange(probe, "server/discover", MODERN.params, MODERN.headers))
        .result,
      "server/discover result",
    );

    return [initialize, discover];
  }

  async function instructions(probe: AnalyticsCredentialProbe) {
    return (await openings(probe)).map((opening) =>
      jsonString(opening.instructions, "instructions"),
    );
  }

  it("gives a released credential the figure tools, prompt and workflow", async () => {
    const tools = await names(RELEASED, "tools/list");
    expect(tools).toHaveLength(14);
    expect(tools).toEqual(
      expect.arrayContaining(["search_figure_references", "get_paper_figures"]),
    );

    const prompts = await names(RELEASED, "prompts/list");
    expect(prompts).toHaveLength(7);
    expect(prompts).toContain("design_figure");

    for (const text of await instructions(RELEASED)) {
      expect(text).toContain("search_figure_references");
    }
  });

  it.each<[string, AnalyticsCredentialProbe]>([
    ["an unreleased credential", UNRELEASED],
    ["a credential whose probe failed", INDETERMINATE],
  ])(
    "gives %s the public surface with no figure wording",
    async (_label, probe) => {
      const tools = await names(probe, "tools/list");
      expect(tools).toHaveLength(12);
      expect(tools.join(" ")).not.toMatch(/figure/);

      const prompts = await names(probe, "prompts/list");
      expect(prompts).toHaveLength(6);
      expect(prompts).not.toContain("design_figure");

      const texts = await instructions(probe);
      expect(texts).toHaveLength(2);

      for (const text of texts) expect(text).not.toMatch(/figure/i);
    },
  );

  it.each<[string, AnalyticsCredentialProbe]>([
    ["an unreleased credential", UNRELEASED],
    ["a credential whose probe failed", INDETERMINATE],
  ])("names nothing released anywhere %s can read", async (_label, probe) => {
    const everything = JSON.stringify([
      await exchange(probe, "tools/list"),
      await exchange(probe, "prompts/list"),
      ...(await openings(probe)),
    ]);

    expect(everything).toContain("search_papers");
    expect(everything).not.toMatch(RELEASED_ONLY);
  });

  it("answers a figure call from an unreleased credential exactly as an unknown tool", async () => {
    const call = (name: string) =>
      exchange(UNRELEASED, "tools/call", {
        name,
        arguments: { query: "a three-stage pipeline" },
      });

    const unreleased = await call("search_figure_references");
    const unknown = await call("definitely_not_a_tool");

    expect(unreleased.result).toBeUndefined();
    expect(unreleased.error).toMatchObject({
      code: -32602,
      message: "Unknown tool: search_figure_references",
    });
    // Byte for byte the unknown-tool answer, bar the name the caller sent.
    expect(
      JSON.stringify(unreleased.error).replace("search_figure_references", "_"),
    ).toBe(JSON.stringify(unknown.error).replace("definitely_not_a_tool", "_"));

    const prompt = await exchange(UNRELEASED, "prompts/get", {
      name: "design_figure",
      arguments: { figure: "a three-stage pipeline" },
    });

    expect(prompt.error).toMatchObject({
      code: -32602,
      message: "Unknown prompt: design_figure",
    });
  });

  it("lets a figure call reach the API while the probe cannot answer and nothing is remembered", async () => {
    const response = await exchange(INDETERMINATE, "tools/call", {
      name: "search_figure_references",
      arguments: { query: "a three-stage pipeline" },
    });

    // Not the unknown-tool refusal: the API's own gate decides, and the dead
    // upstream here makes that an ordinary tool error.
    expect(response.error).toBeUndefined();
    expect(jsonObject(response.result, "tools/call result").isError).toBe(true);
  });

  it("stands on a credential's last answer for a few minutes while the API cannot be asked", async () => {
    const hosted = await hostedApp(RELEASED, INDETERMINATE);
    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      expect(toolNames(await hosted.ask("tools/list"))).toHaveLength(14);
      expect(toolNames(await hosted.ask("tools/list"))).toHaveLength(14);

      // Another credential on the same task inherits nothing.
      expect(
        toolNames(
          await hosted.ask("tools/list", {}, { token: "lune_someone_else" }),
        ),
      ).toHaveLength(12);

      vi.setSystemTime(Date.now() + 5 * 60_000);
      expect(toolNames(await hosted.ask("tools/list"))).toHaveLength(12);
    } finally {
      vi.useRealTimers();
      await hosted.close();
    }
  });

  it("dispatches the same call for a released credential", async () => {
    const response = await exchange(RELEASED, "tools/call", {
      name: "search_figure_references",
      arguments: { query: "a three-stage pipeline" },
    });

    // The dead upstream makes it a tool error, which is the point: the call got
    // past the release gate to the API.
    expect(response.error).toBeUndefined();
    expect(jsonObject(response.result, "tools/call result").isError).toBe(true);
  });
});
