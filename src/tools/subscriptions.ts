import { z } from "zod";
import type { KyInstance } from "ky";
import { rethrowHttpError } from "../errors.js";
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
  conference_id: z
    .string()
    .min(1)
    .describe("UUID of the conference (from `list_conferences`)."),
  email: z.string().email().optional().describe("Override the org's default delivery email."),
  notify_email: z.boolean().default(true).optional(),
  notify_in_app: z.boolean().default(true).optional(),
});

const IdIn = z.object({
  subscription_id: z.string().min(1),
});

const DrainIn = z.object({
  subscription_id: z.string().min(1),
  since: z
    .string()
    .optional()
    .describe(
      "Opaque cursor from a previous response's `next_cursor`. Omit to start from the subscription's creation time.",
    ),
  limit: z.number().int().min(1).max(50).default(20).optional(),
});

export const SUBS_TOOLS: ToolDef[] = [
  {
    name: "list_conference_update_subscriptions",
    title: "List conference update subscriptions",
    description:
      "Use this when the user asks “what conferences am I tracking”, “what am I " +
      "subscribed to”, or before a `check_for_conference_updates` call. Each entry " +
      "returns the subscription ID and conference ID. Feed the subscription ID into " +
      "`check_for_conference_updates` to fetch new papers since the last check.",
    inputSchema: Empty,
    outputSchema: ListSubscriptionsOutput,
    annotations: READ_SUBS,
    scopes: ["subs:rw"],
  },
  {
    name: "subscribe_to_conference_updates",
    title: "Subscribe to conference updates",
    description:
      "Use this when the user asks to follow / track / watch / subscribe to a conference " +
      "(e.g. “keep me updated on NeurIPS”, “track CCS for new papers”). Look up the " +
      "`conference_id` via `list_conferences` first if it's only known by name. The " +
      "cursor starts at the moment the subscription is created, so the first " +
      "`check_for_conference_updates` call returns papers indexed from that point onward.",
    inputSchema: CreateIn,
    outputSchema: SubscribeOutput,
    annotations: WRITE_SUBS,
    scopes: ["subs:rw"],
  },
  {
    name: "unsubscribe_from_conference_updates",
    title: "Unsubscribe from conference updates",
    description:
      "Use this when the user asks to stop following / unsubscribe / drop a conference. " +
      "The cursor is discarded; resubscribing starts a fresh feed.",
    inputSchema: IdIn,
    outputSchema: UnsubscribeOutput,
    annotations: DELETE_SUBS,
    scopes: ["subs:rw"],
  },
  {
    name: "check_for_conference_updates",
    title: "Check for conference updates",
    description:
      "Use this when the user asks “what's new at <conference>”, “any new papers from " +
      "my subscriptions”, “give me a digest”, or wants a fresh pull of recent work from a " +
      "tracked venue. Cursor-aware: pass the previous response's `next_cursor` as " +
      "`since` to resume; omit on the first call. Returns up to `limit` papers and a " +
      "`next_cursor`. One call covers every new paper indexed since the last check, " +
      "regardless of count, cheap to run on a cadence.",
    inputSchema: DrainIn,
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
      case "list_conference_update_subscriptions": {
        Empty.parse(args ?? {});
        const r = await api.get("subscriptions").json();
        return structuredJson(slimSubscriptionList(r));
      }
      case "subscribe_to_conference_updates": {
        const a = CreateIn.parse(args);
        const body: Record<string, unknown> = { conference_id: a.conference_id };
        if (a.email !== undefined) body.email = a.email;
        if (a.notify_email !== undefined) body.notify_email = a.notify_email;
        if (a.notify_in_app !== undefined) body.notify_in_app = a.notify_in_app;
        const r = await api.post("subscriptions", { json: body }).json();
        return structuredJson(slimSubscription(r as Parameters<typeof slimSubscription>[0]));
      }
      case "unsubscribe_from_conference_updates": {
        const a = IdIn.parse(args);
        await api.delete(`subscriptions/${encodeURIComponent(a.subscription_id)}`);
        return structuredJson({ ok: true, subscription_id: a.subscription_id });
      }
      case "check_for_conference_updates": {
        const a = DrainIn.parse(args);
        const sp: Record<string, string | number> = { limit: a.limit ?? 20 };
        if (a.since) sp.since = a.since;
        const r = await api
          .get(`subscriptions/${encodeURIComponent(a.subscription_id)}/drain`, {
            searchParams: sp,
          })
          .json();
        return structuredJson(slimDrainResponse(r));
      }
      default:
        throw new Error(`unknown subscription tool: ${name}`);
    }
  } catch (e) {
    await rethrowHttpError(e);
    throw e;
  }
}
