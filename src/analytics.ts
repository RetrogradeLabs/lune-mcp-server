/**
 * PostHog MCP analytics, hand-rolled against the documented wire contract
 * (posthog.com/docs/mcp-analytics/events) instead of `@posthog/mcp`, for two
 * reasons: the SDK is 0.x beta, and it would ship as a dependency of the
 * npm-published local binary. This emitter is ky-only (already a dep) and is
 * DOUBLE-GATED to the remote deployment: `initAnalytics()` is called only from
 * the `--http` entrypoint, and it no-ops unless `LUNE_POSTHOG_KEY` is set
 * (only the ECS task definition sets it). Local stdio installs therefore run
 * zero telemetry; their usage is observed server-side at the Lune API.
 *
 * Identity comes from the API's authoritative `/account/mcp-context` probe.
 * OAuth identifies the user, user PAT events use the same erasable UUID with
 * person processing off, system PATs use a credential hash, and benchmark
 * principals emit nothing.
 */
import {
  CLIENT_INFO_META_KEY,
  type Server,
  type ServerContext,
} from "@modelcontextprotocol/server";
import ky from "ky";
import { AsyncLocalStorage } from "node:async_hooks";

let posthogKey: string | null = null;
let posthogHost = "https://us.i.posthog.com";
let transportMode: "stdio" | "http" = "stdio";
const pendingDeliveries = new Set<Promise<void>>();
const analyticsContextStorage = new AsyncLocalStorage<McpAnalyticsContext>();
const MCP_ANALYTICS_DAILY_CAP = 10_000;
const MCP_ANALYTICS_PER_IDENTITY_DAILY_CAP = 1_000;
let analyticsBudgetDay = "";
let analyticsDailyCount = 0;
let analyticsCountByIdentity = new Map<string, number>();

export function setTransportMode(mode: "stdio" | "http"): void {
  transportMode = mode;
}

/** Enable capture for this process. Call ONLY from the HTTP entrypoint. */
export function initAnalytics(): void {
  const key = process.env.LUNE_POSTHOG_KEY?.trim();
  if (!key) return;
  posthogKey = key;
  posthogHost = (
    process.env.LUNE_POSTHOG_HOST?.trim() || "https://us.i.posthog.com"
  ).replace(/\/$/, "");
}

export function analyticsEnabled(): boolean {
  return posthogKey !== null;
}

/** Test hook: reset module state (mirrors the env-gated init). */
export function resetAnalyticsForTests(): void {
  posthogKey = null;
  posthogHost = "https://us.i.posthog.com";
  transportMode = "stdio";
  pendingDeliveries.clear();
  analyticsBudgetDay = "";
  analyticsDailyCount = 0;
  analyticsCountByIdentity = new Map<string, number>();
  clientInfoByServer = new WeakMap<object, ClientInfo>();
  serverInfoByServer = new WeakMap<object, ServerInfo>();
}

interface ClientInfo {
  name: string;
  version: string;
}

interface ServerInfo {
  name: string;
  version: string;
}

export interface AnalyticsIdentity {
  distinctId: string;
  personless: boolean;
}

export interface McpAnalyticsContext {
  identity?: AnalyticsIdentity;
  captureEnabled?: boolean;
  /**
   * The principal opted OUT of capture, permanently. NARROWER than
   * `captureEnabled: false`, which is also how a spent daily event budget
   * arrives. Both stop capture; only this one may shape what the agent is
   * offered (`tools/index.ts`, `get_more_tools`).
   */
  captureOptOut?: boolean;
  workspaceCredential?: boolean;
  sessionId?: string;
  protocolVersion?: string;
  clientUserAgent?: string;
}

export function withAnalyticsContext<T>(
  context: McpAnalyticsContext,
  operation: () => T,
): T {
  return analyticsContextStorage.run(context, operation);
}

