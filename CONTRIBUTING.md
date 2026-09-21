# Contributing

Thanks for helping with Jev Research.

## Principles

1. Keep the product deliberately small.
2. Keep pipeline stages separate.
3. Do not silently fall back to `OPENAI_API_KEY` billing.
4. Never expose `TYPESAFE_API_KEY` to the client.

## Development

```bash
npm install
npm test
npm run dev
```

## Pull requests

- Include or update tests for boundary changes.
- Update `docs/architecture.md` when auth or stage contracts change.
- Describe how you verified Codex ChatGPT auth (not API-key mode).
