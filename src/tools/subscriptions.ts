import { z } from "zod";
import type { KyInstance } from "ky";
import { httpErrorToToolResult } from "../errors.js";
import {
  structuredJson,
  type ToolAnnotations,
  type ToolCallResult,
  type ToolDef,
} from "./_shared.js";
import {
  slimDrainResponse,
  slimSubscription,
  slimSubscriptionList,
} from "./_slim.js";
import {
  CheckUpdatesOutput,
  ListSubscriptionsOutput,
  SubscribeOutput,
  UnsubscribeOutput,
} from "./_outputs.js";

const READ_SUBS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};
const WRITE_SUBS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false,
};
const DELETE_SUBS: ToolAnnotations = {
  readOnlyHint: false,
  // Reversible: user can resubscribe, but the cursor is lost. Flag as
  // destructive so ChatGPT prompts before calling.
  destructiveHint: true,
  openWorldHint: false,
  idempotentHint: true,
};

const Empty = z.object({});

const CreateIn = z.object({
  conference: z
    .string()
    .min(1)
    .describe(
      "Conference to follow, by short name (e.g. `NeurIPS`, `CCS`) or UUID. " +
        "Resolved server-side, no `list_conferences` lookup needed.",
    ),
  email: z.email().optional().describe("Override the org's default delivery email."),
  notify_email: z.boolean().default(true).optional(),
  notify_in_app: z.boolean().default(true).optional(),
});

const IdIn = z.object({
  subscription_id: z.string().min(1),
});

const CheckUpdatesIn = z.object({
  since: z
    .string()
    .optional()
    .describe(
      "Opaque cursor from a previous response's `next_cursor`. Omit to start from when each conference was first followed.",
    ),
  limit: z.number().int().min(1).max(50).default(20).optional(),
});

export const SUBS_TOOLS: ToolDef[] = [
  {
    name: "list_subscriptions",
    title: "List conference subscriptions",
    description:
      "Use this when the user asks “what conferences am I tracking”, “what am I " +
      "subscribed to”. Each entry returns the subscription ID and conference ID. To " +
      "fetch new papers across all of them, call `get_subscription_updates` (no id " +
      "needed).",
    inputSchema: Empty,
    outputSchema: ListSubscriptionsOutput,
    annotations: READ_SUBS,
    scopes: ["subs:rw"],
  },
  {
    name: "subscribe_conference",
    title: "Subscribe to a conference",
    description:
      "Use this when the user asks to follow / track / watch / subscribe to a conference " +
      "(e.g. “keep me updated on NeurIPS”, “track CCS for new papers”). Pass the " +
      "conference by name or short name in `conference` (e.g. \"NeurIPS\", \"CCS\"); it " +
      "is resolved the same way as in `search_papers`, no UUID lookup needed. New " +
      "papers indexed after this call show up in `get_subscription_updates`.",
    inputSchema: CreateIn,
    outputSchema: SubscribeOutput,
    annotations: WRITE_SUBS,
    scopes: ["subs:rw"],
  },
  {
    name: "unsubscribe_conference",
    title: "Unsubscribe from a conference",
    description:
      "Use this when the user asks to stop following / unsubscribe / drop a conference. " +
      "Pass the `subscription_id` from `list_subscriptions`. The cursor is discarded; " +
      "resubscribing starts a fresh feed.",
    inputSchema: IdIn,
    outputSchema: UnsubscribeOutput,
    annotations: DELETE_SUBS,
    scopes: ["subs:rw"],
  },
  {
    name: "get_subscription_updates",
    title: "Get new papers from subscriptions",
    description:
      "Use this when the user asks “any new papers from my subscriptions”, “give me a " +
      "digest”, or wants a fresh pull of recent work from their tracked venues. Covers " +
      "EVERY conference the user follows in one merged, time-ordered feed, no " +
      "subscription id needed. Cursor-aware: pass the previous response's `next_cursor` " +
      "as `since` to resume; omit on the first call. Returns up to `limit` papers and a " +
      "`next_cursor`. Cheap to run on a cadence.",
    inputSchema: CheckUpdatesIn,
    outputSchema: CheckUpdatesOutput,
    // Read-only in spirit (returns papers), but advances the cursor as a
    // side effect, so set readOnlyHint:false so ChatGPT doesn't memoize calls.
    annotations: WRITE_SUBS,
    scopes: ["subs:rw"],
  },
];

export async function callSubsTool(
  api: KyInstance,
  name: string,
  args: unknown,
): Promise<ToolCallResult> {
  try {
    switch (name) {
      case "list_subscriptions": {
        Empty.parse(args ?? {});
        const r = await api.get("subscriptions").json();
        return structuredJson(slimSubscriptionList(r));
      }
      case "subscribe_conference": {
        const a = CreateIn.parse(args);
        // `notify_email` / `notify_in_app` always materialise from zod 4
        // defaults (true). `email` is purely optional and stays absent when
        // omitted by the caller. The API field is `conference_id` but accepts
        // a short name too, which it resolves server-side.
        const body: Record<string, unknown> = {
          conference_id: a.conference,
          notify_email: a.notify_email,
          notify_in_app: a.notify_in_app,
        };
        if (a.email !== undefined) body.email = a.email;
        const r = await api.post("subscriptions", { json: body }).json();
        return structuredJson(slimSubscription(r as Parameters<typeof slimSubscription>[0]));
      }
      case "unsubscribe_conference": {
        const a = IdIn.parse(args);
        await api.delete(`subscriptions/${encodeURIComponent(a.subscription_id)}`);
        return structuredJson({ ok: true, subscription_id: a.subscription_id });
      }
      case "get_subscription_updates": {
        const a = CheckUpdatesIn.parse(args);
        // zod 4 materialises the limit default even on `.optional()`, so
        // `a.limit` is guaranteed defined at runtime; the assertion narrows
        // away the residual TS `| undefined`.
        const sp: Record<string, string | number> = { limit: a.limit as number };
        if (a.since) sp.since = a.since;
        // Aggregate feed across every subscription the org holds, no per-sub
        // id needed (see GET /subscriptions/updates).
        const r = await api.get("subscriptions/updates", { searchParams: sp }).json();
        return structuredJson(slimDrainResponse(r));
      }
      default:
        throw new Error(`unknown subscription tool: ${name}`);
    }
  } catch (e) {
    // Upstream Lune-API failures resolve to a `{ isError: true }` tool result
    // (actionable, in-context); non-HTTP errors (zod, unknown-tool) re-throw
    // as JSON-RPC protocol errors. See `httpErrorToToolResult`.
    return await httpErrorToToolResult(e);
  }
}
