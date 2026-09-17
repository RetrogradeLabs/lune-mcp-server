/**
 * The MCP server seam for tests: a REAL SDK `Server` that also records what
 * `registerAllTools` / `registerResources` / `registerPrompts` wired onto it, so
 * a test can invoke one handler directly.
 *
 * It subclasses `Server` rather than standing in for it. `Server` carries
 * private state, so no structural double is assignable to it and every such
 * double had to be laundered through `as unknown as`. Subclassing also keeps the
 * SDK's own guarantees live: `super.setRequestHandler` still runs
 * `assertRequestHandlerCapability`, so a handler registered without its
 * capability declared fails here exactly as it would in `makeServer`.
 *
 * Handlers are keyed by METHOD NAME, so a reordering of the register calls
 * cannot route `tools/call` into the `tools/list` assertions.
 */
import {
  Server,
  type HandlerResultTypeMap,
  type Implementation,
  type Notification,
  type RequestHandlerSchemas,
  type RequestMeta,
  type RequestMetaEnvelope,
  type RequestMethod,
  type RequestTypeMap,
  type Result,
  type ServerContext,
} from "@modelcontextprotocol/server";

/** The 2-argument spec-method registration form, the only one this package uses. */
export type SpecHandler<M extends RequestMethod> = (
  request: RequestTypeMap[M],
  ctx: ServerContext,
) => HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>;

/** The 3-argument custom-method form, declared only to keep the base overloads. */
type CustomHandler = (params: never, ctx: ServerContext) => Promise<Result>;

/**
 * One registration with its method erased. `handle` is declared as a METHOD
 * rather than a function property so its request parameter compares
 * bivariantly, which is what lets a single map hold every method's handler
 * and still hand each one back at its own request and result types.
 */
interface Registration {
  handle(
    request: RequestTypeMap[RequestMethod],
    ctx: ServerContext,
  ):
    | HandlerResultTypeMap[RequestMethod]
    | Promise<HandlerResultTypeMap[RequestMethod]>;
}

/**
 * Registrations live outside the instance because `Server`'s constructor
 * registers `logging/setLevel` through this same override, which runs BEFORE any
 * subclass field initializer would have created the map.
 */
const REGISTERED = new WeakMap<RecordingServer, Map<string, Registration>>();

const HANDSHAKE_CLIENT = new WeakMap<RecordingServer, Implementation>();

export class RecordingServer extends Server {
  override setRequestHandler<M extends RequestMethod>(
    method: M,
    handler: SpecHandler<M>,
  ): void;
  override setRequestHandler(
    method: string,
    schemas: RequestHandlerSchemas,
    handler: CustomHandler,
  ): void;
  override setRequestHandler<M extends RequestMethod>(
    method: M,
    second: SpecHandler<M> | RequestHandlerSchemas,
    third?: CustomHandler,
  ): void {
    if (third !== undefined || !isSpecHandler(second)) {
      throw new Error(
        `custom-method registration is unused in this package (${method})`,
      );
    }

    let store = REGISTERED.get(this);

    if (!store) {
      store = new Map<string, Registration>();
      REGISTERED.set(this, store);
    }

    store.set(method, { handle: second });
    super.setRequestHandler(method, second);
  }

  /** Every method a `register*` call wired, for asserting the wiring itself. */
  registeredMethods(): string[] {
    return [...(REGISTERED.get(this)?.keys() ?? [])];
  }

  /** The handler registered for `method`, at that method's own request/result types. */
  handler<M extends RequestMethod>(method: M): SpecHandler<M> {
    const found = REGISTERED.get(this)?.get(method);

    if (!found) throw new Error(`no handler registered for ${method}`);

    // SAFETY: Only setRequestHandler writes each method key, so lookup under M
    // returns its SpecHandler<M>; the box erases only the method parameter.
    return found.handle as SpecHandler<M>;
  }

  /**
   * The identity a 2025-era peer declared in its `initialize` handshake. Fed by
   * `createRecordingServer({ clientVersion })` so a test can exercise the
   * attribution fallback without running a real handshake.
   */
  override getClientVersion(): Implementation | undefined {
    return HANDSHAKE_CLIENT.get(this) ?? super.getClientVersion();
  }
}

/**
 * The 2-argument form passes the handler where the 3-argument form passes a
 * schema bundle, so which overload the caller reached is readable off the value.
 */
function isSpecHandler<M extends RequestMethod>(
  second: SpecHandler<M> | RequestHandlerSchemas,
): second is SpecHandler<M> {
  return typeof second === "function";
}

export type RecordingServerOptions = {
  /** Stands in for the identity a 2025-era `initialize` handshake recorded. */
  clientVersion?: Implementation;
};

/**
 * A `RecordingServer` declaring the three capabilities this package registers
 * handlers for. Every capability is declared up front because the SDK refuses a
 * registration whose capability is missing, and which of the three a given test
 * wires is decided by the register call it makes, not by this fixture.
 */
export function createRecordingServer(
  options: RecordingServerOptions = {},
): RecordingServer {
  const server = new RecordingServer(
    { name: "lune-test", version: "0.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  if (options.clientVersion) {
    HANDSHAKE_CLIENT.set(server, options.clientVersion);
  }

  return server;
}

export type ServerContextOverrides = {
  /** The 2026-07-28 `_meta` envelope keys the request carried. */
  envelope?: Partial<RequestMetaEnvelope>;
  /** The non-reserved `_meta` the handler sees (trace context lives here). */
  meta?: RequestMeta;
  signal?: AbortSignal;
  sessionId?: string;
  method?: string;
};

/**
 * A complete `ServerContext`, so a handler under test receives the same object
 * shape the transport builds. Everything a Lune handler never touches is a stub
 * that THROWS rather than resolving: a handler that starts calling back to the
 * client should fail the test that pinned it, not silently pass.
 */
export function createServerContext(
  overrides: ServerContextOverrides = {},
): ServerContext {
  const unreachable = (member: string) => () =>
    Promise.reject<never>(
      new Error(`ctx.mcpReq.${member} is not available in tests`),
    );

  const context: ServerContext = {
    mcpReq: {
      id: 1,
      method: overrides.method ?? "tools/call",
      requestState: () => undefined,
      signal: overrides.signal ?? new AbortController().signal,
      send: unreachable("send"),
      notify: (_notification: Notification) => unreachable("notify")(),
      log: unreachable("log"),
      elicitInput: unreachable("elicitInput"),
      requestSampling: unreachable("requestSampling"),
    },
  };

  if (overrides.envelope) context.mcpReq.envelope = overrides.envelope;

  if (overrides.meta) context.mcpReq._meta = overrides.meta;

  if (overrides.sessionId) context.sessionId = overrides.sessionId;

  return context;
}
