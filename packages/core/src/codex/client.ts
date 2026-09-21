import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export type CodexAccount =
  | { type: "chatgpt"; email?: string | null; planType?: string | null }
  | { type: "apiKey" }
  | { type: "other"; raw: unknown }
  | null;

export interface CodexAuthStatus {
  authenticated: boolean;
  account: CodexAccount;
  requiresOpenaiAuth: boolean;
  authModeSafe: boolean;
  message: string;
}

export interface CodexPromptOptions {
  outputSchema?: unknown;
  model?: string;
  cwd?: string;
}

export interface CodexClient {
  start(): Promise<void>;
  close(): Promise<void>;
  getAuthStatus(): Promise<CodexAuthStatus>;
  startChatGptLogin(mode?: "browser" | "device"): Promise<{
    loginId: string;
    authUrl?: string;
    verificationUrl?: string;
    userCode?: string;
  }>;
  waitForLogin(loginId: string, timeoutMs?: number): Promise<boolean>;
  cancelLogin(loginId: string): Promise<void>;
  requireChatGptAuth(): Promise<CodexAuthStatus>;
  runJson<T>(prompt: string, options: CodexPromptOptions & { schemaName: string }): Promise<T>;
  runText(prompt: string, options?: CodexPromptOptions): Promise<string>;
}

const FORBIDDEN_ENV = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY_NAME",
] as const;

function scrubEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if ((FORBIDDEN_ENV as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  return env;
}

function resolveCodexBin(override?: string): string {
  if (override || process.env.CODEX_BIN) return override || process.env.CODEX_BIN!;
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@openai/codex/package.json");
    const bin = join(dirname(pkgJson), "bin", "codex.js");
    if (existsSync(bin)) return bin;
  } catch {
    /* fall through */
  }
  return "codex";
}

type JsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * Thin App Server JSON-RPC client.
 * Uses ChatGPT-managed auth only; never injects API keys.
 */
