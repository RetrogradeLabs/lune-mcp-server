/**
 * Tool-response cache for the MCP server.
 *
 * Two backends behind one async interface:
 *
 *   • {@link InProcessTTLCache}: LRU + TTL inside the Node process.
 *     Used by default; correct for stdio MCP (one process per agent client).
 *   • {@link RedisCache}: auto-selected when ``REDIS_URL`` is set.
 *     Backed by AWS ElastiCache Serverless in production. Lets the
 *     ``mcp.luneresearch.com`` HTTP fleet share a single cache so two MCP
 *     tasks fetching the same paper hit the same cached body.
 *
 * Why an interface despite Redis: a Redis blip degrades to misses, not
 * errors. ``RedisCache`` swallows network failures and returns
 * ``undefined`` so the caller falls through to upstream. Mirrors the
 * approach in `apps/api/src/api/core/cache.py`.
 */

import { createClient, type RedisClientType } from "redis";

/* ───────────────────────────── Cache interface ─────────────────────────── */

export interface Cache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  clear(): Promise<void>;
}

/* ───────────────────────────── In-process LRU+TTL ──────────────────────── */

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class InProcessTTLCache implements Cache {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly maxSize: number,
    private readonly defaultTtlMs: number,
  ) {}

  async get(key: string): Promise<unknown | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU position by re-inserting at the end.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      // store.size >= maxSize ⇒ store is non-empty ⇒ `oldest` is defined.
      // TS narrows the IteratorResult shape but can't prove it at runtime.
      const oldest = this.store.keys().next().value;
      /* v8 ignore next */
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  async invalidate(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

/* ───────────────────────────── Redis-backed ────────────────────────────── */

const NAMESPACE_PREFIX = process.env.LUNE_CACHE_NAMESPACE ?? "v1";

/**
 * ElastiCache Serverless–backed cache. Connects lazily on first use, retries
 * with exponential backoff up to a generous cap, and degrades to silent
 * misses on protocol-level errors. We keep node-redis's reconnection logic
 * (`socket.reconnectStrategy`) on so a transient AZ failover or rolling
 * deploy does not pin the client into a permanently disconnected state.
 *
 * Values are JSON-encoded. The MCP server only ever caches API JSON bodies
 * (already serialisable), so a structured-clone serializer would buy nothing.
 */
export class RedisCache implements Cache {
  private readonly client: RedisClientType;
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(
    redisUrl: string,
    private readonly namespace: string,
    private readonly defaultTtlMs: number,
  ) {
    this.client = createClient({
      url: redisUrl,
      socket: {
        // Cap individual reconnect waits at ~3s so we don't block tool
        // calls forever if Redis is briefly unreachable. node-redis
        // multiplies retries; we cap each individual wait, not the total.
        reconnectStrategy: (retries) => Math.min(50 + retries * 50, 3000),
      },
    });
    this.client.on("error", (err) => {
      // Don't kill the process on connection blips; cache calls degrade to
      // misses and the upstream API still works.
      console.error(`[mcp/cache] redis error: ${(err as Error).message}`);
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.client
      .connect()
      .then(() => {
        this.connected = true;
      })
      .catch((err) => {
        console.error(`[mcp/cache] redis connect failed: ${(err as Error).message}`);
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private k(key: string): string {
    return `lune:${NAMESPACE_PREFIX}:${this.namespace}:${key}`;
  }

  async get(key: string): Promise<unknown | undefined> {
    try {
      await this.ensureConnected();
      if (!this.connected) return undefined;
      const raw = await this.client.get(this.k(key));
      if (raw === null) return undefined;
      return JSON.parse(raw);
    } catch (err) {
      console.error(`[mcp/cache] redis GET miss: ${(err as Error).message}`);
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    try {
      await this.ensureConnected();
      if (!this.connected) return;
      const payload = JSON.stringify(value);
      const seconds = Math.max(1, Math.round((ttlMs ?? this.defaultTtlMs) / 1000));
      await this.client.set(this.k(key), payload, { EX: seconds });
    } catch (err) {
      console.error(`[mcp/cache] redis SET dropped: ${(err as Error).message}`);
    }
  }

  async invalidate(key: string): Promise<void> {
    try {
      await this.ensureConnected();
      if (!this.connected) return;
      await this.client.del(this.k(key));
    } catch (err) {
      console.error(`[mcp/cache] redis DEL dropped: ${(err as Error).message}`);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.ensureConnected();
      if (!this.connected) return;
      // SCAN+DEL is the safe batched form; avoid `KEYS *` which blocks the
      // server on large keyspaces.
      const prefix = this.k("*");
      for await (const key of this.client.scanIterator({ MATCH: prefix, COUNT: 500 })) {
        const keys = Array.isArray(key) ? key : [key];
        if (keys.length > 0) await this.client.del(keys);
      }
    } catch (err) {
      console.error(`[mcp/cache] redis CLEAR dropped: ${(err as Error).message}`);
    }
  }
}

/* ───────────────────────────── Single-flight ───────────────────────────── */

/**
 * Coalesce concurrent identical lookups inside one process onto one upstream
 * call. With Redis as the source of truth, single-flight matters less for
 * correctness (cross-process duplicates are harmless), but it still wins
 * latency: a hot search query that hits 50 MCP requests at once still
 * issues exactly one Lune API request from this process.
 */
export class SingleFlight {
  private inflight = new Map<string, Promise<unknown>>();

  async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const p = (async () => {
      try {
        return await fn();
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

/* ───────────────────────────── Selection ───────────────────────────────── */

function pickCache(): Cache {
  const url = process.env.REDIS_URL;
  if (url) {
    console.log("[mcp/cache] using Redis backend");
    // 5 min default TTL, overridden per-call by Cache-Control max-age.
    return new RedisCache(url, "mcp_tools", 5 * 60 * 1000);
  }
  console.log("[mcp/cache] using in-process backend");
  return new InProcessTTLCache(512, 5 * 60 * 1000);
}

/** Single shared cache + single-flight for tool responses. */
export const TOOL_RESPONSE_CACHE: Cache = pickCache();
export const TOOL_RESPONSE_SINGLEFLIGHT = new SingleFlight();
