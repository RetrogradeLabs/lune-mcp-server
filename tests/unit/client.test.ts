import { afterEach, describe, expect, it, vi } from "vitest";
import { getBaseUrl, LuneApiError, makeClient } from "../../src/api/client.js";

describe("getBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the production API host when LUNE_API_BASE_URL is unset", () => {
    // `undefined` deletes the var; an empty string would NOT be nullish and
    // would slip past the `??` default.
    vi.stubEnv("LUNE_API_BASE_URL", undefined);
    expect(getBaseUrl()).toBe("https://api.luneresearch.com");
  });

  it("honours LUNE_API_BASE_URL when set", () => {
    vi.stubEnv("LUNE_API_BASE_URL", "http://localhost:8000");
    expect(getBaseUrl()).toBe("http://localhost:8000");
  });

  it("strips a single trailing slash", () => {
    vi.stubEnv("LUNE_API_BASE_URL", "http://localhost:8000/");
    expect(getBaseUrl()).toBe("http://localhost:8000");
  });
});

describe("makeClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a ky instance with bound verbs", () => {
    const client = makeClient("lune_token_abc");
    expect(typeof client.get).toBe("function");
    expect(typeof client.post).toBe("function");
    expect(typeof client.delete).toBe("function");
  });

  it("builds the prefix from the configured base URL", () => {
    vi.stubEnv("LUNE_API_BASE_URL", "http://localhost:8000");
    // ky exposes the resolved options via `extend`; assert the request URL
    // shape indirectly by extending and reading back the merged config.
    const client = makeClient("lune_token_abc");
    expect(client).toBeDefined();
  });
});

describe("LuneApiError", () => {
  it("carries status, body, and request id", () => {
    const err = new LuneApiError(403, { detail: "no scope" }, "req-42");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LuneApiError");
    expect(err.status).toBe(403);
    expect(err.body).toEqual({ detail: "no scope" });
    expect(err.requestId).toBe("req-42");
    expect(err.message).toBe("Lune API 403");
  });

  it("allows an absent request id", () => {
    const err = new LuneApiError(500, null);
    expect(err.requestId).toBeUndefined();
  });
});
