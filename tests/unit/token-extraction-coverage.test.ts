import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractTokenStdio, extractTokenHttp } from "../../src/auth/token.js";

describe("extractTokenStdio (coverage)", () => {
  const original = process.env.LUNE_API_KEY;

  beforeEach(() => {
    delete process.env.LUNE_API_KEY;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LUNE_API_KEY;
    } else {
      process.env.LUNE_API_KEY = original;
    }
  });

  it("returns the raw key when LUNE_API_KEY is set", () => {
    process.env.LUNE_API_KEY = "lune_live_xyz";
    expect(extractTokenStdio()).toBe("lune_live_xyz");
  });

  it("trims surrounding whitespace off a valid key", () => {
    process.env.LUNE_API_KEY = "  lune_padded  ";
    expect(extractTokenStdio()).toBe("lune_padded");
  });

  it("throws an actionable error when the env var is unset", () => {
    delete process.env.LUNE_API_KEY;
    expect(() => extractTokenStdio()).toThrow(/LUNE_API_KEY/);
    expect(() => extractTokenStdio()).toThrow(/credentials/i);
  });

  it("throws when the env var is an empty string", () => {
    process.env.LUNE_API_KEY = "";
    expect(() => extractTokenStdio()).toThrow(/LUNE_API_KEY/);
  });

  it("throws when the env var is whitespace only", () => {
    process.env.LUNE_API_KEY = "   \t  ";
    expect(() => extractTokenStdio()).toThrow(/LUNE_API_KEY/);
  });
});

describe("extractTokenHttp (coverage)", () => {
  it("extracts the token from a lowercase authorization header", () => {
    expect(extractTokenHttp({ authorization: "Bearer lune_abc" })).toBe(
      "lune_abc",
    );
  });

  it("extracts the token from a capitalized Authorization header", () => {
    expect(extractTokenHttp({ Authorization: "Bearer x" })).toBe("x");
  });

  it("reads the first value when the header arrives as an array", () => {
    expect(
      extractTokenHttp({ authorization: ["Bearer lune_first", "Bearer other"] }),
    ).toBe("lune_first");
  });

  it("trims surrounding whitespace from the extracted token", () => {
    expect(extractTokenHttp({ authorization: "Bearer   lune_spaced  " })).toBe(
      "lune_spaced",
    );
  });

  it("throws when no authorization header is present", () => {
    expect(() => extractTokenHttp({})).toThrow(/Authorization header/);
  });

  it("throws for a non-Bearer scheme", () => {
    expect(() => extractTokenHttp({ authorization: "Basic x" })).toThrow(
      /Bearer/,
    );
  });

  it("throws when the bearer token is empty", () => {
    expect(() => extractTokenHttp({ authorization: "Bearer " })).toThrow(
      /empty Bearer token/,
    );
  });
});
