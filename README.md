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

- Node.js 20+
- [Codex CLI](https://developers.openai.com/codex/) signed in with **ChatGPT**
- A [TypeSafe](https://typesafe.ai) API key (`TYPESAFE_API_KEY`)

> Do **not** set `OPENAI_API_KEY` / `CODEX_API_KEY` for the normal path. If Codex is only API-key authenticated, the app refuses to run.

## Quick start

```bash
git clone https://github.com/vlasvar/jev-research.git
cd jev-research
cp .env.example .env
# Edit .env and set TYPESAFE_API_KEY=...

npm install
npm run build
npm run dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

### Codex authentication

1. Install Codex (`npm i -g @openai/codex`, or use the `@openai/codex` dependency shipped with this repo).
2. In the app **Settings**, choose **Sign in with ChatGPT (device code)** — or run `codex login` / `codex login --device-auth`.
3. Confirm status shows **Signed in with ChatGPT**.

Jev Research talks to Codex through **App Server** (`codex app-server`), the official path for custom clients that need authentication. Details: [docs/architecture.md](docs/architecture.md).

### TypeSafe configuration

```bash
# .env (never commit this file)
TYPESAFE_API_KEY=your_key_here
# optional:
# TYPESAFE_MODEL=jev-latest
```

Use **Test connection** in Settings. The key stays on the server; it is never sent to the browser bundle or written into reports.

## Sample queries

```text
Find the 5 best cheesecake recipes.
```

```text
Find three credible recent examples of European companies expanding their physical office presence.
```

Neither use case is hard-coded — the pipeline is generic.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local API + UI |
| `npm test` | Pipeline boundary tests (mocked externals) |
| `npm run build` | Build core, server, and web |
| `npm start` | Run the production build |

## Repository layout

```text
apps/web              Minimal React UI
apps/server           Hono local API (secrets stay here)
packages/core         Pipeline stages + Codex / Jev adapters
tests                 Vitest boundary tests
docs/architecture.md  Auth + stage design
.env.example          Required env vars (no secrets)
LICENSE               MIT
CONTRIBUTING.md       Contribution notes
```

## Security

- Secrets stay server-side / local.
- Never commit API keys.
- Fetching does not bypass paywalls, CAPTCHAs, or authentication walls.
- Research Trail is for inspectability — it does not log credentials.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Short version: keep stages separate, prefer deterministic code where possible, use Jev only for bounded judgment, and keep ChatGPT auth as the Codex path.

## License

[MIT](LICENSE)
