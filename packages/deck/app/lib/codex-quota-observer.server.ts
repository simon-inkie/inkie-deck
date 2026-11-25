import { spawn } from "node:child_process";
import readline from "node:readline";
import { z } from "zod";
import {
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

class StdioAppServerConnection implements AppServerConnection {
  private lineHandler: (line: string) => void = () => {};
  private closeHandler: (error?: Error) => void = () => {};
  private closed = false;
  private readonly child;

  constructor(env: Env) {
    const childEnv: NodeJS.ProcessEnv = { ...env };
    const codexHome = env["MC_CODEX_QUOTA_CODEX_HOME"]?.trim();
    if (codexHome) childEnv["CODEX_HOME"] = codexHome;
    this.child = spawn("codex", ["app-server", "--stdio"], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.on("error", () => {
      // Catch EPIPE or write errors if codex process exits prematurely
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.lineHandler(line));
    let stderr = "";
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.subarray(0, MAX_STDERR_BYTES - stderr.length).toString("utf8");
      }
    });
    const closed = (error: Error) => {
      if (this.closed) return;
      this.closed = true;
      lines.close();
      this.closeHandler(error);
    };
    this.child.on("error", (error: NodeJS.ErrnoException) => {
      closed(new Error(`Could not start Codex quota app-server (${error.code ?? "unknown error"}).`));
    });
    this.child.on("close", (code, signal) => {
      const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      closed(new Error(`Codex quota app-server closed with ${status}. ${stderrDiagnostic(stderr)}`));
    });
  }

  send(message: unknown): void {
    try {
      if (!this.closed && this.child.stdin.writable) {
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
  private readonly connectAppServer: ConnectAppServer;
  private readonly now: () => number;
  private readonly reconnectDelayMs: number;
  private readonly scheduleReconnect: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelReconnect: (handle: unknown) => void;
  private readonly onError: (error: Error) => void;
  private state: QuotaState;
  private connection: AppServerConnection | null = null;
  private reconnectHandle: unknown;
  private stopped = true;
  private nextId = 1;
  private initializeId: number | null = null;
  private fullReadId: number | null = null;

  constructor(options: ObserverOptions = {}) {
    this.env = options.env ?? process.env;
    this.store = options.store ?? FileCodexQuotaStore.fromEnv(this.env);
    this.connectAppServer =
      options.connect ?? (() => new StdioAppServerConnection(this.env));
    this.now = options.now ?? Date.now;
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
    this.connection?.close();
    this.connection = null;
  }

  private openConnection(): void {
    try {
      const connection = this.connectAppServer();
      this.connection = connection;
      this.initializeId = this.nextId++;
      this.fullReadId = null;
      connection.onLine((line) => this.handleLine(connection, line));
      connection.onClose((error) => this.handleClose(connection, error));
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
      this.report(error);
      this.queueReconnect();
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

    if (message.id === this.initializeId && "result" in message) {
      connection.send({ method: "initialized" });
      this.fullReadId = this.nextId++;
      connection.send({ id: this.fullReadId, method: "account/rateLimits/read" });
      return;
    }

    if (message.id === this.fullReadId && "result" in message) {
      const parsed = FullReadSchema.safeParse(message.result);
      if (!parsed.success) {
        this.report(new Error("Malformed account/rateLimits/read response"));
        return;
      }
      this.applyFullRead(parsed.data);
      this.fullReadId = null;
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
      this.state = reduceQuotaState(this.state, {
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
      this.state = reduceQuotaState(this.state, {
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
    this.connection = null;
    this.initializeId = null;
    this.fullReadId = null;
    if (error) this.report(error);
    this.queueReconnect();
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
