/**
 * Unit coverage for the stdio transport runner (`src/transport/stdio.ts`).
 *
 * `runStdio` captures the Bearer token once, then hands ONE factory to
 * `serveStdio`, which owns the era decision for the connection. Its three
 * collaborators are injected, so the wiring order is asserted without any real
 * stdio handshake and without replacing a module.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPrompts } from "../../src/prompts.js";
import {
  fixedReleases,
  PUBLIC_RELEASES,
  PUBLIC_VIEW,
} from "../../src/releases.js";
import { TOOL_SURFACE_TTL_MS } from "../../src/server.js";
import { registerAllTools } from "../../src/tools/index.js";
import { runStdio, type StdioDeps } from "../../src/transport/stdio.js";
import {
  createFakeKy,
  httpErrorReply,
  jsonReply,
  type FakeReply,
  type FakeResponder,
} from "../support/fake-ky.js";
import {
  createRecordingServer,
  createServerContext,
  type RecordingServer,
} from "../support/mcp-server.js";

const UNREACHABLE: FakeReply = {
  kind: "thrown",
  cause: new TypeError("fetch failed"),
};

/**
 * Doubles for the three collaborators, typed off `StdioDeps` itself so each one
 * has to satisfy the real signature it stands in for. `serve` has no
 * implementation because `runStdio` discards its handle. `buildServer` wires
 * the real tool and prompt handlers the way `makeServer` does, so a test sees
 * every API call a request makes.
 */
function stdioDoubles(api: FakeResponder = () => jsonReply({})) {
  const upstream = createFakeKy(api);
  const servers: RecordingServer[] = [];

  const buildClient = vi.fn<NonNullable<StdioDeps["buildClient"]>>(
    () => upstream.ky,
  );

  const buildServer = vi.fn<NonNullable<StdioDeps["buildServer"]>>(
    (makeClient, options = {}) => {
      const server = createRecordingServer();

      const current =
        options.currentReleases ??
        fixedReleases(options.releases ?? PUBLIC_VIEW);

      registerAllTools(server, makeClient, options.analyticsContext, current);
      registerPrompts(server, options.analyticsContext, current);
      servers.push(server);

      return server;
    },
  );

  const serve = vi.fn<NonNullable<StdioDeps["serve"]>>();
  const deps: StdioDeps = { serve, buildServer, buildClient };

  const probes = () =>
    upstream.calls.filter((c) => c.url === "account/mcp-context").length;

  return { deps, serve, buildServer, buildClient, upstream, servers, probes };
}

/** The API's answers in order, one per probe; the last one repeats. */
function answering(...replies: FakeReply[]): FakeResponder {
  let probe = 0;

  return (call) => {
    if (call.url !== "account/mcp-context") {
      return jsonReply({ query: "x", total: 0, results: [] });
    }

    const reply = replies[Math.min(probe, replies.length - 1)]!;
    probe += 1;

    return reply;
  };
}

/** The factory `runStdio` handed to `serveStdio`, called the way the SDK calls it. */
async function buildInstance(
  serve: ReturnType<typeof stdioDoubles>["serve"],
): Promise<void> {
  const factory = serve.mock.calls[0]![0];
  // `serveStdio` hands the factory a request context carrying the era it
  // negotiated; stdio pins one connection, so either era exercises the wiring.
  await factory({ ...createServerContext().mcpReq, era: "modern" });
}

/** What an instance lists: each tool's name and its input properties. */
async function listedTools(
  server: RecordingServer,
): Promise<Map<string, string[]>> {
  const res = await server.handler("tools/list")(
    { method: "tools/list" },
    createServerContext({ method: "tools/list" }),
  );

  return new Map(
    res.tools.map((tool) => [
      tool.name,
      Object.keys(tool.inputSchema.properties ?? {}),
    ]),
  );
}

async function listedPrompts(server: RecordingServer): Promise<string[]> {
  const res = await server.handler("prompts/list")(
    { method: "prompts/list" },
    createServerContext({ method: "prompts/list" }),
  );

  return res.prompts.map((prompt) => prompt.name);
}

