import { describe, it, expect } from "vitest";
import { mapHttpError, LuneErrorCode, rethrowHttpError, toMcpError } from "../../src/errors.js";

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

  it("toMcpError wraps to McpError instance", () => {
    const wrapped = toMcpError(mapHttpError(401, {}));
    expect(wrapped.code).toBe(LuneErrorCode.Unauthorized);
    expect(wrapped).toBeInstanceOf(Error);
  });
});

describe("rethrowHttpError", () => {
  it("rethrows non-HTTP errors unchanged", async () => {
    await expect(rethrowHttpError(new Error("kaboom"))).rejects.toThrow("kaboom");
  });

  it("converts ky-shaped HTTPError to McpError", async () => {
    const fake = {
      response: {
        status: 401,
        headers: new Headers({ "x-request-id": "req-z" }),
        json: async () => ({ detail: "expired" }),
      },
    };
    await expect(rethrowHttpError(fake)).rejects.toMatchObject({
      code: LuneErrorCode.Unauthorized,
    });
  });

  it("tolerates non-JSON error body", async () => {
    const fake = {
      response: {
        status: 500,
        headers: new Headers(),
        json: async () => {
          throw new Error("not json");
        },
      },
    };
    await expect(rethrowHttpError(fake)).rejects.toMatchObject({
      code: LuneErrorCode.ServerError,
    });
  });
});
