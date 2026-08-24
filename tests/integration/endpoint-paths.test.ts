/**
 * Endpoint-path migration contract (2026-08-19): the canonical Streamable-HTTP
 * endpoint moved from `https://mcp.luneresearch.com/mcp` to the bare origin.
 *
 * Every already-connected client keeps its configured URL forever (published
 * npm/plugin builds, Claude Desktop connectors, `~/.codex/config.toml` entries
 * users wrote months ago), so `/mcp` and `/v1/mcp` must stay live, must be
 * interchangeable mid-conversation, and must each advertise their OWN RFC 9728
 * identifier (§3.3: metadata whose `resource` is not identical to the URL the
 * client used "MUST NOT be used"). These tests pin all three.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import http from "node:http";
import type { Express } from "express";
import { buildHttpApp } from "../../src/transport/streamableHttp.js";

interface RawResponse {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(data === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              }),
          ...headers,
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: chunks,
          }),
        );
      },
    );
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function parseJsonRpc(raw: string): {
  result?: { tools?: Array<{ name: string }>; serverInfo?: { name: string } };
} {
  const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith("data:"));
  return JSON.parse(
    dataLine ? dataLine.slice("data:".length).trim() : raw.trim(),
  );
}

const ACCEPT = "application/json, text/event-stream";
const AUTH = "Bearer lune_fake_paths_token";
const ORIGIN = "https://mcp.luneresearch.com";
const METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource`;

// Every path a user could have configured, plus the trailing-slash spellings
// people paste into config files.
const ENDPOINTS = ["/", "/mcp", "/mcp/", "/v1/mcp", "/v1/mcp/"];

/** The RFC 9728 resource-identifier suffix a request on `path` belongs to. */
function aliasOf(path: string): string {
  const p = path.replace(/\/+$/, "");
  return p === "/mcp" || p === "/v1/mcp" ? p : "";
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.0" },
  },
};
const toolsList = (id: number): unknown => ({
  jsonrpc: "2.0",
  id,
  method: "tools/list",
  params: {},
});

let app: Express;
let server: HttpServer;
let port: number;

