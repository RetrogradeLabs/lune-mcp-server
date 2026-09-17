import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server as HttpServer } from "node:http";

import serverManifest from "../../server.json";
import packageManifest from "../../package.json";
import { buildHttpApp } from "../../src/transport/streamableHttp.js";
import { portOf } from "../support/net.js";

describe("MCP server manifest discovery", () => {
  let server: HttpServer;
  let port: number;

  beforeAll(async () => {
    server = buildHttpApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = portOf(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each(["/.well-known/mcp/server.json", "/server.json"])(
    "serves the Registry server.json at %s",
    async (path) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("cache-control")).toContain("max-age=3600");
      expect(await response.json()).toEqual(serverManifest);
    },
  );

  it("advertises the published stdio package and Streamable HTTP endpoint", () => {
    expect(serverManifest.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    );
    expect(serverManifest.name).toBe("com.luneresearch/lune");
    expect(serverManifest.version).toBe(packageManifest.version);
    expect(
      serverManifest.packages.find(
        (entry) => entry.identifier === packageManifest.name,
      )?.version,
    ).toBe(packageManifest.version);
    expect(serverManifest.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          registryType: "npm",
          identifier: "@retrograde-labs/lune-mcp-server",
          transport: { type: "stdio" },
        }),
      ]),
    );
    expect(serverManifest.remotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "streamable-http",
          url: "https://mcp.luneresearch.com",
        }),
      ]),
    );

    const authorization = serverManifest.remotes[0]?.headers?.find(
      (header) => header.name === "Authorization",
    );

    expect(authorization?.description).toContain("OAuth-capable MCP client");
    expect(authorization?.description).not.toContain(
      "OAuth access token from https://luneresearch.com/dashboard/settings/credentials",
    );
  });

  it("keeps credentialed CORS valid for an allowed browser origin", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/mcp/server.json`,
      { headers: { Origin: "https://chatgpt.com" } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://chatgpt.com",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(response.headers.get("vary")).toContain("Origin");
  });
});
