import { randomUUID } from "node:crypto";
import type { CodexClient } from "../codex/client.js";
import type { SearchProvider } from "../discovery/search.js";
import { dedupeDocuments, dedupeSearchResults } from "../dedupe/dedupe.js";
import type { ContentFetcher } from "../fetch/content.js";
import { planResearch, describeSpec } from "../planner/plan.js";
import { associateSourcesUsed, deepResearchAndSynthesize } from "../research/synthesize.js";
import type { JevClient } from "../typesafe/jev.js";
import { domainOf } from "../typesafe/jev.js";
import {
  emptyCounters,
  type PipelineStage,
  type ResearchRun,
  type TrailCandidate,
  type TriageResult,
} from "../types.js";

export interface PipelineDeps {
  codex: CodexClient;
  jev: JevClient;
  search: SearchProvider;
  fetcher: ContentFetcher;
}

export type ProgressCallback = (run: ResearchRun) => void | Promise<void>;

export async function runResearchPipeline(
  query: string,
  deps: PipelineDeps,
  onProgress?: ProgressCallback,
  existing?: ResearchRun,
): Promise<ResearchRun> {
  const run: ResearchRun =
    existing ??
    ({
      id: randomUUID(),
      query,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stage: "planning",
      statusMessage: "Planning research",
      trail: { counters: emptyCounters(), candidates: [] },
    } satisfies ResearchRun);

  const update = async (stage: PipelineStage, statusMessage: string, patch?: Partial<ResearchRun>) => {
    run.stage = stage;
    run.statusMessage = statusMessage;
    run.updatedAt = new Date().toISOString();
    Object.assign(run, patch);
    await onProgress?.(run);
  };

  try {
    await deps.codex.requireChatGptAuth();

    await update("planning", "Planning research");
    const spec = await planResearch(deps.codex, query);
    run.spec = spec;
    await update("planning", "Research plan ready", {
      statusMessage: `Interpretation ready.\n${describeSpec(spec)}`,
    });

    await update("searching", "Searching");
    const discovered = [];
    const searchErrors: string[] = [];
    for (const q of spec.searchQueries) {
      try {
        const batch = await deps.search.search(q, { maxResults: 20 });
        discovered.push(...batch);
      } catch (err) {
        searchErrors.push(`${q}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (discovered.length === 0) {
      throw new Error(
        searchErrors.length > 0
          ? `Discovery found no sources. ${searchErrors.join(" | ")}`
          : "Discovery found no sources.",
      );
    }
    const { unique: uniqueResults, removedCount: searchDupes } = dedupeSearchResults(discovered);
    run.trail.counters.discovered = uniqueResults.length;
    run.trail.counters.duplicatesConsolidated += searchDupes;

    run.trail.candidates = uniqueResults.map((result) => ({
      id: randomUUID(),
      result,
      selected: false,
    }));
    await update(
      "searching",
      searchErrors.length > 0
        ? `Discovered ${uniqueResults.length} unique candidates (some providers failed and were skipped)`
        : `Discovered ${uniqueResults.length} unique candidates`,
    );

    await update("screening", "Screening results");
    const triageResults: TriageResult[] = [];
    for (const candidate of run.trail.candidates) {
      const judgment = await deps.jev.triageCandidate({
        researchQuestion: spec.query,
        evaluationCriteria: spec.evaluationCriteria,
        title: candidate.result.title,
        url: candidate.result.url,
        domain: domainOf(candidate.result.url),
        snippet: candidate.result.snippet,
      });
      const triage: TriageResult = {
        result: candidate.result,
        relevant: judgment.relevant,
        confidence: judgment.confidence,
        reason: judgment.reason,
        decision: judgment.decision,
        scores: judgment.scores,
      };
      triageResults.push(triage);
      candidate.triage = triage;
      candidate.selected = judgment.decision !== "reject";
      if (judgment.decision === "reject") run.trail.counters.jevRejected += 1;
      else if (judgment.decision === "uncertain") {
        run.trail.counters.jevUncertain += 1;
        run.trail.counters.jevKept += 1;
      } else run.trail.counters.jevKept += 1;
    }
    await update("screening", `Kept ${run.trail.counters.jevKept} candidates after Jev triage`);

    await update("reading", "Reading sources");
    const selected = run.trail.candidates.filter((c) => c.selected);
    const fetchedDocs = [];
    for (const candidate of selected) {
      const doc = await deps.fetcher.fetch(candidate.result.url);
      candidate.fetchStatus = doc.fetchStatus;
      candidate.fetchError = doc.error;
      if (doc.fetchStatus === "ok") {
        fetchedDocs.push(doc);
        run.trail.counters.sourcesFetched += 1;
      } else {
        run.trail.counters.fetchFailed += 1;
      }
    }

    const { unique: uniqueDocs, removedCount: docDupes, duplicateMap } = dedupeDocuments(fetchedDocs);
    run.trail.counters.duplicatesConsolidated += docDupes;
    for (const [dupUrl, canonical] of duplicateMap) {
      const cand = run.trail.candidates.find((c) => c.result.url === dupUrl);
      if (cand) cand.duplicateOf = canonical;
    }
    await update("reading", `Fetched ${uniqueDocs.length} usable sources`);

    await update("comparing", "Comparing evidence");
    await update("writing", "Writing report");
    const report = await deepResearchAndSynthesize(deps.codex, spec, uniqueDocs, deps.jev);
    const used = new Set(associateSourcesUsed(report));
    for (const candidate of run.trail.candidates) {
      candidate.usedInReport = used.has(candidate.result.url);
    }
    run.trail.counters.sourcesUsed = used.size;
    run.report = report;

    await update("done", "Research complete", { report });
    return run;
  } catch (err) {
    run.stage = "error";
    run.error = err instanceof Error ? err.message : String(err);
    run.statusMessage = "Research failed";
    run.updatedAt = new Date().toISOString();
    await onProgress?.(run);
    return run;
  }
}

export type { TrailCandidate };
