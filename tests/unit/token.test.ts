import { describe, it, expect, vi, afterEach } from "vitest";
import { extractTokenStdio, extractTokenHttp } from "../../src/auth/token.js";

describe("extractTokenStdio", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads LUNE_API_KEY from env", () => {
    vi.stubEnv("LUNE_API_KEY", "lune_abc123");
    expect(extractTokenStdio()).toBe("lune_abc123");
  });

  it("trims whitespace", () => {
    vi.stubEnv("LUNE_API_KEY", "  lune_abc123  ");
    expect(extractTokenStdio()).toBe("lune_abc123");
  });

  it("throws if env missing", () => {
    vi.stubEnv("LUNE_API_KEY", "");
    expect(() => extractTokenStdio()).toThrow(/LUNE_API_KEY/);
  });
});

describe("extractTokenHttp", () => {
  it("extracts Bearer from lowercase Authorization header", () => {
    expect(extractTokenHttp({ authorization: "Bearer eyJabc" })).toBe("eyJabc");
  });

  it("extracts Bearer from PascalCase Authorization header", () => {
    expect(extractTokenHttp({ Authorization: "Bearer pat_xyz" })).toBe("pat_xyz");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractTokenHttp({ authorization: "bearer xyz" })).toBe("xyz");
    expect(extractTokenHttp({ authorization: "BEARER xyz" })).toBe("xyz");
  });

  it("handles array header values (some Node frameworks)", () => {
    expect(extractTokenHttp({ authorization: ["Bearer abc"] })).toBe("abc");
  });

  it("throws on missing header", () => {
    expect(() => extractTokenHttp({})).toThrow(/missing/i);
  });

  it("throws on Basic scheme", () => {
    expect(() => extractTokenHttp({ authorization: "Basic xx" })).toThrow(/bearer/i);
  });

  it("throws on empty bearer token", () => {
    expect(() => extractTokenHttp({ authorization: "Bearer  " })).toThrow(/empty/i);
  });
});
