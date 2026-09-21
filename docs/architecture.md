# Architecture

Jev Research is a local-first MVP. Stages are separate modules; there is no single mega-agent prompt.

```
USER QUERY
  → RESEARCH PLANNER (Codex / App Server)
  → SEARCH / DISCOVERY (SearchProvider)
  → JEV TRIAGE (TypeSafe System One)
  → SELECTED SOURCES
  → FULL CONTENT FETCH (ContentFetcher)
  → DEDUPE (deterministic)
  → CODEX RESEARCH + SYNTHESIS
  → OPTIONAL JEV EVIDENCE CHECK
  → CITED REPORT + RESEARCH TRAIL
```

## Codex authentication (critical)

Official docs distinguish:

- **Codex SDK (`@openai/codex-sdk`)**: control local threads (good for automation). It does **not** expose ChatGPT login/account APIs and can inherit `OPENAI_API_KEY` / inject `CODEX_API_KEY`.
- **Codex App Server**: custom clients that handle **authentication**, history, approvals, and streaming.

Jev Research uses **App Server** (`codex app-server --listen stdio://`) and:

1. Calls `account/read` before research.
2. Requires `account.type === "chatgpt"`.
3. Starts ChatGPT login via `account/login/start` (`chatgpt` or `chatgptDeviceCode`).
4. Scrubs `OPENAI_API_KEY` / `CODEX_API_KEY` from the App Server child environment.
5. Refuses the MVP path when only API-key auth is present.

## Jev / TypeSafe

Jev is the judgment layer (`noul` / `choice` / `score`), not the report writer.

Triage is recall-biased: low-confidence candidates are kept. Only high-confidence low-value / duplicative candidates are rejected.

## Discovery

`SearchProvider` abstracts search. v0.1 uses DuckDuckGo via `ddg-kit` (no paid search API). Providers are swappable.

## Persistence

SQLite (`node:sqlite`) stores research runs for trail inspection. Not required for a single in-memory pass, but useful locally.

## Security

- `TYPESAFE_API_KEY` stays server-side.
- Secrets are never written into reports or client bundles.
- Fetching does not bypass paywalls, CAPTCHAs, or auth walls.
