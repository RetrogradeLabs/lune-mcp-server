import ky, { type KyInstance } from "ky";
import runtimeDefaults from "../runtime-defaults.json";
import { runtimeSetting } from "../runtime-config.js";
import { MCP_VERSION } from "../version.js";

/** Override for tests; production requires an explicit API target. */
export function getBaseUrl(): string {
  return runtimeSetting(
    "LUNE_API_BASE_URL",
    runtimeDefaults.api_public_url,
  ).replace(/\/$/, "");
}

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
      "User-Agent": `lune-mcp/${MCP_VERSION}`,
      Accept: "application/json",
    },
    timeout: DEFAULT_TIMEOUT_MS,
    // Retry only idempotent GETs on transient network or 5xx failures; MCP
    // clients handle POST tool retries themselves.
    retry: {
      limit: 2,
      methods: ["get"],
      statusCodes: [502, 503, 504],
      backoffLimit: 2000,
    },
  });
}