/**
 * The context for the request currently being served. `captureMcp` reads the
 * store itself; the HTTP server factory needs it too, because `tools/list`
 * gates the workspace surface and the capture opt-out on the same object.
 */
export function currentAnalyticsContext(): McpAnalyticsContext | undefined {
  return analyticsContextStorage.getStore();
}

let clientInfoByServer = new WeakMap<object, ClientInfo>();
let serverInfoByServer = new WeakMap<object, ServerInfo>();

export function setServerClientInfo(server: object, info: ClientInfo): void {
  clientInfoByServer.set(server, info);
}

/**
 * The slice of a request handler's `ServerContext` the envelope reader touches.
 * Derived from the SDK type so the COMPILER pins both member names: a renamed
 * `mcpReq` or `envelope` fails the build instead of silently reading undefined.
 */
export type EnvelopeContext = {
  mcpReq?: Pick<ServerContext["mcpReq"], "envelope">;
};

/**
 * A `_meta` value is client-supplied and unvalidated: only a primitive can
 * name a client, and stringifying anything structural would attribute the
 * traffic to `[object Object]` in both the header and PostHog.
 */
function envelopeText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : undefined;
}

/**
 * Client identity for a 2026-07-28 request. The modern protocol dropped
 * `initialize`, so `clientInfo` arrives in each request's `_meta` envelope
 * instead of once per session. Returns undefined on legacy requests, where
 * the handshake already supplied it.
 */
export function clientInfoFromEnvelope(
  ctx: EnvelopeContext | undefined,
): ClientInfo | undefined {
  // `@modelcontextprotocol/server@2.0.0` emits `RequestMetaEnvelope` as `{}` in
  // its bundled declarations, so the reserved keys cannot be indexed under the
  // real type; the SDK's own key constant keeps the string itself in sync.
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined;
  const raw = envelope?.[CLIENT_INFO_META_KEY];
  // Only an object can carry the two members, so narrow rather than assert: a
  // client is free to send a string or a number under that key.
  const info =
    typeof raw === "object" && raw !== null
      ? (raw as { name?: unknown; version?: unknown })
      : undefined;
  const name = envelopeText(info?.name);
  if (!name) return undefined;
  return { name, version: envelopeText(info?.version) ?? "0" };
}

/**
 * Stamp the client identity a 2026-07-28 request carries onto `server`, so the
 * `X-Lune-Client` header and the PostHog client properties both see it. A legacy
 * request carries no envelope, so it leaves the stamp untouched and
 * `clientHeaderFor` falls back to the handshake identity instead.
 *
 * SAFE ONLY PER-INSTANCE: the stamp lands in a WeakMap keyed by `server`, so
 * "one client per stamp" holds because `createMcpHandler` and `serveStdio` build
 * a fresh instance per request / per connection. On an instance shared across
 * clients, an envelope-less request would inherit the previous client's identity,
 * which is cross-principal attribution leakage.
 */
export function attributeFromEnvelope(
  server: object,
  ctx: EnvelopeContext,
): void {
  const fromEnvelope = clientInfoFromEnvelope(ctx);
  if (fromEnvelope) setServerClientInfo(server, fromEnvelope);
}

export function setServerInfo(server: object, info: ServerInfo): void {
  serverInfoByServer.set(server, info);
}

/**
 * The identity a 2025-era peer declared in its `initialize` handshake, read
 * back off the SDK instance. `serveStdio` pins ONE instance for the connection
 * lifetime, so a stdio peer's handshake identity is still live here; on the
 * HTTP legacy leg the `initialize` instance is already gone by the next
 * request, so this is empty there by construction rather than by choice.
 * `getClientVersion` is deprecated in favour of the per-request envelope but
 * documented as functional on BOTH eras (the SDK backfills it from the
 * validated envelope on modern requests), which is exactly this fallback.
 */
function handshakeClientInfo(server: object): ClientInfo | undefined {
  const info = (
    server as Partial<Pick<Server, "getClientVersion">>
  ).getClientVersion?.();
  if (!info?.name) return undefined;
  return { name: info.name, version: info.version || "0" };
}

