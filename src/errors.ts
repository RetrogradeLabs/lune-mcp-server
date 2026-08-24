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
  appeal_email?: string;
  buy_credits_url?: string;
  // Quota facts the API attaches to a 402 (`quota.out_of_credits_payload`).
  upgrade_url?: string;
  reason?: string;
  tier?: string;
  daily_limit?: number;
  used_today?: number;
  remaining_today?: number;
  credits_remaining?: number;
  units_required?: number;
  max_units_now?: number;
  resets_at?: string;
  [k: string]: unknown;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asText(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

/**
 * Where a human clears a quota block. Used when the 402 body carries no
 * `upgrade_url` / `buy_credits_url`: an API that predates them, or a body we
 * could not read at all. A quota message whose only content is "you ran out"
 * ends the user's session there, so the way out is never conditional on the
 * body. Same constant the CLI keeps for the same reason (`packages/cli/src/errors.ts`).
 */
const BILLING_URL = "https://luneresearch.com/dashboard/settings/billing";

/**
 * Flatten a FastAPI-shaped error body. A dependency that raises
 * `HTTPException(403, detail={...})` (i.e. `require_scope`) nests its fields one
 * level down, while the middleware-emitted bodies (quota, rate limit, auth) are
 * flat. Reading only the flat shape silently dropped the required-scope list,
 * which is the one actionable part of a 403.
 */
function flattenDetail(body: ApiErrorBody): ApiErrorBody {
  const nested = body.detail;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as ApiErrorBody)
    : body;
}

/**
 * The largest single call Lune can still serve, per the API.
 *
 * Falls back to `max(remaining_today, credits_remaining)` for an API that predates
 * `max_units_now`. It is a MAX, never a sum: admission is per-lane and
 * all-or-nothing (a call is paid entirely from today's allowance or entirely from
 * credits), so 3 leftover requests plus 1 credit serves a batch of 3, not 4.
 * Advertising the sum told agents to retry a batch that 402s again.
 */
function maxUnitsNow(body: ApiErrorBody): number | undefined {
  const reported = asNumber(body.max_units_now);
  if (reported !== undefined) return reported;
  const remaining = asNumber(body.remaining_today);
  const credits = asNumber(body.credits_remaining);
  if (remaining === undefined && credits === undefined) return undefined;
  return Math.max(remaining ?? 0, credits ?? 0);
}

/**
 * The argument each fan-out tool bills on, so the retry advice names the field
 * the model must actually shrink. `gather_evidence` bills a query BUDGET, not an
 * item count (`max_total_queries` when a loop is enabled, else the number of
 * queries), so telling it to "send fewer items" would re-reserve the same ceiling
 * and 402 again.
 */
const FANOUT_RETRY_KNOB: Record<string, string> = {
  search_papers_many: "fewer `queries`",
  extract_from_papers: "fewer `paper_ids`",
  verify_claims: "fewer `claims`",
  gather_evidence:
    "a lower `max_total_queries` (or fewer `queries` when `max_iterations` is 1)",
};

/** The numbers behind the block, or the API's own sentence when they are absent. */
function quotaUsageLine(body: ApiErrorBody): string | undefined {
  const limit = asNumber(body.daily_limit);
  const used = asNumber(body.used_today);
  const credits = asNumber(body.credits_remaining);
  if (limit === undefined || used === undefined || credits === undefined) {
    return asText(body.detail);
  }
  const plan = asText(body.tier);
  return (
    `Usage: ${used}/${limit} requests used in today's allowance` +
    `${plan ? ` (${plan} plan)` : ""}, ${plural(credits, "prepaid credit")} left.`
  );
}

/**
 * Wait / credits / plan, with the API's tier-aware plan sentence and the link.
 *
 * ALWAYS returns a sentence, so no 402 can reach the user without a way out of it
 * (a bare `{"error":"out_of_credits"}`, or a body that failed to parse, used to
 * render "you ran out, stop calling Lune" and nothing else). The link falls back
 * to `BILLING_URL`; only the plan sentence is conditional, because the API's hint
 * is what knows whether a larger plan exists for this tier at all.
 */
