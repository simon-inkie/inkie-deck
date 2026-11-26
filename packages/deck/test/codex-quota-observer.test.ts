import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { buildCodexQuotaDisplay } from "../app/lib/codex-quota-display";
import { loadCodexQuotaDisplay } from "../app/lib/codex-quota-display.server";
import {
  CodexQuotaObserver,
  codexQuotaTelemetryEnabled,
  quotaContextForHome,
  type AppServerConnection,
} from "../app/lib/codex-quota-observer.server";
import { initialQuotaState, type QuotaState } from "../app/lib/codex-quota";
import { codexUsageReading } from "../app/lib/codex-quota-usage";

vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  return { ...childProcess, spawn: vi.fn(childProcess.spawn) };
});

class FakeConnection implements AppServerConnection {
  readonly sent: unknown[] = [];
  private lineHandler: (line: string) => void = () => {};
  private closeHandler: () => void = () => {};

  send(message: unknown): void {
    this.sent.push(message);
  }
  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  close(): void {}
  line(message: unknown): void {
    this.lineHandler(typeof message === "string" ? message : JSON.stringify(message));
  }
  disconnect(): void {
    this.closeHandler();
  }
}

class MemoryStore {
  state = initialQuotaState();
  readonly saves: QuotaState[] = [];
  load(): QuotaState {
    return this.state;
  }
  save(state: QuotaState): void {
    this.state = state;
    this.saves.push(state);
  }
}

function methodId(connection: FakeConnection, method: string): number {
  const message = [...connection.sent].reverse().find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { method?: string }).method === method
  ) as { id: number } | undefined;
  if (!message) throw new Error(`No ${method} request`);
  return message.id;
}

function initialise(connection: FakeConnection): void {
  connection.line({ id: methodId(connection, "initialize"), result: {} });
}

