import { describe, expect, it } from "vitest";
import {
  MockCodexClient,
  MockJevClient,
  StaticContentFetcher,
  StaticSearchProvider,
  decideFromScores,
  dedupeDocuments,
  dedupeSearchResults,
  normalizeSearchResult,
  parseGoogleNewsRss,
  parseResearchReport,
  parseResearchSpec,
  ResilientSearchProvider,
  runResearchPipeline,
  type SearchProvider,
  type SearchResult,
  type SourceDocument,
} from "@jev-research/core";

describe("ResearchSpec parsing", () => {
  it("parses a planner payload with defaults", () => {
    const spec = parseResearchSpec(
      {
        researchType: "top_n_recommendations",
        objective: "Find excellent cheesecake recipes",
        desiredResults: 5,
        evaluationCriteria: ["taste reputation", "clarity of method", "ingredient quality"],
        searchQueries: ["best cheesecake recipes", "classic New York cheesecake"],
      },
      "Find the 5 best cheesecake recipes.",
    );
    expect(spec.query).toContain("cheesecake");
    expect(spec.desiredResults).toBe(5);
    expect(spec.searchQueries.length).toBeGreaterThan(0);
  });

  it("strips null optional planner fields", () => {
    const spec = parseResearchSpec(
      {
        query: "q",
        researchType: "signal_scan",
        objective: "o",
        desiredResults: null,
        geography: null,
        freshness: null,
        sourcePreferences: [],
        evaluationCriteria: ["credibility"],
        searchQueries: ["q"],
      },
      "q",
    );
    expect(spec.desiredResults).toBeUndefined();
    expect(spec.geography).toBeUndefined();
  });
});

describe("search-result normalization", () => {
  it("normalizes and drops invalid rows", () => {
    const ok = normalizeSearchResult({
      title: "Perfect Cheesecake",
      href: "https://example.com/cake",
      description: "A tested recipe",
    });
    expect(ok?.url).toBe("https://example.com/cake");
    expect(normalizeSearchResult({ title: "", url: "https://x.com" })).toBeNull();
  });
});

