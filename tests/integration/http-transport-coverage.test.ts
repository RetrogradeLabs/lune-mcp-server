/**
 * Streamable HTTP guard coverage plus the verbs the stateless handler answers.
 *
 * Complements `full-http.test.ts` and `http-app.test.ts` rather than repeating
 * them. The additive assertions here are:
 *   - a `notifications/initialized` notification is acknowledged (202) whether
 *     or not it carries a session id, a path full-http does not exercise;
 *   - no response ever carries an `mcp-session-id` header, on any verb: that
 *     header is what a client would try to pin a conversation to;
 *   - host guard BOTH directions: deny on GET (403 / -32003) and admit (the
 *     configured public host AND loopback) far enough to reach the handler
 *     (200 / 405, anything but 403), proving the guard sits upstream of it;
 *   - origin guard BOTH directions: deny (403 / -32003) and admit
 *     https://claude.ai and an absent Origin through to the handler (200);
 *   - CORS preflight: an allowed origin yields 204 with ACAO echoed and
 *     Allow-Credentials: true, a disallowed origin omits ACAO, and the modern
 *     `Mcp-Method` / `Mcp-Name` headers are admitted.
 *
 * Host/Origin cannot be set through WHATWG `fetch`, so these drive a raw
 * `http.request` (the same approach as `http-app.test.ts`); CORS preflight uses
 * `fetch` since it sets only Origin + request-method headers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server as HttpServer } from "node:http";
import { buildHttpApp } from "../../src/transport/streamableHttp.js";
import { jsonRpcObject, rawRequest } from "../support/http.js";
import { jsonNumber, jsonObject, jsonString } from "../support/json.js";
import { portOf } from "../support/net.js";

function rpcErrorCode(raw: string): number {
  const error = jsonObject(jsonRpcObject(raw).error, "JSON-RPC error");

  return jsonNumber(error.code, "JSON-RPC error code");
}

const ACCEPT = "application/json, text/event-stream";

const AUTH = "Bearer lune_fake_transport_token";

function initBody() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    },
  };
}

function toolsListBody(id: number) {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

let server: HttpServer;

let port: number;

beforeAll(async () => {
  const app = buildHttpApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = portOf(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("http transport: the stateless exchange", () => {
  it("returns a JSON-RPC parse error for malformed JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: ACCEPT,
        authorization: AUTH,
        "content-type": "application/json",
      },
      body: '{"jsonrpc":"2.0",',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
  });

  it("returns a bounded JSON-RPC error for an oversized body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: ACCEPT,
        authorization: AUTH,
        "content-type": "application/json",
      },
      body: `{"padding":"${"x".repeat(1024 * 1024)}"}`,
    });

    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600 },
    });
  });

  it.each([
    ["an empty JSON body", "application/json", "", 400, -32600],
    [
      "a non-JSON content type",
      "text/plain",
      JSON.stringify(toolsListBody(1)),
      415,
      -32000,
    ],
  ])(
    "returns JSON-RPC for %s",
    async (_case, contentType, body, status, code) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          accept: ACCEPT,
          authorization: AUTH,
          "content-type": contentType,
        },
        body,
      });

      expect(res.status).toBe(status);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code },
      });
    },
  );

  it("acknowledges a notification with (202) and without a session id", async () => {
    const cases: Record<string, string>[] = [
      { accept: ACCEPT, authorization: AUTH },
      { accept: ACCEPT, authorization: AUTH, "mcp-session-id": "stale-id" },
    ];

    for (const headers of cases) {
      const res = await rawRequest(port, "POST", "/mcp", headers, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      expect(res.status).toBe(202);
    }
  });

  it("never mints an mcp-session-id, on any verb", async () => {
    // A minted id is what a client pins a conversation to, and pinning is what
    // made a deploy or task death drop every connected client.
    const init = await rawRequest(
      port,
      "POST",
      "/mcp",
      { accept: ACCEPT, authorization: AUTH },
      initBody(),
    );

    expect(init.status).toBe(200);
    expect(init.headers["mcp-session-id"]).toBeUndefined();

    const list = await rawRequest(
      port,
      "POST",
      "/mcp",
      { accept: ACCEPT, authorization: AUTH },
      toolsListBody(2),
    );

    expect(list.status).toBe(200);
    expect(list.headers["mcp-session-id"]).toBeUndefined();
    expect(jsonRpcObject(list.body).error).toBeUndefined();

    for (const method of ["GET", "DELETE"]) {
      const res = await rawRequest(port, method, "/mcp", {
        accept: ACCEPT,
        authorization: AUTH,
      });

      expect(res.status).toBe(405);
      expect(res.headers["mcp-session-id"]).toBeUndefined();
    }
  });

  it("serves a stale session id instead of refusing it", async () => {
    // Ids minted before the migration keep arriving; a 404 bricked dashboard
    // follow-up turns on 2026-06-10. Full contract: orphaned-session.test.ts.
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        accept: ACCEPT,
        authorization: AUTH,
        "mcp-session-id": "definitely-not-real",
      },
      toolsListBody(3),
    );

    expect(res.status).toBe(200);
    expect(jsonRpcObject(res.body).error).toBeUndefined();
  });

  it("declines a stale-id GET stream with 405 (not 404 = session death)", async () => {
    const res = await rawRequest(port, "GET", "/mcp", {
      accept: "text/event-stream",
      authorization: AUTH,
      "mcp-session-id": "definitely-not-real",
    });

    expect(res.status).toBe(405);
  });
});

describe("http transport: host guard (both directions)", () => {
  it("rejects a disallowed Host on the GET stream with 403 / -32003", async () => {
    const res = await rawRequest(port, "GET", "/mcp", {
      accept: "text/event-stream",
      authorization: AUTH,
      host: "attacker.example.com",
      "mcp-session-id": "x",
    });

    expect(res.status).toBe(403);
    expect(rpcErrorCode(res.body)).toBe(-32003);
    const error = jsonObject(jsonRpcObject(res.body).error, "JSON-RPC error");
    expect(jsonString(error.message)).toMatch(/host not allowed/i);
  });

  it("admits the configured public host past the guard to the handler (200, not 403)", async () => {
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        accept: ACCEPT,
        authorization: AUTH,
        host: "mcp.luneresearch.com",
        "mcp-session-id": "x",
      },
      toolsListBody(3),
    );

    // Reaching the MCP handler proves the guard let the request through; a 403
    // here would mean the allowlisted host was wrongly rejected.
    expect(res.status).toBe(200);
  });

  it("admits a loopback Host past the guard to the handler (405, not 403)", async () => {
    const res = await rawRequest(port, "GET", "/mcp", {
      accept: "text/event-stream",
      authorization: AUTH,
      host: "127.0.0.1:9",
      "mcp-session-id": "x",
    });

    expect(res.status).toBe(405);
  });
});

describe("http transport: origin guard (both directions)", () => {
  it("rejects a present, disallowed Origin with 403 / -32003", async () => {
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        accept: ACCEPT,
        authorization: AUTH,
        origin: "https://evil.example.com",
      },
      toolsListBody(4),
    );

    expect(res.status).toBe(403);
    expect(rpcErrorCode(res.body)).toBe(-32003);
    const error = jsonObject(jsonRpcObject(res.body).error, "JSON-RPC error");
    expect(jsonString(error.message)).toMatch(/origin not allowed/i);
  });

  it("admits the allowed https://claude.ai Origin past the guard to the handler (200)", async () => {
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        accept: ACCEPT,
        authorization: AUTH,
        origin: "https://claude.ai",
        "mcp-session-id": "x",
      },
      toolsListBody(5),
    );

    expect(res.status).toBe(200);
  });

  it("admits a loopback Origin on the bound development port", async () => {
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        accept: ACCEPT,
        authorization: AUTH,
        origin: `http://127.0.0.1:${port}`,
      },
      toolsListBody(6),
    );

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      `http://127.0.0.1:${port}`,
    );
  });

  it("admits a request with no Origin header (the handshake still answers)", async () => {
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      { accept: ACCEPT, authorization: AUTH },
      initBody(),
    );

    expect(res.status).toBe(200);
    expect(res.body).toContain("lune-research");
  });
});

describe("http transport: CORS preflight (both directions)", () => {
  it("answers an allowed-origin OPTIONS with 204, ACAO echoed, and Allow-Credentials: true", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "content-type,authorization,mcp-session-id",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://claude.ai",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods") ?? "").toContain(
      "POST",
    );

    // `Mcp-Method` is MANDATORY on a 2026-07-28 request, so a browser client
    // blocked from sending it fails every modern call at preflight.
    const allowed = (
      res.headers.get("access-control-allow-headers") ?? ""
    ).toLowerCase();

    expect(allowed).toContain("mcp-method");
    expect(allowed).toContain("mcp-name");
  });

  it("does not echo Access-Control-Allow-Origin for a disallowed preflight origin", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "POST",
      },
    });

    // The preflight still short-circuits (204), but with no allow-origin grant
    // the browser blocks the cross-origin response.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
