import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loader } from "../app/routes/threads.$agent";
import panes from "./fixtures/panes/first-run.json";

const { capture, markRead, readBlocksWindow } = vi.hoisted(() => ({
  capture: vi.fn<() => string | undefined>(),
  markRead: vi.fn(),
  readBlocksWindow: vi.fn(),
}));

vi.mock("~/lib/stores.server", () => ({ makeStores: () => ({ inbox: { markRead, readBlocksWindow } }) }));
vi.mock("~/lib/projects.server", () => ({ listCards: () => [] }));
vi.mock("~/lib/tmux.server", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/tmux.server")>(),
  captureTmuxPane: capture,
}));

function load(search = "") {
  return loader({
    params: { agent: "demo" },
    request: new Request(`http://localhost/threads/demo${search}`),
  } as Parameters<typeof loader>[0]);
}

beforeEach(() => {
  vi.stubEnv("MC_USER", "operator");
  vi.stubEnv("MC_TMUX_ENABLED", "1");
  capture.mockReset();
  readBlocksWindow.mockResolvedValue({ blocks: [], startIndex: 0, totalCount: 0 });
});

afterEach(() => vi.unstubAllEnvs());

describe("thread pane hint payload", () => {
  it.each([false, true])("keeps pane text out of chat (awaiting reply: %s)", async (awaiting) => {
    if (awaiting) {
      readBlocksWindow.mockResolvedValue({
        blocks: [{ header: { from: "operator" }, body: "Hello" }], startIndex: 0, totalCount: 1,
      });
    }
    capture.mockReturnValue(`private-pane-marker\n${panes.trust}`);
    const data = await load();
    expect(data.hint).toBe("H1");
    expect(data.tmux).toBeUndefined();
    expect(data.agentPaneHash !== null).toBe(awaiting);
    expect(JSON.stringify(data)).not.toContain("private-pane-marker");
    expect(JSON.stringify(data)).not.toContain("Do you trust");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("reuses the terminal capture and clears the hint on refresh", async () => {
    capture.mockReturnValueOnce(panes.trust).mockReturnValueOnce(panes.idle);
    expect(await load("?view=tmux")).toMatchObject({ hint: "H1", tmux: { pane: panes.trust } });
    expect(await load("?view=tmux")).toMatchObject({ hint: null, tmux: { pane: panes.idle } });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it.each(["", "?view=tmux"])("returns no hint for an unavailable pane (%j)", async (search) => {
    expect((await load(search)).hint).toBeNull();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("does not capture when tmux is disabled", async () => {
    vi.stubEnv("MC_TMUX_ENABLED", "0");
    capture.mockReturnValue(panes.shell);
    expect(await load("?view=tmux")).toMatchObject({ hint: null, tmuxOn: false, tmux: undefined });
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not capture an already answered chat", async () => {
    readBlocksWindow.mockResolvedValue({
      blocks: [{ header: { from: "demo" }, body: "Reply" }], startIndex: 0, totalCount: 1,
    });
    expect((await load()).hint).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });
});
