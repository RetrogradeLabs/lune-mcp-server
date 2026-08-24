import { describe, it, expect } from "vitest";
import {
  httpErrorToToolResult,
  LuneErrorCode,
  mapHttpError,
  toToolError,
} from "../../src/errors.js";

describe("mapHttpError", () => {
  it("401 → unauthorized with a reconnect hint for any client", () => {
    const e = mapHttpError(401, {}, "req-1");
    expect(e.code).toBe(LuneErrorCode.Unauthorized);
    expect(e.message).toMatch(/re-authorize the connector/i);
    expect(e.message).toMatch(/lune login/i);
    expect(e.data.request_id).toBe("req-1");
  });

  it("401 account_suspended points at the appeal address, not a token rotation", () => {
    // Rotating a credential cannot lift a suspension, so the old "rotate your
    // PAT" line sent the user down a dead end.
    const e = mapHttpError(401, {
      error: "account_suspended",
      appeal_email: "appeal@luneresearch.com",
    });
    expect(e.message).toContain("suspended");
    expect(e.message).toContain("appeal@luneresearch.com");
    expect(e.message).not.toMatch(/lune login/i);
  });

  it("429 → rate_limited with retry_after", () => {
    const e = mapHttpError(429, { retry_after_seconds: 42 }, "req-2");
    expect(e.code).toBe(LuneErrorCode.RateLimited);
    expect(e.data.retry_after_seconds).toBe(42);
    expect(e.message).toContain("42s");
  });

  it("429 with upgrade_hint surfaces upgrade text", () => {
    const e = mapHttpError(429, {
      retry_after_seconds: 60,
      upgrade_hint: "Upgrade to Pro for 5x quota.",
    });
    expect(e.message).toContain("Upgrade to Pro");
  });

  it("403 → forbidden including required scopes", () => {
    const e = mapHttpError(403, {
      error: "insufficient_scope",
      required: ["papers:read"],
    });
    expect(e.code).toBe(LuneErrorCode.Forbidden);
    expect(e.data.required).toEqual(["papers:read"]);
    expect(e.message).toContain("papers:read");
  });

  it("403 reads the scope list out of FastAPI's nested detail", () => {
    // `require_scope` raises HTTPException(403, detail={...}), so this is the
    // shape production actually sends; reading only the flat body dropped the
    // scope list and left the agent with an unactionable "lacks the scope".
    const e = mapHttpError(403, {
      detail: {
        error: "insufficient_scope",
        required: ["guidance:read"],
        granted: ["papers:read"],
      },
    });
    expect(e.message).toContain("guidance:read");
    expect(e.data.required).toEqual(["guidance:read"]);
    expect(e.data.granted).toEqual(["papers:read"]);
  });

  it("404 surfaces detail text when available", () => {
    const e = mapHttpError(404, { detail: "paper not found" });
    expect(e.code).toBe(LuneErrorCode.NotFound);
    expect(e.message).toContain("paper not found");
  });

  it("422 names the offending argument instead of 'Unexpected 422'", () => {
    // FastAPI's 422 body is an ARRAY of {loc, msg}; the string-detail path
    // rendered it as "Unexpected 422", so the model retried the same bad call.
    const e = mapHttpError(
      422,
      {
        detail: [
          {
            type: "value_error",
            loc: ["body", "fields", 0, "name"],
            msg: "Value error, field name 'model_dump' is reserved",
          },
        ],
      },
      undefined,
      undefined,
      "extract_from_papers",
    );
    expect(e.code).toBe(LuneErrorCode.InvalidParams);
    expect(e.message).toContain(
      "fields.0.name: field name 'model_dump' is reserved",
    );
    expect(e.message).toMatch(/retrying unchanged fails identically/i);
  });

  it("402 → quota exhausted with buy-credits url", () => {
    const e = mapHttpError(402, {
      error: "out_of_credits",
      buy_credits_url: "https://x/billing",
    });
    expect(e.code).toBe(LuneErrorCode.QuotaExhausted);
    expect(e.message).toContain("Lune quota exhausted");
    expect(e.message).toContain("https://x/billing");
    expect(e.data.buy_credits_url).toBe("https://x/billing");
  });

  it("402 with no facts at all still hands the user a way out", () => {
    // The body a reader could not parse, or an API that sent nothing but the
    // code. This used to render "you ran out, stop calling Lune" and no way to
    // fix it, which ends the user's session on a dead end.
    const e = mapHttpError(402, { error: "out_of_credits" });
    expect(e.code).toBe(LuneErrorCode.QuotaExhausted);
    // Guidance is client-side, so it survives an API that sends no facts.
    expect(e.message).toContain("did NOT run");
    expect(e.message).toContain("Retrying will fail the same way");
    expect(e.message).toContain("tell the user");
    expect(e.message).toContain("top up credits or move to a bigger plan");
    expect(e.message).toContain(
      "https://luneresearch.com/dashboard/settings/billing",
    );
    expect(e.message).not.toContain("undefined");
    // Structured readers reach the same page the prose names.
    expect(e.data.buy_credits_url).toBe(
      "https://luneresearch.com/dashboard/settings/billing",
    );
    expect(e.data.upgrade_url).toBe(e.data.buy_credits_url);
  });

  it("402 renders the API's quota facts, reset instant and upgrade path", () => {
    const e = mapHttpError(402, {
      error: "out_of_credits",
      reason: "out_of_capacity",
      detail: "Out of Lune requests: this call needs 1 and nothing is left.",
      tier: "free",
      units_required: 1,
      daily_limit: 10,
      used_today: 10,
      remaining_today: 0,
      credits_remaining: 0,
      max_units_now: 0,
      resets_at: "2026-08-16T00:00:00Z",
      upgrade_hint:
        "A higher plan raises the daily allowance: Pro 300/day, Max 600/day.",
      upgrade_url: "https://lune/dashboard/settings/billing",
      buy_credits_url: "https://lune/dashboard/settings/billing",
    });
    expect(e.message).toContain(
      "Usage: 10/10 requests used in today's allowance (free plan), 0 prepaid credits left.",
    );
    expect(e.message).toContain("resets at 2026-08-16T00:00:00Z");
    expect(e.message).toContain("Pro 300/day, Max 600/day");
    expect(e.message).toContain("https://lune/dashboard/settings/billing");
    expect(e.message).toContain("stop calling Lune tools");
    // Nothing is spendable, so there is no smaller retry to suggest.
    expect(e.message).not.toContain("Retry with");
    expect(e.data.resets_at).toBe("2026-08-16T00:00:00Z");
    expect(e.data.daily_limit).toBe(10);
    expect(e.data.credits_remaining).toBe(0);
    expect(e.data.max_units_now).toBe(0);
  });

  it("402 on the largest plan points at credits, never at an upgrade", () => {
    // The API's hint is the only thing that knows whether a bigger plan exists
    // for this org, so pairing it with our own "or move to a bigger plan" would
    // contradict it in the same breath, on the one tier where that is a dead end.
    const e = mapHttpError(402, {
      error: "out_of_credits",
      reason: "out_of_capacity",
      tier: "max",
      units_required: 1,
      daily_limit: 600,
      used_today: 600,
      remaining_today: 0,
      credits_remaining: 0,
      max_units_now: 0,
      upgrade_hint:
        "This is already the largest daily allowance, so prepaid credits are " +
        "the only way to add capacity today.",
      buy_credits_url: "https://x/billing",
    });
    expect(e.message).toContain("prepaid credits are the only way");
    expect(e.message).not.toContain("bigger plan");
    expect(e.message).toContain("Send the user to https://x/billing");
  });

  it("402 on an oversized batch asks for a retry that actually fits, and never says stop", () => {
    // 3 daily + 1 credit serves a batch of 3, NOT 4: a call is paid from one
    // lane, all-or-nothing, so advertising the sum sent the agent into a second
    // guaranteed 402. The API reports the servable size; we must not re-derive it.
    const e = mapHttpError(
      402,
      {
        error: "out_of_credits",
        reason: "call_larger_than_remaining",
        tier: "free",
        units_required: 25,
        daily_limit: 10,
        used_today: 7,
        remaining_today: 3,
        credits_remaining: 1,
        max_units_now: 3,
        resets_at: "2026-08-16T00:00:00Z",
      },
      undefined,
      undefined,
      "search_papers_many",
    );
    expect(e.message).toContain("the most Lune can serve right now is 3");
    expect(e.message).toContain("Retry with fewer `queries`");
    expect(e.message).toContain("needs 3 or fewer");
    expect(e.message).not.toContain("at most 4");
    // Retry advice and a stop instruction must never ship together.
    expect(e.message).not.toMatch(/stop calling Lune tools/i);
    // The dashboard timeline string-matches "quota" to render a hard
    // quota-exhausted step, which is the wrong label for a retryable batch.
    expect(e.message.toLowerCase()).not.toContain("quota");
    expect(e.data.max_units_now).toBe(3);
  });

  it("402 does not promise the reset for a call bigger than the whole allowance", () => {
    // units > daily_limit skips the daily lane entirely, so waiting a day changes
    // nothing for THIS call. Promising the reset costs the user a day.
    const e = mapHttpError(402, {
      error: "out_of_credits",
      reason: "out_of_capacity",
      tier: "free",
      units_required: 20,
      daily_limit: 10,
      used_today: 10,
      remaining_today: 0,
      credits_remaining: 0,
      max_units_now: 0,
      resets_at: "2026-08-16T00:00:00Z",
    });
    expect(e.message).toContain("so will retrying after the reset");
    expect(e.message).toContain("more than the whole 10/day allowance");
    expect(e.message).toContain("a call of 10 or fewer would fit");
    expect(e.message).toMatch(/stop calling Lune tools/i);
    // The ways-out line must agree with that: offering the reset one line above
    // "the reset will not help either" is the same broken promise, twice.
    expect(e.message).not.toContain("wait for the daily reset");
    expect(e.message).toContain(
      "Ways to continue: add capacity with prepaid credits",
    );
  });

  it("402 whose numbers show capacity again asks for one verbatim retry", () => {
    // The numbers are read AFTER the refusal, so a refund / top-up / UTC roll in
    // that window leaves max_units_now >= units_required. Calling that "send a
    // smaller batch" (or "you are out") are both lies.
    const e = mapHttpError(402, {
      error: "out_of_credits",
      reason: "retry_now",
      tier: "pro",
      units_required: 25,
      daily_limit: 300,
      used_today: 300,
      remaining_today: 0,
      credits_remaining: 30,
      max_units_now: 30,
    });
    expect(e.message).toContain("capacity is available again");
    expect(e.message).toContain("Retry the same call ONCE");
    expect(e.message).not.toMatch(/stop calling Lune tools/i);
    expect(e.message).not.toContain("a batch reserves");
    expect(e.data.quota_reason).toBe("retry_now");
  });

  it("402 classifies from the numbers when `reason` is absent or unknown", () => {
    // A published build must not read a NEWER API's reason as terminal: the
    // numbers are self-describing, so derive rather than default to "stop".
    const future = mapHttpError(402, {
      reason: "some_future_reason",
      units_required: 25,
      remaining_today: 30,
      credits_remaining: 0,
    });
    expect(future.data.quota_reason).toBe("retry_now");
    const legacy = mapHttpError(402, {
      units_required: 25,
      remaining_today: 3,
      credits_remaining: 1,
    });
    expect(legacy.data.quota_reason).toBe("batch_too_large");
    const bare = mapHttpError(402, { error: "out_of_credits" });
    expect(bare.data.quota_reason).toBe("no_capacity");
  });

  it("402 on gather_evidence points at the query budget, not the item count", () => {
    // gather_evidence bills `max_total_queries`, so shrinking `queries` alone
    // re-reserves the same ceiling and 402s again.
    const e = mapHttpError(
      402,
      {
        reason: "call_larger_than_remaining",
        units_required: 25,
        max_units_now: 10,
      },
      undefined,
      undefined,
      "gather_evidence",
    );
    expect(e.message).toContain("max_total_queries");
    const unknownTool = mapHttpError(402, {
      reason: "call_larger_than_remaining",
      units_required: 25,
      max_units_now: 10,
    });
    expect(unknownTool.message).toContain("Retry with fewer items");
    // No hint and no URL in that body, so the capacity line falls back to the
    // canonical page: its lead-in colon always has something to introduce.
    expect(unknownTool.message).toContain(
      "add capacity: Send the user to https://luneresearch.com/dashboard/settings/billing",
    );
  });

  it("402 derives the servable size for an API that predates max_units_now", () => {
    const e = mapHttpError(402, {
      units_required: 25,
      remaining_today: 3,
      credits_remaining: 1,
    });
    expect(e.message).toContain("right now is 3");
    expect(e.data.max_units_now).toBe(3);
  });

  it("402 falls back to the API detail sentence when the numbers are missing", () => {
    const e = mapHttpError(402, {
      error: "out_of_credits",
      detail: "Out of Lune requests: the allowance resets at midnight UTC.",
    });
    expect(e.message).toContain(
      "Out of Lune requests: the allowance resets at midnight UTC.",
    );
  });

  it("500+ → server error", () => {
    const e = mapHttpError(503, {});
    expect(e.code).toBe(LuneErrorCode.ServerError);
    expect(e.message).toMatch(/server error/i);
  });

  it("400 surfaces detail with prefix", () => {
    const e = mapHttpError(400, { detail: "limit must be ≤ 50" });
    expect(e.code).toBe(-32600);
    expect(e.message).toContain("limit must be");
  });

  it("400 without a string detail falls back to a generic message", () => {
    const e = mapHttpError(400, {});
    expect(e.code).toBe(-32600);
    expect(e.message).toBe("Unexpected 400 from Lune API");
  });

  it("400 with a non-string detail also uses the generic message", () => {
    const e = mapHttpError(400, { detail: { nested: "object" } });
    expect(e.message).toBe("Unexpected 400 from Lune API");
  });

  it("403 without required scopes uses the generic forbidden message", () => {
    const e = mapHttpError(403, {});
    expect(e.code).toBe(LuneErrorCode.Forbidden);
    expect(e.message).toMatch(/lacks the scope this tool needs/i);
    expect(e.data.required).toEqual([]);
    expect(e.data.granted).toEqual([]);
  });

  it("403 with a non-array required field does not crash the join", () => {
    const e = mapHttpError(403, {
      required: "papers:read" as unknown as string[],
    });
    // Non-array `required` → requiredStr is "" → generic message branch.
    expect(e.message).toMatch(/lacks the scope this tool needs/i);
  });

  it("404 without a string detail falls back to 'Not found'", () => {
    const e = mapHttpError(404, {});
    expect(e.code).toBe(LuneErrorCode.NotFound);
    expect(e.message).toContain("Not found");
  });

  it("404 with a non-string detail also yields 'Not found'", () => {
    const e = mapHttpError(404, { detail: 12345 });
    expect(e.message).toContain("Not found");
  });

  it("429 without a numeric retry_after defaults to 60s", () => {
    const e = mapHttpError(429, {});
    expect(e.code).toBe(LuneErrorCode.RateLimited);
    expect(e.message).toContain("60s");
    expect(e.data.retry_after_seconds).toBe(60);
    expect(e.data.upgrade_hint).toBeUndefined();
  });

  it("429 with a non-string upgrade_hint omits the hint text", () => {
    const e = mapHttpError(429, {
      retry_after_seconds: 30,
      upgrade_hint: 999 as unknown as string,
    });
    expect(e.message).toBe("Rate limited. Retry after 30s.");
  });

  it("429 from Lune's burst guard says it is not the quota", () => {
    // The two 429-ish failures need opposite reactions: this one clears by
    // itself, so the model must not tell the user to buy credits.
    const e = mapHttpError(429, {
      error: "rate_limited",
      retry_after_seconds: 1,
      detail: "Too many Lune requests in one second.",
    });
    expect(e.message).toContain("per-second burst guard");
    expect(e.message).toContain("not your daily allowance");
    expect(e.message).toContain("retry the same call");
  });

  it("429 from an unknown source keeps the generic retry line", () => {
    const e = mapHttpError(429, { retry_after_seconds: 3 });
    expect(e.message).toBe("Rate limited. Retry after 3s.");
  });

  it("accepts a null body without throwing", () => {
    const e = mapHttpError(500, null);
    expect(e.code).toBe(LuneErrorCode.ServerError);
  });

  it("accepts an undefined body without throwing", () => {
    const e = mapHttpError(404, undefined);
    expect(e.message).toContain("Not found");
  });

  it("omits request_id from data when no request id is supplied", () => {
    const e = mapHttpError(401, {});
    expect(e.data.request_id).toBeUndefined();
  });
});

