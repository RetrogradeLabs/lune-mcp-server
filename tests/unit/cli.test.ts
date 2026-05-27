/**
 * Unit coverage for the CLI entrypoint (`src/cli.ts`).
 *
 * `cli.ts` runs `main()` at module-evaluation time, so each test stubs
 * `process.argv`, mocks both transport modules, resets the module registry,
 * and dynamically imports the file. A microtask flush lets the top-level
 * `main().catch(...)` settle before assertions run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runStdio = vi.fn<() => Promise<void>>();
const startHttpServer = vi.fn<(port: number) => void>();

vi.mock("../../src/transport/stdio.js", () => ({
  runStdio: () => runStdio(),
}));
vi.mock("../../src/transport/streamableHttp.js", () => ({
  startHttpServer: (port: number) => startHttpServer(port),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

async function loadCliWith(argv: string[]): Promise<void> {
  // `undefined` deletes PORT so `parseArgs` exercises its literal "8080"
  // default; an empty string would coerce to `Number("") === 0`.
  vi.stubEnv("PORT", undefined);
  process.argv = ["node", "/abs/cli.js", ...argv];
  vi.resetModules();
  await import("../../src/cli.js");
  await flush();
}

describe("cli entrypoint", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalArgv = process.argv;

  beforeEach(() => {
    runStdio.mockReset();
    startHttpServer.mockReset();
    runStdio.mockResolvedValue(undefined);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllEnvs();
    process.argv = originalArgv;
  });

  it("runs the stdio transport with no flags", async () => {
    await loadCliWith([]);
    expect(runStdio).toHaveBeenCalledTimes(1);
    expect(startHttpServer).not.toHaveBeenCalled();
  });

  it("starts the HTTP server with --http and the default port", async () => {
    await loadCliWith(["--http"]);
    expect(startHttpServer).toHaveBeenCalledTimes(1);
    expect(startHttpServer).toHaveBeenCalledWith(8080);
    expect(runStdio).not.toHaveBeenCalled();
  });

  it("starts the HTTP server with --http --port N", async () => {
    await loadCliWith(["--http", "--port", "9999"]);
    expect(startHttpServer).toHaveBeenCalledWith(9999);
  });

  it("reads PORT from the environment as the default", async () => {
    vi.stubEnv("PORT", "7000");
    process.argv = ["node", "/abs/cli.js", "--http"];
    vi.resetModules();
    await import("../../src/cli.js");
    await flush();
    expect(startHttpServer).toHaveBeenCalledWith(7000);
  });

  it("prints help with --help and does not start a transport", async () => {
    await loadCliWith(["--help"]);
    expect(stdoutSpy).toHaveBeenCalled();
    const printed = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(printed).toContain("lune-mcp");
    expect(printed).toContain("Usage:");
    expect(runStdio).not.toHaveBeenCalled();
    expect(startHttpServer).not.toHaveBeenCalled();
  });

  it("prints help with the -h alias", async () => {
    await loadCliWith(["-h"]);
    expect(stdoutSpy).toHaveBeenCalled();
    expect(runStdio).not.toHaveBeenCalled();
  });

  it("ignores unrecognised flags", async () => {
    await loadCliWith(["--frobnicate"]);
    expect(runStdio).toHaveBeenCalledTimes(1);
  });

  it("errors and exits 1 when --port has no argument", async () => {
    await loadCliWith(["--port"]);
    expect(stderrSpy).toHaveBeenCalled();
    const printed = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(printed).toContain("--port requires an argument");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("errors and exits 1 when --port is not a number", async () => {
    await loadCliWith(["--port", "abc"]);
    const printed = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(printed).toContain("invalid --port: abc");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("errors and exits 1 when the stdio transport throws an Error", async () => {
    runStdio.mockRejectedValue(new Error("transport down"));
    await loadCliWith([]);
    const printed = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(printed).toContain("lune-mcp: transport down");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("stringifies non-Error rejections in the failure handler", async () => {
    runStdio.mockRejectedValue("plain string failure");
    await loadCliWith([]);
    const printed = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(printed).toContain("lune-mcp: plain string failure");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
