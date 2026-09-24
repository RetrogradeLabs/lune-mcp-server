import { parseArgs } from "node:util";

import { initAnalytics, setTransportMode } from "./analytics.js";
import { messageOf } from "./cause.js";
import { assertHostedConfiguration, runtimeSiteUrl } from "./runtime-config.js";
import { runStdio } from "./transport/stdio.js";
import { startHttpServer } from "./transport/streamableHttp.js";

interface ParsedArgs {
  http: boolean;
  port: number;
  help: boolean;
}

type CliOptionValue = string | boolean | (string | boolean)[] | undefined;

function carriesValue(value: CliOptionValue): value is string {
  return typeof value === "string";
}

export interface CliPorts {
  runStdio(): Promise<void>;
  assertHostedConfiguration(): void;
  startHttpServer(port: number): void;
  initAnalytics(): void;
  setTransportMode(mode: "http"): void;
  readPort(): string | undefined;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  exit(code: number): never;
}

export const nodeCliPorts: CliPorts = {
  runStdio,
  assertHostedConfiguration,
  startHttpServer,
  initAnalytics,
  setTransportMode,
  readPort: () => process.env.PORT,
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
  exit: (code) => process.exit(code),
};

function parseCliArgs(
  argv: readonly string[],
  configuredPort: string | undefined,
): ParsedArgs {
  const { values } = parseArgs({
    args: argv.slice(2),
    strict: false,
    options: {
      http: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
    },
  });

  let port = Number(configuredPort ?? "8080");

  if (values.port !== undefined) {
    if (!carriesValue(values.port)) {
      throw new Error("--port requires an argument");
    }

    port = Number.parseInt(values.port, 10);

    if (Number.isNaN(port)) throw new Error(`invalid --port: ${values.port}`);
  }

  return { http: values.http === true, port, help: values.help === true };
}

function helpText(): string {
  return (
    `lune-mcp: Lune Research MCP server\n\n` +
    `Usage:\n` +
    `  lune-mcp                 Run on stdio (reads LUNE_API_KEY env var)\n` +
    `  lune-mcp --http          Run Streamable HTTP server\n` +
    `  lune-mcp --http --port N Bind HTTP to port N (default 8080)\n\n` +
    `Get a token at ${runtimeSiteUrl("/dashboard/settings/credentials")}\n`
  );
}

async function executeCli(
  argv: readonly string[],
  ports: CliPorts,
): Promise<void> {
  const parsed = parseCliArgs(argv, ports.readPort());

  if (parsed.help) {
    ports.writeStdout(helpText());

    return;
  }

  if (parsed.http) {
    ports.assertHostedConfiguration();
    ports.setTransportMode("http");
    ports.initAnalytics();
    ports.startHttpServer(parsed.port);

    return;
  }

  await ports.runStdio();
}

export async function runCli(
  argv: readonly string[],
  ports: CliPorts = nodeCliPorts,
): Promise<void> {
  try {
    await executeCli(argv, ports);
  } catch (cause) {
    ports.writeStderr(`lune-mcp: ${messageOf(cause)}\n`);
    ports.exit(1);
  }
}
