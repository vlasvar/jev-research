import type { CodexClient } from "../codex/client.js";
import type { JevClient, EvidenceCheckResult } from "../typesafe/jev.js";
import type { ResearchReport, ResearchSpec, SourceDocument } from "../types.js";
import { ResearchReportSchema } from "../types.js";

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "findings", "evidenceSynthesis", "sources", "citations"],
  properties: {
    answer: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "summary",
          "whySelected",
          "characteristics",
          "dimensionEntries",
          "sourceUrls",
        ],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          whySelected: { type: "string" },
          characteristics: { type: "array", items: { type: "string" } },
          dimensionEntries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "value"],
              properties: {
                name: { type: "string" },
                value: { type: "string" },
              },
            },
          },
          sourceUrls: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
    evidenceSynthesis: { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "publisher"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          publisher: { type: "string" },
        },
      },
    },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "sourceUrl", "support"],
        properties: {
          claim: { type: "string" },
          sourceUrl: { type: "string" },
          support: { type: "string", enum: ["supports", "contradicts", "unverified"] },
        },
      },
    },
  },
} as const;

export async function deepResearchAndSynthesize(
  codex: CodexClient,
  spec: ResearchSpec,
  documents: SourceDocument[],
  jev?: JevClient,
): Promise<ResearchReport> {
  const dossier = documents
    .filter((d) => d.fetchStatus === "ok" && d.text.trim().length > 0)
    .map((d, i) => {
      return [
        `### Source ${i + 1}`,
        `Title: ${d.title}`,
        `URL: ${d.url}`,
        `Publisher: ${d.publisher ?? "unknown"}`,
        `Published: ${d.publishedAt ?? "unknown"}`,
        `Excerpt:`,
        d.text.slice(0, 8000),
      ].join("\n");
    })
    .join("\n\n");

  const investigationPrompt = `You are performing deep research for Jev Research.

ResearchSpec JSON:
${JSON.stringify(spec, null, 2)}

Source documents (already fetched; do not invent URLs):
${dossier || "(no documents successfully fetched)"}

Tasks:
1. Inspect evidence against the evaluation criteria.
2. Compare candidates; note contradictions and missing information.
3. Distinguish claims from evidence.
4. Select findings that actually answer the user question (not merely top search ranks).
5. Produce the final human-readable research report as JSON matching the schema.
6. Every material factual claim must be traceable to a provided source URL. Never fabricate citations.
7. If desiredResults is set, return about that many findings when evidence supports it.

Return JSON only.`;

  const raw = await codex.runJson<unknown>(investigationPrompt, {
    schemaName: "ResearchReport",
    outputSchema: REPORT_SCHEMA,
  });

  let report = parseResearchReport(raw, documents);

  if (jev?.checkEvidence && report.citations?.length) {
    const checked = [];
    for (const citation of report.citations.slice(0, 12)) {
      const doc = documents.find((d) => d.url === citation.sourceUrl);
      if (!doc || doc.fetchStatus !== "ok") {
        checked.push({ ...citation, support: "unverified" as const });
        continue;
      }
      try {
        const result: EvidenceCheckResult = await jev.checkEvidence({
          claim: citation.claim,
          sourceUrl: citation.sourceUrl,
          sourceExcerpt: doc.text.slice(0, 5000),
        });
        checked.push({
          ...citation,
          support:
            result.support === "says_nothing"
              ? ("unverified" as const)
              : (result.support as "supports" | "contradicts"),
        });
      } catch {
        checked.push({ ...citation, support: "unverified" as const });
      }
    }
    report = { ...report, citations: checked };
  }

  return report;
}

export function parseResearchReport(
  raw: unknown,
  documents: SourceDocument[] = [],
): ResearchReport {
  const normalized = normalizeReportPayload(raw);
  const parsed = ResearchReportSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Invalid ResearchReport: ${parsed.error.message}`);
  }

  const allowed = new Set(documents.map((d) => d.url));
  const report = parsed.data;

  // Drop fabricated URLs that were never fetched/discovered when we have a allow-list.
  if (allowed.size > 0) {
    report.findings = report.findings.map((f) => ({
      ...f,
      sourceUrls: f.sourceUrls.filter((u) => allowed.has(u)),
    }));
    report.findings = report.findings.filter((f) => f.sourceUrls.length > 0);
    report.sources = report.sources.filter((s) => allowed.has(s.url));
    if (report.citations) {
      report.citations = report.citations.filter((c) => allowed.has(c.sourceUrl));
    }
  }

  return report;
}

function normalizeReportPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = { ...(raw as Record<string, unknown>) };

  if (Array.isArray(obj.findings)) {
    obj.findings = obj.findings.map((finding) => {
      if (!finding || typeof finding !== "object") return finding;
      const f = { ...(finding as Record<string, unknown>) };
      if (Array.isArray(f.dimensionEntries)) {
        const dimensions: Record<string, string> = {};
        for (const entry of f.dimensionEntries) {
          if (!entry || typeof entry !== "object") continue;
          const e = entry as { name?: unknown; value?: unknown };
          if (typeof e.name === "string" && typeof e.value === "string" && e.name.trim()) {
            dimensions[e.name] = e.value;
          }
        }
        if (Object.keys(dimensions).length > 0) f.dimensions = dimensions;
        delete f.dimensionEntries;
      }
      if (f.whySelected === null) delete f.whySelected;
      if (Array.isArray(f.characteristics) && f.characteristics.length === 0) {
        delete f.characteristics;
      }
      return f;
    });
  }

  if (Array.isArray(obj.sources)) {
    obj.sources = obj.sources.map((source) => {
      if (!source || typeof source !== "object") return source;
      const s = { ...(source as Record<string, unknown>) };
      if (s.publisher === null || s.publisher === "") delete s.publisher;
      return s;
    });
  }

  if (obj.evidenceSynthesis === null || obj.evidenceSynthesis === "") {
    delete obj.evidenceSynthesis;
  }
  if (!Array.isArray(obj.citations)) obj.citations = [];

  return obj;
}

export function associateSourcesUsed(report: ResearchReport): string[] {
  const urls = new Set<string>();
  for (const f of report.findings) for (const u of f.sourceUrls) urls.add(u);
  for (const s of report.sources) urls.add(s.url);
  if (report.citations) for (const c of report.citations) urls.add(c.sourceUrl);
  return [...urls];
}
