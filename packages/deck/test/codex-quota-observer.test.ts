import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CodexQuotaObserver,
  codexQuotaTelemetryEnabled,
  type AppServerConnection,
} from "../app/lib/codex-quota-observer.server";
import { initialQuotaState, type QuotaState } from "../app/lib/codex-quota";

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
  const message = connection.sent.find(
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
  });

  it("persists quota under the supplied DATA_ROOT", () => {
    const root = mkdtempSync(join(tmpdir(), "deck-quota-observer-"));
    const ambient = join(root, "ambient");
    mkdirSync(ambient);
    vi.stubEnv("DATA_ROOT", ambient);
    const connection = new FakeConnection();
    const onError = vi.fn();
    const observer = new CodexQuotaObserver({
      env: { DATA_ROOT: root, MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" },
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
      expect(JSON.parse(readFileSync(join(root, "codex-quota.json"), "utf8")))
        .toMatchObject({ observedAt: 1_000_000, status: "AVAILABLE_CONFIRMED" });
      expect(existsSync(join(ambient, "codex-quota.json"))).toBe(false);
    } finally {
      observer.stop();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the app-server exit code and a sanitized stderr diagnostic", () => {
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
    child.stderr.write("error: unexpected argument 'token-secret'\n");
    child.emit("close", 2, null);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      new Error("Codex quota app-server closed with exit code 2. Unsupported command-line option."),
    );
    observer.stop();
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
  });

  it("reconnects and refetches full state before recovery candidacy", () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    const connections = [first, second];
    const store = new MemoryStore();
    let reconnect: (() => void) | undefined;
    const observer = new CodexQuotaObserver({
      env: { MC_CODEX_QUOTA_TELEMETRY_ENABLED: "1" },
      connect: () => connections.shift()!,
      store,
      now: () => 2_000_000,
      scheduleReconnect: (callback) => {
        reconnect = callback;
        return 1;
      },
      cancelReconnect: () => {},
    });
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

    second.line({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 0 } } },
    });
    expect(store.state.status).toBe("BLOCKED_CONFIRMED");

    second.line({
      id: methodId(second, "account/rateLimits/read"),
      result: { rateLimits: { primary: { usedPercent: 0 } } },
    });
    expect(store.state.status).toBe("RECOVERY_CANDIDATE");
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
  });
});
