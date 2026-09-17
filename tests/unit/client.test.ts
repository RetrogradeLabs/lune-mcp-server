import { afterEach, describe, expect, it, vi } from "vitest";
import { getBaseUrl, makeClient } from "../../src/api/client.js";

describe("getBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the production API host when LUNE_API_BASE_URL is unset", () => {
    vi.stubEnv("NODE_ENV", undefined);
    vi.stubEnv("LUNE_API_BASE_URL", undefined);
    expect(getBaseUrl()).toBe("https://api.luneresearch.com");
  });

  it("fails closed when a hosted production task omits its API target", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LUNE_API_BASE_URL", undefined);
    expect(() => getBaseUrl()).toThrow(/LUNE_API_BASE_URL/);
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
    expect(client).toHaveProperty("get");
    expect(client).toHaveProperty("post");
    expect(client).toHaveProperty("delete");
  });

  it("builds the prefix from the configured base URL", async () => {
    vi.stubEnv("LUNE_API_BASE_URL", "http://localhost:8000");

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const client = makeClient("lune_token_abc");
    await client.get("papers/search");

    const request = fetchSpy.mock.calls[0]?.[0];

    if (!(request instanceof Request)) {
      throw new Error("ky did not call fetch with a Request");
    }

    expect(request.url).toBe("http://localhost:8000/api/v1/papers/search");

    fetchSpy.mockRestore();
  });
});
