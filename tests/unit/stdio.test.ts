/**
 * Unit coverage for the stdio transport runner (`src/transport/stdio.ts`).
 *
 * `runStdio` captures the Bearer token once, then hands ONE factory to
 * `serveStdio`, which owns the era decision for the connection. Its three
 * collaborators are injected, so the wiring order is asserted without any real
 * stdio handshake and without replacing a module.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runStdio, type StdioDeps } from "../../src/transport/stdio.js";
import { createFakeKy } from "../support/fake-ky.js";
import {
  createRecordingServer,
  createServerContext,
} from "../support/mcp-server.js";

/**
 * Doubles for the three collaborators, typed off `StdioDeps` itself so each one
 * has to satisfy the real signature it stands in for. `serve` has no
 * implementation because `runStdio` discards its handle.
 */
function stdioDoubles() {
  const buildClient = vi.fn<NonNullable<StdioDeps["buildClient"]>>(
    () => createFakeKy().ky,
  );

  const buildServer = vi.fn<NonNullable<StdioDeps["buildServer"]>>(() =>
    createRecordingServer(),
  );

  const serve = vi.fn<NonNullable<StdioDeps["serve"]>>();
  const deps: StdioDeps = { serve, buildServer, buildClient };

  return { deps, serve, buildServer, buildClient };
}

describe("runStdio", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("captures the token, builds a server, and serves it over stdio", async () => {
    vi.stubEnv("LUNE_API_KEY", "lune_stdio_token");
    const { deps, serve, buildServer, buildClient } = stdioDoubles();

    await runStdio(deps);

    expect(serve).toHaveBeenCalledTimes(1);

    // `serveStdio` calls the factory itself (once per connection, plus once for
    // a discarded `server/discover` probe), so nothing is built until it does.
    expect(buildServer).not.toHaveBeenCalled();
    const factory = serve.mock.calls[0]![0];
    // `serveStdio` hands the factory a request context carrying the era it
    // negotiated; stdio pins one connection, so either era exercises the wiring.
    await factory({ ...createServerContext().mcpReq, era: "modern" });
    expect(buildServer).toHaveBeenCalledTimes(1);

    // The client factory passed into makeServer must, when invoked, build a
    // client bound to the token captured at startup.
    buildServer.mock.calls[0]![0]();
    expect(buildClient).toHaveBeenCalledWith("lune_stdio_token");
  });

  it("throws when LUNE_API_KEY is missing before anything is served", async () => {
    vi.stubEnv("LUNE_API_KEY", "");
    const { deps, serve } = stdioDoubles();
    await expect(runStdio(deps)).rejects.toThrow(/LUNE_API_KEY/);
    expect(serve).not.toHaveBeenCalled();
  });
});
