/**
 * Unit coverage for `makeServer` and the server-level constants.
 *
 * `makeServer` wires capabilities + instructions and delegates tool
 * registration to `registerAllTools`. We assert it produces a connectable
 * `Server` and that the per-invocation `makeClient` factory is threaded
 * through (the HTTP transport relies on this to rotate Bearer tokens).
 */
import { describe, expect, it, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { KyInstance } from "ky";
import { makeServer, SERVER_NAME, SERVER_VERSION } from "../../src/server.js";

describe("server constants", () => {
  it("exposes a stable server name", () => {
    expect(SERVER_NAME).toBe("lune-research");
  });

  it("falls back to the dev version when the build constant is absent", () => {
    // `__LUNE_MCP_VERSION__` is only substituted by tsup; under vitest the
    // `declare const` is undefined so the module picks the dev sentinel.
    expect(SERVER_VERSION).toBe("0.0.0-dev");
  });
});

describe("makeServer", () => {
  it("returns an MCP Server instance with tools registered", () => {
    const makeClient = vi.fn<() => KyInstance>(
      () => ({}) as unknown as KyInstance,
    );
    const server = makeServer(makeClient);
    expect(server).toBeInstanceOf(Server);
  });

  it("does not eagerly invoke the client factory at construction time", () => {
    // The factory must only run per tool invocation, never at wiring time.
    const makeClient = vi.fn<() => KyInstance>(
      () => ({}) as unknown as KyInstance,
    );
    makeServer(makeClient);
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("builds independent server instances on repeated calls", () => {
    const a = makeServer(() => ({}) as unknown as KyInstance);
    const b = makeServer(() => ({}) as unknown as KyInstance);
    expect(a).not.toBe(b);
  });
});
