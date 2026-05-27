/**
 * Unit coverage for the Redis-backed cache path (`RedisCache` + the
 * `pickCache` selection branch).
 *
 * The `redis` module is mocked with a controllable fake client so we can
 * drive get/set/del/scan, connection failures, and protocol-level errors
 * without a real Redis. `RedisCache` is contractually a "degrade to misses,
 * never throw" wrapper, so every error branch must return cleanly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ── Controllable fake redis client ─────────────────────────────────────── */

interface FakeClient {
  url?: string;
  reconnectStrategy?: (retries: number) => number | Error;
  handlers: Record<string, (arg: unknown) => void>;
  store: Map<string, string>;
  connectImpl: () => Promise<void>;
  failOps: boolean;
  on: (event: string, cb: (arg: unknown) => void) => FakeClient;
  connect: () => Promise<void>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, val: string, opts: unknown) => Promise<void>;
  del: (keys: string | string[]) => Promise<void>;
  scanIterator: (opts: unknown) => AsyncGenerator<string | string[]>;
  scanYields: Array<string | string[]>;
}

let fake: FakeClient;

function makeFakeClient(): FakeClient {
  const c: FakeClient = {
    handlers: {},
    store: new Map(),
    connectImpl: async () => {},
    failOps: false,
    scanYields: [],
    on(event, cb) {
      c.handlers[event] = cb;
      return c;
    },
    async connect() {
      return c.connectImpl();
    },
    async get(key) {
      if (c.failOps) throw new Error("GET protocol error");
      return c.store.has(key) ? c.store.get(key)! : null;
    },
    async set(key, val) {
      if (c.failOps) throw new Error("SET protocol error");
      c.store.set(key, val);
    },
    async del(keys) {
      if (c.failOps) throw new Error("DEL protocol error");
      for (const k of Array.isArray(keys) ? keys : [keys]) c.store.delete(k);
    },
    async *scanIterator() {
      if (c.failOps) throw new Error("SCAN protocol error");
      for (const y of c.scanYields) yield y;
    },
  };
  return c;
}

vi.mock("redis", () => ({
  createClient: (opts: {
    url: string;
    socket: { reconnectStrategy: (n: number) => number | Error };
  }) => {
    fake.url = opts.url;
    fake.reconnectStrategy = opts.socket.reconnectStrategy;
    return fake;
  },
}));

beforeEach(() => {
  fake = makeFakeClient();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("RedisCache", () => {
  it("namespaces keys and round-trips get/set", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    await cache.set("paper:1", { title: "Foo" });
    // Stored under the lune:<ns-prefix>:<namespace>:<key> form.
    const storedKey = [...fake.store.keys()][0]!;
    expect(storedKey).toContain(":mcp_tools:paper:1");
    expect(await cache.get("paper:1")).toEqual({ title: "Foo" });
  });

  it("returns undefined for an unknown key", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("connects exactly once across concurrent calls", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    let connects = 0;
    fake.connectImpl = async () => {
      connects++;
    };
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    await Promise.all([cache.get("a"), cache.get("b"), cache.set("c", 1)]);
    expect(connects).toBe(1);
  });

  it("the registered error handler swallows connection blips", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    expect(fake.handlers.error).toBeTypeOf("function");
    // Must not throw.
    expect(() => fake.handlers.error!(new Error("ECONNRESET"))).not.toThrow();
  });

  it("the reconnect strategy caps individual waits at ~3s", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    const strat = fake.reconnectStrategy!;
    expect(strat(0)).toBe(50);
    expect(strat(10)).toBe(550);
    expect(strat(1000)).toBe(3000);
  });

  it("degrades to a miss when the initial connect fails", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    fake.connectImpl = async () => {
      throw new Error("connection refused");
    };
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    expect(await cache.get("k")).toBeUndefined();
    // set / invalidate / clear also no-op cleanly when disconnected.
    await expect(cache.set("k", 1)).resolves.toBeUndefined();
    await expect(cache.invalidate("k")).resolves.toBeUndefined();
    await expect(cache.clear()).resolves.toBeUndefined();
  });

  it("degrades to a miss on a GET protocol error", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    fake.failOps = true;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("drops the write on a SET protocol error without throwing", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    fake.failOps = true;
    await expect(cache.set("k", { a: 1 })).resolves.toBeUndefined();
  });

  it("clamps a sub-second TTL to a 1s floor", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const setSpy = vi.spyOn(fake, "set");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    await cache.set("k", "v", 10);
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      EX: 1,
    });
  });

  it("uses the default TTL when no per-call TTL is given", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const setSpy = vi.spyOn(fake, "set");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 120_000);
    await cache.set("k", "v");
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      EX: 120,
    });
  });

  it("invalidate deletes the namespaced key", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    await cache.set("k", "v");
    expect(fake.store.size).toBe(1);
    await cache.invalidate("k");
    expect(fake.store.size).toBe(0);
  });

  it("invalidate swallows a DEL protocol error", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    fake.failOps = true;
    await expect(cache.invalidate("k")).resolves.toBeUndefined();
  });

  it("clear scans and deletes keys in batches (string yields)", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    const delSpy = vi.spyOn(fake, "del");
    fake.scanYields = ["lune:v1:mcp_tools:a", "lune:v1:mcp_tools:b"];
    await cache.clear();
    expect(delSpy).toHaveBeenCalledTimes(2);
  });

  it("clear handles array-shaped scan yields", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    const delSpy = vi.spyOn(fake, "del");
    fake.scanYields = [["k1", "k2"], []];
    await cache.clear();
    // Non-empty array → one del; empty array → skipped.
    expect(delSpy).toHaveBeenCalledTimes(1);
    expect(delSpy).toHaveBeenCalledWith(["k1", "k2"]);
  });

  it("clear swallows a SCAN protocol error", async () => {
    const { RedisCache } = await import("../../src/cache.js");
    const cache = new RedisCache("redis://localhost:6379", "mcp_tools", 60_000);
    fake.failOps = true;
    await expect(cache.clear()).resolves.toBeUndefined();
  });
});

describe("pickCache selection", () => {
  it("selects the Redis backend when REDIS_URL is set", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    const mod = await import("../../src/cache.js");
    expect(mod.TOOL_RESPONSE_CACHE).toBeInstanceOf(mod.RedisCache);
  });

  it("selects the in-process backend when REDIS_URL is absent", async () => {
    vi.stubEnv("REDIS_URL", "");
    const mod = await import("../../src/cache.js");
    expect(mod.TOOL_RESPONSE_CACHE).toBeInstanceOf(mod.InProcessTTLCache);
  });
});
