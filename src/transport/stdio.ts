import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { KyInstance } from "ky";
import { makeServer, TOOL_SURFACE_TTL_MS } from "../server.js";
import { extractTokenStdio } from "../auth/token.js";
import { makeClient } from "../api/client.js";
import {
  factsOf,
  fetchMcpContext,
  REFUSED_FACTS,
  refusesCredential,
  RememberedAnswers,
  viewOf,
  type CredentialFacts,
} from "../api/mcp-context.js";
import type { ReleaseView } from "../releases.js";

/**
 * The three collaborators `runStdio` wires together. Each defaults to the real
 * implementation, so production calls `runStdio()` unchanged and a test can
 * hand in a double without replacing a module.
 */
export interface StdioDeps {
  serve?: typeof serveStdio;
  buildServer?: typeof makeServer;
  buildClient?: typeof makeClient;
}

interface CredentialAnswers {
  view: () => Promise<ReleaseView>;
  workspace: () => boolean;
}

/**
 * What the API says about the process's one credential. An answer is reused for
 * the tool-surface TTL and then asked for again; a failure is never reused, and
 * while the API cannot be asked the last answer stands in for a few minutes. A
 * 401 is an answer: the credential is refused.
 */
function credentialAnswers(
  token: string,
  client: () => KyInstance,
): CredentialAnswers {
  const answers = new RememberedAnswers(1);
  let asking: Promise<CredentialFacts | undefined> | undefined;

  async function ask(): Promise<CredentialFacts | undefined> {
    try {
      const facts = factsOf(await fetchMcpContext(client()));
      answers.remember(token, facts);

      return facts;
    } catch (cause) {
      if (!refusesCredential(cause)) return undefined;

      answers.remember(token, REFUSED_FACTS);

      return REFUSED_FACTS;
    }
  }

  async function facts(): Promise<CredentialFacts | undefined> {
    const fresh = answers.recall(token, TOOL_SURFACE_TTL_MS);

    if (fresh) return fresh;

    // Concurrent requests share one question instead of each asking.
    asking ??= ask().finally(() => {
      asking = undefined;
    });

    return (await asking) ?? answers.recall(token);
  }

  return {
    view: async () => viewOf(await facts()),
    workspace: () => answers.recall(token)?.workspace === true,
  };
}

/**
 * Run the MCP server over stdio. The Bearer token is captured once at process
 * startup (stdio is single-tenant: one process per agent invocation).
 *
 * `serveStdio` serves both protocol eras from the one factory: a 2026-07-28
 * peer negotiates through `server/discover`, a 2025-era peer through
 * `initialize`, and the connection stays pinned to whichever it opened with.
 * It resolves as soon as the wiring is done; the process stays alive because
 * the stdio transport holds stdin open.
 *
 * The credential is asked about before the first instance is built, because
 * its instructions describe the releases, and those stay fixed for the
 * connection. Every list, call and prompt asks again once the answer is older
 * than the tool-surface TTL, so a failed first probe, a withdrawn release and a
 * new grant all reach the running session.
 */
export async function runStdio(deps: StdioDeps = {}): Promise<void> {
  const serve = deps.serve ?? serveStdio;
  const buildServer = deps.buildServer ?? makeServer;
  const buildClient = deps.buildClient ?? makeClient;
  const token = extractTokenStdio();
  const client = (): KyInstance => buildClient(token);
  const credential = credentialAnswers(token, client);

  serve(async () =>
    buildServer(client, {
      releases: await credential.view(),
      currentReleases: credential.view,
      // Read after `currentReleases` in every handler, so it sees that answer.
      analyticsContext: () => ({
        workspaceCredential: credential.workspace(),
      }),
    }),
  );
}
