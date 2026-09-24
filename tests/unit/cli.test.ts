import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliPorts } from "../../src/cli-runner.js";
import { assertHostedConfiguration } from "../../src/runtime-config.js";

class CliExit extends Error {}

const runStdio = vi.fn<() => Promise<void>>();

const assertHosted = vi.fn<() => void>();

const startHttpServer = vi.fn<(port: number) => void>();

const initAnalytics = vi.fn<() => void>();

const setTransportMode = vi.fn<(mode: "http") => void>();

let configuredPort: string | undefined;

let stdout: string[];

let stderr: string[];

const ports: CliPorts = {
  runStdio,
  assertHostedConfiguration: assertHosted,
  startHttpServer,
  initAnalytics,
  setTransportMode,
  readPort: () => configuredPort,
  writeStdout: (text) => stdout.push(text),
  writeStderr: (text) => stderr.push(text),
  exit: (code): never => {
    throw new CliExit(`exit ${code}`);
  },
};

async function run(args: readonly string[]): Promise<void> {
  await runCli(["node", "/abs/cli.js", ...args], ports);
}

beforeEach(() => {
  configuredPort = undefined;
  stdout = [];
  stderr = [];
  runStdio.mockReset();
  runStdio.mockResolvedValue(undefined);
  startHttpServer.mockReset();
  initAnalytics.mockReset();
  setTransportMode.mockReset();
});

describe("CLI runner", () => {
  it("runs the stdio transport with no flags", async () => {
    await run([]);
    expect(runStdio).toHaveBeenCalledOnce();
    expect(startHttpServer).not.toHaveBeenCalled();
  });

  it("starts HTTP on the default port and initializes analytics", async () => {
    await run(["--http"]);
    expect(setTransportMode).toHaveBeenCalledWith("http");
    expect(initAnalytics).toHaveBeenCalledOnce();
    expect(startHttpServer).toHaveBeenCalledWith(8080);
    expect(runStdio).not.toHaveBeenCalled();
  });

  it("uses an explicit HTTP port", async () => {
    await run(["--http", "--port", "9999"]);
    expect(startHttpServer).toHaveBeenCalledWith(9999);
  });

  it("uses PORT as the HTTP default", async () => {
    configuredPort = "7000";
    await run(["--http"]);
    expect(startHttpServer).toHaveBeenCalledWith(7000);
  });

  it.each([["--help"], ["-h"]])("prints help for %s", async (flag) => {
    await run([flag]);
    expect(stdout.join("")).toContain("lune-mcp");
    expect(stdout.join("")).toContain("Usage:");
    expect(runStdio).not.toHaveBeenCalled();
    expect(startHttpServer).not.toHaveBeenCalled();
  });

  it("ignores unrecognized flags", async () => {
    await run(["--frobnicate"]);
    expect(runStdio).toHaveBeenCalledOnce();
  });

  it("reports a missing port argument and exits one", async () => {
    await expect(run(["--port"])).rejects.toThrow("exit 1");
    expect(stderr.join("")).toContain("--port requires an argument");
  });

  it("reports a non-numeric port and exits one", async () => {
    await expect(run(["--port", "abc"])).rejects.toThrow("exit 1");
    expect(stderr.join("")).toContain("invalid --port: abc");
  });

  it("reports transport errors and exits one", async () => {
    runStdio.mockRejectedValue(new Error("transport down"));
    await expect(run([])).rejects.toThrow("exit 1");
    expect(stderr.join("")).toContain("lune-mcp: transport down");
  });

  it("reports non-Error transport rejections", async () => {
    runStdio.mockRejectedValue("plain string failure");
    await expect(run([])).rejects.toThrow("exit 1");
    expect(stderr.join("")).toContain("lune-mcp: plain string failure");
  });
});

describe("hosted configuration", () => {
  const HOSTED_SETTINGS = {
    LUNE_API_BASE_URL: "https://api.example.test",
    LUNE_AUTH_SERVER_URL: "https://api.example.test",
    LUNE_SITE_ORIGIN: "https://example.test",
    MCP_PUBLIC_URL: "https://mcp.example.test",
    MCP_DOCS_URL: "https://example.test/docs/mcp",
    MCP_ALLOWED_ORIGINS: '["https://example.test"]',
    OPENAI_APPS_CHALLENGE_TOKEN: "challenge",
  };

  function stubHostedSettings(except?: keyof typeof HOSTED_SETTINGS): void {
    for (const [name, value] of Object.entries(HOSTED_SETTINGS)) {
      vi.stubEnv(name, name === except ? undefined : value);
    }
  }

  const realPorts: CliPorts = {
    ...ports,
    assertHostedConfiguration,
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to serve hosted production on a fallback and names the missing setting", async () => {
    vi.stubEnv("NODE_ENV", "production");
    stubHostedSettings("LUNE_SITE_ORIGIN");

    await expect(
      runCli(["node", "/abs/cli.js", "--http"], realPorts),
    ).rejects.toThrow("exit 1");
    expect(stderr.join("")).toContain(
      "Missing required production configuration: LUNE_SITE_ORIGIN",
    );
    expect(startHttpServer).not.toHaveBeenCalled();
  });

  it("serves hosted production once every setting is injected", async () => {
    vi.stubEnv("NODE_ENV", "production");
    stubHostedSettings();

    await runCli(["node", "/abs/cli.js", "--http"], realPorts);
    expect(startHttpServer).toHaveBeenCalledWith(8080);
  });

  it("runs stdio under NODE_ENV=production with none of the hosted settings", async () => {
    // The published package is launched by shells that export NODE_ENV for
    // their own apps; stdio must run on its bundled defaults regardless.
    vi.stubEnv("NODE_ENV", "production");

    for (const name of Object.keys(HOSTED_SETTINGS))
      vi.stubEnv(name, undefined);

    await runCli(["node", "/abs/cli.js"], realPorts);
    expect(runStdio).toHaveBeenCalledOnce();
    expect(stderr).toEqual([]);
  });
});
