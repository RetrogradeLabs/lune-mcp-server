import { afterEach, describe, expect, it, vi } from "vitest";
import { getBaseUrl, makeClient } from "../../src/api/client.js";

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

  it("builds the prefix from the configured base URL", async () => {
    vi.stubEnv("LUNE_API_BASE_URL", "http://localhost:8000");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const client = makeClient("lune_token_abc");
    await client.get("papers/search");

    const request = fetchSpy.mock.calls[0]![0] as Request;
    expect(request.url).toBe("http://localhost:8000/api/v1/papers/search");

    fetchSpy.mockRestore();
  });
});
