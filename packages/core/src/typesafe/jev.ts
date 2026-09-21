import {
  TypeSafeClient,
  noul,
  score,
  choice,
} from "@typesafe-ai/sdk";

export interface TypeSafeConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface TriageJudgmentInput {
  researchQuestion: string;
  evaluationCriteria: string[];
  title: string;
  url: string;
  domain: string;
  snippet?: string;
}

export interface TriageJudgment {
  relevant: boolean;
  confidence: number;
  reason: string;
  decision: "keep" | "reject" | "uncertain";
  scores: {
    relevance: number;
    evidenceLikely: number;
    duplicative: number;
  };
  raw?: unknown;
}

export interface EvidenceCheckInput {
  claim: string;
  sourceUrl: string;
  sourceExcerpt: string;
}

export interface EvidenceCheckResult {
  support: "supports" | "contradicts" | "says_nothing";
  confidence: number;
}

export interface JevClient {
  testConnection(): Promise<{ ok: boolean; message: string; model?: string }>;
  triageCandidate(input: TriageJudgmentInput): Promise<TriageJudgment>;
  checkEvidence?(input: EvidenceCheckInput): Promise<EvidenceCheckResult>;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Recall-biased triage policy:
 * - high-confidence reject → reject
 * - otherwise keep (including low-confidence / uncertain)
 */
export function decideFromScores(scores: {
  relevance: number;
  evidenceLikely: number;
  duplicative: number;
}): Pick<TriageJudgment, "relevant" | "confidence" | "decision" | "reason"> {
  const usefulness = (scores.relevance + scores.evidenceLikely) / 2;
  const uniqueness = 1 - scores.duplicative;
  const combined = usefulness * 0.75 + uniqueness * 0.25;

  // Confidence proxy: distance from middle for usefulness, clipped
  const confidence = Math.min(1, Math.abs(usefulness - 0.5) * 2);

  if (scores.duplicative >= 0.85 && confidence >= 0.55) {
    return {
      relevant: false,
      confidence,
      decision: "reject",
      reason: "Likely duplicative of material already discovered.",
    };
  }

  if (usefulness < 0.28 && confidence >= 0.6) {
    return {
      relevant: false,
      confidence,
      decision: "reject",
      reason: "Low relevance and unlikely to contain useful evidence.",
    };
  }

  if (confidence < 0.45) {
    return {
      relevant: true,
      confidence,
      decision: "uncertain",
      reason: "Low-confidence candidate preserved for recall.",
    };
  }

  if (combined >= 0.45) {
    return {
      relevant: true,
      confidence,
      decision: "keep",
      reason: "Candidate appears worth investigating.",
    };
  }

  return {
    relevant: true,
    confidence,
    decision: "uncertain",
    reason: "Borderline usefulness; kept to avoid false negatives.",
  };
}

export class TypeSafeJevClient implements JevClient {
  private client: TypeSafeClient;
  private model: string;

  constructor(config: TypeSafeConfig = {}) {
    const apiKey = config.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
      throw new Error("TYPESAFE_API_KEY is required for Jev triage.");
    }
    this.client = new TypeSafeClient({
      apiKey,
      baseURL: config.baseURL ?? process.env.TYPESAFE_BASE_URL,
    });
    this.model = config.model ?? process.env.TYPESAFE_MODEL ?? "jev-latest";
  }

  async testConnection(): Promise<{ ok: boolean; message: string; model?: string }> {
    try {
      const result = await this.client.systemOne({
        model: this.model,
        state: { ping: "connection test" },
        questions: {
          ok: noul("Is this a harmless connectivity probe?"),
        },
      });
      return {
        ok: true,
        message: "TypeSafe connection succeeded.",
        model: result.model,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async triageCandidate(input: TriageJudgmentInput): Promise<TriageJudgment> {
    const domain = input.domain || domainOf(input.url);
    const state = {
      researchQuestion: input.researchQuestion,
      evaluationCriteria: input.evaluationCriteria,
      candidate: {
        title: input.title,
        url: input.url,
        domain,
        snippet: input.snippet ?? "",
      },
    };

    const response = await this.client.systemOne({
      model: this.model,
      state,
      questions: {
        relevance: score(
          "How relevant is this search candidate to the research question and criteria?",
          [
            "Clearly unrelated",
            "Weakly related",
            "Moderately relevant",
            "Strongly relevant",
            "Directly on-target",
          ],
        ),
        evidenceLikely: score(
          "How likely is this page to contain useful evidence worth fetching?",
          [
            "Almost certainly no useful evidence",
            "Probably thin or promotional",
            "Might contain some useful detail",
            "Likely contains useful evidence",
            "Very likely high-value primary material",
          ],
        ),
        duplicative: noul(
          "Is this candidate substantially duplicative of a generic listing already well covered by other results?",
          {
            true: "Mostly the same thin listicle/repetition",
            false: "Offers distinct evidence, angle, or primary material",
          },
        ),
      },
    });

    const relevance = normalizeScore(response.answers.relevance);
    const evidenceLikely = normalizeScore(response.answers.evidenceLikely);
    const duplicative = response.answers.duplicative.noul;

    const scores = { relevance, evidenceLikely, duplicative };
    const decision = decideFromScores(scores);

    return {
      ...decision,
      scores,
      raw: response.answers,
    };
  }

  async checkEvidence(input: EvidenceCheckInput): Promise<EvidenceCheckResult> {
    const response = await this.client.systemOne({
      model: this.model,
      state: {
        claim: input.claim,
        sourceUrl: input.sourceUrl,
        excerpt: input.sourceExcerpt.slice(0, 6000),
      },
      questions: {
        relation: choice("How does the source excerpt relate to the claim?", {
          supports: "The excerpt states or directly implies the claim",
          contradicts: "The excerpt states or implies the opposite",
          says_nothing: "The excerpt does not address the claim",
        }),
      },
    });

    const answer = response.answers.relation as {
      choice: "supports" | "contradicts" | "says_nothing";
      confidence: number;
    };

    return {
      support: answer.choice,
      confidence: answer.confidence,
    };
  }
}

function normalizeScore(answer: unknown): number {
  if (!answer || typeof answer !== "object") return 0.5;
  const a = answer as { score?: number; legend?: Record<string, string> };
  if (typeof a.score !== "number") return 0.5;
  const maxLevel = a.legend ? Math.max(...Object.keys(a.legend).map(Number)) : 4;
  if (!Number.isFinite(maxLevel) || maxLevel <= 0) return 0.5;
  return Math.min(1, Math.max(0, a.score / maxLevel));
}

export class MockJevClient implements JevClient {
  constructor(
    private readonly impl?: (input: TriageJudgmentInput) => TriageJudgment,
  ) {}

  async testConnection(): Promise<{ ok: boolean; message: string; model?: string }> {
    return { ok: true, message: "Mock TypeSafe OK", model: "mock-jev" };
  }

  async triageCandidate(input: TriageJudgmentInput): Promise<TriageJudgment> {
    if (this.impl) return this.impl(input);
    const hay = `${input.title} ${input.snippet ?? ""}`.toLowerCase();
    const q = input.researchQuestion.toLowerCase();
    const tokens = q.split(/\W+/).filter((t) => t.length > 3);
    const hits = tokens.filter((t) => hay.includes(t)).length;
    const relevance = tokens.length ? hits / tokens.length : 0.5;
    const scores = {
      relevance,
      evidenceLikely: relevance * 0.9 + 0.05,
      duplicative: hay.includes("duplicate") ? 0.9 : 0.2,
    };
    return { ...decideFromScores(scores), scores };
  }
}

export { domainOf };