function addCapacityLine(body: ApiErrorBody, lead: string): string {
  const url =
    asText(body.upgrade_url) ?? asText(body.buy_credits_url) ?? BILLING_URL;
  // The API's hint carries the plan lever, so this never names one itself: on the
  // largest tier there is no upgrade, and naming one anyway contradicts the
  // sentence right before it. Only a body with NO hint gets the generic pair.
  const hint = asText(body.upgrade_hint);
  return [
    lead,
    hint,
    hint
      ? `Send the user to ${url} to do that; include that link in your reply.`
      : `Send the user to ${url} to top up credits or move to a bigger plan; ` +
        "include that link in your reply.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A fan-out call refused because the BATCH was too big, while a smaller one still
 * goes through right now. This is the only block the model can fix by itself, so
 * it gets retry advice and NOT the "stop calling Lune tools" instruction, which
 * would strand the user with capacity left on their account.
 */
function batchTooLargeMessage(
  body: ApiErrorBody,
  needed: number,
  servable: number,
  toolName?: string,
): string {
  const knob = toolName ? FANOUT_RETRY_KNOB[toolName] : undefined;
  const lines = [
    `Lune did not run this call: a batch reserves one request per item, so it ` +
      `needed ${needed}, and the most Lune can serve right now is ${servable}.`,
  ];
  const usage = quotaUsageLine(body);
  if (usage) {
    lines.push(
      `${usage} A call draws on the allowance or on credits, never both, so ` +
        `${servable} is the ceiling for one call.`,
    );
  }
  lines.push(
    `Retry with ${knob ?? "fewer items"} so the call needs ${servable} or fewer. ` +
      "Nothing was charged for this attempt.",
  );
  lines.push(
    addCapacityLine(
      body,
      "If the user wants the full batch instead, they can add capacity:",
    ),
  );
  return lines.filter(Boolean).join("\n");
}

/**
 * The API refused the call, then saw capacity again (`reason="retry_now"`): a
 * refund, a top-up, or the UTC-day roll landed between the two. The numbers are
 * read after the admission decision, so this is unavoidable; the one correct
 * instruction is a single verbatim retry, and "once" is explicit so a flapping
 * balance cannot turn into a retry loop.
 */
function retryNowMessage(body: ApiErrorBody): string {
  const lines = [
    "Lune refused this call for capacity, but capacity is available again now " +
      "(a refund, a top-up, or the daily reset landed in between). Nothing was charged.",
  ];
  const usage = quotaUsageLine(body);
  if (usage) lines.push(usage);
  lines.push(
    "Retry the same call ONCE. If it fails again, treat that failure as the " +
      "real answer and tell the user rather than retrying further.",
  );
  return lines.join("\n");
}

/**
 * Nothing is spendable: no retry of any size works before the reset
 * (`reason="out_of_capacity"`).
 *
 * This is TERMINAL until a human acts, and it reaches that human only if the model
 * relays it, so the text states that the call never ran, gives the numbers and the
 * reset instant, hands over the options plus the link, and only then instructs the
 * model. The instruction goes LAST because many clients render tool-error text
 * verbatim in the transcript, so the user should read the facts first. Retrying is
 * called out as futile because the default agent reflex on a tool error is to try
 * again, which burns turns and buries the one message the user needs.
 */
function noCapacityMessage(body: ApiErrorBody): string {
  const lines = [
    "Lune quota exhausted: this call did NOT run and nothing was charged.",
  ];
  const usage = quotaUsageLine(body);
  if (usage) lines.push(usage);

  // Waiting only helps a call that FITS the allowance. A batch bigger than the
  // whole daily cap 402s again after the reset, so naming the reset as the fix
  // would cost the user a day for nothing, and the ways-out line must not offer
  // it either.
  const needed = asNumber(body.units_required);
  const limit = asNumber(body.daily_limit);
  const resetsAt = asText(body.resets_at);
  const resetHelps = !(
    needed !== undefined &&
    limit !== undefined &&
    needed > limit
  );
  lines.push(
    addCapacityLine(
      body,
      resetHelps
        ? "Ways to continue: wait for the daily reset, or add capacity now with " +
            "prepaid credits (they never expire)."
        : "Ways to continue: add capacity with prepaid credits (they never expire) " +
            "or a bigger plan.",
    ),
  );

  if (!resetHelps) {
    lines.push(
      `Retrying will fail the same way, and so will retrying after the reset: ` +
        `this one call needs ${needed} requests, more than the whole ${limit}/day ` +
        `allowance (a call of ${limit} or fewer would fit). Stop calling Lune ` +
        "tools and tell the user the above.",
    );
  } else {
    lines.push(
      `Retrying will fail the same way${
        resetsAt ? ` until the allowance resets at ${resetsAt}` : ""
      }, so stop calling Lune tools, tell the user the above, and do not quietly ` +
        `answer their research question from a non-Lune source instead.`,
    );
  }
  return lines.join("\n");
}

/**
 * Which of the three 402 states this body describes.
 *
 * Trusts the API's `reason` for the states this build knows, and DERIVES from the
 * numbers otherwise: an older API sends no `reason`, and a newer one may send a
 * value this published build predates, in which case falling back to "terminal"
 * would tell the user to stop when a retry was the fix. The numbers are
 * self-describing, so derivation is strictly better than a default.
 */
function classifyQuotaBlock(
  body: ApiErrorBody,
  needed: number | undefined,
  servable: number | undefined,
): "no_capacity" | "batch_too_large" | "retry_now" {
  if (body.reason === "out_of_capacity") return "no_capacity";
  if (needed === undefined || servable === undefined || servable <= 0) {
    return "no_capacity";
  }
  if (body.reason === "call_larger_than_remaining") return "batch_too_large";
  if (body.reason === "retry_now") return "retry_now";
  return servable >= needed ? "retry_now" : "batch_too_large";
}

type QuotaBlock = ReturnType<typeof classifyQuotaBlock>;

/**
 * Compose the agent-facing 402 message for an already-classified state.
 *
 * The three 402 states need OPPOSITE behaviour (stop and tell the user / retry
 * smaller / retry as-is once), so the branch happens before any wording. Facts
 * come from the API's structured fields, so the wording here can be agent-shaped
 * without duplicating them; a body with no facts at all still gets the guidance.
 */
function quotaMessageFor(
  state: QuotaBlock,
  body: ApiErrorBody,
  needed: number | undefined,
  servable: number | undefined,
  toolName?: string,
): string {
  if (state === "retry_now") return retryNowMessage(body);
  if (
    state === "batch_too_large" &&
    needed !== undefined &&
    servable !== undefined
  ) {
    return batchTooLargeMessage(body, needed, servable, toolName);
  }
  return noCapacityMessage(body);
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

/**
 * Flatten FastAPI's 422 body, which is an ARRAY of `{loc, msg}` objects rather
 * than the string `detail` every other status carries. Without this the default
 * branch renders it as "Unexpected 422 from Lune API", stripping the one
 * sentence that names the offending argument, so the model retries the same
 * call verbatim instead of correcting it. `loc` drops the leading "body" and
 * `msg` drops pydantic's "Value error, " prefix, leaving `paper_ids.0: ...`.
 */
function validationLines(body: ApiErrorBody): string | undefined {
  if (!Array.isArray(body.detail)) return undefined;
  const lines = body.detail.slice(0, 5).map((item) => {
    const e = (item ?? {}) as { loc?: unknown; msg?: unknown };
    const path = Array.isArray(e.loc)
      ? e.loc.filter((p) => p !== "body").join(".")
      : "";
    const msg = (asText(e.msg) ?? "invalid value").replace(
      /^Value error, /,
      "",
    );
    return path ? `${path}: ${msg}` : msg;
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

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
    case 401: {
      // A suspended account is NOT a credential problem, so rotating one is a
      // dead end; name the appeal address instead.
      if (safeBody.error === "account_suspended") {
        const appeal =
          asText(safeBody.appeal_email) ?? "appeal@luneresearch.com";
        return {
          code: LuneErrorCode.Unauthorized,
          message:
            "This Lune account is suspended, so no Lune tool will succeed. Stop " +
            `retrying and tell the user to appeal at ${appeal}; new credentials ` +
            "will not change this.",
          data: { ...base, error: "account_suspended", appeal_email: appeal },
        };
      }
      return {
        code: LuneErrorCode.Unauthorized,
        message:
          "Unauthorized: the Lune credential is expired, revoked, or invalid. Tell " +
          "the user to reconnect Lune in this client: re-authorize the connector, " +
          "or replace the API key (`lune login` for the CLI).",
        data: base,
      };
    }
    case 402: {
      const needed = asNumber(safeBody.units_required);
      const servable = maxUnitsNow(safeBody);
      const state = classifyQuotaBlock(safeBody, needed, servable);
      return {
        code: LuneErrorCode.QuotaExhausted,
        message: quotaMessageFor(state, safeBody, needed, servable, toolName),
        // Mirror the quota facts into `data` so a client that reads structured
        // error fields (rather than the text) can render its own prompt.
        // `quota_reason` is OUR classification, not the raw API `reason`, so a
        // consumer never has to re-derive it (and gets one for a legacy body).
        data: {
          ...base,
          // Resolved, never raw: a client that renders `data` instead of the text
          // must reach the same page the message names.
          buy_credits_url: asText(safeBody.buy_credits_url) ?? BILLING_URL,
          upgrade_url: asText(safeBody.upgrade_url) ?? BILLING_URL,
          quota_reason: state,
          resets_at: asText(safeBody.resets_at),
          tier: asText(safeBody.tier),
          daily_limit: asNumber(safeBody.daily_limit),
          used_today: asNumber(safeBody.used_today),
          remaining_today: asNumber(safeBody.remaining_today),
          credits_remaining: asNumber(safeBody.credits_remaining),
          units_required: needed,
          max_units_now: servable,
        },
      };
    }
    case 403: {
      const fields = flattenDetail(safeBody);
      const required = fields.required ?? [];
      const granted = fields.granted ?? [];
      const requiredStr = Array.isArray(required) ? required.join(", ") : "";
      return {
        code: LuneErrorCode.Forbidden,
        message: requiredStr
          ? `Forbidden: this Lune credential is missing the ${requiredStr} scope. ` +
            "Retrying will not help; tell the user to re-authorize the Lune " +
            "connector or issue a new API key that includes it."
          : "Forbidden: this Lune credential lacks the scope this tool needs. " +
            "Tell the user to re-authorize Lune or issue a new API key for it.",
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
      const hint = asText(safeBody.upgrade_hint);
      // Lune's own 429 is the per-second burst guard, which clears on its own;
      // say so, or the model reads any 429 as "out of quota" and stops working
      // (and tells the user to buy something they do not need).
      const lane =
        safeBody.error === "rate_limited"
          ? " This is Lune's short per-second burst guard, not your daily " +
            "allowance or credit balance: wait it out, retry the same call, and " +
            "avoid firing many Lune tools in parallel."
          : "";
      return {
        code: LuneErrorCode.RateLimited,
        message:
          `Rate limited. Retry after ${retry}s.${lane}` +
          (hint ? ` ${hint}` : ""),
        data: { ...base, retry_after_seconds: retry, upgrade_hint: hint },
      };
    }
    case 422: {
      // The arguments are wrong, not the service: a verbatim retry fails
      // identically, so say so and name the field the model must change.
      const lines = validationLines(safeBody);
      return {
        code: LuneErrorCode.InvalidParams,
        message: lines
          ? `Lune rejected the arguments for this call:\n${lines}\n` +
            "Fix the named argument and call again; retrying unchanged fails identically."
          : "Lune rejected the arguments for this call. Re-read the tool's input " +
            "schema, fix the arguments, and call again; retrying unchanged fails identically.",
        data: { ...base, body: safeBody },
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
 * The footer appends the actionable fields (retry_after_seconds, buy_credits_url,
 * quota_reason, quota_resets_at, http_status) as one space-joined `k=v` line so a
 * consumer can parse them from `content`, the only channel every client forwards.
 * That line is also how the dashboard timeline labels a quota step
 * (`_error_step_detail` reads `quota_reason=`) without pattern-matching our
 * prose, which silently mislabelled a retryable batch.
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
  if (typeof data.quota_reason === "string") {
    footer.push(`quota_reason=${data.quota_reason}`);
  }
  if (typeof data.resets_at === "string") {
    footer.push(`quota_resets_at=${data.resets_at}`);
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
