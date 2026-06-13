import ky, { type KyInstance } from "ky";

/** Override for tests; production reads `LUNE_API_BASE_URL` or defaults to prod. */
export function getBaseUrl(): string {
  return (process.env.LUNE_API_BASE_URL ?? "https://api.luneresearch.com").replace(/\/$/, "");
}

const VERSION = "1.0.0";

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
    timeout: 30_000,
    // Retry idempotent GETs only (paper/conference/guidance reads): a transient
    // 502/503/504 or a network drop during a long delegated sweep should not be
    // a hard failure. POST /search and subscription mutations are NOT retried
    // (search is non-idempotent; MCP clients retry tool errors themselves).
    retry: {
      limit: 2,
      methods: ["get"],
      statusCodes: [502, 503, 504],
      backoffLimit: 2000,
    },
  });
}

export class LuneApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly requestId?: string,
  ) {
    super(`Lune API ${status}`);
    this.name = "LuneApiError";
  }
}