describe("Google News RSS parsing", () => {
  it("extracts items from RSS XML", () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title><![CDATA[Athens office demand rises]]></title>
          <link>https://news.example/athens-office</link>
          <pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate>
          <source>Example News</source>
          <description><![CDATA[Logistics and offices]]></description>
        </item>
      </channel></rss>`;
    const results = parseGoogleNewsRss(xml);
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toContain("Athens");
    expect(results[0]?.url).toContain("athens-office");
  });
});

describe("resilient search fallback", () => {
  it("falls back when primary provider fails with a bot challenge-like error", async () => {
    const primary: SearchProvider = {
      name: "primary",
      async search() {
        throw new Error("Provider returned a bot challenge.");
      },
    };
    const fallback: SearchProvider = {
      name: "fallback",
      async search() {
        return [
          {
            title: "Fallback hit",
            url: "https://example.com/fallback",
            snippet: "ok",
          },
        ];
      },
    };
    const provider = new ResilientSearchProvider(primary, [fallback]);
    const results = await provider.search("greece offices");
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toContain("fallback");
  });
});

describe("Jev triage / low-confidence preservation", () => {
  it("rejects only high-confidence low-value candidates", () => {
    const rejected = decideFromScores({
      relevance: 0.1,
      evidenceLikely: 0.1,
      duplicative: 0.1,
    });
    expect(rejected.decision).toBe("reject");

    const uncertain = decideFromScores({
      relevance: 0.48,
      evidenceLikely: 0.5,
      duplicative: 0.2,
    });
    expect(uncertain.decision).toBe("uncertain");
    expect(uncertain.relevant).toBe(true);
  });
});

describe("deduplication", () => {
  it("collapses URL and near-title duplicates", () => {
    const results: SearchResult[] = [
      { title: "Office Expansion in Berlin", url: "https://news.example/a" },
      { title: "Office Expansion in Berlin", url: "https://news.example/a/" },
      { title: "Office Expansion in Berlin", url: "https://news.example/b" },
    ];
    const { unique, removedCount } = dedupeSearchResults(results);
    expect(unique.length).toBe(1);
    expect(removedCount).toBe(2);
  });

  it("collapses near-identical document bodies", () => {
    const text = "evidence ".repeat(80);
    const docs: SourceDocument[] = [
      {
        url: "https://a.example/1",
        title: "A",
        text,
        retrievedAt: new Date().toISOString(),
        fetchStatus: "ok",
      },
      {
        url: "https://b.example/2",
        title: "B",
        text,
        retrievedAt: new Date().toISOString(),
        fetchStatus: "ok",
      },
    ];
    const { unique, removedCount } = dedupeDocuments(docs);
    expect(unique.length).toBe(1);
    expect(removedCount).toBe(1);
  });
});

describe("failed page fetches", () => {
  it("records failed fetches without crashing the pipeline", async () => {
    const codex = new MockCodexClient();
    codex.handlers.json = (_prompt, schemaName) => {
      if (schemaName === "ResearchSpec") {
        return {
          query: "Find three credible recent examples of European companies expanding offices",
          researchType: "signal_scan",
          objective: "Find office expansion examples",
          desiredResults: 3,
          evaluationCriteria: ["credibility", "recency", "Europe"],
          searchQueries: ["European companies expanding offices 2025"],
        };
      }
      return {
        answer: "Insufficient fetched evidence.",
        findings: [],
        sources: [],
        evidenceSynthesis: "",
        citations: [],
      };
    };

    const search = new StaticSearchProvider([
      {
        title: "Acme opens Berlin office",
        url: "https://example.com/acme-berlin",
        snippet: "European company expanding offices",
      },
    ]);
    const fetcher = new StaticContentFetcher({});
    const jev = new MockJevClient();

    const run = await runResearchPipeline("European office expansions", {
      codex,
      jev,
      search,
      fetcher,
    });

    expect(run.trail.counters.fetchFailed).toBeGreaterThan(0);
    expect(run.stage === "done" || run.stage === "error").toBe(true);
  });
});

describe("citation/source association and report schema", () => {
  it("drops fabricated citations not in fetched sources", () => {
    const report = parseResearchReport(
      {
        answer: "Three recipes stand out.",
        findings: [
          {
            title: "Classic NY",
            summary: "Dense and tangy",
            sourceUrls: ["https://real.example/recipe"],
          },
          {
            title: "Fake",
            summary: "Invented",
            sourceUrls: ["https://fake.example/nope"],
          },
        ],
        sources: [
          { title: "Classic NY", url: "https://real.example/recipe" },
          { title: "Fake", url: "https://fake.example/nope" },
        ],
        citations: [
          { claim: "Uses full-fat cream cheese", sourceUrl: "https://real.example/recipe" },
          { claim: "Invented claim", sourceUrl: "https://fake.example/nope" },
        ],
      },
      [
        {
          url: "https://real.example/recipe",
          title: "Classic NY",
          text: "cream cheese",
          retrievedAt: new Date().toISOString(),
          fetchStatus: "ok",
        },
      ],
    );

    expect(report.findings).toHaveLength(1);
    expect(report.sources).toHaveLength(1);
    expect(report.citations).toHaveLength(1);
    expect(report.citations?.[0]?.sourceUrl).toBe("https://real.example/recipe");
  });
});

describe("end-to-end mocked pipeline", () => {
  it("runs cheesecake-style research without hard-coding the use case", async () => {
    const docs: Record<string, SourceDocument> = {
      "https://baker.example/ny": {
        url: "https://baker.example/ny",
        title: "New York Cheesecake",
        publisher: "baker.example",
        text: "A dense baked cheesecake with cream cheese, eggs, sugar, and a graham crust. Bake in a water bath for 70 minutes.",
        retrievedAt: new Date().toISOString(),
        fetchStatus: "ok",
      },
      "https://baker.example/japanese": {
        url: "https://baker.example/japanese",
        title: "Japanese Cotton Cheesecake",
        publisher: "baker.example",
        text: "A souffle-style cheesecake whipped with egg whites. Light texture, lower sugar, 40 minute bake.",
        retrievedAt: new Date().toISOString(),
        fetchStatus: "ok",
      },
      "https://spam.example/unrelated": {
        url: "https://spam.example/unrelated",
        title: "Car insurance deals",
        text: "Save on car insurance today.",
        retrievedAt: new Date().toISOString(),
        fetchStatus: "ok",
      },
    };

    const search = new StaticSearchProvider([
      { title: "New York Cheesecake", url: "https://baker.example/ny", snippet: "best classic cheesecake recipe" },
      { title: "Japanese Cotton Cheesecake", url: "https://baker.example/japanese", snippet: "fluffy cheesecake" },
      { title: "Car insurance deals", url: "https://spam.example/unrelated", snippet: "insurance" },
      { title: "New York Cheesecake", url: "https://baker.example/ny/", snippet: "duplicate url variant" },
    ]);

    const codex = new MockCodexClient();
    codex.handlers.json = (_prompt, schemaName) => {
      if (schemaName === "ResearchSpec") {
        return {
          query: "Find the 5 best cheesecake recipes.",
          researchType: "top_n_recommendations",
          objective: "Recommend standout cheesecake recipes with clear reasons",
          desiredResults: 5,
          evaluationCriteria: ["method clarity", "distinctiveness", "reputation signals in source"],
          searchQueries: [
            "best cheesecake recipes",
            "classic new york cheesecake",
            "japanese cotton cheesecake",
          ],
        };
      }
      return {
        answer: "Two strong recipes emerge from the available evidence.",
        findings: [
          {
            title: "New York Cheesecake",
            summary: "Dense baked classic with clear method.",
            whySelected: "Strong technique detail and classic profile.",
            characteristics: ["baked", "dense", "graham crust"],
            sourceUrls: ["https://baker.example/ny"],
          },
          {
            title: "Japanese Cotton Cheesecake",
            summary: "Light souffle style alternative.",
            whySelected: "Distinct texture and well-specified method.",
            characteristics: ["souffle", "light"],
            sourceUrls: ["https://baker.example/japanese"],
          },
        ],
        evidenceSynthesis: "Available sources support two well-differentiated styles.",
        sources: [
          { title: "New York Cheesecake", url: "https://baker.example/ny", publisher: "baker.example" },
          {
            title: "Japanese Cotton Cheesecake",
            url: "https://baker.example/japanese",
            publisher: "baker.example",
          },
        ],
        citations: [
          { claim: "Uses a water bath", sourceUrl: "https://baker.example/ny", support: "supports" },
        ],
      };
    };

    const run = await runResearchPipeline("Find the 5 best cheesecake recipes.", {
      codex,
      jev: new MockJevClient(),
      search,
      fetcher: new StaticContentFetcher(docs),
    });

    expect(run.stage).toBe("done");
    expect(run.trail.counters.discovered).toBeGreaterThan(2);
    expect(run.trail.counters.jevRejected).toBeGreaterThan(0);
    expect(run.report?.findings.length).toBeGreaterThan(0);
    expect(run.report?.sources.every((s) => s.url.startsWith("https://"))).toBe(true);
  });
});
