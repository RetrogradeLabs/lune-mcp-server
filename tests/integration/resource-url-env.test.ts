/**
 * `MCP_PUBLIC_URL` -> advertised RFC 9728 `resource`, across module re-imports.
 *
 * The endpoint is served at the bare origin AND at the legacy `/mcp` +
 * `/v1/mcp` paths, so the env var can legitimately carry any of those spellings
 * (the service's deployment configuration today, a dev tunnel tomorrow, a stale task definition during a
 * rollout). What must be stable is the ORIGIN they all resolve to: the per-path
 * identifiers are built from it (`resourceFor`), and discovery is deliberately
 * path-aware, so this pins the prefix, NOT one `resource` for every path.
 * A stray path on the env var would otherwise advertise an identifier we do not
 * serve, and the metadata URL would no longer sit on the same origin as the
 * resource, which RFC 9728 §3.3 requires them to agree on.
 *
 * The constants resolve at module import, so each case re-imports the module
 * under a stubbed env rather than mutating it afterwards (a no-op).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJsonObject, jsonString } from "../support/json.js";
import { portOf } from "../support/net.js";

const ORIGIN = "https://mcp.luneresearch.com";

async function advertisedResource(
  publicUrl: string | undefined,
): Promise<{ resource: string; hostAllowed: (h: string) => boolean }> {
  vi.resetModules();
  vi.stubEnv("MCP_PUBLIC_URL", publicUrl);
  const mod = await import("../../src/transport/streamableHttp.js");
  const server = mod.buildHttpApp().listen(0);

  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = portOf(server);

    const res = await fetch(
      `http://localhost:${port}/.well-known/oauth-protected-resource`,
    );

    const body = await fetchJsonObject(res);

    return {
      resource: jsonString(body.resource, "resource"),
      hostAllowed: mod.hostIsAllowed,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("advertised resource identifier", () => {
  it.each([
    undefined,
    "",
    ORIGIN,
    `${ORIGIN}/`,
    `${ORIGIN}/mcp`,
    `${ORIGIN}/mcp/`,
    `${ORIGIN}/v1/mcp`,
  ])("collapses MCP_PUBLIC_URL=%s to the origin", async (publicUrl) => {
    const { resource } = await advertisedResource(publicUrl);
    expect(resource).toBe(ORIGIN);
  });

  it("keeps a dev tunnel's own origin (and allows its Host)", async () => {
    const { resource, hostAllowed } = await advertisedResource(
      "https://demo.trycloudflare.com/mcp",
    );

    expect(resource).toBe("https://demo.trycloudflare.com");
    expect(hostAllowed("demo.trycloudflare.com")).toBe(true);
    expect(hostAllowed("attacker.example.com")).toBe(false);
  });
});
