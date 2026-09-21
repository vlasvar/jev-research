import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  AppServerCodexClient,
  DuckDuckGoSearchProvider,
  HttpContentFetcher,
  RunStore,
  TypeSafeJevClient,
  runResearchPipeline,
  type ResearchRun,
} from "@jev-research/core";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = resolve(process.cwd(), process.env.DATA_DIR || "../../data");
const WEB_DIST = resolve(process.cwd(), "../web/dist");

const store = new RunStore(resolve(DATA_DIR, "runs.sqlite"));
const codex = new AppServerCodexClient({ codexBin: process.env.CODEX_BIN });
const search = new DuckDuckGoSearchProvider();
const fetcher = new HttpContentFetcher();

const active = new Map<string, ResearchRun>();
const listeners = new Map<string, Set<(run: ResearchRun) => void>>();

function broadcast(run: ResearchRun): void {
  active.set(run.id, run);
  store.save(run);
  const set = listeners.get(run.id);
  if (set) for (const fn of set) fn(run);
}

function getJev() {
  return new TypeSafeJevClient({
    apiKey: process.env.TYPESAFE_API_KEY,
    baseURL: process.env.TYPESAFE_BASE_URL,
    model: process.env.TYPESAFE_MODEL,
  });
}

const app = new Hono();
app.use("*", cors({ origin: ["http://127.0.0.1:5173", "http://localhost:5173"] }));

app.get("/api/health", (c) => c.json({ ok: true, name: "jev-research" }));

app.get("/api/settings/status", async (c) => {
  let codexStatus;
  try {
    await codex.start();
    codexStatus = await codex.getAuthStatus();
  } catch (err) {
    codexStatus = {
      authenticated: false,
      account: null,
      requiresOpenaiAuth: true,
      authModeSafe: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let typesafe: { ok: boolean; message: string; model?: string } = {
    ok: false,
    message: "TYPESAFE_API_KEY not set",
  };
  if (process.env.TYPESAFE_API_KEY) {
    try {
      typesafe = await getJev().testConnection();
    } catch (err) {
      typesafe = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        model: undefined,
      };
    }
  }

  return c.json({
    codex: {
      authenticated: codexStatus.authenticated,
      authModeSafe: codexStatus.authModeSafe,
      requiresOpenaiAuth: codexStatus.requiresOpenaiAuth,
      message: codexStatus.message,
      // Privacy: never expose account email (or other personal identifiers) to the client.
      account: codexStatus.account
        ? {
            type: codexStatus.account.type,
            planType:
              codexStatus.account.type === "chatgpt"
                ? (codexStatus.account.planType ?? null)
                : null,
          }
        : null,
    },
    typesafe: {
      configured: Boolean(process.env.TYPESAFE_API_KEY),
      ok: typesafe.ok,
      message: typesafe.message,
      model: typesafe.model,
    },
  });
});

app.post("/api/settings/typesafe/test", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : process.env.TYPESAFE_API_KEY;
  if (!apiKey) return c.json({ ok: false, message: "No TYPESAFE_API_KEY provided." }, 400);
  // Persist only via env for MVP — accept one-shot test without writing secrets to disk from browser.
  try {
    const client = new TypeSafeJevClient({ apiKey });
    const result = await client.testConnection();
    // Local MVP: successful test adopts the provided key for this process session.
    if (result.ok) {
      process.env.TYPESAFE_API_KEY = apiKey;
    }
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/api/settings/codex/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const mode = body.mode === "browser" ? "browser" : "device";
  try {
    await codex.start();
    const login = await codex.startChatGptLogin(mode);
    return c.json(login);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/api/settings/codex/login/:loginId/wait", async (c) => {
  const loginId = c.req.param("loginId");
  try {
    const ok = await codex.waitForLogin(loginId);
    const status = await codex.getAuthStatus();
    return c.json({
      ok,
      status: {
        authenticated: status.authenticated,
        authModeSafe: status.authModeSafe,
        message: status.message,
        account: status.account
          ? {
              type: status.account.type,
              planType:
                status.account.type === "chatgpt" ? (status.account.planType ?? null) : null,
            }
          : null,
      },
    });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/api/research", async (c) => {
  const body = await c.req.json();
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return c.json({ error: "query is required" }, 400);
  if (!process.env.TYPESAFE_API_KEY) {
    return c.json({ error: "TYPESAFE_API_KEY is required on the server." }, 400);
  }

  try {
    await codex.start();
    await codex.requireChatGptAuth();
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 401);
  }

  const runId = crypto.randomUUID();
  const seed: ResearchRun = {
    id: runId,
    query,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stage: "planning",
    statusMessage: "Planning research",
    trail: {
      counters: {
        discovered: 0,
        jevRejected: 0,
        jevUncertain: 0,
        jevKept: 0,
        sourcesFetched: 0,
        fetchFailed: 0,
        duplicatesConsolidated: 0,
        sourcesUsed: 0,
      },
      candidates: [],
    },
  };
  broadcast(seed);

  void runResearchPipeline(
    query,
    { codex, jev: getJev(), search, fetcher },
    (run) => broadcast(run),
    seed,
  );

  return c.json({ id: runId });
});

app.get("/api/research/:id", (c) => {
  const id = c.req.param("id");
  const run = active.get(id) ?? store.get(id);
  if (!run) return c.json({ error: "not found" }, 404);
  return c.json(run);
});

app.get("/api/research/:id/events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const send = async (run: ResearchRun) => {
      await stream.writeSSE({ event: "run", data: JSON.stringify(run) });
    };
    const existing = active.get(id) ?? store.get(id);
    if (existing) await send(existing);

    const set = listeners.get(id) ?? new Set();
    const handler = (run: ResearchRun) => {
      void send(run);
    };
    set.add(handler);
    listeners.set(id, set);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const run = active.get(id) ?? store.get(id);
        if (run && (run.stage === "done" || run.stage === "error")) {
          clearInterval(interval);
          resolve();
        }
      }, 1000);
      stream.onAbort(() => {
        clearInterval(interval);
        resolve();
      });
    });

    set.delete(handler);
  });
});

app.get("/api/runs", (c) => c.json({ runs: store.list() }));

app.use("/*", serveStatic({ root: WEB_DIST }));
app.get("*", serveStatic({ path: resolve(WEB_DIST, "index.html") }));

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`Jev Research listening on http://${HOST}:${info.port}`);
  console.log("Codex auth: ChatGPT subscription path only (API keys scrubbed from Codex env).");
});

process.on("SIGINT", async () => {
  await codex.close();
  process.exit(0);
});
