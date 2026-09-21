import type { CodexClient } from "../codex/client.js";
import { ResearchSpecSchema, type ResearchSpec } from "../types.js";

const PLANNER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "query",
    "researchType",
    "objective",
    "evaluationCriteria",
    "searchQueries",
  ],
  properties: {
    query: { type: "string" },
    researchType: { type: "string" },
    objective: { type: "string" },
    desiredResults: { type: "integer" },
    geography: { type: "string" },
    freshness: { type: "string" },
    sourcePreferences: { type: "array", items: { type: "string" } },
    evaluationCriteria: { type: "array", items: { type: "string" }, minItems: 1 },
    searchQueries: { type: "array", items: { type: "string" }, minItems: 1 },
  },
} as const;

export async function planResearch(
  codex: CodexClient,
  query: string,
): Promise<ResearchSpec> {
  const prompt = `Create an internal ResearchSpec for this user research request.

User query:
${query}

Rules:
- Infer sensible defaults. Do not ask clarifying questions.
- If the user asks for N best/examples, set desiredResults accordingly.
- evaluationCriteria should make vague words like "best" concrete (quality signals, credibility, freshness, specificity).
- searchQueries should be diverse enough to discover substantially more candidates than desiredResults.
- researchType should be a short label such as "top_n_recommendations", "comparison", "evidence_review", or "signal_scan".
- Return JSON only matching the schema.`;

  const raw = await codex.runJson<unknown>(prompt, {
    schemaName: "ResearchSpec",
    outputSchema: PLANNER_SCHEMA,
  });

  return parseResearchSpec(raw, query);
}

export function parseResearchSpec(raw: unknown, fallbackQuery?: string): ResearchSpec {
  const withDefaults = {
    query: fallbackQuery,
    researchType: "general_research",
    objective: fallbackQuery ? `Answer: ${fallbackQuery}` : "Answer the research question",
    evaluationCriteria: ["relevance", "credibility", "specificity of evidence"],
    searchQueries: fallbackQuery ? [fallbackQuery] : ["research"],
    ...(typeof raw === "object" && raw ? raw : {}),
  };

  const parsed = ResearchSpecSchema.safeParse(withDefaults);
  if (!parsed.success) {
    throw new Error(`Invalid ResearchSpec: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function describeSpec(spec: ResearchSpec): string {
  const bits = [
    `Type: ${spec.researchType}`,
    `Objective: ${spec.objective}`,
    spec.desiredResults ? `Desired results: ${spec.desiredResults}` : null,
    spec.geography ? `Geography: ${spec.geography}` : null,
    spec.freshness ? `Freshness: ${spec.freshness}` : null,
    `Criteria: ${spec.evaluationCriteria.join("; ")}`,
    `Search angles: ${spec.searchQueries.length}`,
  ].filter(Boolean);
  return bits.join("\n");
}
