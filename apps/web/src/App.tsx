import { useEffect, useState } from "react";
import {
  fetchSettings,
  startCodexLogin,
  startResearch,
  subscribeResearch,
  testTypeSafe,
  waitCodexLogin,
  type ResearchRun,
  type SettingsStatus,
} from "./api";

const STAGES = [
  ["planning", "Planning research"],
  ["searching", "Searching"],
  ["screening", "Screening results"],
  ["reading", "Reading sources"],
  ["comparing", "Comparing evidence"],
  ["writing", "Writing report"],
] as const;

export function App() {
  const [view, setView] = useState<"home" | "settings" | "run">("home");
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<SettingsStatus | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [loginInfo, setLoginInfo] = useState<{
    loginId: string;
    verificationUrl?: string;
    userCode?: string;
    authUrl?: string;
  } | null>(null);

  async function refreshSettings() {
    const status = await fetchSettings();
    setSettings(status);
  }

  useEffect(() => {
    void refreshSettings().catch((err) => setNotice(String(err)));
  }, []);

  async function onResearch() {
    setNotice(null);
    setBusy(true);
    try {
      const result = await startResearch(query.trim());
      if ("error" in result) {
        setNotice(result.error);
        setBusy(false);
        return;
      }
      setView("run");
      const unsub = subscribeResearch(result.id, (next) => {
        setRun(next);
        if (next.stage === "done" || next.stage === "error") {
          setBusy(false);
          unsub();
        }
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function onTestTypeSafe() {
    setBusy(true);
    setNotice(null);
    const result = await testTypeSafe(apiKeyDraft || undefined);
    setNotice(result.message);
    await refreshSettings();
    setBusy(false);
  }

  async function onCodexLogin() {
    setBusy(true);
    setNotice(null);
    const login = await startCodexLogin("device");
    if (login.error) {
      setNotice(login.error);
      setBusy(false);
      return;
    }
    setLoginInfo(login);
    setNotice("Complete device login in your browser, then wait…");
    const waited = await waitCodexLogin(login.loginId);
    if (waited.ok) setNotice("ChatGPT sign-in complete.");
    else setNotice(waited.error || "Login failed.");
    await refreshSettings();
    setBusy(false);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">Jev Research</div>
        <button className="ghost-btn" type="button" onClick={() => setView(view === "settings" ? "home" : "settings")}>
          {view === "settings" ? "Back" : "Settings"}
        </button>
      </header>

      {view === "home" && (
        <section className="hero">
          <h1>Jev Research</h1>
          <p>Search finds information. Research decides what deserves investigation.</p>
          <div className="ask">
            <label htmlFor="q">What do you want to research?</label>
            <textarea
              id="q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find the 5 best cheesecake recipes."
            />
            <div className="ask-actions">
              <button className="primary-btn" type="button" disabled={!query.trim() || busy} onClick={() => void onResearch()}>
                Research
              </button>
            </div>
          </div>
          {notice && <p className="meta">{notice}</p>}
          {settings && (
            <p className="meta">
              Codex:{" "}
              <span className={settings.codex.authModeSafe ? "status-ok" : "status-bad"}>
                {settings.codex.authModeSafe ? "Signed in with ChatGPT" : settings.codex.message}
              </span>
              {" · "}
              TypeSafe:{" "}
              <span className={settings.typesafe.ok ? "status-ok" : "status-bad"}>
                {settings.typesafe.ok ? "Connected" : settings.typesafe.configured ? settings.typesafe.message : "API key needed"}
              </span>
            </p>
          )}
        </section>
      )}

      {view === "settings" && (
        <section className="panel settings-grid">
          <h2>Settings</h2>
          <div>
            <h3>Codex</h3>
            <p className={settings?.codex.authModeSafe ? "status-ok" : "status-bad"}>
              {settings?.codex.message ?? "Checking…"}
            </p>
            <div className="row">
              <button className="secondary-btn" type="button" disabled={busy} onClick={() => void onCodexLogin()}>
                Sign in with ChatGPT (device code)
              </button>
              <button className="ghost-btn" type="button" disabled={busy} onClick={() => void refreshSettings()}>
                Refresh
              </button>
            </div>
            {loginInfo && (
              <p className="meta">
                Open <a href={loginInfo.verificationUrl || loginInfo.authUrl}>{loginInfo.verificationUrl || loginInfo.authUrl}</a>
                {loginInfo.userCode ? ` and enter code ${loginInfo.userCode}` : ""}.
              </p>
            )}
          </div>
          <div>
            <h3>TypeSafe</h3>
            <div className="field">
              <label htmlFor="typesafe">API key</label>
              <input
                id="typesafe"
                type="password"
                placeholder="TYPESAFE_API_KEY"
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <button className="secondary-btn" type="button" disabled={busy} onClick={() => void onTestTypeSafe()}>
                Test connection
              </button>
            </div>
            <p className="meta">{settings?.typesafe.message}</p>
          </div>
          {notice && <p className="meta">{notice}</p>}
        </section>
      )}

      {view === "run" && run && (
        <section className="panel">
          <h2>{run.query}</h2>
          <ul className="stage-list">
            {STAGES.map(([id, label]) => {
              const order = STAGES.map((s) => s[0]);
              const currentIdx = order.indexOf(run.stage as (typeof order)[number]);
              const idx = order.indexOf(id);
              const done = run.stage === "done" || (currentIdx > idx && currentIdx >= 0);
              const active = run.stage === id;
              return (
                <li key={id} className={done ? "done" : active ? "active" : ""}>
                  <span className="dot" />
                  {label}
                </li>
              );
            })}
          </ul>
          <p className="meta" style={{ marginTop: "1rem", whiteSpace: "pre-wrap" }}>
            {run.statusMessage}
          </p>
          {run.error && <p className="status-bad">{run.error}</p>}

          {run.report && (
            <div style={{ marginTop: "1.5rem" }}>
              <h3>Answer</h3>
              <p>{run.report.answer}</p>
              <h3>Findings</h3>
              <div className="findings">
                {run.report.findings.map((f) => (
                  <article className="finding" key={f.title + f.sourceUrls[0]}>
                    <h3>{f.title}</h3>
                    <p>{f.summary}</p>
                    {f.whySelected && <p className="meta">{f.whySelected}</p>}
                    {f.characteristics && f.characteristics.length > 0 && (
                      <p className="meta">{f.characteristics.join(" · ")}</p>
                    )}
                    <p className="meta">
                      Sources:{" "}
                      {f.sourceUrls.map((u, i) => (
                        <span key={u}>
                          {i > 0 ? ", " : ""}
                          <a href={u} target="_blank" rel="noreferrer">
                            {u}
                          </a>
                        </span>
                      ))}
                    </p>
                  </article>
                ))}
              </div>
              {run.report.evidenceSynthesis && (
                <>
                  <h3>What the evidence says</h3>
                  <p>{run.report.evidenceSynthesis}</p>
                </>
              )}
              <h3>Sources</h3>
              <ul className="sources">
                {run.report.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.title}
                    </a>
                    {s.publisher ? ` — ${s.publisher}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className="trail" style={{ marginTop: "1.5rem" }}>
            <summary>Research Trail</summary>
            <div className="trail-grid">
              {Object.entries(run.trail.counters).map(([k, v]) => (
                <div className="stat" key={k}>
                  <strong>{v}</strong>
                  <span className="meta">{k}</span>
                </div>
              ))}
            </div>
            <table className="candidate-table">
              <thead>
                <tr>
                  <th>Result</th>
                  <th>Jev</th>
                  <th>Conf.</th>
                  <th>Fetch</th>
                  <th>Used</th>
                </tr>
              </thead>
              <tbody>
                {run.trail.candidates.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <a href={c.result.url} target="_blank" rel="noreferrer">
                        {c.result.title}
                      </a>
                      <div className="meta">{c.triage?.reason}</div>
                    </td>
                    <td>{c.triage?.decision ?? "—"}</td>
                    <td>{c.triage ? c.triage.confidence.toFixed(2) : "—"}</td>
                    <td>{c.fetchStatus ?? (c.selected ? "pending" : "skipped")}</td>
                    <td>{c.usedInReport ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <div className="row" style={{ marginTop: "1.25rem" }}>
            <button className="ghost-btn" type="button" onClick={() => { setView("home"); setRun(null); }}>
              New research
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
