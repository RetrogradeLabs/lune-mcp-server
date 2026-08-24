import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "../..");
const CLI_PATH = resolve(PKG_ROOT, "dist/cli.js");

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: {
    supportedVersions?: string[];
    protocolVersion?: string;
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      _meta?: Record<string, unknown>;
    }>;
  };
  error?: { code: number; message: string };
}

const EXPECTED_TOOLS = [
  "get_conference_papers",
  "get_paper_citations",
  "get_paper_fulltext",
  "get_research_guidance_doc",
  "list_conferences",
  "search_papers",
  "search_papers_many",
  "extract_from_papers",
  "verify_claims",
  "gather_evidence",
  "search_related_papers",
  "search_research_guidance",
].sort();

/**
 * Drive the published binary over real stdio: write every message, then wait for
 * the response ids the caller asked for. `serveStdio` pins the connection to
 * whichever era its opening message used, so each case gets its own process.
 */
async function driveStdio(
  messages: unknown[],
  awaitIds: number[],
): Promise<Map<number, JsonRpcResponse>> {
  const proc = spawn("node", [CLI_PATH], {
    env: { ...process.env, LUNE_API_KEY: "lune_fake_token_for_init_only" },
    cwd: PKG_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  proc.stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
  for (const message of messages) {
    proc.stdin.write(JSON.stringify(message) + "\n");
  }

  const seen = new Map<number, JsonRpcResponse>();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && seen.size < awaitIds.length) {
    await new Promise((r) => setTimeout(r, 100));
    for (const line of chunks.join("").trim().split("\n").filter(Boolean)) {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === "number" && awaitIds.includes(msg.id)) {
          seen.set(msg.id, msg);
        }
      } catch {
        // Partial JSON line; skip and wait for the rest of the chunk.
      }
    }
  }

  proc.kill();
  await new Promise((r) => proc.once("exit", r));
  return seen;
}

describe("stdio E2E", () => {
  beforeAll(() => {
    // ALWAYS rebuild. A dist/cli.js left over from before a tool-catalog change
    // would make this E2E silently exercise the STALE binary (it did: an old
    // 17-tool dist passed while source had moved to 16). tsup is fast, so the
    // cost is negligible and the test always reflects current source.
    const r = spawnSync("bun", ["run", "build"], {
      cwd: PKG_ROOT,
      stdio: "pipe",
    });
    if (r.status !== 0) {
      throw new Error(
        `build failed: ${r.stderr?.toString() ?? "(no stderr)"} ${r.stdout?.toString() ?? ""}`,
      );
    }
  }, 30_000);

  it("serves a 2025-era client through the initialize handshake", async () => {
    const seen = await driveStdio(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ],
      [2],
    );

    const tools = seen.get(2)?.result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);

    // Sanity-check that every tool has a non-empty description and an inputSchema.
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.inputSchema).toBeTypeOf("object");
    }
  }, 20_000);

  it("serves a 2026-07-28 client through server/discover", async () => {
    // The modern opening replaces `initialize` outright: the published binary
    // has to negotiate it, and the entry tools' alwaysLoad hint has to survive
    // this era's encode seam too (see tool-meta-roundtrip.test.ts for the HTTP
    // half of that contract).
    const envelope = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "0.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const seen = await driveStdio(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: envelope },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: { _meta: envelope },
        },
      ],
      [1, 2],
    );

    expect(seen.get(1)?.result?.supportedVersions).toContain("2026-07-28");
    const tools = seen.get(2)?.result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(tools.find((t) => t.name === "search_papers")?._meta).toMatchObject({
      "anthropic/alwaysLoad": true,
    });
  }, 20_000);
});
