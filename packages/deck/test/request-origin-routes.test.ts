import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAgentModel } from "~/lib/agent-model.server";
import { saveDraft } from "~/lib/drafts.server";
import { createCard } from "~/lib/projects.server";
import { captureTmuxPane, pushMessageToIdleAgent, sendKeysToWindow, sendNamedKeyToWindow, wakeIdleAgent } from "~/lib/tmux.server";
import { action as modelAction } from "~/routes/api.agent-model";
import { action as draftAction } from "~/routes/api.drafts";
import { action as terminalAction } from "~/routes/api.tmux-send";
import { action as homeAction } from "~/routes/home";
import { action as projectAction } from "~/routes/projects";
import { action as threadAction, loader as threadLoader } from "~/routes/threads.$agent";

const { inbox } = vi.hoisted(() => ({
  inbox: {
    readBlocks: vi.fn(async () => []),
    readBlocksWindow: vi.fn(async () => ({ blocks: [], startIndex: 0, totalCount: 0 })),
    writeReply: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}),
    markActionDone: vi.fn(async () => ({})),
  },
}));

vi.mock("~/lib/stores.server", () => ({ makeStores: () => ({ inbox }) }));
vi.mock("~/lib/tmux.server", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/tmux.server")>(),
  captureTmuxPane: vi.fn(),
  pushMessageToIdleAgent: vi.fn(async () => {}),
  sendKeysToWindow: vi.fn(async () => ({ status: "submitted" })),
  sendNamedKeyToWindow: vi.fn(),
  wakeIdleAgent: vi.fn(async () => {}),
}));
vi.mock("~/lib/agent-model.server", () => ({ setAgentModel: vi.fn(() => ({ ok: true })) }));
vi.mock("~/lib/drafts.server", () => ({ draftsEnabled: () => true, saveDraft: vi.fn(async () => ({ ok: true })) }));
vi.mock("~/lib/projects.server", () => ({ listCards: () => [], createCard: vi.fn(() => "card") }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOST", undefined);
  vi.stubEnv("MC_USER", "alex");
  vi.stubEnv("MC_TMUX_ENABLED", "1");
  vi.stubEnv("MC_ALLOWED_HOSTS", "deck.example.com");
  vi.stubEnv("MC_CRON_ALLOW_REMOTE_ADMIN", "0");
});

afterEach(() => vi.unstubAllEnvs());

const routes = [
  { path: "/api/tmux-send", action: terminalAction, fields: { window: "agent", text: "Hello" }, write: sendKeysToWindow },
  { path: "/threads/agent", action: threadAction, fields: { intent: "compose", body: "Hello" }, write: inbox.writeReply },
  { path: "/threads/agent", action: threadLoader, fields: null, write: inbox.markRead },
  { path: "/", action: homeAction, fields: { intent: "done", agent: "agent", actionId: "card" }, write: inbox.markActionDone },
  { path: "/api/agent-model", action: modelAction, fields: { agent: "agent", model: "opus" }, write: setAgentModel },
  { path: "/projects", action: projectAction, fields: { intent: "create", agent: "agent", title: "Card" }, write: createCard },
  { path: "/api/drafts", action: draftAction, fields: { intent: "create", name: "draft", content: "Hello" }, write: saveDraft },
] as const;

const host = "localhost:5174";
const browser = { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" };

describe.each(routes)("origin guard on $path ($write.name)", ({ path, action, fields, write }) => {
  function submit(headers: HeadersInit, socketAddress = "127.0.0.1") {
    const url = new URL(`http://${host}${path}`);
    const request = new Request(url, {
      method: fields ? "POST" : "GET",
      headers,
      body: fields ? new URLSearchParams(fields) : undefined,
    });
    return action({ request, url, pattern: path, params: { agent: "agent" }, context: { socketAddress } });
  }

  it.each([
    ["cross-site", { ...browser, "sec-fetch-site": "cross-site" }],
    ["same-site", { ...browser, "sec-fetch-site": "same-site" }],
    ["wrong Origin port", { ...browser, origin: "http://localhost:5175" }],
    ["opaque Origin", { ...browser, origin: "null" }],
    ["unapproved Host", { ...browser, host: "other.example.com", origin: "http://other.example.com" }],
    ["forwarded without browser proof", { host, "x-forwarded-for": "192.0.2.10" }],
  ] as const)("refuses %s before any write or tmux call", async (_label, headers) => {
    await expect(submit(headers)).rejects.toMatchObject({ status: 403 });
    expect(write).not.toHaveBeenCalled();
    for (const tmux of [captureTmuxPane, pushMessageToIdleAgent, sendKeysToWindow, sendNamedKeyToWindow, wakeIdleAgent]) {
      expect(tmux).not.toHaveBeenCalled();
    }
  });

  it("rejects a non-loopback client without browser proof", async () => {
    await expect(submit({ host }, "192.0.2.10")).rejects.toMatchObject({ status: 403 });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["same-origin browser", browser, "127.0.0.1"],
    ["same-origin proxy", { ...browser, host: "deck.example.com", origin: "https://deck.example.com", "x-forwarded-for": "192.0.2.10" }, "192.0.2.11"],
    ["direct header-less loopback client", { host }, "::1"],
  ] as const)("allows a %s", async (_label, headers, address) => {
    await submit(headers, address);
    expect(write).toHaveBeenCalledOnce();
  });
});
