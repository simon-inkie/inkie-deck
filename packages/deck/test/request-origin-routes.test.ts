import { createStaticHandler } from "react-router";
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
  vi.stubEnv("MC_ALLOWED_HOSTS", "deck.example.com,192.0.2.11");
  vi.stubEnv("MC_CRON_ALLOW_REMOTE_ADMIN", "0");
});

afterEach(() => vi.unstubAllEnvs());

const routes = [
  { path: "/api/tmux-send", action: terminalAction, fields: { window: "agent", text: "Hello" }, write: sendKeysToWindow },
  { path: "/threads/agent", action: threadAction, fields: { intent: "compose", body: "Hello" }, write: inbox.writeReply },
  { path: "/", action: homeAction, fields: { intent: "done", agent: "agent", actionId: "card" }, write: inbox.markActionDone },
  { path: "/api/agent-model", action: modelAction, fields: { agent: "agent", model: "opus" }, write: setAgentModel },
  { path: "/projects", action: projectAction, fields: { intent: "create", agent: "agent", title: "Card" }, write: createCard },
  { path: "/api/drafts", action: draftAction, fields: { intent: "create", name: "draft", content: "Hello" }, write: saveDraft },
] as const;

const host = "localhost:5174";
const loopbackAddress = "127.0.0.1";
const browser = { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" };

const deniedRequests = [
  ["cross-site", { ...browser, "sec-fetch-site": "cross-site" }, loopbackAddress],
  ["same-site", { ...browser, "sec-fetch-site": "same-site" }, loopbackAddress],
  ["wrong Origin port", { ...browser, origin: "http://localhost:5175" }, loopbackAddress],
  ["opaque Origin", { ...browser, origin: "null" }, loopbackAddress],
  ["unapproved Host", { ...browser, host: "other.example.com", origin: "http://other.example.com" }, loopbackAddress],
  ["forwarded without browser proof", { host, "x-forwarded-for": "192.0.2.10" }, loopbackAddress],
  ["non-loopback client without browser proof", { host }, "192.0.2.10"],
] as const;

const allowedRequests = [
  ["same-origin browser", browser, loopbackAddress],
  ["same-origin proxy", { ...browser, host: "deck.example.com", origin: "https://deck.example.com", "x-forwarded-for": "192.0.2.10" }, "192.0.2.11"],
  ["direct header-less loopback client", { host }, "::1"],
] as const;

describe.each(routes)("origin guard on $path ($write.name)", ({ path, action, fields, write }) => {
  function submit(headers: HeadersInit, socketAddress: string) {
    const url = new URL(`http://${host}${path}`);
    const request = new Request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(fields),
    });
    return action({ request, url, pattern: path, params: { agent: "agent" }, context: { socketAddress } });
  }

  it.each(deniedRequests)("refuses %s before any write or tmux call", async (_label, headers, address) => {
    await expect(submit(headers, address)).rejects.toMatchObject({ status: 403 });
    expect(write).not.toHaveBeenCalled();
    for (const tmux of [captureTmuxPane, pushMessageToIdleAgent, sendKeysToWindow, sendNamedKeyToWindow, wakeIdleAgent]) {
      expect(tmux).not.toHaveBeenCalled();
    }
  });

  it.each(allowedRequests)("allows a %s", async (_label, headers, address) => {
    await submit(headers, address);
    expect(write).toHaveBeenCalledOnce();
  });
});

describe("origin guard on chat read receipts", () => {
  const { query } = createStaticHandler([{
    id: "thread",
    path: "/threads/agent",
    loader: (args) => threadLoader({ ...args, params: { agent: "agent" } }),
  }]);

  function openThread(headers: { host: string }, socketAddress: string) {
    return query(new Request(`http://${headers.host}/threads/agent`, { headers }), {
      requestContext: { socketAddress },
    });
  }

  it.each([
    ...deniedRequests,
    ["approved LAN Host without browser proof", { host: "192.0.2.11:5174" }, "192.0.2.10"],
  ] as const)("renders 200 without marking messages read for %s", async (_label, headers, address) => {
    await expect(openThread(headers, address)).resolves.toMatchObject({
      statusCode: 200,
      loaderData: { thread: { agent: "agent", blocks: [] } },
    });
    expect(inbox.markRead).not.toHaveBeenCalled();
  });

  it.each([
    ...allowedRequests,
    ["same-origin navigation without Origin", { host, "sec-fetch-site": "same-origin" }, "192.0.2.10"],
  ] as const)("marks messages read for a %s", async (_label, headers, address) => {
    await expect(openThread(headers, address)).resolves.toMatchObject({ statusCode: 200 });
    expect(inbox.markRead).toHaveBeenCalledExactlyOnceWith("agent", "alex");
  });
});
