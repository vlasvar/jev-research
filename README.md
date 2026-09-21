# Jev Research

**Search finds information. Research decides what deserves investigation.**

Jev Research is a local-first, open-source research application. You ask a question in natural language; the app plans the research, discovers sources, uses [TypeSafe](https://typesafe.ai) / Jev to decide what is worth reading, then uses [Codex](https://developers.openai.com/codex/) (ChatGPT-authenticated) for deeper reasoning and a cited, human-readable report.

It is deliberately small. No Redis, queues, vector databases, cloud accounts, or mega-agent frameworks.

## How it works

```text
USER QUERY
  → RESEARCH PLANNER (Codex)
  → SEARCH / DISCOVERY
  → JEV TRIAGE
  → FULL CONTENT FETCH
  → DEDUPE
  → CODEX RESEARCH + SYNTHESIS
  → OPTIONAL JEV EVIDENCE CHECK
  → CITED REPORT + RESEARCH TRAIL
```

- **Codex** plans, investigates, and writes the report (subscription / ChatGPT auth — not `OPENAI_API_KEY`).
- **Jev** answers bounded judgment questions (relevant? worth fetching? duplicative? evidence supports claim?).
- **Ordinary code** handles fetching, parsing, URL normalization, counting, and deduplication.

## Requirements

- [Node.js 20+](https://nodejs.org/) (includes `npm`)
- [Git](https://git-scm.com/)
- A [TypeSafe](https://typesafe.ai) API key (`TYPESAFE_API_KEY`)
- [Codex](https://developers.openai.com/codex/) signed in with **ChatGPT** (subscription entitlement)

> Do **not** set `OPENAI_API_KEY` or `CODEX_API_KEY` for the normal path. If Codex is only API-key authenticated, the app refuses to run.

---

## Install (Windows PowerShell)

### 1. Clone the repository

```powershell
git clone https://github.com/vlasvar/jev-research.git
cd jev-research
```

### 2. Create your `.env` file

```powershell
Copy-Item .env.example .env
notepad .env
```

Set your TypeSafe key (no quotes):

```text
TYPESAFE_API_KEY=your_real_key_here
```

Save and close Notepad.

### 3. Sign in to Codex with ChatGPT

```powershell
npx --yes @openai/codex@0.155.1 login --device-auth
```

Complete the URL/code in your browser, then verify:

```powershell
npx --yes @openai/codex@0.155.1 login status
```

### 4. Install, build, and run (one command)

From the **repo root** (`jev-research` folder):

```powershell
git pull; if (-not (Test-Path .env)) { Copy-Item .env.example .env }; npm install; npm run build; npm run dev
```

Or use the helper script (after `git pull` so the file exists):

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

### 5. Open the app

In a **new** PowerShell window (keep the first one running):

```powershell
start http://127.0.0.1:8787
```

In the UI:

1. Open **Settings** and confirm Codex is signed in with ChatGPT.
2. Click **Test connection** for TypeSafe.
3. Go back home and enter a research question, then click **Research**.

Stop the app anytime with `Ctrl+C` in the terminal where it is running.

### Update later / start over

```powershell
cd jev-research
```

```powershell
git pull; npm install; npm run build; npm run dev
```

```powershell
start http://127.0.0.1:8787
```

---

## Install (macOS / Linux)

```bash
git clone https://github.com/vlasvar/jev-research.git
cd jev-research
cp .env.example .env
# Edit .env and set TYPESAFE_API_KEY=...

npx --yes @openai/codex@0.155.1 login --device-auth
npx --yes @openai/codex@0.155.1 login status

npm install
npm run build
npm run dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

---

## Configuration notes

### TypeSafe

```bash
# .env (never commit this file)
TYPESAFE_API_KEY=your_key_here
# optional:
# TYPESAFE_MODEL=jev-latest
# PORT=8787
```

The key stays on the server. It is never sent to the browser bundle or written into reports.

### Codex

Jev Research talks to Codex through **App Server** (`codex app-server`), the official path for custom clients that need authentication. Details: [docs/architecture.md](docs/architecture.md).

Preferred sign-in:

```powershell
npx --yes @openai/codex@0.155.1 login --device-auth
```

You can also use **Settings → Sign in with ChatGPT (device code)** in the UI.

---

## Sample queries

```text
Find the 5 best cheesecake recipes.
```

```text
Find three credible recent examples of European companies expanding their physical office presence.
```

Neither use case is hard-coded — the pipeline is generic.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `scripts\start.ps1` does not exist | Run `git pull` first, or use the one-line `git pull; npm install; npm run build; npm run dev` command |
| `spawn EFTYPE` (Windows) | Pull latest, rebuild, restart — Codex must be launched via native binary / Node |
| `Provider returned a bot challenge` | Pull latest — discovery falls back to Google News RSS and other sources |
| `invalid_json_schema` / missing `desiredResults` | Pull latest and rebuild |
| Codex not signed in | Run `npx --yes @openai/codex@0.155.1 login --device-auth` |
| TypeSafe not connected | Check `TYPESAFE_API_KEY` in `.env`, restart the app, use **Test connection** |
| Blank page | Run `npm run build`, then `npm run dev` again |
| Port in use | Set `PORT=8788` in `.env`, restart, open that URL |

---

## npm scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local API + UI |
| `npm run build` | Build core, server, and web |
| `npm start` | Run the production build |
| `npm test` | Pipeline boundary tests (mocked externals) |

---

## Repository layout

```text
apps/web              Minimal React UI
apps/server           Hono local API (secrets stay here)
packages/core         Pipeline stages + Codex / Jev adapters
tests                 Vitest boundary tests
scripts/start.ps1     Windows one-shot pull/build/run helper
docs/architecture.md  Auth + stage design
.env.example          Required env vars (no secrets)
LICENSE               MIT
CONTRIBUTING.md       Contribution notes
```

## Privacy & security

- This is a **local-first** app: research runs on your machine.
- Secrets (`TYPESAFE_API_KEY`, Codex credentials) stay server-side / local. Never commit `.env`.
- The app does not create user accounts, analytics profiles, or multi-tenant identity.
- Settings may show whether *your* local Codex session is signed in; that status is not published by the app to third parties.
- Fetching does not bypass paywalls, CAPTCHAs, or authentication walls.
- Research Trail is for local inspectability — it must not log credentials.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Short version: keep stages separate, prefer deterministic code where possible, use Jev only for bounded judgment, and keep ChatGPT auth as the Codex path.

## License

[MIT](LICENSE)