describe("toToolError", () => {
  // Per the MCP spec, upstream API failures are Tool Execution Errors:
  // `{ isError: true }` results whose `content` text carries the actionable
  // message (forwarded into the model's context), NOT JSON-RPC protocol
  // errors (captured by the client and typically dropped).
  it("renders a 429 as an isError result with retryable guidance", () => {
    const r = toToolError(mapHttpError(429, { retry_after_seconds: 5 }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Rate limited");
    expect(r.content[0]!.text).toContain("retry_after_seconds=5");
    expect(r.content[0]!.text).toContain("http_status=429");
  });

  it("renders a 402 as an isError result with the buy-credits url", () => {
    const r = toToolError(
      mapHttpError(402, {
        error: "out_of_credits",
        buy_credits_url: "https://x/billing",
        resets_at: "2026-08-16T00:00:00Z",
      }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Lune quota exhausted");
    expect(r.content[0]!.text).toContain("buy_credits_url=https://x/billing");
    // Machine-parseable footer: the reset instant a client can schedule against.
    expect(r.content[0]!.text).toContain(
      "quota_resets_at=2026-08-16T00:00:00Z",
    );
  });

  it("omits the footer entirely when no actionable fields are present", () => {
    const r = toToolError(mapHttpError(404, { detail: "paper not found" }));
    expect(r.isError).toBe(true);
    // 404 carries only `status` in data; status surfaces as http_status.
    expect(r.content[0]!.text).toBe(
      "paper not found If you do not have a valid paper_id, call search_papers first. " +
        "The id must match the source: a corpus paper_id comes from search_papers " +
        "(source=corpus); a workspace document id comes from " +
        "search_papers(source=workspace) and must be used with source=workspace; a " +
        "guidance doc_id comes from search_research_guidance.\nhttp_status=404",
    );
  });

  it("returns the bare message when the mapped error carries no data fields", () => {
    // Defensive: a hand-built MappedError with empty `data` exercises the
    // no-footer branch (`mapHttpError` always sets `status`, so this path is
    // otherwise unreachable through it).
    const r = toToolError({ code: -32014, message: "boom", data: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("boom");
  });
});

describe("httpErrorToToolResult", () => {
  it("re-throws non-HTTP errors unchanged (they stay protocol errors)", async () => {
    await expect(httpErrorToToolResult(new Error("kaboom"))).rejects.toThrow(
      "kaboom",
    );
  });

  it("converts a ky-shaped 429 into an isError tool result, not a throw", async () => {
    const fake = {
      response: {
        status: 429,
        headers: new Headers({ "x-request-id": "req-z" }),
        json: async () => ({ error: "rate_limited", retry_after_seconds: 1 }),
      },
    };
    const r = await httpErrorToToolResult(fake);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/rate limited/i);
    expect(r.content[0]!.text).toContain("retry_after_seconds=1");
  });

  it("converts a ky-shaped 402 into an isError tool result with the buy-credits url", async () => {
    const fake = {
      response: {
        status: 402,
        headers: new Headers(),
        json: async () => ({
          error: "out_of_credits",
          buy_credits_url: "https://lune/billing",
        }),
      },
    };
    const r = await httpErrorToToolResult(fake);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Lune quota exhausted");
    expect(r.content[0]!.text).toContain(
      "buy_credits_url=https://lune/billing",
    );
  });

  it("tolerates a non-JSON error body", async () => {
    const fake = {
      response: {
        status: 500,
        headers: new Headers(),
        json: async () => {
          throw new Error("not json");
        },
      },
    };
    const r = await httpErrorToToolResult(fake);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/server error/i);
  });

  it("maps a ky TimeoutError to a retryable isError result, not a thrown protocol error", async () => {
    const timeout = Object.assign(new Error("Request timed out"), {
      name: "TimeoutError",
    });
    const r = await httpErrorToToolResult(timeout, "gather_evidence");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/timed out|connection dropped/i);
    expect(r.content[0]!.text).toContain("gather_evidence");
    expect(r.content[0]!.text).toMatch(/retry/i);
  });

  it("maps a network error (ECONNRESET) to a retryable isError result", async () => {
    const netErr = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const r = await httpErrorToToolResult(netErr);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/retry/i);
  });

  it("maps an undici fetch-failed TypeError to a retryable isError result", async () => {
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const r = await httpErrorToToolResult(fetchFailed);
    expect(r.isError).toBe(true);
  });
});

describe("mapHttpError header + steer", () => {
  it("uses the Retry-After header (delta-seconds) when the body lacks retry_after_seconds", () => {
    const m = mapHttpError(429, {}, undefined, 17);
    expect(m.data.retry_after_seconds).toBe(17);
    expect(m.message).toContain("17s");
  });

  it("prefers the body's retry_after_seconds over the header", () => {
    const m = mapHttpError(429, { retry_after_seconds: 5 }, undefined, 99);
    expect(m.data.retry_after_seconds).toBe(5);
  });

  it("falls back to 60s when neither body nor header is present", () => {
    const m = mapHttpError(429, {}, undefined, undefined);
    expect(m.data.retry_after_seconds).toBe(60);
  });

  it("appends a search_papers recovery steer to 404 messages", () => {
    const m = mapHttpError(404, { detail: "Paper not found" });
    expect(m.message).toContain("Paper not found");
    expect(m.message).toContain("call search_papers");
  });

  it("steers paper-id tools to search_papers on 404", () => {
    const m = mapHttpError(
      404,
      { detail: "Paper not found" },
      undefined,
      undefined,
      "get_paper_fulltext",
    );
    expect(m.message).toContain("Paper not found");
    expect(m.message).toContain("call search_papers");
  });

  it("does NOT surface the paper steer for conference tools", () => {
    const conf = mapHttpError(
      404,
      { detail: "Conference 'xyz' not found" },
      undefined,
      undefined,
      "get_conference_papers",
    );
    expect(conf.message).toContain("Conference 'xyz' not found");
    expect(conf.message).not.toContain("call search_papers");
    expect(conf.message).toContain("list_conferences");
  });

  it("steers a guidance-doc 404 to search_research_guidance, not search_papers", () => {
    const m = mapHttpError(
      404,
      { detail: "Guidance document not found" },
      undefined,
      undefined,
      "get_research_guidance_doc",
    );
    expect(m.message).toContain("Guidance document not found");
    expect(m.message).not.toContain("call search_papers");
    expect(m.message).toContain("search_research_guidance");
  });

  it("leaves the detail bare for tools with no recovery steer", () => {
    const m = mapHttpError(
      404,
      { detail: "Nothing here" },
      undefined,
      undefined,
      "search_papers",
    );
    expect(m.message).toBe("Nothing here");
  });
});