beforeAll(async () => {
  app = buildHttpApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("every endpoint spelling serves the JSON-RPC transport", () => {
  it.each(ENDPOINTS)("initialize + tools/list on %s", async (path) => {
    const init = await rawRequest(
      port,
      "POST",
      path,
      { accept: ACCEPT, authorization: AUTH },
      initBody,
    );
    expect(init.status).toBe(200);
    // Stateless serving mints no session id, so the handshake RESULT is the
    // proof the request reached a server instance rather than a guard branch.
    expect(parseJsonRpc(init.body).result?.serverInfo?.name).toBe(
      "lune-research",
    );

    const list = await rawRequest(
      port,
      "POST",
      path,
      { accept: ACCEPT, authorization: AUTH },
      toolsList(2),
    );
    expect(list.status).toBe(200);
    expect(
      (parseJsonRpc(list.body).result?.tools ?? []).length,
    ).toBeGreaterThan(0);
  });

  it.each(ENDPOINTS)("challenges an anonymous POST on %s", async (path) => {
    const res = await rawRequest(
      port,
      "POST",
      path,
      { accept: ACCEPT },
      initBody,
    );
    expect(res.status).toBe(401);
    // RFC 9728 §3.3: the pointer names the metadata for the endpoint the client
    // actually called, and that document echoes the matching identifier. One
    // shared document would make a conforming client on a legacy URL discard it
    // ("MUST NOT be used") and fail OAuth outright.
    expect(res.headers["www-authenticate"]).toBe(
      `Bearer resource_metadata="${METADATA_URL}${aliasOf(path)}", ` +
        'scope="papers:read guidance:read account:read"',
    );
  });
});

describe("the DNS-rebinding guard covers the new root path", () => {
  it.each(ENDPOINTS)("rejects a spoofed Host on %s", async (path) => {
    const res = await rawRequest(
      port,
      "POST",
      path,
      { accept: ACCEPT, authorization: AUTH, host: "attacker.example.com" },
      initBody,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/host not allowed/i);
  });

  it("does not turn an unknown path into a guard 403 (array match, not catch-all)", async () => {
    const res = await rawRequest(
      port,
      "POST",
      "/not-an-endpoint",
      { accept: ACCEPT, authorization: AUTH, host: "attacker.example.com" },
      initBody,
    );
    expect(res.status).toBe(404);
  });

  it.each(ENDPOINTS)(
    "rejects a disallowed browser Origin on %s",
    async (path) => {
      const res = await rawRequest(
        port,
        "POST",
        path,
        {
          accept: ACCEPT,
          authorization: AUTH,
          origin: "https://evil.example.com",
        },
        initBody,
      );
      expect(res.status).toBe(403);
      expect(res.body).toMatch(/origin not allowed/i);
    },
  );
});

describe("the endpoint spellings are interchangeable mid-conversation", () => {
  it("opens on the legacy /mcp, continues on the root, and its stale id is ignored on /v1/mcp", async () => {
    // A client that opened against `/mcp` before the migration keeps sending
    // the id its handshake returned. Nothing looks it up any more, so every
    // spelling serves it, and none of them refuses it.
    const init = await rawRequest(
      port,
      "POST",
      "/mcp",
      { accept: ACCEPT, authorization: AUTH },
      initBody,
    );
    expect(init.status).toBe(200);

    for (const path of ["/", "/v1/mcp"]) {
      const list = await rawRequest(
        port,
        "POST",
        path,
        {
          accept: ACCEPT,
          authorization: AUTH,
          "mcp-session-id": "id-minted-against-the-legacy-alias",
        },
        toolsList(2),
      );
      expect(list.status).toBe(200);
      expect(
        (parseJsonRpc(list.body).result?.tools ?? []).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("each endpoint advertises its own resource identifier", () => {
  it.each([
    ["", ORIGIN],
    ["/mcp", `${ORIGIN}/mcp`],
    ["/v1/mcp", `${ORIGIN}/v1/mcp`],
  ])(
    "%s metadata echoes the identifier its URL was built from",
    async (alias, expected) => {
      const res = await rawRequest(
        port,
        "GET",
        `/.well-known/oauth-protected-resource${alias}`,
        {},
      );
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as {
        resource: string;
        authorization_servers: string[];
      };
      expect(body.resource).toBe(expected);
      // Everything else is shared: one authorization server for every alias.
      expect(body.authorization_servers).toEqual([
        "https://api.luneresearch.com",
      ]);
    },
  );
});

describe("GET on the endpoint", () => {
  it("sends a browser to the docs instead of a JSON-RPC error", async () => {
    const res = await rawRequest(port, "GET", "/", {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://luneresearch.com/docs/mcp");
  });

  // 405 = "no standalone SSE stream offered at this endpoint", which the
  // Streamable-HTTP spec allows at any time, and which `2026-07-28` makes
  // unconditional: GET was a session operation and sessions are gone. It must
  // never become 404, which declares the session terminated.
  it("declines the stream for an MCP client with 405", async () => {
    const res = await rawRequest(port, "GET", "/", {
      accept: "text/event-stream",
    });
    expect(res.status).toBe(405);
  });

  it.each(["/mcp", "/v1/mcp"])(
    "does NOT redirect a browser on the legacy alias %s",
    async (path) => {
      const res = await rawRequest(port, "GET", path, {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      });
      expect(res.status).toBe(405);
    },
  );

  it("declines a wildcard Accept (curl, bots, lax clients) rather than redirecting", async () => {
    const res = await rawRequest(port, "GET", "/", { accept: "*/*" });
    expect(res.status).toBe(405);
  });

  it("declines a client that sends no Accept header", async () => {
    const res = await rawRequest(port, "GET", "/mcp", {});
    expect(res.status).toBe(405);
  });
});
