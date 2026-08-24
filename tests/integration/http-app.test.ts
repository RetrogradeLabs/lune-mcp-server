/**
 * Coverage for `buildHttpApp` (used standalone in tests) and
 * `startHttpServer`'s bind callback, plus the `/v1/mcp` alias path and the
 * duplicated `mcp-session-id` header branch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import http from "node:http";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { initAnalytics, resetAnalyticsForTests } from "../../src/analytics.js";
import {
  buildHttpApp,
  startHttpServer,
  hostIsAllowed,
  originIsAllowed,
} from "../../src/transport/streamableHttp.js";

// Raw HTTP POST so the test can set Host/Origin, which the WHATWG `fetch`
// implementation forbids as request headers.
function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => resolve({ status: res.statusCode, body: chunks }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("buildHttpApp standalone", () => {
  let server: HttpServer;
  let port: number;

  beforeAll(async () => {
    // buildHttpApp returns an un-bound express app; bind it ourselves.
    const app = buildHttpApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves /health from an app built without a port binding", async () => {
    vi.stubEnv("LUNE_BUILD_ID", "");
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        status: string;
        build_id?: string;
      };
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
      const body = (await r.json()) as { build_id?: string };
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
    const isolatedPort = (isolatedServer.address() as AddressInfo).port;

    try {
      const response = await rawPost(
        isolatedPort,
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
    // The probe is the identity authority, so an API 401 on
    // `/account/mcp-context` means the bearer is dead. The client has to see
    // `invalid_token` here to refresh-and-retry; letting the request through
    // would surface the API's own 401 as a tool error the model reads as
    // "please reconnect", which is the failure auto-reauth exists to prevent.
    vi.stubEnv("LUNE_POSTHOG_KEY", "phc_test");
    initAnalytics();
    const isolatedApp = buildHttpApp({
      credentialProbe: async () => ({ status: "invalid" }),
    });
    const isolatedServer = isolatedApp.listen(0);
    await new Promise<void>((resolve) =>
      isolatedServer.once("listening", resolve),
    );
    const isolatedPort = (isolatedServer.address() as AddressInfo).port;

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
    // A revoked credential has to stop passing on its NEXT request, and a
    // cache here would be exactly the cross-request state the stateless
    // transport removed. Counted at the route because that is where the
    // decision is now made.
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
    const isolatedPort = (isolatedServer.address() as AddressInfo).port;
    const call = (token: string) =>
      rawPost(
        isolatedPort,
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
    // Batching left the spec at 2025-06-18 and is refused outright on the
    // modern path, so an array can only come from a 2025-03-26-era client. One
    // POST buys one credential probe and one API-side analytics claim while
    // every element dispatches its own handler and emits its own event, which
    // is what makes an uncapped array a 40x amplifier and the one path where
    // per-request accounting under-counts. `prompts/list` needs no upstream
    // call, so nothing else in the stack would see the flood.
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
    const isolatedPort = (isolatedServer.address() as AddressInfo).port;
    const batch = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        jsonrpc: "2.0",
        id: i + 1,
        method: "prompts/list",
        params: {},
      }));
    const call = (n: number) =>
      rawPost(
        isolatedPort,
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
      expect(JSON.parse(over.body)).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600 },
      });
      // Rejected ahead of the auth work, so the flood never buys the 2.5s
      // `account/mcp-context` call that every accepted POST pays for.
      expect(probes).toBe(0);

      // The cap is a ceiling on abuse, not a ban: a batch at the limit is still
      // served in full, which is also what proves the probe counter above is
      // wired to a probe that really runs.
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
    const closeSpy = vi.spyOn(app.locals.mcpHandler as McpHttpHandler, "close");
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
    const body = (await r.json()) as { resource: string };
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
    // Node collapses duplicated inbound headers into a single comma-joined
    // string (only `set-cookie` is ever arrayed), so the request carries
    // "first-id, second-id" as one value. Nothing resolves it any more, so it
    // is served like any other stale id (and reported as the `$session_id`).
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
    // POSTs are served with the id ignored (a 404 would tell the Anthropic
    // managed-agents client its session died, and it never re-initializes; see
    // orphaned-session.test.ts); the optional standalone GET stream is declined
    // with 405, which is spec-legal at any time and does NOT signal session
    // termination.
    const post = await rawPost(
      port,
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
    const r = await rawPost(
      port,
      "/mcp",
      { authorization: "Bearer fake", origin: "https://evil.example.com" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/origin not allowed/);
  });

  it("rejects POST /mcp with a spoofed/rebound Host with 403", async () => {
    const r = await rawPost(
      port,
      "/mcp",
      { host: "attacker.example.com", authorization: "Bearer fake" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/host not allowed/);
  });

  it("admits an allowlisted Origin through the guard (then 401 on auth)", async () => {
    // claude.ai is allowlisted, so the guard passes and the request reaches the
    // handler, which rejects the fake token. Proves the guard does not block
    // legitimate browser clients.
    const r = await rawPost(
      port,
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
