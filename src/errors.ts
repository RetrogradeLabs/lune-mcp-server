import type { ToolCallResult } from "./tool-result.js";

/**
 * MCP error codes for Lune-specific failures. Picked from the JSON-RPC
 * "implementation-defined server error" range (-32000 to -32099) while
 * avoiding the values the MCP SDK already uses (-32000 ConnectionClosed,
 * -32001 RequestTimeout).
 */
export const LuneErrorCode = {
  Unauthorized: -32010,
  Forbidden: -32011,
  RateLimited: -32012,
  NotFound: -32013,
  ServerError: -32014,
  QuotaExhausted: -32015,
  // JSON-RPC standard "Invalid params" code. Used by the MCP tool layer
  // when a fuzzy-resolved argument matches multiple candidates and we
  // need the agent to retry with a more specific input.
  InvalidParams: -32602,
} as const;

export interface MappedError {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

interface ApiErrorBody {
  retry_after_seconds?: number;
  upgrade_hint?: string;
  required?: string[];
  granted?: string[];
  detail?: unknown;
  error?: string;
  buy_credits_url?: string;
  [k: string]: unknown;
}

// Most paper-tool 404s are an id from the WRONG namespace/source fed to a fetch
// tool (e.g. a workspace document id used with source=corpus, or a corpus
// paper_id used with source=workspace). Name the namespaces so the model
// self-corrects on ANY client, not just our cloud agents.
const PAPER_NOT_FOUND_STEER =
  " If you do not have a valid paper_id, call search_papers first. The id " +
  "must match the source: a corpus paper_id comes from search_papers " +
  "(source=corpus); a workspace document id comes from " +
  "search_papers(source=workspace) and must be used with source=workspace; a " +
  "guidance doc_id comes from search_research_guidance.";

// A 404's recovery hint must name the resource the CALLING tool addresses.
// The paper-id steer (call search_papers, match the source) is actionable only
// for paper-id tools; surfacing it verbatim on a conference/guidance 404
// misleads the agent into search_papers, which cannot help. Tools absent from
// this map (search_papers, list_*) get the bare detail/"Not found".
const NOT_FOUND_STEER: Record<string, string> = {
  get_paper_fulltext: PAPER_NOT_FOUND_STEER,
  get_paper_citations: PAPER_NOT_FOUND_STEER,
  search_related_papers: PAPER_NOT_FOUND_STEER,
  extract_from_papers: PAPER_NOT_FOUND_STEER,
  verify_claims: PAPER_NOT_FOUND_STEER,
  gather_evidence: PAPER_NOT_FOUND_STEER,
  get_research_guidance_doc:
    " If you do not have a valid doc_id, call search_research_guidance first.",
  get_conference_papers:
    " If the conference is unknown, call list_conferences for valid short names.",
};

export function mapHttpError(
  status: number,
  body: ApiErrorBody | null | undefined,
  requestId?: string,
  retryAfterSeconds?: number,
  toolName?: string,
): MappedError {
  const safeBody = body ?? {};
  const base: Record<string, unknown> = { status };
  if (requestId) base.request_id = requestId;

  switch (status) {
    case 401:
      return {
        code: LuneErrorCode.Unauthorized,
        message:
          "Unauthorized: token expired or revoked. Rotate your PAT or run `lune login` again.",
        data: base,
      };
    case 402: {
      const buyUrl =
        typeof safeBody.buy_credits_url === "string"
          ? safeBody.buy_credits_url
          : undefined;
      const message = buyUrl
        ? `Quota exhausted. Upgrade your plan or top up credits to continue: ${buyUrl}`
        : "Quota exhausted. Upgrade your plan or top up credits to continue.";
      return {
        code: LuneErrorCode.QuotaExhausted,
        message,
        data: { ...base, buy_credits_url: buyUrl },
      };
    }
    case 403: {
      const required = safeBody.required ?? [];
      const granted = safeBody.granted ?? [];
      const requiredStr = Array.isArray(required) ? required.join(", ") : "";
      return {
        code: LuneErrorCode.Forbidden,
        message: requiredStr
          ? `Forbidden: missing scope. Required: ${requiredStr}`
          : "Forbidden: your token lacks the required scope for this tool.",
        data: { ...base, required, granted },
      };
    }
    case 404: {
      const detail =
        typeof safeBody.detail === "string" ? safeBody.detail : "Not found";
      const steer = toolName
        ? (NOT_FOUND_STEER[toolName] ?? "")
        : PAPER_NOT_FOUND_STEER;
      return {
        code: LuneErrorCode.NotFound,
        message: detail + steer,
        data: base,
      };
    }
    case 429: {
      const retry =
        typeof safeBody.retry_after_seconds === "number"
          ? safeBody.retry_after_seconds
          : (retryAfterSeconds ?? 60);
      const hint =
        typeof safeBody.upgrade_hint === "string"
          ? safeBody.upgrade_hint
          : undefined;
      return {
        code: LuneErrorCode.RateLimited,
        message: hint
          ? `Rate limited. Retry after ${retry}s. ${hint}`
          : `Rate limited. Retry after ${retry}s.`,
        data: { ...base, retry_after_seconds: retry, upgrade_hint: hint },
      };
    }
    default: {
      if (status >= 500) {
        return {
          code: LuneErrorCode.ServerError,
          message: `Lune API server error (${status}). Try again later.`,
          data: { ...base, body: safeBody },
        };
      }
      // 400 Bad Request and other 4xx fall here. Surface as InvalidRequest so
      // MCP clients show the message verbatim.
      return {
        code: -32600,
        message:
          typeof safeBody.detail === "string"
            ? `Lune API ${status}: ${safeBody.detail}`
            : `Unexpected ${status} from Lune API`,
        data: { ...base, body: safeBody },
      };
    }
  }
}

/**
 * Render a mapped upstream error as an MCP tool execution error (`isError: true`
 * + a text block), NOT a JSON-RPC protocol error: per the MCP spec, tool
 * execution errors reach the model so it can self-correct/retry, while protocol
 * errors are captured client-side and never enter its context. So every upstream
 * HTTP failure (incl. 429/402) belongs here.
 *
 * The footer appends the actionable fields (status, retry_after_seconds,
 * buy_credits_url) on their own lines so the agent can parse them from `content`,
 * the only channel every client forwards.
 */
export function toToolError(m: MappedError): ToolCallResult {
  const footer: string[] = [];
  const data = m.data;
  if (typeof data.retry_after_seconds === "number") {
    footer.push(`retry_after_seconds=${data.retry_after_seconds}`);
  }
  if (typeof data.buy_credits_url === "string") {
    footer.push(`buy_credits_url=${data.buy_credits_url}`);
  }
  if (typeof data.status === "number")
    footer.push(`http_status=${data.status}`);
  const text = footer.length ? `${m.message}\n${footer.join(" ")}` : m.message;
  return { content: [{ type: "text", text }], isError: true };
}

interface KyHttpError {
  response?: { status: number; headers: Headers; json: () => Promise<unknown> };
}

/** Narrow an unknown caught value to a ky `HTTPError` (exposes `.response`). */
function asKyHttpError(e: unknown): KyHttpError["response"] | null {
  // Avoid importing `HTTPError` directly so this stays usable from tests that
  // don't import ky.
  return (e as KyHttpError)?.response ?? null;
}

// Node/undici network failure codes a fresh attempt would heal.
const _RETRYABLE_NET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * True for a TRANSPORT failure (no HTTP response ever arrived): a ky per-call
 * `TimeoutError` or a network error. These must reach the model as a retryable
 * tool result, NOT a thrown JSON-RPC protocol error the client swallows. A heavy
 * tool exceeding its 120s deadline, or a transient blip to the API, otherwise
 * surfaced to the agent as an opaque "protocol error" it could not act on.
 */
function isRetryableTransportError(e: unknown): boolean {
  const err = e as {
    name?: string;
    code?: string;
    message?: string;
    cause?: { code?: string };
  };
  if (err?.name === "TimeoutError") return true;
  const code = err?.code ?? err?.cause?.code;
  if (code && _RETRYABLE_NET_CODES.has(code)) return true;
  // undici surfaces a bare network failure as a TypeError("fetch failed").
  return (
    err?.name === "TypeError" &&
    (err.message ?? "").toLowerCase().includes("fetch failed")
  );
}

/** Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) to seconds. */
function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds)) return Math.max(0, Math.round(asSeconds));
  const at = Date.parse(value);
  if (!Number.isNaN(at)) {
    return Math.max(0, Math.round((at - Date.now()) / 1000));
  }
  return undefined;
}

/**
 * Route a caught value to the right MCP error channel: a ky `HTTPError` (upstream
 * API failure) becomes an isError tool result the agent can act on (see
 * `toToolError`); anything else (zod `ZodError`, the fuzzy-resolver's
 * `InvalidParams`, the unknown-tool guard) is re-thrown as a JSON-RPC protocol
 * error. Throws for the non-HTTP case.
 */
export async function httpErrorToToolResult(
  e: unknown,
  toolName?: string,
): Promise<ToolCallResult> {
  const response = asKyHttpError(e);
  if (response) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const retryAfter = parseRetryAfterHeader(
      response.headers.get("retry-after"),
    );
    return toToolError(
      mapHttpError(response.status, body, requestId, retryAfter, toolName),
    );
  }
  if (isRetryableTransportError(e)) {
    // No HTTP response arrived (timeout / network drop). Surface a retryable
    // tool result so the model can self-correct, not an opaque protocol error.
    const label = toolName ? ` for ${toolName}` : "";
    return {
      content: [
        {
          type: "text",
          text:
            `The Lune API request${label} timed out or the connection dropped before a ` +
            `response. This is usually transient; retry the call.`,
        },
      ],
      isError: true,
    };
  }
  throw e;
}
