import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { JsonObject, JsonValue } from "../../src/json.js";
import {
  jsonNumber,
  jsonObject,
  jsonObjects,
  jsonString,
  jsonStrings,
  parseJsonObject,
} from "../support/json.js";

const __filename = fileURLToPath(import.meta.url);

const __dirname = dirname(__filename);

const PKG_ROOT = resolve(__dirname, "../..");

const CLI_PATH = resolve(PKG_ROOT, "dist/cli.js");

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    supportedVersions?: string[];
    protocolVersion?: string;
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: JsonObject;
      _meta?: JsonObject;
    }>;
  };
}

function decodeResponse(raw: string): JsonRpcResponse {
  const body = parseJsonObject(raw, "JSON-RPC response");
  const id = jsonNumber(body.id, "response id");
  const response: JsonRpcResponse = { jsonrpc: "2.0", id };

  if (body.result === undefined) return response;
  const resultBody = jsonObject(body.result, "response result");
  const result: NonNullable<JsonRpcResponse["result"]> = {};

  if (resultBody.supportedVersions !== undefined) {
    result.supportedVersions = jsonStrings(
      resultBody.supportedVersions,
      "supported versions",
    );
  }

  if (resultBody.protocolVersion !== undefined) {
    result.protocolVersion = jsonString(
      resultBody.protocolVersion,
      "protocol version",
    );
  }

  if (resultBody.tools !== undefined) {
    result.tools = jsonObjects(resultBody.tools, "tools").map(decodeTool);
  }

  response.result = result;

  return response;
}

function decodeTool(
  body: JsonObject,
): NonNullable<NonNullable<JsonRpcResponse["result"]>["tools"]>[number] {
  const tool = { name: jsonString(body.name, "tool name") };

  const decoded: NonNullable<
    NonNullable<JsonRpcResponse["result"]>["tools"]
  >[number] = tool;

  if (body.description !== undefined) {
    decoded.description = jsonString(body.description, "tool description");
  }

  if (body.inputSchema !== undefined) {
    decoded.inputSchema = jsonObject(body.inputSchema, "tool input schema");
  }

  if (body._meta !== undefined) {
    decoded._meta = jsonObject(body._meta, "tool metadata");
  }

  return decoded;
}

// The API below is a dead port, so the release probe fails and the credential
// gets the public catalog, exactly as it would when the API is unreachable.
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

// Every setting only the hosted server must inject. The API target stays set, to
// the dead port above, so no case ever leaves the machine.
const HOSTED_ONLY_SETTINGS = [
  "LUNE_AUTH_SERVER_URL",
  "LUNE_SITE_ORIGIN",
  "MCP_PUBLIC_URL",
  "MCP_DOCS_URL",
  "MCP_ALLOWED_ORIGINS",
  "OPENAI_APPS_CHALLENGE_TOKEN",
];

/**
 * Drive the published binary over real stdio: write every message, then wait for
 * the response ids the caller asked for. `serveStdio` pins the connection to
 * whichever era its opening message used, so each case gets its own process.
 */
async function driveStdio(
  messages: readonly JsonValue[],
  awaitIds: number[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Map<number, JsonRpcResponse>> {
  const proc = spawn("node", [CLI_PATH], {
    env: {
      ...process.env,
      LUNE_API_KEY: "lune_fake_token_for_init_only",
      LUNE_API_BASE_URL: "http://127.0.0.1:9",
      ...extraEnv,
    },
    cwd: PKG_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const chunks: string[] = [];
  proc.stdout.on("data", (c: Buffer) => chunks.push(c.toString()));

  for (const message of messages) {
    proc.stdin.write(JSON.stringify(message) + "\n");
  }

  const seen = new Map<number, JsonRpcResponse>();
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline && seen.size < awaitIds.length) {
    await new Promise((r) => setTimeout(r, 100));

    for (const line of chunks.join("").trim().split("\n").filter(Boolean)) {
      try {
        const msg = decodeResponse(line);

        if (awaitIds.includes(msg.id)) {
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
    // ALWAYS rebuild: a stale dist/cli.js once let this E2E pass against a
    // 17-tool binary while source had already moved to 16.
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
  }, 30_000);

  it("serves a 2026-07-28 client through server/discover", async () => {
    // The modern opening replaces `initialize` outright, so the published
    // binary must negotiate it and alwaysLoad must survive this encode seam.
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
  }, 30_000);

  it("serves stdio under NODE_ENV=production with no hosted configuration", async () => {
    // A shell that exports NODE_ENV=production for its own apps once made
    // `npx` die at startup on the hosted server's configuration check.
    const unset = Object.fromEntries(
      HOSTED_ONLY_SETTINGS.map((name) => [name, undefined]),
    );

    const seen = await driveStdio(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ],
      [2],
      { ...unset, NODE_ENV: "production" },
    );

    const tools = seen.get(2)?.result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  }, 30_000);
});
