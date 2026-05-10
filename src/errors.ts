import { McpError } from "@modelcontextprotocol/sdk/types.js";

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
 * Adapter: catch ky `HTTPError` and rethrow as a typed MCP error so each
 * tool handler doesn't repeat the boilerplate.
 */
export async function rethrowHttpError(e: unknown): Promise<never> {
  // ky errors expose `.response`. Avoid importing `HTTPError` directly
  // to keep this file usable from tests that don't import ky.
  const maybe = e as { response?: { status: number; headers: Headers; json: () => Promise<unknown> } };
  if (maybe?.response) {
    const status = maybe.response.status;
    let body: ApiErrorBody | null = null;
    try {
      body = (await maybe.response.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    const requestId = maybe.response.headers.get("x-request-id") ?? undefined;
    throw toMcpError(mapHttpError(status, body, requestId));
  }
  throw e;
}
