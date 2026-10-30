import { z } from "zod";
import type { KyInstance } from "ky";
import { httpErrorToToolResult, isUnconfirmedDelivery } from "../errors.js";
import { isJsonObject, type JsonValue } from "../json.js";
import {
  plainText,
  structuredJson,
  type ToolCallResult,
  type ToolDef,
} from "./_shared.js";
import { SendFeedbackOutput } from "./_outputs.js";

/** The inbox an agent writes to: `send_feedback`, and the roadmap copy of a
 *  `request_capability` call (`tools/index.ts`). */
export const AGENT_FEEDBACK_PATH = "feedback/agent";

const FeedbackIn = z.object({
  category: z
    .enum([
      "missing_papers",
      "irrelevant_results",
      "helpful",
      "issue",
      "idea",
      "other",
    ])
    .describe(
      "missing_papers: Lune did not find papers the user expected. " +
        "irrelevant_results: the results did not fit the question. helpful: " +
        "Lune helped. issue: an error or something broken. idea: a suggestion.",
    ),
  message: z
    .string()
    .trim()
    .min(3)
    .max(2000)
    .describe(
      "The feedback as the user approved it: what they asked Lune for and " +
        "what happened, naming the papers involved. Leave out the user's own " +
        "name and contact details, credentials, and private documents.",
    ),
  allow_training: z
    .boolean()
    .default(false)
    .optional()
    .describe(
      "True only when the user explicitly agreed that Lune may use this " +
        "feedback to train its models.",
    ),
});

export const FEEDBACK_TOOLS: ToolDef[] = [
  {
    name: "send_feedback",
    title: "Send feedback to Lune",
    description:
      "Sends the user's feedback about Lune to the Lune team. Use it when the " +
      "user says something about Lune itself (papers it missed, results that " +
      "did not fit, an error, something that helped, an idea): offer to pass " +
      "it on, show the user the message you would send, and call this only " +
      "after they agree. Set `allow_training` only if they also agreed that " +
      "Lune may train models on it, after telling them they can withdraw " +
      "that at any time in their Lune account settings. Write the message " +
      "from what the user said about Lune, leaving out unrelated " +
      "conversation and personal details.",
    inputSchema: FeedbackIn,
    outputSchema: SendFeedbackOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

/** A 2xx body that is not JSON is a malformed answer, not a failed delivery. */
function undecodableAsNull(cause: unknown): null {
  if (cause instanceof SyntaxError) return null;

  throw cause;
}

export async function callFeedbackTool(
  api: KyInstance,
  name: string,
  args: JsonValue,
): Promise<ToolCallResult> {
  if (name !== "send_feedback") {
    throw new Error(`unknown feedback tool: ${name}`);
  }

  try {
    const input = FeedbackIn.parse(args);

    const stored = await api
      .post(AGENT_FEEDBACK_PATH, {
        json: { ...input, allow_training: input.allow_training === true },
      })
      .json<JsonValue>()
      .catch(undecodableAsNull);

    // No fallback id: a malformed answer fails output validation in dispatch
    // and is reported as drift, never as a confirmed send.
    return structuredJson({
      status: "sent",
      id: isJsonObject(stored) ? stored.id : null,
    });
  } catch (e) {
    if (isUnconfirmedDelivery(e)) {
      return {
        ...plainText(
          "Lune did not confirm the feedback arrived, and it may already be " +
            "stored. Tell the user, and do not send it again unless they ask.",
        ),
        isError: true,
      };
    }

    return await httpErrorToToolResult(e, name);
  }
}
