/**
 * Unit coverage for the stdio transport runner (`src/transport/stdio.ts`).
 *
 * `runStdio` captures the Bearer token once, then hands ONE factory to
 * `serveStdio`, which owns the era decision for the connection. We mock both so
 * no real stdio handshake is attempted, and assert the wiring order.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const makeServer = vi.fn<(factory: () => unknown) => object>(() => ({}));
const makeClient = vi.fn<(token: string) => unknown>();
const serveStdio = vi.fn<(factory: () => unknown) => { close: () => void }>(
  () => ({ close: () => {} }),
);

vi.mock("../../src/server.js", () => ({
  makeServer: (factory: () => unknown) => makeServer(factory),
}));
vi.mock("../../src/api/client.js", () => ({
  makeClient: (token: string) => makeClient(token),
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: (factory: () => unknown) => serveStdio(factory),
}));

describe("runStdio", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("captures the token, builds a server, and serves it over stdio", async () => {
    vi.stubEnv("LUNE_API_KEY", "lune_stdio_token");
    const { runStdio } = await import("../../src/transport/stdio.js");

    await runStdio();

    expect(serveStdio).toHaveBeenCalledTimes(1);

    // `serveStdio` calls the factory itself (once per connection, plus once for
    // a discarded `server/discover` probe), so nothing is built until it does.
    expect(makeServer).not.toHaveBeenCalled();
    const factory = serveStdio.mock.calls[0]![0];
    factory();
    expect(makeServer).toHaveBeenCalledTimes(1);

    // The client factory passed into makeServer must, when invoked, build a
    // client bound to the token captured at startup.
    makeServer.mock.calls[0]![0]();
    expect(makeClient).toHaveBeenCalledWith("lune_stdio_token");
  });

  it("throws when LUNE_API_KEY is missing before anything is served", async () => {
    vi.stubEnv("LUNE_API_KEY", "");
    const { runStdio } = await import("../../src/transport/stdio.js");
    await expect(runStdio()).rejects.toThrow(/LUNE_API_KEY/);
    expect(serveStdio).not.toHaveBeenCalled();
  });
});
