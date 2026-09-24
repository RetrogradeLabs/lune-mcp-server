/**
 * The upstream-HTTP seam for tests: a structurally complete `KyInstance` whose
 * verbs record what a handler asked for and reply from a per-test responder.
 *
 * `KyInstance` is a published type alias with no private members, so the double
 * inhabits it for real instead of being laundered through `as unknown as`. Only
 * the reply keeps one assertion (see `replyOf`): a test double cannot produce a
 * real `Response`, and no consumer in `src/` reads more of one than `.json()`
 * and `.headers.get()`.
 *
 * Recorded options are read back through the helpers below rather than field by
 * field, so every test asserts the same thing the API would see: a request body
 * as `JSON.stringify` leaves it, and query parameters as their URL wire form.
 */
import ky, {
  type Input,
  type KyInstance,
  type Options as KyOptions,
  type ResponsePromise,
} from "ky";

import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../../src/json.js";

export type KyVerb =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "query";

export type RecordedCall = {
  method: KyVerb;
  url: string;
  options: KyOptions | undefined;
};

export function callTo(
  calls: readonly RecordedCall[],
  url: string,
  method?: KyVerb,
): RecordedCall {
  const call = calls.find(
    (candidate) =>
      candidate.url === url &&
      (method === undefined || candidate.method === method),
  );

  if (!call) {
    const verb = method === undefined ? "request" : method.toUpperCase();
    throw new Error(`recorded calls contain no ${verb} ${url}`);
  }

  return call;
}

export function callAt(
  calls: readonly RecordedCall[],
  index: number,
): RecordedCall {
  const call = calls.at(index);

  if (!call) throw new Error(`recorded calls contain no entry at ${index}`);

  return call;
}

/**
 * The shape `errors.ts:isHttpError` recognizes a ky `HTTPError` by. Declared
 * here rather than reusing ky's own class because the tests need to name a
 * status and a body without owning a `Request`, and the mapper reads the
 * response by duck type on purpose (so a malformed throwable stays malformed).
 */
export type FakeHttpError = {
  response: {
    status: number;
    headers: Headers;
    json: () => Promise<JsonValue>;
  };
};

/** How a fake ky answers one call. */
export type FakeReply =
  | {
      kind: "json";
      body: JsonValue;
      /** `Cache-Control` on the reply; `cachedJson` reads only this header. */
      cacheControl?: string;
      /**
       * Drop the `headers` member entirely, which is the "verb-level mock with
       * no headers" case `cachedJson`'s `hasHeaders` guard exists for.
       */
      withoutHeaders?: boolean;
    }
  | {
      kind: "httpError";
      status: number;
      body: JsonValue;
      requestId?: string;
      retryAfter?: string;
    }
  | { kind: "thrown"; cause: Error };

/** An empty successful reply, which is what most calls under test need. */
export const EMPTY_REPLY: FakeReply = { kind: "json", body: {} };

export function jsonReply(
  body: JsonValue,
  extras: { cacheControl?: string; withoutHeaders?: boolean } = {},
): FakeReply {
  const reply: FakeReply = { kind: "json", body };

  if (extras.cacheControl !== undefined)
    reply.cacheControl = extras.cacheControl;

  if (extras.withoutHeaders) reply.withoutHeaders = true;

  return reply;
}

export function httpErrorReply(
  status: number,
  body: JsonValue = {},
  extras: { requestId?: string; retryAfter?: string } = {},
): FakeReply {
  const reply: FakeReply = { kind: "httpError", status, body };

  if (extras.requestId !== undefined) reply.requestId = extras.requestId;

  if (extras.retryAfter !== undefined) reply.retryAfter = extras.retryAfter;

  return reply;
}

/** Decides the reply for one call. Called at `.json()` time, not at verb time. */
export type FakeResponder = (call: RecordedCall) => FakeReply;

export type FakeKy = {
  ky: KyInstance;
  /** Every verb call, in order, across the instance and everything it extended. */
  calls: RecordedCall[];
  /** Every option bag passed to `extend`, in order. */
  extensions: KyOptions[];
};

type FakeResponseBody = {
  json: () => Promise<JsonValue>;
  headers?: Headers;
};

function replyOf(reply: FakeResponseBody): ResponsePromise<never> {
  // SAFETY: MCP code reads only json() and optional headers.get() from replies;
  // this narrow fake cannot construct a real Response but supplies that subset.
  return reply as ResponsePromise<never>;
}

function bodyFor(reply: FakeReply): FakeResponseBody {
  if (reply.kind === "thrown") {
    const { cause } = reply;

    return { json: () => Promise.reject(cause), headers: new Headers() };
  }

  if (reply.kind === "httpError") {
    const headers = new Headers();

    if (reply.requestId !== undefined) {
      headers.set("x-request-id", reply.requestId);
    }

    if (reply.retryAfter !== undefined) {
      headers.set("retry-after", reply.retryAfter);
    }

    const failure: FakeHttpError = {
      response: {
        status: reply.status,
        headers,
        json: () => Promise.resolve(reply.body),
      },
    };

    return { json: () => Promise.reject(failure) };
  }

  const body: FakeResponseBody = { json: () => Promise.resolve(reply.body) };

  if (!reply.withoutHeaders) {
    body.headers = new Headers(
      reply.cacheControl === undefined
        ? undefined
        : { "cache-control": reply.cacheControl },
    );
  }

  return body;
}

