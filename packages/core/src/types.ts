import { z } from "zod";

export const ResearchSpecSchema = z.object({
  query: z.string().min(1),
  researchType: z.string().min(1),
  objective: z.string().min(1),
  desiredResults: z.number().int().positive().optional(),
  geography: z.string().optional(),
  freshness: z.string().optional(),
  sourcePreferences: z.array(z.string()).optional(),
  evaluationCriteria: z.array(z.string()).min(1),
  searchQueries: z.array(z.string()).min(1),
});

export type ResearchSpec = z.infer<typeof ResearchSpecSchema>;

export const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string().optional(),
  source: z.string().optional(),
  publishedAt: z.string().optional(),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;

export const TriageResultSchema = z.object({
  result: SearchResultSchema,
  relevant: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
  decision: z.enum(["keep", "reject", "uncertain"]),
  scores: z
    .object({
      relevance: z.number().optional(),
      evidenceLikely: z.number().optional(),
      duplicative: z.number().optional(),
    })
    .optional(),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

export const SourceDocumentSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  publisher: z.string().optional(),
  publishedAt: z.string().optional(),
  text: z.string(),
  retrievedAt: z.string(),
  fetchStatus: z.enum(["ok", "failed", "blocked", "empty"]),
  error: z.string().optional(),
});

export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export const ReportFindingSchema = z.object({
  title: z.string(),
  summary: z.string(),
  whySelected: z.string().optional(),
  characteristics: z.array(z.string()).optional(),
  dimensions: z.record(z.string()).optional(),
  sourceUrls: z.array(z.string().url()).min(1),
});

export const CitationSchema = z.object({
  claim: z.string(),
  sourceUrl: z.string().url(),
  support: z.enum(["supports", "contradicts", "unverified"]).optional(),
});

export const ResearchReportSchema = z.object({
  answer: z.string(),
  findings: z.array(ReportFindingSchema),
  evidenceSynthesis: z.string().optional(),
  sources: z.array(
    z.object({
      title: z.string(),
      url: z.string().url(),
      publisher: z.string().optional(),
    }),
  ),
  citations: z.array(CitationSchema).optional(),
});

export type ResearchReport = z.infer<typeof ResearchReportSchema>;

export type PipelineStage =
  | "planning"
  | "searching"
  | "screening"
  | "reading"
  | "comparing"
  | "writing"
  | "done"
  | "error";

export interface ResearchTrailCounters {
  discovered: number;
  jevRejected: number;
  jevUncertain: number;
  jevKept: number;
  sourcesFetched: number;
  fetchFailed: number;
  duplicatesConsolidated: number;
  sourcesUsed: number;
}

export interface TrailCandidate {
  id: string;
  result: SearchResult;
  triage?: TriageResult;
  selected: boolean;
  fetchStatus?: SourceDocument["fetchStatus"];
  fetchError?: string;
  duplicateOf?: string;
  usedInReport?: boolean;
}

export interface ResearchRun {
  id: string;
  query: string;
  createdAt: string;
  updatedAt: string;
  stage: PipelineStage;
  statusMessage: string;
  spec?: ResearchSpec;
  report?: ResearchReport;
  trail: {
    counters: ResearchTrailCounters;
    candidates: TrailCandidate[];
  };
  error?: string;
}

export function emptyCounters(): ResearchTrailCounters {
  return {
    discovered: 0,
    jevRejected: 0,
    jevUncertain: 0,
    jevKept: 0,
    sourcesFetched: 0,
    fetchFailed: 0,
    duplicatesConsolidated: 0,
    sourcesUsed: 0,
  };
}
