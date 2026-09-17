/**
 * A recording stand-in for the MCP `Server`, for tests that exercise a registrar
 * (`registerAllTools`, `registerResources`, `registerPrompts`).
 *
 * Handlers are keyed by the METHOD STRING the v2 SDK registers on, not by call
 * order: with a positional lookup, reordering the registrar's own
 * `setRequestHandler` calls silently routes `tools/call` into the `tools/list`
 * assertions instead of failing on the behaviour under test.
 */
import type { McpServerLike } from "../../src/analytics.js";
import type { JsonObject, JsonValue } from "../../src/json.js";

/** The request slice a handler under test reads. */
export type FakeRequest = { params?: JsonObject };

/**
 * The context slice a handler under test reads: `envelope` carries the
 * 2026-07-28 `_meta` identity keys, `_meta` the trace headers, and `signal` the
 * abort the heavy-tool client forwards.
 */
export type FakeContext = {
  mcpReq?: {
    envelope?: JsonObject;
    _meta?: JsonObject;
    signal?: AbortSignal;
  };
};

/**
 * A registered handler, as a test calls it. `R` lets the caller name the concrete
 * result the handler under test returns, so the assertion lives here once rather
 * than at every call site.
 */
export type FakeHandler<R = JsonValue> = (
  req: FakeRequest,
  ctx?: FakeContext,
) => Promise<R>;

/**
 * How a handler is STORED: a supertype of every handler the SDK's generic maps
 * produce. `never` parameters accept any argument types, and a `void` return
 * position accepts any return type, so registration needs no assertion at all.
 * The single assertion is on the way back out, where the test supplies its own
 * request and context shapes.
 */
type StoredHandler = (req: never, ctx: never) => void;

/** What a fake may carry besides the registry, e.g. the deprecated accessor the
 *  legacy client-attribution path reads. */
export type FakeServerExtras = {
  getClientVersion?: (() => { name: string; version: string }) | undefined;
};

export type FakeServer = {
  server: McpServerLike;
  /** The handler registered for a method, or a throw naming the missing one. */
  handler: <R = JsonValue>(method: string) => FakeHandler<R>;
  /** Which methods were registered, in registration order. */
  registered: () => string[];
};

export function createFakeServer(extras: FakeServerExtras = {}): FakeServer {
  const handlers = new Map<string, StoredHandler>();

  const server: McpServerLike = {
    ...extras,
    setRequestHandler(method, registered) {
      handlers.set(method, registered);
    },
  };

  return {
    server,
    handler: <R = JsonValue>(method: string): FakeHandler<R> => {
      const found = handlers.get(method);

      if (!found) throw new Error(`no handler registered for ${method}`);

      // SAFETY: Test handlers read only supplied params/mcpReq; callers choose R
      // for the named handler while this fake erases unused live-request detail.
      return found as FakeHandler<R>;
    },
    registered: () => [...handlers.keys()],
  };
}
