import { parseArgs } from "node:util";

import { runStdio } from "./transport/stdio.js";
import { startHttpServer } from "./transport/streamableHttp.js";

interface ParsedArgs {
  http: boolean;
  port: number;
  help: boolean;
}

function parseCliArgs(argv: readonly string[]): ParsedArgs {
  // `strict: false` ignores unrecognised flags instead of throwing (matching
  // the prior hand-rolled loop). A valueless `--port` lands as boolean `true`.
  const { values } = parseArgs({
    args: argv.slice(2),
    strict: false,
    options: {
      http: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
    },
  });

  let port = Number(process.env.PORT ?? "8080");
  if (values.port !== undefined) {
    if (typeof values.port !== "string")
      throw new Error("--port requires an argument");
    port = parseInt(values.port, 10);
    if (Number.isNaN(port)) throw new Error(`invalid --port: ${values.port}`);
  }

  return { http: values.http === true, port, help: values.help === true };
}

function printHelp(): void {
  process.stdout.write(
    `lune-mcp: Lune Research MCP server\n\n` +
      `Usage:\n` +
      `  lune-mcp                 Run on stdio (reads LUNE_API_KEY env var)\n` +
      `  lune-mcp --http          Run Streamable HTTP server\n` +
      `  lune-mcp --http --port N Bind HTTP to port N (default 8080)\n\n` +
      `Get a token at https://luneresearch.com/dashboard/settings/credentials\n`,
  );
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.http) {
    startHttpServer(parsed.port);
    return;
  }
  await runStdio();
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`lune-mcp: ${msg}\n`);
  process.exit(1);
});