describe("CodexQuotaObserver", () => {
  it("is disabled unless explicitly opted in", () => {
    expect(codexQuotaTelemetryEnabled({})).toBe(false);
    expect(codexQuotaTelemetryEnabled({ MC_CODEX_QUOTA_TELEMETRY_ENABLED: "false" })).toBe(false);
    expect(codexQuotaTelemetryEnabled({ MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" })).toBe(true);

    const connect = vi.fn(() => new FakeConnection());
    const observer = new CodexQuotaObserver({ env: {}, connect, store: new MemoryStore() });
    expect(observer.start()).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it("initialises and persists the initial full rate-limit read", () => {
    const connection = new FakeConnection();
    const store = new MemoryStore();
    const observer = new CodexQuotaObserver({
      env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "true" },
      connect: () => connection,
      store,
      now: () => 1_000_000,
    });

    expect(observer.start()).toBe(true);
    initialise(connection);
    expect(connection.sent).toContainEqual({ method: "initialized" });
    const readId = methodId(connection, "account/rateLimits/read");
    connection.line({
      id: readId,
      result: {
        accountId: "must-not-persist",
        rateLimitUpsell: { secret: "must-not-persist" },
        rateLimits: { planType: "plus", primary: { usedPercent: 20 } },
      },
    });

    expect(store.state.status).toBe("AVAILABLE_CONFIRMED");
    expect(store.state.snapshot).toEqual({
      primary: { usedPercent: 20 },
      planType: "plus",
    });
    expect(JSON.stringify(store.state)).not.toContain("must-not-persist");
    observer.stop();
  });

  it("refreshes idle quota before it expires and retries failed or malformed reads", () => {
    vi.useFakeTimers();
    const connection = new FakeConnection();
    const store = new MemoryStore();
    const observer = new CodexQuotaObserver({
      env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1", MC_CODEX_QUOTA_STALE_MS: "20000" },
      connect: () => connection,
      store,
    });
    const respond = (response: object) => connection.line({
      id: methodId(connection, "account/rateLimits/read"),
      ...response,
    });
    const available = { result: { rateLimits: { primary: { usedPercent: 20 } } } };
    try {
      observer.start();
      initialise(connection);
      respond(available);
      const firstReadAt = Date.now();
      const firstId = methodId(connection, "account/rateLimits/read");
      vi.advanceTimersByTime(9_999);
      expect(methodId(connection, "account/rateLimits/read")).toBe(firstId);
      vi.advanceTimersByTime(1);
      expect(methodId(connection, "account/rateLimits/read")).not.toBe(firstId);
      respond(available);
      expect(store.state.observedAt).toBe(firstReadAt + 10_000);

      vi.advanceTimersByTime(10_000);
      respond({ error: { code: -32603 } });
      vi.advanceTimersByTime(5_000);
      respond({ result: {} });
      expect(store.state.observedAt).toBe(firstReadAt + 10_000);
      vi.advanceTimersByTime(5_000);
      respond(available);
      expect(store.state.observedAt).toBe(firstReadAt + 30_000);
      expect(store.state.status).toBe("AVAILABLE_CONFIRMED");
    } finally {
      observer.stop();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it("reconnects after an unanswered read and ignores a late reply", () => {
    vi.useFakeTimers();
    const first = new FakeConnection();
    const second = new FakeConnection();
    const connect = vi.fn(() => second).mockReturnValueOnce(first);
    const close = vi.spyOn(first, "close");
    const store = new MemoryStore();
    const observer = new CodexQuotaObserver({
      env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" },
      connect,
      store,
    });
    try {
      observer.start();
      initialise(first);
      vi.advanceTimersByTime(15_000);
      expect(close).toHaveBeenCalledOnce();
      const result = { rateLimits: { primary: { usedPercent: 20 } } };
      first.line({ id: methodId(first, "account/rateLimits/read"), result });
      expect(store.saves).toHaveLength(0);
      vi.advanceTimersByTime(5_000);
      expect(connect).toHaveBeenCalledTimes(2);
      initialise(second);
      second.line({ id: methodId(second, "account/rateLimits/read"), result });
      expect(store.state.status).toBe("AVAILABLE_CONFIRMED");
    } finally {
      observer.stop();
      vi.useRealTimers();
    }
  });

  it("samples quota after first-run creation of an absent Codex home", () => {
    const root = mkdtempSync(join(tmpdir(), "deck-quota-first-login-"));
    const home = join(root, "home");
    const alias = join(root, "home-alias");
    mkdirSync(home);
    symlinkSync(home, alias, "dir");
    const env = { HOME: alias, MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1", MC_CODEX_QUOTA_STALE_MS: "20000" };
    const connection = new FakeConnection();
    const connect = vi.fn(() => connection);
    const store = new MemoryStore();
    const observer = new CodexQuotaObserver({ env, connect, store });
    const codexHome = join(home, ".codex");
    vi.useFakeTimers();
    try {
      observer.start();
      initialise(connection);
      const readId = methodId(connection, "account/rateLimits/read");
      connection.line({ id: readId, error: { code: -32000 } });
      expect(store.state.status).toBe("UNKNOWN");

      mkdirSync(codexHome);
      vi.advanceTimersByTime(5_000);
      const retryId = methodId(connection, "account/rateLimits/read");
      expect(retryId).not.toBe(readId);
      connection.line({ id: retryId, result: { rateLimits: { primary: { usedPercent: 20 } } } });
      expect(store.state.status).toBe("AVAILABLE_CONFIRMED");
      expect(store.state.quotaContext).toBe(quotaContextForHome(realpathSync(codexHome)));
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      observer.stop();
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes and displays quota under the supplied literal DATA_ROOT", () => {
    const root = mkdtempSync(join(tmpdir(), "deck-quota-observer-"));
    const ambient = join(root, "ambient");
    const sibling = join(root, "instance");
    const dataRoot = `${sibling} `;
    mkdirSync(ambient);
    mkdirSync(sibling);
    mkdirSync(dataRoot);
    vi.stubEnv("DATA_ROOT", ambient);
    const connection = new FakeConnection();
    const onError = vi.fn();
    const observer = new CodexQuotaObserver({
      env: {
        DATA_ROOT: dataRoot,
        MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1",
        CODEX_HOME: ambient,
        MC_CODEX_QUOTA_CODEX_HOME: sibling,
      },
      connect: () => connection,
      now: () => 1_000_000,
      onError,
    });
    try {
      observer.start();
      initialise(connection);
      connection.line({
        id: methodId(connection, "account/rateLimits/read"),
        result: { rateLimits: { primary: { usedPercent: 20 } } },
      });
      expect(onError).not.toHaveBeenCalled();
      const persisted = readFileSync(join(dataRoot, "codex-quota.json"), "utf8");
      expect(JSON.parse(persisted)).toMatchObject({
        observedAt: 1_000_000,
        status: "AVAILABLE_CONFIRMED",
        quotaContext: quotaContextForHome(realpathSync(sibling)),
      });
      expect(persisted).not.toContain(sibling);
      expect(loadCodexQuotaDisplay({ DATA_ROOT: dataRoot }, 1_000_000, []).quota)
        .toMatchObject({ freshness: "fresh", status: "AVAILABLE_CONFIRMED" });
      expect(existsSync(join(sibling, "codex-quota.json"))).toBe(false);
      expect(existsSync(join(ambient, "codex-quota.json"))).toBe(false);
    } finally {
      observer.stop();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a startup error when spawning fails before creating pipes", () => {
    const child = Object.assign(new EventEmitter(), { stdin: null, stdout: null, stderr: null });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const onError = vi.fn();
    const observer = new CodexQuotaObserver({
      env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" },
      store: new MemoryStore(),
      scheduleReconnect: () => 1,
      cancelReconnect: () => {},
      onError,
    });
    observer.start();
    child.emit("error", Object.assign(new Error("startup-secret"), { code: "EMFILE" }));
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      new Error("Could not start Codex quota app-server (EMFILE)."),
    );
    observer.stop();
  });

  it("reports the app-server exit code and a sanitized stderr diagnostic", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const onError = vi.fn();
    const observer = new CodexQuotaObserver({
      env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" },
      store: new MemoryStore(),
      scheduleReconnect: () => 1,
      cancelReconnect: () => {},
      onError,
    });
    observer.start();
    child.emit("exit", 2, null);
    const stderrClosed = new Promise<void>((resolve) => child.stderr.once("close", resolve));
    child.stderr.end("error: unexpected argument 'token-secret'\n");
    await stderrClosed;
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      new Error("Codex quota app-server closed with exit code 2. Unsupported command-line option."),
    );
    observer.stop();
  });

  it("reconnects after exit with a bounded wait for inherited pipes", () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const scheduleReconnect = vi.fn(() => 1);
    const onError = vi.fn();
    const observer = new CodexQuotaObserver({
      env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" },
      store: new MemoryStore(),
      scheduleReconnect,
      cancelReconnect: () => {},
      onError,
    });
    try {
      observer.start();
      child.emit("exit", 2, null);
      vi.advanceTimersByTime(99);
      expect(scheduleReconnect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      child.emit("close", 2, null);
      expect(scheduleReconnect).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        new Error("Codex quota app-server closed with exit code 2. Codex provided no stderr diagnostic."),
      );
      expect(child.stderr.destroyed).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
    } finally {
      observer.stop();
      vi.useRealTimers();
    }
  });

  it("merges sparse updates without clearing a confirmed block", () => {
    const connection = new FakeConnection();
    const store = new MemoryStore();
    const observer = new CodexQuotaObserver({
      env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" },
      connect: () => connection,
      store,
      now: () => 1_100_000,
    });
    observer.start();
    initialise(connection);
    connection.line({
      id: methodId(connection, "account/rateLimits/read"),
      result: {
        rateLimits: {
          limitName: "Codex",
          primary: { usedPercent: 100, resetsAt: 900 },
          rateLimitReachedType: "rate_limit_reached",
        },
      },
    });
    connection.line({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 0 } } },
    });

    expect(store.state.status).toBe("BLOCKED_CONFIRMED");
    expect(store.state.snapshot?.limitName).toBe("Codex");
    expect(store.state.snapshot?.primary?.usedPercent).toBe(0);
    observer.stop();
  });

  it("recovers a confirmed block after two available full reads, without a prompt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const first = new FakeConnection();
    const second = new FakeConnection();
    const connections = [first, second];
    const store = new MemoryStore();
    let reconnect: (() => void) | undefined;
    const observer = new CodexQuotaObserver({
      env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1", MC_CODEX_QUOTA_STALE_MS: "20000" },
      connect: () => connections.shift()!,
      store,
      scheduleReconnect: (callback) => {
        reconnect = callback;
        return 1;
      },
      cancelReconnect: () => {},
    });
    const usageState = () => codexUsageReading({
      quota: buildCodexQuotaDisplay({ kind: "ok", state: store.state }, Date.now(), 20_000),
      providers: {},
    }, "fixture-codex", Date.now()).state;
    try {
      observer.start();
      initialise(first);
      first.line({
        id: methodId(first, "account/rateLimits/read"),
        result: {
          rateLimits: {
            primary: { usedPercent: 100, resetsAt: 1_500 },
            rateLimitReachedType: "rate_limit_reached",
          },
        },
      });
      first.disconnect();
      reconnect?.();
      initialise(second);

      const update = () => second.line({
        method: "account/rateLimits/updated",
        params: { rateLimits: { primary: { usedPercent: 0 } } },
      });
      const respond = (usedPercent: number) => second.line({
        id: methodId(second, "account/rateLimits/read"),
        result: { rateLimits: { primary: { usedPercent }, spendControlReached: false } },
      });
      update();
      respond(100);
      expect(store.state.status).toBe("BLOCKED_CONFIRMED");
      expect(usageState()).toBe("exhausted");
      vi.advanceTimersByTime(10_000);
      respond(0);
      expect(store.state.status).toBe("RECOVERY_CANDIDATE");
      update();
      expect(store.state.status).toBe("RECOVERY_CANDIDATE");
      expect(usageState()).toBe("unknown");
      vi.advanceTimersByTime(10_000);
      respond(0);
      expect(store.state).toMatchObject({
        status: "AVAILABLE_CONFIRMED", blockedReason: null, resetCandidateAt: null,
      });
      expect(usageState()).toBe("ok");
    } finally {
      observer.stop();
      vi.useRealTimers();
    }
  });

  it("ignores malformed frames without persisting them", () => {
    const connection = new FakeConnection();
    const store = new MemoryStore();
    const onError = vi.fn();
    const observer = new CodexQuotaObserver({
      env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" },
      connect: () => connection,
      store,
      onError,
    });
    observer.start();
    connection.line("not json");
    connection.line({ method: "account/rateLimits/updated", params: { nope: true } });

    expect(store.saves).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(2);
    observer.stop();
  });
});
