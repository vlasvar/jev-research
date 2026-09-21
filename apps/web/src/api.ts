export type ResearchStage =
  | "planning"
  | "searching"
  | "screening"
  | "reading"
  | "comparing"
  | "writing"
  | "done"
  | "error";

export interface ResearchReport {
  answer: string;
  findings: Array<{
    title: string;
    summary: string;
    whySelected?: string;
    characteristics?: string[];
    dimensions?: Record<string, string>;
    sourceUrls: string[];
  }>;
  evidenceSynthesis?: string;
  sources: Array<{ title: string; url: string; publisher?: string }>;
}

export interface ResearchRun {
  id: string;
  query: string;
  stage: ResearchStage;
  statusMessage: string;
  report?: ResearchReport;
  error?: string;
  spec?: {
    objective: string;
    researchType: string;
    evaluationCriteria: string[];
    desiredResults?: number;
  };
  trail: {
    counters: {
      discovered: number;
      jevRejected: number;
      jevUncertain: number;
      jevKept: number;
      sourcesFetched: number;
      fetchFailed: number;
      duplicatesConsolidated: number;
      sourcesUsed: number;
    };
    candidates: Array<{
      id: string;
      result: { title: string; url: string; snippet?: string };
      selected: boolean;
      triage?: {
        decision: "keep" | "reject" | "uncertain";
        confidence: number;
        reason?: string;
      };
      fetchStatus?: string;
      usedInReport?: boolean;
    }>;
  };
}

export interface SettingsStatus {
  codex: {
    authenticated: boolean;
    authModeSafe: boolean;
    message: string;
    account: null | { type: string; email?: string | null; planType?: string | null };
  };
  typesafe: {
    configured: boolean;
    ok: boolean;
    message: string;
    model?: string;
  };
}

const API = "";

export async function fetchSettings(): Promise<SettingsStatus> {
  const res = await fetch(`${API}/api/settings/status`);
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

export async function testTypeSafe(apiKey?: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${API}/api/settings/typesafe/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  return res.json();
}

export async function startCodexLogin(mode: "browser" | "device" = "device") {
  const res = await fetch(`${API}/api/settings/codex/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  return res.json();
}

export async function waitCodexLogin(loginId: string) {
  const res = await fetch(`${API}/api/settings/codex/login/${loginId}/wait`);
  return res.json();
}

export async function startResearch(query: string): Promise<{ id: string } | { error: string }> {
  const res = await fetch(`${API}/api/research`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

export function subscribeResearch(id: string, onRun: (run: ResearchRun) => void): () => void {
  const es = new EventSource(`${API}/api/research/${id}/events`);
  es.addEventListener("run", (ev) => {
    onRun(JSON.parse((ev as MessageEvent).data) as ResearchRun);
  });
  es.onerror = () => {
    /* EventSource reconnects; final state also polled via done */
  };
  return () => es.close();
}
