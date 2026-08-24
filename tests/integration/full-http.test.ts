import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startHttpServer } from "../../src/transport/streamableHttp.js";
import type { Server as HttpServer } from "node:http";

describe("HTTP transport", () => {
  let server: HttpServer;
  let port: number;

  beforeAll(async () => {
    server = startHttpServer(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port assigned");
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("/health returns 200", async () => {
    const r = await fetch(`http://localhost:${port}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ status: "ok", server: "lune-mcp" });
  });

  it("rejects POST /mcp without Authorization", async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
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
    // The remote-MCP connector keys off this header to start OAuth discovery.
    // Without it Claude Desktop reports "Couldn't reach the MCP server" even
    // though the transport itself is healthy.
    const wa = r.headers.get("www-authenticate");
    expect(wa).toMatch(/^Bearer\s/);
    expect(wa).toContain('resource_metadata="');
    // Path-aware per RFC 9728 §3.3: the challenge points at the metadata for the
    // endpoint the client actually called, here the legacy `/mcp` alias.
    expect(wa).toContain('/.well-known/oauth-protected-resource/mcp"');
    const body = (await r.json()) as {
      id: number;
      error: {
        code: number;
        data: { _meta: { "mcp/www_authenticate": string } };
      };
    };
    expect(body.id).toBe(1);
    expect(body.error.code).toBe(-32001);
    expect(body.error.data._meta["mcp/www_authenticate"]).toBe(wa);
  });

  it("exposes RFC 9728 protected-resource metadata", async () => {
    const r = await fetch(
      `http://localhost:${port}/.well-known/oauth-protected-resource`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(body.resource).toBe("https://mcp.luneresearch.com");
    expect(body.authorization_servers.length).toBeGreaterThan(0);
    expect(body.authorization_servers[0]).toMatch(/^https?:\/\//);
    expect(body.scopes_supported).toContain("papers:read");
    expect(body.bearer_methods_supported).toContain("header");
  });

  it("exposes path-specific protected-resource metadata for /mcp", async () => {
    const r = await fetch(
      `http://localhost:${port}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    // RFC 9728 §3.3: identical to the identifier the suffix was inserted into.
    expect(body.resource).toBe("https://mcp.luneresearch.com/mcp");
    expect(body.authorization_servers).toContain(
      "https://api.luneresearch.com",
    );
    expect(body.scopes_supported).toContain("papers:read");
  });

  it("exposes path-specific resource metadata for the /v1/mcp alias", async () => {
    const r = await fetch(
      `http://localhost:${port}/.well-known/oauth-protected-resource/v1/mcp`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(body.resource).toBe("https://mcp.luneresearch.com/v1/mcp");
    expect(body.authorization_servers).toContain(
      "https://api.luneresearch.com",
    );
  });

  it("rejects POST /mcp with non-Bearer scheme", async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Basic xx",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    expect(r.status).toBe(401);
  });

  it("serves a stale session ID from before the stateless migration", async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer fake_token",
        "mcp-session-id": "definitely-not-a-real-session",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    // The stateless handler IGNORES an unexpected session id rather than
    // rejecting it: the Anthropic managed-agents MCP client never
    // re-initializes after a 404, which bricked dashboard follow-up turns
    // (2026-06-10). The full contract lives in orphaned-session.test.ts.
    expect(r.status).toBe(200);
  });

  it("serves a POST /mcp with no session ID and a non-initialize method", async () => {
    // The session transport refused this (only `initialize` could mint a
    // session); stateless serving has nothing to look up, so it answers.
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer fake_token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/list",
        params: {},
      }),
    });
    expect(r.status).toBe(200);
  });

  it("serves the OpenAI Apps domain-ownership challenge as plain text", async () => {
    const r = await fetch(
      `http://localhost:${port}/.well-known/openai-apps-challenge`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/plain/);
    const token = await r.text();
    expect(token.length).toBeGreaterThan(10);
  });

  it("redirects favicon probes to the marketing asset", async () => {
    for (const path of [
      "/favicon.ico",
      "/favicon.svg",
      "/apple-touch-icon.png",
    ]) {
      const r = await fetch(`http://localhost:${port}${path}`, {
        redirect: "manual",
      });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(
        "https://luneresearch.com/favicon.svg",
      );
    }
  });

  it("echoes CORS headers for an allowed browser origin", async () => {
    const r = await fetch(`http://localhost:${port}/health`, {
      headers: { origin: "https://claude.ai" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(
      "https://claude.ai",
    );
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
    expect(r.headers.get("vary")).toBe("Origin");
  });

  it("omits CORS headers for a non-allowlisted origin", async () => {
    const r = await fetch(`http://localhost:${port}/health`, {
      headers: { origin: "https://evil.example.com" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("short-circuits an OPTIONS preflight with 204", async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://chatgpt.com",
        "access-control-request-method": "POST",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("handles a legacy initialize then tools/list with no session between them", async () => {
    // Parse the SSE-framed JSON-RPC body the legacy stateless fallback emits.
    const parseSse = (raw: string): Record<string, unknown> => {
      const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) throw new Error(`no SSE data frame in: ${raw}`);
      return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
    };

    // 1. initialize: answered, and deliberately mints NO session id.
    const initRes = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer lune_fake_session_token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get("mcp-session-id")).toBeNull();
    const initBody = parseSse(await initRes.text()) as {
      result: { serverInfo: { name: string } };
    };
    expect(initBody.result.serverInfo.name).toBe("lune-research");

    // 2. tools/list carrying no session: no API call, fully local.
    const listRes = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer lune_fake_session_token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(listRes.status).toBe(200);
    const listBody = parseSse(await listRes.text()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listBody.result.tools.length).toBe(12);

    // 3. The 2025 session verbs are declined without ceremony: there is no
    // standalone stream to open and nothing to tear down.
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method,
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer lune_fake_session_token",
        },
      });
      expect(res.status).toBe(405);
      await res.text();
    }
  });

  it("GET /mcp declines the standalone stream with 405", async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    expect(r.status).toBe(405);
  });

  it.each([["never-existed"], [undefined]])(
    "DELETE /mcp answers 405 for session id %s",
    async (sid) => {
      const r = await fetch(`http://localhost:${port}/mcp`, {
        method: "DELETE",
        headers: sid ? { "mcp-session-id": sid } : {},
      });
      expect(r.status).toBe(405);
    },
  );

  it("the 401 body id defaults to null when the request body carries no id", async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      // No `id` field → `req.body?.id ?? null` falls to null.
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {},
      }),
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { id: number | null };
    expect(body.id).toBeNull();
  });

  it("the 401 body id is null when there is no JSON body at all", async () => {
    const r = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { id: number | null };
    expect(body.id).toBeNull();
  });

  it("dispatches a real tools/call through the per-request client factory", async () => {
    // A genuine `tools/call` over HTTP exercises the per-request `makeClient`
    // closure the handler factory builds. `getBaseUrl()` is read per request,
    // so we point it at a guaranteed-closed local port: the tool's upstream
    // fetch fails fast (connection refused, no real network), but the client
    // factory has already executed.
    const savedBaseUrl = process.env.LUNE_API_BASE_URL;
    process.env.LUNE_API_BASE_URL = "http://127.0.0.1:1";
    const parseSse = (raw: string): Record<string, unknown> => {
      const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) throw new Error(`no SSE data frame in: ${raw}`);
      return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
    };

    try {
      const callRes = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer lune_toolcall_token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_papers",
            arguments: { query: "nonexistent topic" },
          },
        }),
      });
      expect(callRes.status).toBe(200);
      const body = parseSse(await callRes.text()) as {
        id: number;
        result?: unknown;
        error?: { message: string };
      };
      expect(body.id).toBe(2);
      // Either an MCP error or an error-flagged result is fine; the point
      // is the request round-tripped through the per-request client factory.
      expect(body.result ?? body.error).toBeDefined();
    } finally {
      if (savedBaseUrl === undefined) delete process.env.LUNE_API_BASE_URL;
      else process.env.LUNE_API_BASE_URL = savedBaseUrl;
    }
  });
});
