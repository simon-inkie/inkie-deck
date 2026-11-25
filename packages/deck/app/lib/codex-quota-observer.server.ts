import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import readline from "node:readline";
import { z } from "zod";
import {
  initialQuotaState,
  reduceQuotaState,
  type AccountRateLimits,
  type QuotaState,
  type RateLimitSnapshot,
} from "./codex-quota.js";
import { FileCodexQuotaStore } from "./codex-quota-store.server.js";

type Env = Record<string, string | undefined>;

export interface QuotaStore {
  load(): QuotaState;
  save(state: QuotaState): void;
}

export interface AppServerConnection {
  send(message: unknown): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

export type ConnectAppServer = () => AppServerConnection;

const WindowSchema = z
  .object({
    usedPercent: z.number().optional(),
    windowDurationMins: z.number().nullable().optional(),
    resetsAt: z.number().nullable().optional(),
  })
  .strip();

const SnapshotSchema = z
  .object({
    limitId: z.string().nullable().optional(),
    limitName: z.string().nullable().optional(),
    primary: WindowSchema.nullable().optional(),
    secondary: WindowSchema.nullable().optional(),
    credits: z
      .object({
        hasCredits: z.boolean(),
        unlimited: z.boolean(),
        balance: z.string().nullable(),
      })
      .strip()
      .nullable()
      .optional(),
    individualLimit: z
      .object({
        limit: z.string(),
        used: z.string(),
        remainingPercent: z.number(),
        resetsAt: z.number(),
      })
      .strip()
      .nullable()
      .optional(),
    spendControlReached: z.boolean().nullable().optional(),
    planType: z.string().nullable().optional(),
    rateLimitReachedType: z
      .enum([
        "rate_limit_reached",
        "workspace_owner_credits_depleted",
        "workspace_member_credits_depleted",
        "workspace_owner_usage_limit_reached",
        "workspace_member_usage_limit_reached",
      ])
      .nullable()
      .optional(),
  })
  .strip();

const FullReadSchema = z
  .object({
    rateLimits: SnapshotSchema,
    rateLimitsByLimitId: z.record(z.string(), SnapshotSchema).nullable().optional(),
  })
  .strip();

const SparseUpdateSchema = z
  .object({ rateLimits: SnapshotSchema })
  .strip();
const MAX_STDERR_BYTES = 4096;
const STDERR_CLOSE_GRACE_MS = 100;
const MAX_REFRESH_INTERVAL_MS = 5 * 60_000;
const MIN_REFRESH_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_CODEX_QUOTA_STALE_MS = 15 * 60_000;
const SAFE_SPAWN_ERROR_CODES = [
  "ENOENT", "EACCES", "EPERM", "ENOEXEC", "EAGAIN", "EMFILE", "ENFILE", "ENOMEM", "ENOTDIR",
  "ERR_INVALID_ARG_VALUE",
];

export class CodexQuotaLifecycleError extends Error {}

function startupError(error: unknown): CodexQuotaLifecycleError {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  const detail = code && SAFE_SPAWN_ERROR_CODES.includes(code) ? code : "unknown error";
  return new CodexQuotaLifecycleError(`Could not start Codex quota app-server (${detail}).`);
}

function stderrDiagnostic(stderr: string): string {
  // Use fixed diagnostics because raw stderr can contain credentials and paths.
  if (/permission denied|operation not permitted/i.test(stderr)) return "Permission denied.";
  if (/no such file or directory|command not found/i.test(stderr)) return "Required file or command missing.";
  if (/unexpected argument|unknown (?:argument|option|flag)|unrecognized option/i.test(stderr)) return "Unsupported command-line option.";
  if (/not authenticated|not logged in|authentication required/i.test(stderr)) return "Authentication required.";
  return stderr.trim() ? "Codex wrote to stderr." : "Codex provided no stderr diagnostic.";
}

export function codexQuotaTelemetryEnabled(env: Env): boolean {
  const value = env["MC_CODEX_QUOTA_TELEMETRY_ENABLED"]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function codexQuotaStaleAfterMs(env: Env): number {
  const parsed = Number(env.MC_CODEX_QUOTA_STALE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_QUOTA_STALE_MS;
}

function observerEnv(env: Env): Env {
  const codexHome = env.MC_CODEX_QUOTA_CODEX_HOME?.trim();
  return codexHome ? { ...env, CODEX_HOME: codexHome } : { ...env };
}

/** Identify a local login store without persisting its path or credentials. */
export function codexQuotaContext(env: Env, cwd: string): string | undefined {
  if (env.CODEX_API_KEY || env.OPENAI_API_KEY) return undefined;
  try {
    const home = env.CODEX_HOME || join(env.HOME || userInfo().homedir, ".codex");
    const directory = realpathSync(isAbsolute(home) ? home : cwd + "/" + home);
    const info = statSync(directory, { bigint: true });
    if (info.isDirectory()) {
      return createHash("sha256").update(JSON.stringify([directory, String(info.dev), String(info.ino)])).digest("hex");
    }
  } catch {
    // An unresolvable store cannot be matched to an ACP login.
  }
  return undefined;
}

export function observerQuotaContext(env: Env): string | undefined {
  return codexQuotaContext(observerEnv(env), process.cwd());
}

class StdioAppServerConnection implements AppServerConnection {
  private lineHandler: (line: string) => void = () => {};
  private closeHandler: (error?: Error) => void = () => {};
  private closed = false;
  private readonly child: ChildProcess;

  constructor(childEnv: Env) {
    try {
      this.child = spawn("codex", ["app-server", "--stdio"], {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw startupError(error);
    }
    // Node may leave the pipes unset if spawning runs out of file descriptors.
    const { stdin, stdout, stderr } = this.child;
    stdin?.on("error", () => {
      // Catch EPIPE or write errors if codex process exits prematurely
    });
    const lines = stdout ? readline.createInterface({ input: stdout }) : undefined;
    lines?.on("line", (line) => this.lineHandler(line));
    let stderrText = "";
    stderr?.on("data", (chunk: Buffer) => {
      if (stderrText.length < MAX_STDERR_BYTES) {
        stderrText += chunk.subarray(0, MAX_STDERR_BYTES - stderrText.length).toString("utf8");
      }
    });
    let stderrCloseTimer: NodeJS.Timeout | undefined;
    const closed = (error: CodexQuotaLifecycleError) => {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(stderrCloseTimer);
      lines?.close();
      stdin?.destroy();
      stdout?.destroy();
      stderr?.destroy();
      this.closeHandler(error);
    };
    this.child.on("error", (error) => closed(startupError(error)));
    this.child.once("exit", (code, signal) => {
      if (this.closed) return;
      const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const finish = () => {
        stderr?.removeListener("close", finish);
        closed(new CodexQuotaLifecycleError(`Codex quota app-server closed with ${status}. ${stderrDiagnostic(stderrText)}`));
      };
      if (!stderr || stderr.closed) {
        finish();
      } else {
        // A descendant can hold the inherited pipes open after the launcher exits.
        stderr.once("close", finish);
        stderrCloseTimer = setTimeout(finish, STDERR_CLOSE_GRACE_MS);
      }
    });
  }

  send(message: unknown): void {
    try {
      if (!this.closed && this.child.stdin?.writable) {
        this.child.stdin.write(JSON.stringify(message) + "\n");
      }
    } catch {
      // ignore write errors on closed child process
    }
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.child.kill();
  }
}

interface ObserverOptions {
  env?: Env;
  store?: QuotaStore;
  connect?: ConnectAppServer;
  now?: () => number;
  reconnectDelayMs?: number;
  scheduleReconnect?: (callback: () => void, delayMs: number) => unknown;
  cancelReconnect?: (handle: unknown) => void;
  onError?: (error: Error) => void;
}

export class CodexQuotaObserver {
  private readonly env: Env;
  private readonly store: QuotaStore;
  private readonly connectAppServer: (env: Env) => AppServerConnection;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly scheduleReconnect: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelReconnect: (handle: unknown) => void;
  private readonly onError: (error: Error) => void;
  private state: QuotaState;
  private quotaContext: string | undefined;
  private connection: AppServerConnection | null = null;
  private reconnectHandle: unknown;
  private requestTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private nextId = 1;
  private initializeId: number | null = null;
  private fullReadId: number | null = null;

  constructor(options: ObserverOptions = {}) {
    this.env = options.env ?? process.env;
    this.store = options.store ?? FileCodexQuotaStore.fromEnv(this.env);
    this.connectAppServer =
      options.connect ?? ((env) => new StdioAppServerConnection(env));
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs = Math.max(
      MIN_REFRESH_INTERVAL_MS,
      Math.min(MAX_REFRESH_INTERVAL_MS, codexQuotaStaleAfterMs(this.env) / 2),
    );
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
    this.scheduleReconnect =
      options.scheduleReconnect ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelReconnect =
      options.cancelReconnect ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.onError = options.onError ?? (() => {});
    this.state = this.store.load();
  }

  start(): boolean {
    if (!codexQuotaTelemetryEnabled(this.env)) return false;
    if (!this.stopped) return true;
    this.stopped = false;
    this.openConnection();
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectHandle !== undefined) {
      this.cancelReconnect(this.reconnectHandle);
      this.reconnectHandle = undefined;
    }
    clearTimeout(this.requestTimer);
    const connection = this.connection;
    this.connection = null;
    connection?.close();
  }

  private openConnection(): void {
    try {
      const env = observerEnv(this.env);
      this.quotaContext = codexQuotaContext(env, process.cwd());
      if (this.state.quotaContext !== this.quotaContext) this.state = initialQuotaState();
      const connection = this.connectAppServer(env);
      this.connection = connection;
      this.initializeId = this.nextId++;
      this.fullReadId = null;
      connection.onLine((line) => this.handleLine(connection, line));
      connection.onClose((error) => this.handleClose(connection, error));
      this.awaitResponse(connection, "initialize");
      connection.send({
        id: this.initializeId,
        method: "initialize",
        params: {
          clientInfo: {
            name: "inkie-deck-quota-observer",
            title: "Inkie Deck quota observer",
            version: "1",
          },
          capabilities: null,
        },
      });
    } catch (error) {
      if (this.connection) this.resetConnection(this.connection, error);
      else {
        this.report(error);
        this.queueReconnect();
      }
    }
  }

  private scheduleRequestTask(callback: () => void, delayMs: number): void {
    clearTimeout(this.requestTimer);
    this.requestTimer = setTimeout(callback, delayMs);
    this.requestTimer.unref();
  }

  private awaitResponse(connection: AppServerConnection, method: string): void {
    this.scheduleRequestTask(() => {
      this.resetConnection(connection, new CodexQuotaLifecycleError(`Codex quota ${method} timed out.`));
    }, Math.min(REQUEST_TIMEOUT_MS, this.refreshIntervalMs));
  }

  private readRateLimits(connection: AppServerConnection): void {
    this.fullReadId = this.nextId++;
    this.awaitResponse(connection, "account/rateLimits/read");
    try {
      connection.send({ id: this.fullReadId, method: "account/rateLimits/read" });
    } catch (error) {
      this.resetConnection(connection, error);
    }
  }

  private handleLine(connection: AppServerConnection, line: string): void {
    if (connection !== this.connection) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      this.report(error);
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const message = frame as { id?: unknown; method?: unknown; params?: unknown; result?: unknown };

    if (this.initializeId !== null && message.id === this.initializeId) {
      this.initializeId = null;
      if (!("result" in message)) {
        this.resetConnection(connection, new CodexQuotaLifecycleError("Codex quota initialize failed."));
        return;
      }
      try {
        connection.send({ method: "initialized" });
        this.readRateLimits(connection);
      } catch (error) {
        this.resetConnection(connection, error);
      }
      return;
    }

    if (this.fullReadId !== null && message.id === this.fullReadId) {
      this.fullReadId = null;
      const parsed = FullReadSchema.safeParse(message.result);
      if (parsed.success) this.applyFullRead(parsed.data);
      else this.report(new CodexQuotaLifecycleError(
        "error" in message ? "Codex quota account/rateLimits/read failed." : "Malformed account/rateLimits/read response",
      ));
      const delayMs = parsed.success ? this.refreshIntervalMs : Math.min(this.reconnectDelayMs, this.refreshIntervalMs);
      this.scheduleRequestTask(() => this.readRateLimits(connection), delayMs);
      return;
    }

    if (message.method === "account/rateLimits/updated") {
      const parsed = SparseUpdateSchema.safeParse(message.params);
      if (!parsed.success) {
        this.report(new Error("Malformed account/rateLimits/updated notification"));
        return;
      }
      this.applySparseUpdate(parsed.data.rateLimits);
    }
  }

  private applyFullRead(payload: AccountRateLimits): void {
    try {
      this.state = reduceQuotaState({ ...this.state, quotaContext: this.quotaContext }, {
        type: "full_read",
        payload,
        observedAt: this.now(),
      });
      this.store.save(this.state);
    } catch (err) {
      this.report(err);
    }
  }

  private applySparseUpdate(payload: RateLimitSnapshot): void {
    try {
      this.state = reduceQuotaState({ ...this.state, quotaContext: this.quotaContext }, {
        type: "sparse_update",
        payload,
        observedAt: this.now(),
      });
      this.store.save(this.state);
    } catch (err) {
      this.report(err);
    }
  }

  private handleClose(connection: AppServerConnection, error?: Error): void {
    if (connection !== this.connection) return;
    clearTimeout(this.requestTimer);
    this.connection = null;
    this.initializeId = null;
    this.fullReadId = null;
    if (error) this.report(error);
    this.queueReconnect();
  }

  private resetConnection(connection: AppServerConnection, error: unknown): void {
    if (connection !== this.connection) return;
    this.handleClose(connection, error instanceof Error ? error : new Error(String(error)));
    connection.close();
  }

  private queueReconnect(): void {
    if (this.stopped || this.reconnectHandle !== undefined) return;
    this.reconnectHandle = this.scheduleReconnect(() => {
      this.reconnectHandle = undefined;
      if (!this.stopped) this.openConnection();
    }, this.reconnectDelayMs);
  }

  private report(error: unknown): void {
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }
}

let activeObserver: CodexQuotaObserver | undefined;

/** Ensure singleton observer is running if enabled in env. */
export function ensureCodexQuotaObserver(
  options: ObserverOptions = {}
): CodexQuotaObserver | undefined {
  if (!codexQuotaTelemetryEnabled(options.env ?? process.env)) return undefined;
  if (!activeObserver) {
    activeObserver = startCodexQuotaObserver(options);
  }
  return activeObserver;
}

/** Start only when the explicit environment gate is enabled. */
export function startCodexQuotaObserver(
  options: ObserverOptions = {}
): CodexQuotaObserver | undefined {
  if (!codexQuotaTelemetryEnabled(options.env ?? process.env)) return undefined;
  const observer = new CodexQuotaObserver(options);
  return observer.start() ? observer : undefined;
}
