import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createToolResponseCache,
  InProcessTTLCache,
  RedisCache,
  type RedisCacheClient,
  type RedisClientFactory,
  type RedisClientOptions,
} from "../../src/cache.js";

type RedisErrorHandler = (cause: Error) => void;

class FakeRedisClient implements RedisCacheClient {
  readonly handlers: Partial<Record<"error", RedisErrorHandler>> = {};
  readonly store = new Map<string, string>();
  connectImpl: () => Promise<void> = async () => undefined;
  failOps = false;
  scanYields: Array<string | string[]> = [];
  options?: RedisClientOptions;

  on(event: "error", listener: RedisErrorHandler): RedisCacheClient {
    this.handlers[event] = listener;

    return this;
  }

  async connect(): Promise<RedisCacheClient> {
    await this.connectImpl();

    return this;
  }

  async get(key: string): Promise<string | null> {
    if (this.failOps) throw new Error("GET protocol error");

    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _options: { EX: number },
  ): Promise<string | null> {
    if (this.failOps) throw new Error("SET protocol error");
    this.store.set(key, value);

    return "OK";
  }

  async del(keys: string | string[]): Promise<number> {
    if (this.failOps) throw new Error("DEL protocol error");
    let deleted = 0;

    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.store.delete(key)) deleted++;
    }

    return deleted;
  }

  async *scanIterator(_options: {
    MATCH: string;
    COUNT: number;
  }): AsyncGenerator<string | string[]> {
    if (this.failOps) throw new Error("SCAN protocol error");

    for (const value of this.scanYields) yield value;
  }
}

let fake: FakeRedisClient;

let createRedisClient: RedisClientFactory;

function cache(defaultTtlMs = 60_000): RedisCache {
  return new RedisCache(
    "redis://localhost:6379",
    "mcp_tools",
    defaultTtlMs,
    createRedisClient,
  );
}

function onlyStoredKey(): string {
  const key = fake.store.keys().next().value;

  if (key === undefined) throw new Error("expected one stored Redis key");

  return key;
}

function redisErrorHandler(): RedisErrorHandler {
  const handler = fake.handlers.error;

  if (!handler) throw new Error("expected a Redis error handler");

  return handler;
}

function reconnectStrategy(): (retries: number) => number | Error {
  const strategy = fake.options?.socket.reconnectStrategy;

  if (!strategy) throw new Error("expected a reconnect strategy");

  return strategy;
}

beforeEach(() => {
  fake = new FakeRedisClient();
  createRedisClient = (options) => {
    fake.options = options;

    return fake;
  };

  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RedisCache", () => {
  it("namespaces keys and round-trips get/set", async () => {
    const redisCache = cache();
    await redisCache.set("paper:1", { title: "Foo" });
    expect(onlyStoredKey()).toContain(":mcp_tools:paper:1");
    expect(await redisCache.get("paper:1")).toEqual({ title: "Foo" });
  });

  it("returns undefined for an unknown key", async () => {
    expect(await cache().get("missing")).toBeUndefined();
  });

  it("connects exactly once across concurrent calls", async () => {
    let connects = 0;
    fake.connectImpl = async () => {
      connects++;
    };

    const redisCache = cache();
    await Promise.all([
      redisCache.get("a"),
      redisCache.get("b"),
      redisCache.set("c", 1),
    ]);
    expect(connects).toBe(1);
  });

  it("swallows connection-error events", () => {
    cache();
    expect(() => redisErrorHandler()(new Error("ECONNRESET"))).not.toThrow();
  });

  it("caps individual reconnect waits at three seconds", () => {
    cache();
    const strategy = reconnectStrategy();
    expect(strategy(0)).toBe(50);
    expect(strategy(10)).toBe(550);
    expect(strategy(1000)).toBe(3000);
  });

  it("degrades to misses and no-ops when the initial connect fails", async () => {
    fake.connectImpl = async () => {
      throw new Error("connection refused");
    };

    const redisCache = cache();
    expect(await redisCache.get("k")).toBeUndefined();
    await expect(redisCache.set("k", 1)).resolves.toBeUndefined();
    await expect(redisCache.clear()).resolves.toBeUndefined();
  });

  it("degrades to a miss on a GET protocol error", async () => {
    const redisCache = cache();
    fake.failOps = true;
    expect(await redisCache.get("k")).toBeUndefined();
  });

  it("drops a SET protocol error", async () => {
    const redisCache = cache();
    fake.failOps = true;
    await expect(redisCache.set("k", { a: 1 })).resolves.toBeUndefined();
  });

  it("clamps a sub-second TTL to one second", async () => {
    const setSpy = vi.spyOn(fake, "set");
    await cache().set("k", "v", 10);
    expect(setSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { EX: 1 },
    );
  });

  it("uses the default TTL when no per-call TTL is given", async () => {
    const setSpy = vi.spyOn(fake, "set");
    await cache(120_000).set("k", "v");
    expect(setSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { EX: 120 },
    );
  });

  it("clears namespaced keys", async () => {
    const redisCache = cache();
    await redisCache.set("a", { v: 1 });
    await redisCache.set("b", { v: 2 });
    fake.scanYields = [...fake.store.keys()];
    await redisCache.clear();
    expect(fake.store.size).toBe(0);
    expect(await redisCache.get("a")).toBeUndefined();
  });

  it("handles array-shaped scan yields and skips empty batches", async () => {
    const delSpy = vi.spyOn(fake, "del");
    fake.scanYields = [["k1", "k2"], []];
    await cache().clear();
    expect(delSpy).toHaveBeenCalledOnce();
    expect(delSpy).toHaveBeenCalledWith(["k1", "k2"]);
  });

  it("swallows a SCAN protocol error", async () => {
    const redisCache = cache();
    fake.failOps = true;
    await expect(redisCache.clear()).resolves.toBeUndefined();
  });
});

describe("cache selection", () => {
  it("selects Redis when a URL is configured", () => {
    expect(
      createToolResponseCache("redis://localhost:6379", createRedisClient),
    ).toBeInstanceOf(RedisCache);
  });

  it("selects the in-process backend without a Redis URL", () => {
    expect(createToolResponseCache("", createRedisClient)).toBeInstanceOf(
      InProcessTTLCache,
    );
  });
});
