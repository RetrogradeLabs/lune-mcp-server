import { TimeoutError } from "ky";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getBaseUrl, makeClient } from "../../src/api/client.js";
import {
  fetchMcpContext,
  RememberedAnswers,
} from "../../src/api/mcp-context.js";
import { ALL_RELEASES, PUBLIC_RELEASES } from "../../src/releases.js";

describe("getBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the production API host when LUNE_API_BASE_URL is unset", () => {
    vi.stubEnv("NODE_ENV", undefined);
    vi.stubEnv("LUNE_API_BASE_URL", undefined);
    expect(getBaseUrl()).toBe("https://api.luneresearch.com");
  });

  it("keeps the published API host under NODE_ENV=production", () => {
    // A stdio install inherits its shell's NODE_ENV; only the hosted server must
    // inject a target, and `assertHostedConfiguration` checks that at boot.
    vi.stubEnv("NODE_ENV", "production");
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

describe("fetchMcpContext", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * One reply per attempt, built fresh because a `Response` body reads only
   * once. `"socket"` drops the connection; a 429 and a 503 carry a one-second
   * `Retry-After`, as the burst guard's and a busy API's do.
   */
  function answering(...replies: (number | "socket")[]) {
    const queue = [...replies];

    return vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      const reply = queue.shift() ?? 200;

      if (reply === "socket")
        return Promise.reject(new TypeError("fetch failed"));

      if (reply === 200)
        return Promise.resolve(Response.json({ figures: true }));

      const headers = new Headers(
        reply === 429 || reply === 503 ? { "retry-after": "1" } : {},
      );

      return Promise.resolve(new Response(null, { status: reply, headers }));
    });
  }

  it.each<[string, number | "socket"]>([
    ["a deploy's 503", 503],
    ["an unhandled 500", 500],
    ["a dropped socket", "socket"],
  ])(
    "absorbs %s within 300ms, since the probe is on every request",
    async (_case, failure) => {
      vi.useFakeTimers();
      const fetchSpy = answering(failure, 200);
      const settled = fetchMcpContext(makeClient("lune_token"));

      await vi.advanceTimersByTimeAsync(300);

      await expect(settled).resolves.toEqual({ figures: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["a refused credential", [401], 1],
    ["the burst guard's 429, which it does not wait out", [429], 1],
    ["an API that stays down", [503, 503, 503], 2],
  ])("gives up on %s", async (_case, statuses, attempts) => {
    vi.useFakeTimers();
    const fetchSpy = answering(...statuses);

    const settled = expect(
      fetchMcpContext(makeClient("lune_token")),
    ).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(300);
    await settled;
    expect(fetchSpy).toHaveBeenCalledTimes(attempts);
  });

  it("spends one bounded attempt on an API that never answers", async () => {
    vi.useFakeTimers();

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>(() => {}));

    const settled = expect(
      fetchMcpContext(makeClient("lune_token")),
    ).rejects.toBeInstanceOf(TimeoutError);

    await vi.advanceTimersByTimeAsync(2_500);
    await settled;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("RememberedAnswers", () => {
  const released = { releases: ALL_RELEASES, workspace: false };
  const withheld = { releases: PUBLIC_RELEASES, workspace: true };

  it("answers only for the credential it heard about, until the answer is too old", () => {
    let now = 0;
    const answers = new RememberedAnswers(10, () => now);

    answers.remember("lune_a", released);

    expect(answers.recall("lune_a")).toEqual(released);
    expect(answers.recall("lune_b")).toBeUndefined();

    now = 5 * 60_000;
    expect(answers.recall("lune_a")).toBeUndefined();
    expect(answers.recall("lune_a", Number.POSITIVE_INFINITY)).toEqual(
      released,
    );
  });

  it("forgets the credential answered longest ago once full", () => {
    const answers = new RememberedAnswers(2);

    answers.remember("lune_a", released);
    answers.remember("lune_b", withheld);
    answers.remember("lune_a", released);
    answers.remember("lune_c", withheld);

    expect(answers.recall("lune_a")).toEqual(released);
    expect(answers.recall("lune_b")).toBeUndefined();
    expect(answers.recall("lune_c")).toEqual(withheld);
  });
});
