import { z } from "zod";

export { pathSegmentId } from "./papers.schemas.js";

/**
 * The rhetorical roles a figure can play. Mirrors the API's own `FigureRole`
 * literal, which is the vision model's output vocabulary, so an agent cannot
 * filter for a role no row can hold. Keep the two in step: the API validates
 * with a Pydantic `Literal` and rejects anything else with a 422.
 */
export const FIGURE_ROLES = [
  "teaser",
  "architecture",
  "pipeline",
  "qualitative_grid",
  "results_plot",
  "data_schema",
  "algorithm",
  "concept",
  "other",
] as const;

export const FigureSearchInput = z.object({
  query: z
    .string()
    .min(2)
    .max(500)
    .describe(
      "A description of the FIGURE you need, not the research topic. Name the " +
        "composition you are after: what the panels are, which way the flow runs, " +
        'what is being compared. Good: "a system overview where data flows left ' +
        'to right through three stages, with the trained part highlighted". Bad: ' +
        '"retrieval augmented generation" (that is a topic; use search_papers).',
    ),
  roles: z
    .array(z.enum(FIGURE_ROLES))
    .optional()
    .describe(
      "Narrow to the rhetorical job the figure does: `teaser` (the figure that " +
        "sells the paper), `architecture` (model or system structure), `pipeline` " +
        "(stage-by-stage process), `qualitative_grid` (example outputs side by " +
        "side), `results_plot`, `data_schema`, `algorithm`, `concept`.",
    ),
  venues: z
    .array(z.string())
    .max(20)
    .optional()
    .describe(
      'Conference short names (e.g. ["CVPR", "NeurIPS"]). Figure conventions ' +
        "are venue-specific, so this is how you match your target venue's style. " +
        "An unknown name narrows to zero results rather than being ignored.",
    ),
  year_min: z
    .number()
    .int()
    .min(1990)
    .max(2100)
    .optional()
    .describe("Only figures from papers published in this year or later."),
  limit: z
    .number()
    .int()
    .min(1)
    /* No `.max()` here on purpose. The ceiling is deployment configuration
       (`figure_search_max_results`, currently 12), and a second copy in this
       schema is a copy that drifts: the 24 this carried let an agent send 13
       through JSON-Schema validation straight into an API 422. The API owns
       the cap and says so in the description, so an agent learns it from the
       tool rather than from a rejected call. */
    .default(8)
    .optional()
    .describe(
      "How many references to return (default 8). The server caps this; asking for more than the cap is rejected.",
    ),
  exclude_figure_ids: z
    .array(z.string())
    .max(64)
    .optional()
    .describe(
      "`figure_id`s to leave out. This is how you page: judge the first set, " +
        "then re-call the SAME query naming the ones you rejected and you get " +
        "the next best instead. There is no offset, because the ranking is a " +
        "fused reranked pool rather than a stable list, so the same offset " +
        "against a re-run query is not the same window.",
    ),
  include_images: z
    .boolean()
    .default(false)
    .optional()
    .describe(
      "Attach the actual figure images to the result. OFF by default because " +
        "each image costs a large amount of your context and the design analysis " +
        "already carries the reusable structure. Turn it on only when you need to " +
        "look at the reference to draw; at most the top few are attached.",
    ),
});

export const PaperFiguresInput = z.object({
  paper_id: z
    .string()
    .min(1)
    .describe(
      "A corpus paper UUID, from `search_papers` or `search_figure_references`.",
    ),
});