/** ky's `extend` also accepts a function of the parent options; tests pass a bag. */
function isOptionsBag(
  defaults: KyOptions | ((parentOptions: KyOptions) => KyOptions),
): defaults is KyOptions {
  return typeof defaults !== "function";
}

type KyMembers = Pick<
  KyInstance,
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "query"
  | "create"
  | "extend"
  | "stop"
  | "retry"
>;

function urlOf(input: Input): string {
  if (input instanceof URL) return input.href;

  if (input instanceof Request) return input.url;

  return input;
}

/**
 * A fake ky whose every derived instance (`extend`, `create`) records into the
 * SAME arrays, because the code under test always calls through a `.extend()`
 * of the client it was handed.
 */
export function createFakeKy(
  respond: FakeResponder = () => EMPTY_REPLY,
): FakeKy {
  const calls: RecordedCall[] = [];
  const extensions: KyOptions[] = [];

  // The reply resolves when the verb is called, not when `.json()` is awaited:
  // `cached-fetch.ts` reads `resp.headers` before it ever calls `.json()`.
  const verb =
    (method: KyVerb) =>
    <T>(url: Input, options?: KyOptions): ResponsePromise<T> => {
      const call: RecordedCall = { method, url: urlOf(url), options };
      calls.push(call);

      return replyOf(bodyFor(respond(call)));
    };

  const build = (): KyInstance => {
    const members: KyMembers = {
      get: verb("get"),
      post: verb("post"),
      put: verb("put"),
      patch: verb("patch"),
      delete: verb("delete"),
      head: verb("head"),
      query: verb("query"),
      create: () => build(),
      extend: (defaults) => {
        if (isOptionsBag(defaults)) extensions.push(defaults);

        return build();
      },
      stop: ky.stop,
      retry: ky.retry,
    };

    return Object.assign(verb("get"), members);
  };

  return { ky: build(), calls, extensions };
}

/**
 * The request body a handler put on a call, as `JSON.stringify` leaves it: a key
 * whose value is `undefined` is gone, exactly as it would be on the wire. So an
 * assertion here is an assertion about what the API receives.
 */
export function jsonBodyOf(call: RecordedCall): JsonObject {
  const wire: JsonValue = JSON.parse(
    JSON.stringify(call.options?.json ?? null),
  );

  if (!isJsonObject(wire)) {
    throw new Error(`${call.method} ${call.url} carried no JSON body`);
  }

  return wire;
}

/**
 * The raw query a handler put on a call. Use this when the assertion is about
 * REPEATED keys (`?sections=a&sections=b`), which `searchParamsOf` collapses
 * because it flattens to a record.
 */
export function queryOf(call: RecordedCall): URLSearchParams {
  const params = call.options?.searchParams;

  if (!(params instanceof URLSearchParams)) {
    throw new Error(
      `${call.method} ${call.url} carried no URLSearchParams query`,
    );
  }

  return params;
}

/**
 * The query a handler put on a call, in URL wire form. `URLSearchParams`
 * stringifies every value, so `limit: 25` reads back as `"25"`; that is the
 * form the API parses, and asserting anything else would be asserting the
 * in-process object rather than the request.
 */
export function searchParamsOf(call: RecordedCall): Record<string, string> {
  const params = call.options?.searchParams;

  if (!(params instanceof URLSearchParams)) {
    throw new Error(
      `${call.method} ${call.url} carried no URLSearchParams query`,
    );
  }

  return Object.fromEntries(params);
}

/**
 * ky accepts several `searchParams` forms and some handlers pass a plain record
 * rather than `URLSearchParams`, so `searchParamsOf` does not apply to them.
 * Narrowing with a predicate keeps the assertion on the object the handler built.
 */
function isQueryRecord(
  params: KyOptions["searchParams"],
): params is Record<string, string | number | boolean> {
  return (
    params !== undefined &&
    !(params instanceof URLSearchParams) &&
    typeof params === "object" &&
    !Array.isArray(params)
  );
}

export function queryRecordOf(call: RecordedCall) {
  const params = call.options?.searchParams;

  if (!isQueryRecord(params)) {
    throw new Error(`${call.method} ${call.url} carried no record query`);
  }

  return params;
}

/** True when the call carried no query at all, which some defaults rely on. */
export function hasSearchParams(call: RecordedCall): boolean {
  return call.options?.searchParams !== undefined;
}

/** The per-call timeout a handler set, if it set one. */
export function timeoutOf(call: RecordedCall): number | false | undefined {
  return call.options?.timeout;
}

/**
 * The headers an `extend` stamped, with the exact casing the caller used.
 * A `Headers` instance would lowercase every name, so a plain record is
 * normalized in place and only the other `HeadersInit` shapes are converted.
 */
export function headersOf(options: KyOptions | undefined) {
  const headers = options?.headers;
  const named = new Map<string, string>();

  if (headers instanceof Headers || Array.isArray(headers)) {
    for (const [name, value] of new Headers(headers)) named.set(name, value);
  } else if (headers !== undefined) {
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) named.set(name, value);
    }
  }

  return Object.fromEntries(named);
}
