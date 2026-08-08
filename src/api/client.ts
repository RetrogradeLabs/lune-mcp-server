import ky, { type KyInstance } from "ky";

/** Override for tests; production reads `LUNE_API_BASE_URL` or defaults to prod. */
export function getBaseUrl(): string {
  return (
    process.env.LUNE_API_BASE_URL ?? "https://api.luneresearch.com"
  ).replace(/\/$/, "");
}

// `__LUNE_MCP_VERSION__` is substituted by tsup `define` at build time (see
// `tsup.config.ts`, same constant server.ts stamps). The fallback keeps tsx /
// vitest happy in dev where it isn't substituted, and stops the User-Agent from
// drifting to a hardcoded version that lies about the running build.
declare const __LUNE_MCP_VERSION__: string | undefined;
const VERSION =
  typeof __LUNE_MCP_VERSION__ === "string" ? __LUNE_MCP_VERSION__ : "0.0.0-dev";

/** Default per-call timeout, for the light read tools (search / fetch / list). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Per-call timeout for the heavy orchestration tools (`gather_evidence`,
 * `verify_claims`, `extract_from_papers`, `search_papers_many`). Each fans out
 * MULTIPLE server-side LLM + retrieval calls, so a call legitimately runs past the
 * 30s default (a one-iteration corpus gather is ~25s; workspace + multi-iteration
 * push higher), which blanket-30s surfaced as a generic "protocol error".
 * `gather_evidence` also self-bounds wall-clock server-side
 * (`evidence_service._WALL_CLOCK_BUDGET_S`), returning partial results before this backstop.
 */
export const HEAVY_TOOL_TIMEOUT_MS = 120_000;

/**
 * Construct a ky instance bound to the given Bearer token. Each tool call
 * receives a fresh client (via the `makeClient` factory passed to the server)
 * so token rotation mid-session is handled automatically by the transport
 * layer updating the closure.
 */
export function makeClient(token: string): KyInstance {
  return ky.create({
    // ky 2.0 renamed `prefixUrl` → `prefix`.
    prefix: `${getBaseUrl()}/api/v1/`,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": `lune-mcp/${VERSION}`,
      Accept: "application/json",
    },
    timeout: DEFAULT_TIMEOUT_MS,
    // Retry idempotent GETs only (paper/conference/guidance reads): a transient
    // 502/503/504 or a network drop during a long delegated sweep should not be
    // a hard failure. POST /search is NOT retried (non-idempotent; MCP clients
    // retry tool errors themselves).
    retry: {
      limit: 2,
      methods: ["get"],
      statusCodes: [502, 503, 504],
      backoffLimit: 2000,
    },
  });
}
