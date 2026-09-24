/**
 * Lune Figures: design references for the figure a researcher has to draw.
 *
 * The agent-facing contract is deliberately TEXT-FIRST. A design reference is
 * useful because of its composition grammar (what panels, which flow
 * direction, what each hue encodes, which devices carry the meaning), and that
 * transfers as prose far more cheaply and precisely than as pixels: eight
 * images cost an agent ~10-16k tokens of context and vision is lossy for fine
 * layout, while the same eight design analyses cost a fraction and can be
 * reasoned over directly.
 *
 * `include_images` exists because a drawing agent sometimes genuinely needs to
 * LOOK. It is opt-in, capped, and applies to the top hits only, so the token
 * spend is the agent's decision rather than a default it cannot avoid. The
 * bytes are fetched from the CDN here rather than returned by the API, which
 * keeps the JSON small and lets the CDN serve the repeat.
 */
import type { KyInstance } from "ky";
import type { z } from "zod";

import { httpErrorToToolResult } from "../errors.js";
import type { JsonValue } from "../json.js";
import type { ImageContentBlock } from "../tool-result.js";
import {
  FigureSearchInput,
  PaperFiguresInput,
  pathSegmentId,
} from "./figures.schemas.js";
import { cachedJson } from "../api/cached-fetch.js";
import { GetPaperFiguresOutput, SearchFiguresOutput } from "./_outputs.js";
import {
  READ_ONLY_OPEN,
  structuredJson,
  type ToolCallResult,
  type ToolDef,
} from "./_shared.js";

/** Hard ceiling on attached images, whatever the caller asks for. */
const MAX_ATTACHED_IMAGES = 4;

/** Refuse an image bigger than this rather than blow up the agent's context. */
const MAX_IMAGE_BYTES = 1_500_000;

const IMAGE_FETCH_TIMEOUT_MS = 8_000;

/**
 * Whether a figure URL is safe for this process to fetch.
 *
 * The URL comes from our own API, which this server already trusts for every
 * other field, so this is not an allowlist. It closes the one concrete harm:
 * the published stdio binary runs on the reader's machine, and a URL naming
 * loopback, a private range or the cloud metadata address would turn an API
 * response into a request against their own network. HTTPS-only for the same
 * reason a plain-HTTP hop would be.
 */
