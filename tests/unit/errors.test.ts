import { describe, it, expect } from "vitest";
import {
  httpErrorToToolResult,
  LuneErrorCode,
  mapHttpError,
  toMcpError,
  toToolError,
} from "../../src/errors.js";

describe("mapHttpError", () => {
  it("401 → unauthorized with rotate hint", () => {
    const e = mapHttpError(401, {}, "req-1");
    expect(e.code).toBe(LuneErrorCode.Unauthorized);
    expect(e.message).toMatch(/rotate|lune login/i);
    expect(e.data.request_id).toBe("req-1");
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
    const e = mapHttpError(403, { error: "insufficient_scope", required: ["papers:read"] });
    expect(e.code).toBe(LuneErrorCode.Forbidden);
    expect(e.data.required).toEqual(["papers:read"]);
    expect(e.message).toContain("papers:read");
  });

  it("404 surfaces detail text when available", () => {
    const e = mapHttpError(404, { detail: "paper not found" });
    expect(e.code).toBe(LuneErrorCode.NotFound);
    expect(e.message).toBe("paper not found");
  });

  it("402 → quota exhausted with buy-credits url", () => {
    const e = mapHttpError(402, {
      error: "out_of_credits",
      buy_credits_url: "https://x/billing",
    });
    expect(e.code).toBe(LuneErrorCode.QuotaExhausted);
    expect(e.message).toContain("Quota exhausted");
    expect(e.message).toContain("https://x/billing");
    expect(e.data.buy_credits_url).toBe("https://x/billing");
  });

  it("402 without a url ends with a period", () => {
    const e = mapHttpError(402, { error: "out_of_credits" });
    expect(e.code).toBe(LuneErrorCode.QuotaExhausted);
    expect(e.message).toBe("Quota exhausted. Upgrade your plan or top up credits to continue.");
    expect(e.data.buy_credits_url).toBeUndefined();
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
    expect(e.message).toMatch(/lacks the required scope/i);
    expect(e.data.required).toEqual([]);
    expect(e.data.granted).toEqual([]);
  });

  it("403 with a non-array required field does not crash the join", () => {
    const e = mapHttpError(403, {
      required: "papers:read" as unknown as string[],
    });
    // Non-array `required` → requiredStr is "" → generic message branch.
    expect(e.message).toMatch(/lacks the required scope/i);
  });

  it("404 without a string detail falls back to 'Not found'", () => {
    const e = mapHttpError(404, {});
    expect(e.code).toBe(LuneErrorCode.NotFound);
    expect(e.message).toBe("Not found");
  });

  it("404 with a non-string detail also yields 'Not found'", () => {
    const e = mapHttpError(404, { detail: 12345 });
    expect(e.message).toBe("Not found");
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

  it("accepts a null body without throwing", () => {
    const e = mapHttpError(500, null);
    expect(e.code).toBe(LuneErrorCode.ServerError);
  });

  it("accepts an undefined body without throwing", () => {
    const e = mapHttpError(404, undefined);
    expect(e.message).toBe("Not found");
  });

  it("omits request_id from data when no request id is supplied", () => {
    const e = mapHttpError(401, {});
    expect(e.data.request_id).toBeUndefined();
  });

  it("toMcpError wraps to McpError instance", () => {
    const wrapped = toMcpError(mapHttpError(401, {}));
    expect(wrapped.code).toBe(LuneErrorCode.Unauthorized);
    expect(wrapped).toBeInstanceOf(Error);
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
      }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Quota exhausted");
    expect(r.content[0]!.text).toContain("buy_credits_url=https://x/billing");
  });

  it("omits the footer entirely when no actionable fields are present", () => {
    const r = toToolError(mapHttpError(404, { detail: "paper not found" }));
    expect(r.isError).toBe(true);
    // 404 carries only `status` in data; status surfaces as http_status.
    expect(r.content[0]!.text).toBe("paper not found\nhttp_status=404");
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
    expect(r.content[0]!.text).toContain("Quota exhausted");
    expect(r.content[0]!.text).toContain("buy_credits_url=https://lune/billing");
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
});
