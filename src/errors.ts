import { McpError } from "@modelcontextprotocol/sdk/types.js";

import type { ToolCallResult } from "./tools/_shared.js";

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

export function mapHttpError(
  status: number,
  body: ApiErrorBody | null | undefined,
  requestId?: string,
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
    case 404:
      return {
        code: LuneErrorCode.NotFound,
        message: typeof safeBody.detail === "string" ? safeBody.detail : "Not found",
        data: base,
      };
    case 402: {
      const buyUrl = typeof safeBody.buy_credits_url === "string" ? safeBody.buy_credits_url : undefined;
      const message = buyUrl
        ? `Quota exhausted. Upgrade your plan or top up credits to continue: ${buyUrl}`
        : "Quota exhausted. Upgrade your plan or top up credits to continue.";
      return {
        code: LuneErrorCode.QuotaExhausted,
        message,
        data: { ...base, buy_credits_url: buyUrl },
      };
    }
    case 429: {
      const retry = typeof safeBody.retry_after_seconds === "number" ? safeBody.retry_after_seconds : 60;
      const hint = typeof safeBody.upgrade_hint === "string" ? safeBody.upgrade_hint : undefined;
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

export function toMcpError(m: MappedError): McpError {
  return new McpError(m.code, m.message, m.data);
}

/**
 * Render a mapped upstream error as an MCP "tool execution error": a normal
 * tool result with `isError: true` and a single text block carrying the
 * actionable message.
 *
 * Per the MCP spec (Tools > Error Handling, rev 2025-06-18 and 2025-11-25),
 * upstream API failures and business-logic errors are Tool Execution Errors,
 * NOT JSON-RPC protocol errors: "Tool Execution Errors contain actionable
 * feedback that language models can use to self-correct and retry [...]
 * Clients SHOULD provide tool execution errors to language models to enable
 * self-correction." A JSON-RPC protocol error, by contrast, is captured by
 * the client and typically NOT forwarded into the model's context, so the
 * agent never sees our retry / buy-credits guidance and cannot recover. The
 * spec's own example tool execution error is a rate limit
 * ("API rate limit exceeded"), so 429 (transient, retryable) and 402
 * (quota / credits exhausted) both belong here, as does every other upstream
 * HTTP failure mapped by `mapHttpError`.
 *
 * The text leads with the human-readable message, then appends a compact
 * machine-readable footer (status + the actionable fields) on its own lines
 * so an agent can parse `retry_after_seconds` / `buy_credits_url` without a
 * separate structured channel (`content` is the field every client forwards).
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
  if (typeof data.status === "number") footer.push(`http_status=${data.status}`);
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

/**
 * Map a caught value to the right MCP error channel.
 *
 *   • ky `HTTPError` (an upstream Lune API failure) → resolve a
 *     `ToolCallResult` with `isError: true` so the agent receives the
 *     actionable message in-context (see `toToolError`).
 *   • Anything else (zod input-validation `ZodError`, the fuzzy-resolver's
 *     `InvalidParams` `McpError`, the `unknown tool` guard) → re-thrown so the
 *     SDK serialises it as a JSON-RPC protocol error. These are malformed
 *     requests / unknown tools, which the spec assigns to Protocol Errors and
 *     which a model is unlikely to recover from anyway.
 *
 * Returns the tool result for the HTTP-error case and never returns
 * (always throws) otherwise.
 */
export async function httpErrorToToolResult(e: unknown): Promise<ToolCallResult> {
  const response = asKyHttpError(e);
  if (response) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    return toToolError(mapHttpError(response.status, body, requestId));
  }
  throw e;
}