describe("runStdio", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    await buildInstance(serve);
    expect(buildServer).toHaveBeenCalledTimes(1);

    // The client factory passed into makeServer must, when invoked, build a
    // client bound to the token captured at startup.
    buildServer.mock.calls[0]![0]();
    expect(buildClient).toHaveBeenCalledWith("lune_stdio_token");
  });

  it("lists what the API released and reuses that answer within the TTL", async () => {
    vi.stubEnv("LUNE_API_KEY", "lune_stdio_token");

    const { deps, serve, servers, probes } = stdioDoubles(
      answering(jsonReply({ workspace: true, figures: true })),
    );

    await runStdio(deps);
    await buildInstance(serve);
    const tools = await listedTools(servers[0]!);

    expect(tools.size).toBe(14);
    expect(tools.get("search_papers")).toContain("source");
    expect(await listedPrompts(servers[0]!)).toContain("design_figure");
    expect(probes()).toBe(1);
  });

  it("asks again once the answer is older than the TTL, so a withdrawn release leaves", async () => {
    vi.stubEnv("LUNE_API_KEY", "lune_stdio_token");
    vi.useFakeTimers({ toFake: ["Date"] });

    const { deps, serve, servers, probes } = stdioDoubles(
      answering(jsonReply({ figures: true }), jsonReply({ figures: false })),
    );

    await runStdio(deps);
    await buildInstance(serve);
    expect((await listedTools(servers[0]!)).size).toBe(14);

    vi.setSystemTime(Date.now() + TOOL_SURFACE_TTL_MS - 1);
    expect((await listedTools(servers[0]!)).size).toBe(14);
    expect(probes()).toBe(1);

    vi.setSystemTime(Date.now() + 1);
    expect((await listedTools(servers[0]!)).size).toBe(12);
    expect(await listedPrompts(servers[0]!)).not.toContain("design_figure");
    expect(probes()).toBe(2);
  });

  it("asks again after a failed first probe, while the instructions keep the first answer", async () => {
    vi.stubEnv("LUNE_API_KEY", "lune_stdio_token");

    const { deps, serve, servers, buildServer, probes } = stdioDoubles(
      answering(UNREACHABLE, jsonReply({ figures: true })),
    );

    await runStdio(deps);
    await buildInstance(serve);

    expect(buildServer.mock.calls[0]![1]?.releases?.listed).toEqual(
      PUBLIC_RELEASES,
    );
    expect((await listedTools(servers[0]!)).size).toBe(14);
    expect(probes()).toBe(2);
  });

  it("takes a 401 as an answer: the public surface, asked once per TTL", async () => {
    vi.stubEnv("LUNE_API_KEY", "lune_stdio_token");

    const { deps, serve, servers, probes } = stdioDoubles(
      answering(httpErrorReply(401)),
    );

    await runStdio(deps);
    await buildInstance(serve);
    const tools = await listedTools(servers[0]!);

    expect(tools.size).toBe(12);
    expect(tools.get("search_papers")).not.toContain("source");
    expect(probes()).toBe(1);
  });

  it("lets a figure call reach the API while the API cannot be asked", async () => {
    vi.stubEnv("LUNE_API_KEY", "lune_stdio_token");

    const { deps, serve, servers, upstream } = stdioDoubles(
      answering(UNREACHABLE),
    );

    await runStdio(deps);
    await buildInstance(serve);

    expect((await listedTools(servers[0]!)).size).toBe(12);

    await servers[0]!.handler("tools/call")(
      {
        method: "tools/call",
        params: {
          name: "search_figure_references",
          arguments: { query: "a three-stage pipeline" },
        },
      },
      createServerContext(),
    );

    expect(upstream.calls.map((c) => `${c.method} ${c.url}`)).toContain(
      "post figures/search",
    );
  });

  it("keeps the last answer for a few minutes while the API cannot be asked", async () => {
    vi.stubEnv("LUNE_API_KEY", "lune_stdio_token");
    vi.useFakeTimers({ toFake: ["Date"] });

    const { deps, serve, servers } = stdioDoubles(
      answering(jsonReply({ figures: true }), UNREACHABLE),
    );

    await runStdio(deps);
    await buildInstance(serve);

    vi.setSystemTime(Date.now() + 4 * 60_000);
    expect((await listedTools(servers[0]!)).size).toBe(14);

    vi.setSystemTime(Date.now() + 60_000);
    expect((await listedTools(servers[0]!)).size).toBe(12);
  });

  it("asks once for instances the SDK builds together", async () => {
    vi.stubEnv("LUNE_API_KEY", "lune_stdio_token");

    const { deps, serve, servers, probes } = stdioDoubles(
      answering(jsonReply({ figures: true })),
    );

    await runStdio(deps);
    // A modern client's `server/discover` builds a probe instance that is
    // discarded when the client falls back to `initialize`.
    await Promise.all([buildInstance(serve), buildInstance(serve)]);

    expect(servers).toHaveLength(2);
    expect(probes()).toBe(1);
  });

  it("throws when LUNE_API_KEY is missing before anything is served", async () => {
    vi.stubEnv("LUNE_API_KEY", "");
    const { deps, serve } = stdioDoubles();
    await expect(runStdio(deps)).rejects.toThrow(/LUNE_API_KEY/);
    expect(serve).not.toHaveBeenCalled();
  });
});