export class AppServerCodexClient extends EventEmitter implements CodexClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private loginWaiters = new Map<
    string,
    { resolve: (ok: boolean) => void; reject: (err: Error) => void }
  >();
  private started = false;
  private readonly codexBin: string;

  constructor(options?: { codexBin?: string }) {
    super();
    this.codexBin = resolveCodexBin(options?.codexBin);
  }

  async start(): Promise<void> {
    if (this.started) return;

    const env = scrubEnv();
    this.proc = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.on("exit", (code, signal) => {
      const err = new Error(`codex app-server exited (code=${code}, signal=${signal})`);
      for (const [, waiter] of this.pending) waiter.reject(err);
      this.pending.clear();
      this.started = false;
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.onLine(line));

    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    await this.request("initialize", {
      clientInfo: {
        name: "jev-research",
        title: "Jev Research",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
      },
    });
    this.notify("initialized", null);
    this.started = true;
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.started = false;
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    proc.kill("SIGTERM");
  }

  async getAuthStatus(): Promise<CodexAuthStatus> {
    await this.ensureStarted();
    const result = (await this.request("account/read", { refreshToken: false })) as {
      account?: unknown;
      requiresOpenaiAuth?: boolean;
    };

    const account = normalizeAccount(result.account);
    const requiresOpenaiAuth = Boolean(result.requiresOpenaiAuth);
    const authModeSafe = account?.type === "chatgpt";
    const authenticated = account !== null;

    let message: string;
    if (!authenticated) {
      message = "Not signed in to Codex. Sign in with ChatGPT to use subscription entitlements.";
    } else if (account.type === "chatgpt") {
      message = `Signed in with ChatGPT${account.planType ? ` (${account.planType})` : ""}${
        account.email ? ` as ${account.email}` : ""
      }.`;
    } else if (account.type === "apiKey") {
      message =
        "Codex is authenticated with an API key. Jev Research requires ChatGPT subscription auth — API key billing is not supported for the MVP path.";
    } else {
      message = "Codex is authenticated with an unsupported mode for this app.";
    }

    return { authenticated, account, requiresOpenaiAuth, authModeSafe, message };
  }

  async requireChatGptAuth(): Promise<CodexAuthStatus> {
    const status = await this.getAuthStatus();
    if (!status.authModeSafe) {
      throw new Error(
        `ChatGPT-authenticated Codex required. ${status.message} Do not set OPENAI_API_KEY/CODEX_API_KEY.`,
      );
    }
    return status;
  }

  async startChatGptLogin(mode: "browser" | "device" = "device"): Promise<{
    loginId: string;
    authUrl?: string;
    verificationUrl?: string;
    userCode?: string;
  }> {
    await this.ensureStarted();
    const params =
      mode === "browser"
        ? {
            type: "chatgpt",
            useHostedLoginSuccessPage: true,
            appBrand: "chatgpt",
          }
        : { type: "chatgptDeviceCode" };

    const result = (await this.request("account/login/start", params)) as {
      type: string;
      loginId?: string;
      authUrl?: string;
      verificationUrl?: string;
      userCode?: string;
    };

    if (result.type === "apiKey") {
      throw new Error("Refusing API key login for the MVP path.");
    }

    const loginId = result.loginId;
    if (!loginId) throw new Error("Codex login did not return a loginId.");

    return {
      loginId,
      authUrl: result.authUrl,
      verificationUrl: result.verificationUrl,
      userCode: result.userCode,
    };
  }

  waitForLogin(loginId: string, timeoutMs = 300_000): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loginWaiters.delete(loginId);
        reject(new Error("Timed out waiting for ChatGPT login."));
      }, timeoutMs);

      this.loginWaiters.set(loginId, {
        resolve: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.ensureStarted();
    await this.request("account/login/cancel", { loginId });
    const waiter = this.loginWaiters.get(loginId);
    if (waiter) {
      this.loginWaiters.delete(loginId);
      waiter.resolve(false);
    }
  }

  async runJson<T>(
    prompt: string,
    options: CodexPromptOptions & { schemaName: string },
  ): Promise<T> {
    const text = await this.runTurn(prompt, options);
    return parseJsonLoose<T>(text, options.schemaName);
  }

  async runText(prompt: string, options?: CodexPromptOptions): Promise<string> {
    return this.runTurn(prompt, options);
  }

  private async runTurn(prompt: string, options?: CodexPromptOptions): Promise<string> {
    await this.requireChatGptAuth();

    const start = (await this.request("thread/start", {
      cwd: options?.cwd ?? process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      model: options?.model,
      threadSource: "jev-research",
      developerInstructions:
        "You are the research reasoning engine for Jev Research. Do not invent sources. Prefer evidence from provided documents. Return only the requested output format.",
    })) as { thread?: { id?: string }; id?: string };

    const threadId = start.thread?.id ?? start.id;
    if (!threadId) throw new Error("thread/start did not return a thread id.");

    const turn = (await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
      outputSchema: options?.outputSchema ?? null,
    })) as { turn?: { id?: string }; id?: string };

    const turnId = turn.turn?.id ?? turn.id;
    if (!turnId) throw new Error("turn/start did not return a turn id.");

    return this.waitForTurnText(turnId);
  }

  private waitForTurnText(turnId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let finalText = "";
      const timeout = setTimeout(() => {
        this.off("notification", onNotification);
        reject(new Error(`Timed out waiting for Codex turn ${turnId}`));
      }, 600_000);

      const onNotification = (msg: JsonRpcMessage) => {
        if (!msg.method) return;
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const eventTurnId =
          (params.turnId as string | undefined) ??
          ((params.turn as { id?: string } | undefined)?.id);

        if (eventTurnId && eventTurnId !== turnId) return;

        if (msg.method === "item/agentMessage/delta") {
          const delta = params.delta;
          if (typeof delta === "string") finalText += delta;
        }

        if (msg.method === "item/completed") {
          const item = params.item as { type?: string; text?: string } | undefined;
          if (item?.type === "agentMessage" && typeof item.text === "string") {
            finalText = item.text;
          }
        }

        if (msg.method === "turn/completed") {
          clearTimeout(timeout);
          this.off("notification", onNotification);
          if (!finalText.trim()) {
            reject(new Error("Codex turn completed without an agent message."));
            return;
          }
          resolve(finalText);
        }

        if (msg.method === "turn/failed" || msg.method === "error") {
          clearTimeout(timeout);
          this.off("notification", onNotification);
          const message =
            (params.error as { message?: string } | undefined)?.message ||
            (params.message as string | undefined) ||
            "Codex turn failed";
          reject(new Error(message));
        }
      };

      this.on("notification", onNotification);
    });
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started) await this.start();
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error("Codex app-server is not running."));
    const id = randomUUID();
    const message: JsonRpcMessage = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(message);
    });
  }

  private notify(method: string, params: unknown): void {
    const message: JsonRpcMessage = { method };
    if (params !== undefined) message.params = params;
    this.write(message);
  }

  private write(message: JsonRpcMessage): void {
    if (!this.proc?.stdin.writable) throw new Error("Codex stdin is not writable.");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit("parse-error", line);
      return;
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(String(msg.id));
      if (waiter) {
        this.pending.delete(String(msg.id));
        if (msg.error) {
          waiter.reject(new Error(`JSON-RPC ${msg.error.code}: ${msg.error.message}`));
        } else {
          waiter.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method) {
      this.emit("notification", msg);
      if (msg.method === "account/login/completed") {
        const params = msg.params as {
          loginId?: string | null;
          success?: boolean;
          error?: string | null;
        };
        const loginId = params.loginId;
        if (loginId && this.loginWaiters.has(loginId)) {
          const waiter = this.loginWaiters.get(loginId)!;
          this.loginWaiters.delete(loginId);
          if (params.success) waiter.resolve(true);
          else waiter.reject(new Error(params.error || "ChatGPT login failed."));
        }
      }
    }
  }
}

