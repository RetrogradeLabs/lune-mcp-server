/**
 * Coverage for `buildHttpApp` (used standalone in tests) and
 * `startHttpServer`'s bind callback, plus the `/v1/mcp` alias path and the
 * duplicated `mcp-session-id` header branch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server as HttpServer } from "node:http";
import { initAnalytics, resetAnalyticsForTests } from "../../src/analytics.js";
import {
  buildHttpApp,
  startHttpServer,
  hostIsAllowed,
  originIsAllowed,
} from "../../src/transport/streamableHttp.js";
import { rawRequest } from "../support/http.js";
import { fetchJsonObject, parseJsonObject } from "../support/json.js";
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