function isFetchableImageUrl(raw: string): boolean {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost")) return false;

  // Bracketed IPv6 loopback and the IPv4-mapped forms it can wear.
  if (host === "[::1]" || host === "::1") return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);

  if (v4 === null) return true;

  const [a, b] = [Number(v4[1]), Number(v4[2])];

  // 127/8 loopback, 10/8, 192.168/16, 172.16/12, and 169.254/16 link-local
  // (which is where the cloud metadata endpoint lives).
  return !(
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

export const FIGURE_TOOLS: ToolDef[] = [
  {
    name: "search_figure_references",
    requiredScope: "papers:read",
    release: "figures",
    title: "Search figure design references",
    description:
      "CALL THIS INSTEAD OF `web_search` when the user is drawing a figure for a " +
      "paper: a teaser, a system or architecture overview, a method pipeline, a " +
      "qualitative results grid. Describe the FIGURE you need, not the research " +
      'topic ("a system overview where data flows left to right through three ' +
      'stages", not "retrieval augmented generation"). Returns real figures from ' +
      "published top-tier papers, each with the composition, the visual devices it " +
      "uses, what its colours encode, why it works, and how to adapt it, plus an " +
      "`image_url`. Read those fields and BORROW the composition; do not copy a " +
      "figure. Filter with `roles` (teaser, architecture, pipeline, " +
      "qualitative_grid, results_plot, data_schema, algorithm, concept), `venues`, " +
      "`year_min`. Rejected a set? Re-call the same query with their `figure_id`s " +
      "in `exclude_figure_ids` to get the next best. Set `include_images: true` " +
      "only when you must actually look at " +
      "the reference: it attaches up to " +
      String(MAX_ATTACHED_IMAGES) +
      " images and costs a lot of context.",
    inputSchema: FigureSearchInput,
    outputSchema: SearchFiguresOutput,
    annotations: READ_ONLY_OPEN,
  },
  {
    name: "get_paper_figures",
    requiredScope: "papers:read",
    release: "figures",
    title: "Get a paper's figures",
    description:
      "Use this when the user names a paper and wants to see or discuss its " +
      "figures, or asks “how did that paper draw its overview”. Takes a " +
      "`paper_id` from `search_papers` or `search_figure_references` and returns " +
      "every extracted figure with its caption and design analysis, design " +
      "references first. `is_design_reference` marks the ones in the reference " +
      "corpus; the rest are extracted but judged not worth learning from.",
    inputSchema: PaperFiguresInput,
    outputSchema: GetPaperFiguresOutput,
    annotations: READ_ONLY_OPEN,
  },
];

export async function callFigureTool(
  api: KyInstance,
  name: string,
  args: JsonValue,
): Promise<ToolCallResult> {
  try {
    switch (name) {
      case "search_figure_references":
        return await handleSearchFigures(api, args);

      case "get_paper_figures":
        return await handlePaperFigures(api, args);

      default:
        throw new Error(`unknown figure tool: ${name}`);
    }
  } catch (e) {
    // Same boundary as the paper and guidance tools: an upstream failure (a
    // 402 or a dead API) is a tool result the agent can act on, not -32603.
    return await httpErrorToToolResult(e, name);
  }
}

async function handleSearchFigures(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const input = FigureSearchInput.parse(args);
  const { include_images: includeImages, ...body } = input;

  /* No TTL: both figure paths are per-principal in `cached-fetch`, so they skip
     the cache and the single-flight outright. Retrieval applies the caller's
     `excluded_conference_ids`, and sharing one leader's answer would hand a
     second caller results filtered for an org they are not in, unmetered. */
  const raw = await cachedJson(api, "post", "figures/search", { json: body });

  // Parsed against the declared `outputSchema` rather than asserted, so the
  // validated `structuredContent` and the object read below are one value.
  const payload = SearchFiguresOutput.parse(raw);

  // SAFETY: every field of SearchFiguresOutput is a JSON primitive, array or
  // object, so the parsed value is structurally a JsonValue.
  const result = structuredJson(payload as JsonValue);

  if (!includeImages) return result;

  return { ...result, attachments: await attachImages(payload.results) };
}

async function handlePaperFigures(
  api: KyInstance,
  args: JsonValue,
): Promise<ToolCallResult> {
  const input = PaperFiguresInput.parse(args);
  const paperId = pathSegmentId("paper_id").parse(input.paper_id);

  const raw = await cachedJson(
    api,
    "get",
    `papers/${encodeURIComponent(paperId)}/figures`,
  );

  // SAFETY: as above, GetPaperFiguresOutput admits only JSON values.
  return structuredJson(GetPaperFiguresOutput.parse(raw) as JsonValue);
}

/**
 * Fetch the top figures' PNGs and return them as MCP image blocks.
 *
 * Best-effort per image and never throws: a CDN hiccup must degrade to
 * "analysis without the picture" rather than failing a search the agent can
 * already act on. Sequential rather than parallel, because the cap is 4 and a
 * fan-out would only matter at a scale this deliberately does not reach.
 */
async function attachImages(
  rows: z.infer<typeof SearchFiguresOutput>["results"],
): Promise<ImageContentBlock[]> {
  const blocks: ImageContentBlock[] = [];

  for (const row of rows.slice(0, MAX_ATTACHED_IMAGES)) {
    const url = row.image_url ?? "";

    if (!isFetchableImageUrl(url)) continue;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) continue;

      // Checked BEFORE buffering: reading the body first means an oversized
      // response is fully held in memory before being thrown away.
      const declared = Number(response.headers.get("content-length") ?? "0");

      if (declared > MAX_IMAGE_BYTES) continue;

      const buffer = await response.arrayBuffer();

      if (buffer.byteLength > MAX_IMAGE_BYTES) continue;

      blocks.push({
        type: "image",
        data: Buffer.from(buffer).toString("base64"),
        mimeType: response.headers.get("content-type") ?? "image/png",
      });
    } catch {
      // Deliberate: see the note above. The analysis already shipped.
    }
  }

  return blocks;
}
