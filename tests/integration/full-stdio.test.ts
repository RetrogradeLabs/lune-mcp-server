import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "../..");
const CLI_PATH = resolve(PKG_ROOT, "dist/cli.js");

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
  error?: { code: number; message: string };
}

describe("stdio E2E", () => {
  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      // Build once. tsup is fast (~10ms) so this is cheap.
      const r = spawnSync("pnpm", ["build"], { cwd: PKG_ROOT, stdio: "pipe" });
      if (r.status !== 0) {
        throw new Error(
          `build failed: ${r.stderr?.toString() ?? "(no stderr)"} ${r.stdout?.toString() ?? ""}`,
        );
      }
    }
  }, 30_000);

  it("returns 13 tools via tools/list", async () => {
    const proc = spawn("node", [CLI_PATH], {
      env: { ...process.env, LUNE_API_KEY: "lune_fake_token_for_init_only" },
      cwd: PKG_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    proc.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString()));

    // MCP framing: send initialize first, then tools/list. The SDK requires
    // a successful initialize before responding to tool requests.
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }) + "\n",
    );

    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }) + "\n",
    );

    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }) + "\n",
    );

    // Wait for output to accumulate.
    const deadline = Date.now() + 3000;
    let toolsResponse: JsonRpcResponse | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const all = stdoutChunks.join("");
      const lines = all.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (msg.id === 2 && msg.result) {
            toolsResponse = msg;
            break;
          }
        } catch {
          // Partial JSON line; skip and wait.
        }
      }
      if (toolsResponse) break;
    }

    proc.kill();
    await new Promise((r) => proc.once("exit", r));

    expect(toolsResponse).not.toBeNull();
    const tools = toolsResponse?.result?.tools ?? [];
    const names = tools.map((t) => t.name).sort();

    expect(names).toHaveLength(12);
    expect(names).toEqual(
      [
        "check_for_conference_updates",
        "subscribe_to_conference_updates",
        "unsubscribe_from_conference_updates",
        "get_conference_papers",
        "get_paper",
        "get_paper_citations",
        "get_paper_fulltext",
        "get_research_guidance_doc",
        "list_conference_update_subscriptions",
        "list_conferences",
        "search_papers",
        "search_research_guidance",
      ].sort(),
    );

    // Sanity-check that every tool has a non-empty description and an inputSchema.
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.inputSchema).toBeTypeOf("object");
    }
  }, 15_000);
});
