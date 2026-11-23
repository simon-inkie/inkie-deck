import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
import { execFileSync } from "node:child_process";
import {
  buildSendKeysNamedArgs,
  listTmuxWindows,
  SEND_KEYS_ALLOWED_KEYS,
  sendKeysToWindow,
  sendNamedKeyToWindow,
} from "~/lib/tmux.server";
import { action } from "~/routes/api.tmux-send";

const exec = vi.mocked(execFileSync);
const env = { MC_TMUX_SESSION: "agents" };
let viewport: string;
let submitted: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("MC_TMUX_ENABLED", "true");
  viewport = "\u276F ";
  submitted = false;
  exec.mockReset();
  exec.mockImplementation((_file, args) => {
    if (args?.[0] === "list-windows") return "agent\n";
    if (args?.[0] === "capture-pane") {
      return submitted ? "(esc to interrupt)" : viewport;
    }
    if (
      args?.[0] === "send-keys" &&
      args.length === 4 &&
      args.at(-1) === "Enter"
    ) {
      submitted = true;
    }
    return "";
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function writes() {
  return exec.mock.calls.filter(([, args]) => args?.[0] === "send-keys").map(([, args]) => args);
}

function postBody(body: BodyInit) {
  const url = new URL("http://localhost/api/tmux-send");
  const request = new Request(url, { method: "POST", body, headers: { host: "localhost" } });
  return action({ request, url, pattern: url.pathname, params: {}, context: { socketAddress: "127.0.0.1" } });
}

function post(fields: Record<string, string>) {
  return postBody(new URLSearchParams(fields));
}

describe("pane named keys", () => {
  it.each(SEND_KEYS_ALLOWED_KEYS)("sends %s once with exact target and no automatic Enter", (key) => {
    expect(buildSendKeysNamedArgs("agents", "agent", key)).toEqual([
      "send-keys",
      "-t",
      "=agents:=agent",
      key,
    ]);
    expect(sendNamedKeyToWindow(env, "agent", key)).toEqual({ ok: true });
    expect(writes()).toEqual([["send-keys", "-t", "=agents:=agent", key]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores agents-dev when the agents session is absent", () => {
    exec.mockImplementation((_file, args) => {
      if (args?.[0] === "list-windows" && (args[2] === "agents" || args[2] === "=agents-dev")) {
        return "agent\n";
      }
      throw new Error("cannot find session");
    });
    expect(listTmuxWindows({ MC_TMUX_SESSION: "agents-dev" })).toEqual(["agent"]);
    expect(listTmuxWindows(env)).toEqual([]);
  });

  it("rejects unrecognised keys and invalid targets before any subprocess", () => {
    expect(sendNamedKeyToWindow(env, "agent", "C-c").ok).toBe(false);
    expect(sendNamedKeyToWindow(env, "agent;exit", "Up").ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects absent windows and failed key sends", () => {
    expect(sendNamedKeyToWindow(env, "missing", "Up").ok).toBe(false);
    expect(writes()).toHaveLength(0);
    exec.mockImplementation((_file, args) => {
      if (args?.[0] === "list-windows") return "agent\n";
      throw new Error("unavailable");
    });
    expect(sendNamedKeyToWindow(env, "agent", "Up").ok).toBe(false);
  });
});

describe("literal text shell guard", () => {
  it("refuses shell prompts on any viewport line before writing", async () => {
    viewport = "Old shell frame\nuser@host:work$ \n\u276F ";
    expect((await sendKeysToWindow(env, "agent", "hello")).status).toBe(
      "not-attempted"
    );
    expect(writes()).toHaveLength(0);
    expect(
      exec.mock.calls.find(([, args]) => args?.[0] === "capture-pane")?.[1]
    ).toEqual(["capture-pane", "-t", "=agents:=agent", "-p", "-J"]);
  });

  it("fails closed when the capture fails", async () => {
    exec.mockImplementation((_file, args) => {
      if (args?.[0] === "list-windows") return "agent\n";
      throw new Error("unavailable");
    });
    expect((await sendKeysToWindow(env, "agent", "hello")).status).toBe(
      "not-attempted"
    );
    expect(writes()).toHaveLength(0);
  });

  it("preserves literal text, then verifies one successful submit", async () => {
    const result = sendKeysToWindow(env, "agent", " hello ");
    expect(writes()).toEqual([
      ["send-keys", "-t", "=agents:=agent", "-l", "--", " hello "],
    ]);
    await vi.runAllTimersAsync();
    expect(await result).toEqual({
      status: "submitted",
      evidence: "turn-started",
      enterAttempts: 1,
    });
    expect(writes()).toHaveLength(2);
    expect(writes()[1]).toEqual(["send-keys", "-t", "=agents:=agent", "Enter"]);
  });

  it("does not press Enter when the agent exits during the delay", async () => {
    const result = sendKeysToWindow(env, "agent", "hello");
    viewport = "user@host:work$ ";
    await vi.runAllTimersAsync();
    expect((await result).status).toBe("not-submitted");
    expect(writes()).toHaveLength(1);
  });

  it("does not press Enter when the second capture fails", async () => {
    const result = sendKeysToWindow(env, "agent", "hello");
    exec.mockImplementation(() => { throw new Error("unavailable"); });
    await vi.runAllTimersAsync();
    expect((await result).status).toBe("not-submitted");
    expect(writes()).toHaveLength(1);
  });
});

describe("send API", () => {
  it.each(SEND_KEYS_ALLOWED_KEYS)("accepts key %s", async (key) => {
    expect(await post({ window: "agent", key })).toEqual({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  const invalidPayloads: Record<string, string>[] = [
    { window: "agent", key: "C-c" },
    { window: "agent", key: "" },
    { window: "agent", key: "Up", text: "hello" },
    { window: "agent" },
    { window: "agent", text: " " },
    { window: "agent;exit", key: "Up" },
  ];
  it.each(invalidPayloads)("returns HTTP 400 for invalid payload %j", async (fields) => {
    expect(await post(fields)).toMatchObject({ init: { status: 400 }, data: { ok: false } });
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses direct sends on a disabled instance", async () => {
    vi.stubEnv("MC_TMUX_ENABLED", "false");
    expect(await post({ window: "agent", key: "Enter" })).toMatchObject({ ok: false });
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns HTTP 400 for repeated fields or malformed form data", async () => {
    for (const body of [
      new URLSearchParams([["window", "agent"], ["key", "Up"], ["key", "Down"]]),
      "invalid",
    ]) {
      expect(await postBody(body)).toMatchObject({ init: { status: 400 } });
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("accepts text without trimming its literal payload", async () => {
    const result = post({ window: "agent", text: " hello " });
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ ok: true });
    expect(writes()[0]?.at(-1)).toBe(" hello ");
  });
});
