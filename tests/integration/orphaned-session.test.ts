/**
 * Stale session ids from before the stateless migration must keep working.
 *
 * Why: clients hold a session id far longer than any server-side session lived.
 * The Anthropic Managed Agents MCP client (dashboard Search/Critique) keeps ONE
 * id for the lifetime of a managed session (24h) and does NOT re-initialize
 * after a 404: it surfaces "server terminated the MCP session" and every later
 * tool call in that managed session fails (prod incident 2026-06-10: turn 0
 * succeeded, the follow-up 64 min later failed 3/3 tool calls). `2026-07-28`
 * deleted protocol sessions outright, and `createMcpHandler`'s stateless legacy
 * posture IGNORES an unexpected `mcp-session-id` rather than rejecting it, so
 * every id minted before the migration is served on its next request. Lune's
 * tools are stateless per request (Bearer auth arrives on every request; no
 * subscriptions, sampling, or server-initiated notifications), so there is no
 * per-session state to have lost.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server as HttpServer } from "node:http";
import type { Express } from "express";
import { buildHttpApp } from "../../src/transport/streamableHttp.js";
import { jsonRpcObject, rawRequest } from "../support/http.js";
import { jsonObject, jsonObjects } from "../support/json.js";
import { portOf } from "../support/net.js";

function rpcTools(raw: string) {
  const result = jsonObject(jsonRpcObject(raw).result, "JSON-RPC result");

  return jsonObjects(result.tools, "tool list");
}

const ACCEPT = "application/json, text/event-stream";

const AUTH = "Bearer lune_fake_orphan_token";

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

async function listen(
  app: Express,
): Promise<{ server: HttpServer; port: number }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  return { server, port: portOf(server) };
}

let server: HttpServer;

let port: number;

beforeAll(async () => {
  ({ server, port } = await listen(buildHttpApp()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("a stale session id is served, never refused", () => {
  it("serves tools/list on a never-seen session id and is repeatable", async () => {
    const sid = "id-minted-before-the-deploy";

    for (const id of [1, 2]) {
      const res = await rawRequest(
        port,
        "POST",
        "/mcp",
        { accept: ACCEPT, authorization: AUTH, "mcp-session-id": sid },
        toolsListBody(id),
      );

      expect(res.status).toBe(200);
      expect(res.body).not.toContain("Session not found");
      expect(rpcTools(res.body).length).toBeGreaterThan(0);
      // Stateless handling mints nothing: the client keeps its own id.
      expect(res.headers["mcp-session-id"]).toBeUndefined();
    }
  });

  it("serves the same id against a fresh process (the deploy / restart case)", async () => {
    const fresh = await listen(buildHttpApp());

    try {
      const res = await rawRequest(
        fresh.port,
        "POST",
        "/mcp",
        {
          accept: ACCEPT,
          authorization: AUTH,
          "mcp-session-id": "id-minted-before-the-deploy",
        },
        toolsListBody(3),
      );

      expect(res.status).toBe(200);
      expect(rpcTools(res.body).length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => fresh.server.close(() => resolve()));
    }
  });

  it("serves an initialize that arrives with a stale id (no 404, no re-binding)", async () => {
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        accept: ACCEPT,
        authorization: AUTH,
        "mcp-session-id": "stale-from-before-the-deploy",
      },
      initBody(),
    );

    expect(res.status).toBe(200);
    // The legacy handshake still answers; it just no longer mints an id.
    expect(res.body).toContain("lune-research");
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("serves a POST that carries NO session id at all", async () => {
    // The old transport 400'd this (only `initialize` could mint a session).
    // Stateless serving needs no id, so a client that dropped its own works.
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      { accept: ACCEPT, authorization: AUTH },
      toolsListBody(4),
    );

    expect(res.status).toBe(200);
    expect(rpcTools(res.body).length).toBeGreaterThan(0);
  });

  it("round-trips a stale-id tools/call through the per-request client", async () => {
    // The prod failure was tools/call, not tools/list. The closed local port
    // fails the fetch fast, but only after `makeClient(token)` has run.
    const savedBaseUrl = process.env.LUNE_API_BASE_URL;
    process.env.LUNE_API_BASE_URL = "http://127.0.0.1:1";

    try {
      const res = await rawRequest(
        port,
        "POST",
        "/mcp",
        {
          accept: ACCEPT,
          authorization: AUTH,
          "mcp-session-id": "stale-tools-call",
        },
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "search_papers",
            arguments: { query: "stale-id follow-up" },
          },
        },
      );

      expect(res.status).toBe(200);
      const body = jsonRpcObject(res.body);
      // Either an error-flagged tool result or a JSON-RPC error is fine; the
      // point is the call was served instead of refused.
      expect(body.result ?? body.error).toBeDefined();
    } finally {
      if (savedBaseUrl === undefined) delete process.env.LUNE_API_BASE_URL;
      else process.env.LUNE_API_BASE_URL = savedBaseUrl;
    }
  });

  it("accepts a notification carrying a stale session id (202)", async () => {
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        accept: ACCEPT,
        authorization: AUTH,
        "mcp-session-id": "stale-notification",
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    );

    expect(res.status).toBe(202);
  });

  it("still requires auth on a stale-id request (401 + WWW-Authenticate)", async () => {
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      { accept: ACCEPT, "mcp-session-id": "stale-no-auth" },
      toolsListBody(5),
    );

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer\s/);
  });

  it("answers GET with 405, never 404", async () => {
    // 405 = "no standalone SSE stream offered" (spec-legal at any time); 404
    // would say the session was terminated, which the client cannot recover.
    const res = await rawRequest(port, "GET", "/", {
      accept: "text/event-stream",
      authorization: AUTH,
      "mcp-session-id": "id-minted-before-the-deploy",
    });

    expect(res.status).toBe(405);
  });
});
