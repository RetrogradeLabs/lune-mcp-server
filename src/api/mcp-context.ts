import { createHash } from "node:crypto";

import { replaceOption, type KyInstance } from "ky";

import {
  answeredView,
  PUBLIC_RELEASES,
  UNANSWERED_VIEW,
  type ReleaseView,
  type Releases,
} from "../releases.js";

/** What `GET account/mcp-context` says about the calling credential. */
export interface McpContextBody {
  workspace?: boolean;
  figures?: boolean;
  analytics_user_id?: string | null;
  analytics_personless?: boolean;
  analytics_suppressed?: boolean;
  analytics_capture_allowed?: boolean;
}

/**
 * Bounded at 2.5s in total, retries included, unlike the default client's 30s
 * and two retries: the probe runs on every hosted request, so it has to stay
 * cheap. It retries once, after at most 300ms, for a deploy's 5xx or a dropped
 * socket. The burst guard's 429 is not waited out, since a caller over its burst
 * would pay that second on every request, and a timeout has already spent the
 * budget. The status list REPLACES the client's gateway-only one, which a
 * per-call `retry` would otherwise inherit.
 */
export function fetchMcpContext(client: KyInstance): Promise<McpContextBody> {
  return client
    .get("account/mcp-context", {
      timeout: 2500,
      totalTimeout: 2500,
      retry: {
        limit: 1,
        maxRetryAfter: 300,
        statusCodes: replaceOption([500, 502, 503, 504]),
      },
    })
    .json<McpContextBody>();
}

/** What the API said about a credential that its tool surface depends on. */
export interface CredentialFacts {
  readonly releases: Releases;
  readonly workspace: boolean;
}

export function factsOf(body: McpContextBody): CredentialFacts {
  return {
    releases: { figures: body.figures === true },
    workspace: body.workspace === true,
  };
}

/** A refused credential has nothing released to it and no workspace. */
export const REFUSED_FACTS: CredentialFacts = Object.freeze({
  releases: PUBLIC_RELEASES,
  workspace: false,
});

/** A ky failure that carries an upstream response, i.e. the API answered. */
interface UpstreamHttpFailure {
  response: { status: number };
}

/**
 * Structural instead of `instanceof HTTPError`, so a hand-built double (and any
 * ky major that re-exports the class) still resolves to a status.
 */
function isUpstreamHttpFailure(cause: unknown): cause is UpstreamHttpFailure {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "response" in cause &&
    typeof cause.response === "object" &&
    cause.response !== null &&
    "status" in cause.response &&
    typeof cause.response.status === "number"
  );
}

/**
 * Whether a failed probe is the API answering that the credential is refused.
 * Only a 401 is: anything else (a 403, a 5xx, a 429, a dropped socket) leaves
 * the question open.
 */
export function refusesCredential(cause: unknown): boolean {
  return isUpstreamHttpFailure(cause) && cause.response.status === 401;
}

/** What a request may see and reach given the facts, or none at all. */
export function viewOf(facts: CredentialFacts | undefined): ReleaseView {
  return facts ? answeredView(facts.releases) : UNANSWERED_VIEW;
}

/** How long an answer stands in for an API that cannot be asked. */
export const REMEMBERED_ANSWER_MS = 5 * 60_000;

interface RememberedAnswer {
  facts: CredentialFacts;
  at: number;
}

/**
 * The API's latest answer per credential, for requests it cannot answer. Keyed
 * by a digest so no token is held, and bounded: past `capacity` the credential
 * answered longest ago is forgotten first.
 */
export class RememberedAnswers {
  readonly #answers = new Map<string, RememberedAnswer>();
  readonly #capacity: number;
  readonly #now: () => number;

  constructor(capacity: number, now: () => number = () => Date.now()) {
    this.#capacity = capacity;
    this.#now = now;
  }

  remember(token: string, facts: CredentialFacts): void {
    const key = digestOf(token);

    // Re-inserting moves the key to the end, which keeps the map in answer order.
    this.#answers.delete(key);
    this.#answers.set(key, { facts, at: this.#now() });

    if (this.#answers.size > this.#capacity) {
      const oldest = this.#answers.keys().next();

      if (!oldest.done) this.#answers.delete(oldest.value);
    }
  }

  /** The last answer for this credential, if it is younger than `maxAgeMs`. */
  recall(
    token: string,
    maxAgeMs: number = REMEMBERED_ANSWER_MS,
  ): CredentialFacts | undefined {
    const answer = this.#answers.get(digestOf(token));

    return answer && this.#now() - answer.at < maxAgeMs
      ? answer.facts
      : undefined;
  }
}

function digestOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