function normalizeAccount(raw: unknown): CodexAccount {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type === "chatgpt") {
    return {
      type: "chatgpt",
      email: (obj.email as string | null | undefined) ?? null,
      planType: (obj.planType as string | null | undefined) ?? null,
    };
  }
  if (obj.type === "apiKey") return { type: "apiKey" };
  return { type: "other", raw };
}

export function parseJsonLoose<T>(text: string, label: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim()) as T;
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error(`Failed to parse Codex JSON for ${label}.`);
  }
}

/** Test double — never talks to Codex. */
export class MockCodexClient implements CodexClient {
  public auth: CodexAuthStatus = {
    authenticated: true,
    account: { type: "chatgpt", email: "tester@example.com", planType: "pro" },
    requiresOpenaiAuth: true,
    authModeSafe: true,
    message: "Signed in with ChatGPT (mock).",
  };

  public handlers: {
    json?: (prompt: string, schemaName: string) => unknown;
    text?: (prompt: string) => string;
  } = {};

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  async getAuthStatus(): Promise<CodexAuthStatus> {
    return this.auth;
  }

  async startChatGptLogin(): Promise<{ loginId: string; verificationUrl?: string; userCode?: string }> {
    return { loginId: "mock-login", verificationUrl: "https://example.com", userCode: "ABCD" };
  }

  async waitForLogin(): Promise<boolean> {
    return true;
  }

  async cancelLogin(): Promise<void> {}

  async requireChatGptAuth(): Promise<CodexAuthStatus> {
    if (!this.auth.authModeSafe) throw new Error(this.auth.message);
    return this.auth;
  }

  async runJson<T>(prompt: string, options: CodexPromptOptions & { schemaName: string }): Promise<T> {
    if (!this.handlers.json) throw new Error("MockCodexClient missing json handler");
    return this.handlers.json(prompt, options.schemaName) as T;
  }

  async runText(prompt: string): Promise<string> {
    if (!this.handlers.text) throw new Error("MockCodexClient missing text handler");
    return this.handlers.text(prompt);
  }
}
