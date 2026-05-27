/**
 * Unit coverage for the stdio transport runner (`src/transport/stdio.ts`).
 *
 * `runStdio` captures the Bearer token once, builds a server, and connects
 * a `StdioServerTransport`. We mock the SDK transport and the server factory
 * so no real stdio handshake is attempted, and assert the wiring order.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const connect = vi.fn<() => Promise<void>>();
const fakeServer = { connect };
const makeServer = vi.fn<(factory: () => unknown) => typeof fakeServer>(
  () => fakeServer,
);
const makeClient = vi.fn<(token: string) => unknown>();
const StdioServerTransport = vi.fn<() => void>();

vi.mock("../../src/server.js", () => ({
  makeServer: (factory: () => unknown) => makeServer(factory),
}));
vi.mock("../../src/api/client.js", () => ({
  makeClient: (token: string) => makeClient(token),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    constructor() {
      StdioServerTransport();
    }
  },
}));

describe("runStdio", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("captures the token, builds a server, and connects a stdio transport", async () => {
    vi.stubEnv("LUNE_API_KEY", "lune_stdio_token");
    connect.mockResolvedValue(undefined);
    const { runStdio } = await import("../../src/transport/stdio.js");

    await runStdio();

    expect(makeServer).toHaveBeenCalledTimes(1);
    expect(StdioServerTransport).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);

    // The factory passed into makeServer must, when invoked, build a client
    // bound to the token captured at startup.
    const factory = makeServer.mock.calls[0]![0];
    factory();
    expect(makeClient).toHaveBeenCalledWith("lune_stdio_token");
  });

  it("throws when LUNE_API_KEY is missing before any server is built", async () => {
    vi.stubEnv("LUNE_API_KEY", "");
    const { runStdio } = await import("../../src/transport/stdio.js");
    await expect(runStdio()).rejects.toThrow(/LUNE_API_KEY/);
    expect(makeServer).not.toHaveBeenCalled();
  });
});
