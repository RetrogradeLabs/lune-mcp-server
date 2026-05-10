import { runStdio } from "./transport/stdio.js";
import { startHttpServer } from "./transport/streamableHttp.js";

interface ParsedArgs {
  http: boolean;
  port: number;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  let http = false;
  let port = Number(process.env.PORT ?? "8080");
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--http") http = true;
    else if (a === "--port") {
      const v = args[++i];
      if (!v) throw new Error("--port requires an argument");
      port = parseInt(v, 10);
      if (Number.isNaN(port)) throw new Error(`invalid --port: ${v}`);
    } else if (a === "--help" || a === "-h") {
      help = true;
    }
  }
  return { http, port, help };
}

function printHelp(): void {
  process.stdout.write(
    `lune-mcp: Lune Research MCP server\n\n` +
      `Usage:\n` +
      `  lune-mcp                 Run on stdio (reads LUNE_API_KEY env var)\n` +
      `  lune-mcp --http          Run Streamable HTTP server\n` +
      `  lune-mcp --http --port N Bind HTTP to port N (default 8080)\n\n` +
      `Get a token at https://luneresearch.com/dashboard/credentials\n`,
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
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
