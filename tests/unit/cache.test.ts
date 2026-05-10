/**
 * Unit tests for the MCP tool-response cache primitives.
 *
 * Covers in-process LRU+TTL semantics and the SingleFlight collapse
 * behaviour. Redis-backed paths are exercised in production smoke runs;
 * we don't spin up a real Redis here.
 */

import { describe, it, expect } from "vitest";

import { InProcessTTLCache, SingleFlight } from "../../src/cache.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("InProcessTTLCache", () => {
  it("returns undefined for unknown keys", async () => {
    const cache = new InProcessTTLCache(8, 60_000);
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("stores and retrieves values inside the TTL", async () => {
    const cache = new InProcessTTLCache(8, 60_000);
    await cache.set("k", { foo: 1 });
    expect(await cache.get("k")).toEqual({ foo: 1 });
  });

  it("expires entries past their TTL", async () => {
    const cache = new InProcessTTLCache(8, 60_000);
    await cache.set("k", "v", 30);
    expect(await cache.get("k")).toBe("v");
    await sleep(50);
    expect(await cache.get("k")).toBeUndefined();
  });

  it("evicts the least-recently-used entry when full", async () => {
    const cache = new InProcessTTLCache(2, 60_000);
    await cache.set("a", 1);
    await cache.set("b", 2);
    // Touch 'a' so it becomes MRU.
    expect(await cache.get("a")).toBe(1);
    await cache.set("c", 3); // 'b' is LRU now → evicted.
    expect(await cache.get("a")).toBe(1);
    expect(await cache.get("c")).toBe(3);
    expect(await cache.get("b")).toBeUndefined();
  });

  it("invalidate removes a single key", async () => {
    const cache = new InProcessTTLCache(8, 60_000);
    await cache.set("k", "v");
    await cache.invalidate("k");
    expect(await cache.get("k")).toBeUndefined();
  });

  it("clear empties the cache", async () => {
    const cache = new InProcessTTLCache(8, 60_000);
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.clear();
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeUndefined();
  });
});

describe("SingleFlight", () => {
  it("collapses concurrent calls for the same key onto one factory invocation", async () => {
    const sf = new SingleFlight();
    let invocations = 0;
    const factory = async () => {
      invocations++;
      await sleep(20);
      return "value";
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => sf.do("k", factory)),
    );

    expect(results).toEqual(Array.from({ length: 20 }, () => "value"));
    expect(invocations).toBe(1);
  });

  it("different keys do not block each other", async () => {
    const sf = new SingleFlight();
    const calls: Record<string, number> = { a: 0, b: 0 };
    const factory = (key: string) => async () => {
      calls[key]!++;
      await sleep(5);
      return `value-${key}`;
    };

    const [a, b] = await Promise.all([sf.do("a", factory("a")), sf.do("b", factory("b"))]);
    expect([a, b]).toEqual(["value-a", "value-b"]);
    expect(calls).toEqual({ a: 1, b: 1 });
  });

  it("propagates errors and clears the entry so the next call retries", async () => {
    const sf = new SingleFlight();
    let attempts = 0;

    const failing = async () => {
      attempts++;
      throw new Error("boom");
    };

    const errs = await Promise.allSettled(
      Array.from({ length: 5 }, () => sf.do("k", failing)),
    );
    expect(errs.every((r) => r.status === "rejected")).toBe(true);
    expect(attempts).toBe(1);

    // Entry was cleared → next call retries.
    const ok = await sf.do("k", async () => "ok");
    expect(ok).toBe("ok");
  });
});