/**
 * `X-Lune-Client` value forwarded on every API call so server-side analytics
 * attributes usage to the agent client (claude-code, cursor, ...) without any
 * client-side telemetry. Format: `mcp-<stdio|remote>/<client>/<version>`.
 *
 * ALWAYS returns a value: sending no header is not "no attribution" but the
 * WRONG attribution, because the API's `surface_of` (`core/analytics.py`) then
 * reports the request as `api_direct` and collapses the
 * `mcp_remote`/`mcp_stdio`/`api_direct` split. `unknown` keeps the transport
 * fact without inventing a client name, which is why a sanitized user agent is
 * NOT the fallback: it would mix inferred names into a dimension that
 * otherwise holds only self-declared ones.
 */
export function clientHeaderFor(server: object): string {
  const info = clientInfoByServer.get(server) ?? handshakeClientInfo(server);
  const mode = transportMode === "http" ? "remote" : "stdio";
  if (!info) return `mcp-${mode}/unknown/0`;
  const clean = (value: string, maxLength: number) =>
    value.replace(/[^\w.-]+/g, "-").slice(0, maxLength);
  return `mcp-${mode}/${clean(info.name, 40)}/${clean(info.version, 32)}`;
}

/**
 * Per-task backstop, NOT the real ceiling. The binding cap is the API's
 * `claim_mcp_analytics_budget`, which is DynamoDB-backed and shared across
 * tasks and restarts; it reaches us as `captureEnabled: false` on the probe.
 * These counters are per process, so they multiply with the task count
 * (`infra/mcp.ts` runs 2 to 6). That is safe only because the shared cap
 * still binds globally: the most a fleet can overshoot is what it emits
 * inside one probe TTL. Do not treat these numbers as the fleet's limit.
 */
export function claimMcpAnalyticsBudget(identity: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== analyticsBudgetDay) {
    analyticsBudgetDay = today;
    analyticsDailyCount = 0;
    analyticsCountByIdentity.clear();
  }
  const identityCount = analyticsCountByIdentity.get(identity) ?? 0;
  if (
    analyticsDailyCount >= MCP_ANALYTICS_DAILY_CAP ||
    identityCount >= MCP_ANALYTICS_PER_IDENTITY_DAILY_CAP
  ) {
    return false;
  }
  analyticsDailyCount += 1;
  analyticsCountByIdentity.set(identity, identityCount + 1);
  return true;
}

const SENSITIVE_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:authorization|cookie|password|token|secret|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)(\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g;
const PROJECT_TOKEN_VALUE = /\bph[a-z]_[A-Za-z0-9_-]{8,}\b/gi;
const LUNE_TOKEN_VALUE = /\blune_[A-Za-z0-9_-]{8,}\b/gi;
const PEM_VALUE = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;

export function sanitizeAnalyticsText(value: string, maxLength = 500): string {
  const sanitized = value
    .replace(PEM_VALUE, "[private material redacted]")
    .replace(BEARER_VALUE, "Bearer [redacted]")
    .replace(
      SENSITIVE_ASSIGNMENT,
      (_match, key: string, separator: string) =>
        `${key}${separator}[redacted]`,
    )
    .replace(JWT_VALUE, "[token redacted]")
    .replace(PROJECT_TOKEN_VALUE, "[token redacted]")
    .replace(LUNE_TOKEN_VALUE, "[token redacted]")
    .replace(EMAIL_VALUE, "[email redacted]")
    // oxlint-disable-next-line no-control-regex -- stripping control chars IS the point
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return sanitized.length <= maxLength
    ? sanitized
    : sanitized.slice(0, maxLength).trimEnd();
}

function sanitizeAnalyticsValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitizeAnalyticsText(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (depth >= 6) return "[nested value omitted]";
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => sanitizeAnalyticsValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, nested]) => [
          key,
          /authorization|cookie|password|token|secret|api[_-]?key|private[_-]?key/i.test(
            key,
          )
            ? "[redacted]"
            : sanitizeAnalyticsValue(nested, depth + 1),
        ]),
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // bigint / symbol / function are not analytics values; name the type rather
  // than emitting "[object Object]" or a whole function body.
  return typeof value === "bigint" ? value.toString() : `[${typeof value}]`;
}

function sanitizeProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeAnalyticsValue(properties) as Record<string, unknown>;
}

/**
 * Fire-and-forget single-event capture against PostHog's public ingest
 * endpoint. Never throws, never blocks the tool call. `$mcp_source` follows
 * the documented wire contract so PostHog's MCP analytics views pick the
 * events up.
 */
export function captureMcp(
  event: string,
  server: object,
  context: McpAnalyticsContext | undefined,
  properties: Record<string, unknown>,
): boolean {
  if (posthogKey === null) return false;
  try {
    const scopedContext = analyticsContextStorage.getStore();
    const effectiveContext =
      context || scopedContext ? { ...context, ...scopedContext } : undefined;
    if (effectiveContext?.captureEnabled === false) return false;
    const identity = effectiveContext?.identity ?? {
      distinctId: "mcp-anonymous",
      personless: true,
    };
    if (!claimMcpAnalyticsBudget(identity.distinctId)) return false;
    const info = clientInfoByServer.get(server);
    const serverInfo = serverInfoByServer.get(server);
    const delivery = Promise.resolve(
      ky.post(`${posthogHost}/i/v0/e/`, {
        json: {
          api_key: posthogKey,
          event: sanitizeAnalyticsText(event, 200),
          distinct_id: sanitizeAnalyticsText(identity.distinctId, 200),
          properties: {
            ...sanitizeProperties(properties),
            ...(effectiveContext?.sessionId
              ? {
                  $session_id: sanitizeAnalyticsText(
                    effectiveContext.sessionId,
                    200,
                  ),
                }
              : {}),
            ...(effectiveContext?.protocolVersion
              ? {
                  $mcp_protocol_version: sanitizeAnalyticsText(
                    effectiveContext.protocolVersion,
                    100,
                  ),
                }
              : {}),
            ...(effectiveContext?.clientUserAgent
              ? {
                  $mcp_client_user_agent: sanitizeAnalyticsText(
                    effectiveContext.clientUserAgent,
                    300,
                  ),
                }
              : {}),
            ...(serverInfo
              ? {
                  $mcp_server_name: sanitizeAnalyticsText(serverInfo.name, 100),
                  $mcp_server_version: sanitizeAnalyticsText(
                    serverInfo.version,
                    100,
                  ),
                }
              : {}),
            ...(info
              ? {
                  $mcp_client_name: sanitizeAnalyticsText(info.name, 100),
                  $mcp_client_version: sanitizeAnalyticsText(info.version, 100),
                }
              : {}),
            ...(identity.personless ? { $process_person_profile: false } : {}),
            $geoip_disable: true,
            $mcp_source: "posthog_mcp_analytics",
            service: "lune-mcp",
            // Same env stamp every surface carries, so the project's
            // internal-user filter (env != development) applies uniformly.
            env:
              process.env.NODE_ENV === "production"
                ? "production"
                : "development",
          },
        },
        timeout: 3000,
        retry: 0,
      }),
    )
      .then(() => undefined)
      .catch(() => undefined);
    pendingDeliveries.add(delivery);
    void delivery.then(() => pendingDeliveries.delete(delivery));
    return true;
  } catch {
    // Analytics must never break a tool call.
    return false;
  }
}

/** Wait for already-enqueued HTTP events, bounded below the ECS stop grace. */
export async function flushAnalytics(timeoutMs = 2000): Promise<void> {
  const deliveries = [...pendingDeliveries];
  if (deliveries.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(deliveries).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
