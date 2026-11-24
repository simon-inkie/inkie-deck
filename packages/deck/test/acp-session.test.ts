import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AcpRecords, expireOldRecords } from "../app/lib/acp-records.server";
import { AcpSession } from "../app/lib/acp-session.server";
import { LineFramer } from "../app/lib/acp-wire.server";
import { createEventSource } from "../app/lib/deck-event";
import type { DeckEvent } from "../app/lib/deck-event";

const fixture = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url));
const result = (stopReason?: unknown) => ({ kind: "result", result: { stopReason } });
const update = (payload: object, sessionId?: string) => ({ kind: "update", sessionId, update: payload });
const chunk = (text: string, sessionId?: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, sessionId);
const choice = (optionId: string, name = "Choose") => ({ optionId, name, kind: "allow_once" });
const permission = (id: number, options = [choice("allow")], title = "Tool", toolCallId = "fixture-tool") => ({
  kind: "permission", id, options, toolCall: { toolCallId, title, rawInput: "hidden input" },
});
type SetupOptions = Omit<Parameters<typeof AcpSession.start>[1], "cwd" | "dataRoot" | "onEvent">;

let root: string;
let owners: AcpSession[];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "acp-"));
  owners = [];
});
afterEach(async () => {
  for (const owner of owners) {
    await owner.close();
    owner.records.delete();
  }
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function start(script: object = {}, options: SetupOptions = {}, environment?: string[]) {
  const events: DeckEvent[] = [];
  const owner = await AcpSession.start({ executable: process.execPath, args: [fixture, JSON.stringify(script)],
    version: "fixture-1", environment }, { cwd: root, dataRoot: root, onEvent: (event) => events.push(event), ...options });
  owners.push(owner);
  return { owner, events };
}

function raw(owner: AcpSession) {
  return fs.readFileSync(path.join(owner.records.directory, "raw.ndjson"), "utf-8").trim().split("\n").map((line) => {
    const entry = JSON.parse(line) as { direction: string; issue?: string; bytes: string };
    return { ...entry, bytes: Buffer.from(entry.bytes, "base64").toString() };
  });
}

function sent(owner: AcpSession) {
  return raw(owner).filter(({ direction }) => direction === "out").map(({ bytes }) => JSON.parse(bytes));
}

function issues(owner: AcpSession) { return raw(owner).flatMap(({ issue }) => issue ? [issue] : []); }

describe.skipIf(process.platform !== "linux")("ACP v1 scripted agent", () => {
  test("initialises first, stores capabilities, and refuses an unadvertised method without sending it", async () => {
    const { owner, events } = await start({}, { requireCapability: "session/load" });
    expect(owner.state).toEqual({ kind: "unsupported" });
    expect(await owner.prompt("not sent")).toBe("unsupported");
    expect(sent(owner)).toMatchObject([{ method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }]);
    expect(events).toMatchObject([{ class: "action", type: "session.unsupported" }]);
    const advertised = await start({ capabilities: { loadSession: true } }, { requireCapability: "session/load" });
    expect(advertised.owner.capabilities).toEqual({ loadSession: true });
    expect(sent(advertised.owner).map(({ method }) => method)).toEqual(["initialize", "session/new"]);
    expect((await start({ protocolVersion: 2 })).owner.state.kind).toBe("unsupported");
  });

  test("publishes and records a prompt before sending it, once even if the agent echoes it", async () => {
    const text = "Show the prompt";
    const echo = ["Show the ", "prompt"].map((part) => update({
      sessionUpdate: "user_message_chunk", content: { type: "text", text: part },
    }));
    const { owner, events } = await start({ prompts: [[...echo, result("end_turn")]] });
    const recordEvent = vi.spyOn(owner.records, "event");
    const recordFrame = vi.spyOn(owner.records, "frame");

    expect(await owner.prompt(text)).toBe("completed");
    const promptEvent = { type: "message.chunk", title: "You", view: { kind: "text", excerpt: text } };
    expect(events.filter(({ type }) => type === "message.chunk")).toMatchObject([promptEvent]);
    expect(recordEvent.mock.invocationCallOrder[0]).toBeLessThan(recordFrame.mock.invocationCallOrder[0]!);
    const display = fs.readFileSync(path.join(owner.records.directory, "display.ndjson"), "utf8");
    expect(JSON.parse(display.split("\n")[0]!)).toMatchObject(promptEvent);
  });

  test("fails closed and sends no prompt when recording the prompt event fails", async () => {
    const { owner } = await start({ prompts: [[result("end_turn")]] });
    vi.spyOn(owner.records, "event").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });

    expect(await owner.prompt("cannot record")).toBe("failed");
    expect(owner.state.kind).toBe("failed");
    expect(sent(owner).some((frame) => frame.method === "session/prompt")).toBe(false);
  });

  test("passes only the base and adapter environment allowlists, excluding Deck credentials", async () => {
    const keys = ["PATH", "FIXTURE_ALLOWED", "FIXTURE_NOT_ALLOWED", "DEEPGRAM_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
    for (const key of keys.slice(1)) vi.stubEnv(key, "fixture-value");
    const { owner, events } = await start({ prompts: [[{ kind: "environment", keys }, result("end_turn")]] }, {},
      ["FIXTURE_ALLOWED", "DEEPGRAM_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]);
    expect(await owner.prompt("inspect environment")).toBe("completed");
    expect(events[1]?.view).toEqual({ kind: "text", excerpt: "[true,true,false,false,false]" });
  });

  test.each([
    [result("end_turn"), "completed"], [result("max_tokens"), "truncated"],
    [result("max_turn_requests"), "truncated"], [result("refusal"), "refused"],
    [result("cancelled"), "cancelled"], [result("error"), "invalid"],
    [result(), "invalid"], [{ kind: "error" }, "failed"],
  ])("settles only matching, valid stop reasons: %j", async (response, expected) => {
    const { owner } = await start({ prompts: [[response], [result("end_turn")]] });
    expect(await owner.prompt("first")).toBe(expected);
    expect(owner.state).toEqual({ kind: "settled", outcome: expected });
    expect(issues(owner)).toEqual(expected === "invalid" ? ["invalid stop reason"] : []);
    expect(await owner.prompt("next")).toBe("completed");
    expect(sent(owner).filter(({ method }) => method === "session/prompt")).toHaveLength(2);
  });

  test("malformed apparent success leaves the slot busy until cancellation", async () => {
    const { owner } = await start({ prompts: [[
      { kind: "result", result: { stopReason: "end_turn", usage: { totalTokens: "invalid" } } },
    ]], onCancel: [result("cancelled")] });
    const first = owner.prompt("first");
    const next = owner.prompt("next");
    await expect.poll(() => issues(owner)).toContain("invalid prompt response or outstanding permission");
    expect(owner.state.kind).toBe("busy");
    expect(sent(owner).filter(({ method }) => method === "session/prompt")).toHaveLength(1);
    await owner.cancel();
    expect(await first).toBe("cancelled");
    expect(await next).toBe("completed");
  });

  test("discards bad frames and rejects duplicate settlement without changing the first outcome", async () => {
    const { owner, events } = await start({ prompts: [[
      { kind: "line", line: "{bad" }, { kind: "line", line: "z".repeat(600) },
      { ...result("end_turn"), id: 987 }, chunk("wrong session", "another/session"),
      update({ sessionUpdate: "agent_message_chunk", content: 42 }),
      chunk("valid"), result("refusal"), result("end_turn"),
    ]] }, { maxLineBytes: 512, violationLimit: 7 });
    expect(await owner.prompt("first")).toBe("refused");
    await expect.poll(() => issues(owner)).toEqual([
      "invalid JSON or UTF-8", "oversized", "unknown or already answered response id", "wrong update session",
      "invalid update schema", "unknown or already answered response id",
    ]);
    expect(owner.state).toEqual({ kind: "settled", outcome: "refused" });
    expect(events.map(({ type }) => type)).toEqual(["message.chunk", "message.chunk", "turn.settled"]);
  });

  test("records stale generation and ends at the violation limit", async () => {
    const { owner, events } = await start({ prompts: [[
      { kind: "line", line: "x" }, { kind: "line", line: "x".repeat(600) },
    ]] }, { maxLineBytes: 512, violationLimit: 3 });
    Reflect.get(owner, "receive").call(owner, owner.generation - 1, { bytes: Buffer.from("{}") });
    expect(await owner.prompt("first")).toBe("failed");
    expect(issues(owner)).toEqual(["stale generation", "invalid JSON or UTF-8", "oversized"]);
    expect(events).toMatchObject([{ type: "message.chunk" }, { type: "session.failed", class: "action" }]);
    expect(() => process.kill(owner.pid!, 0)).toThrow();
  });

  test("projects ordered updates and patches without exposing raw tool data or reasoning", async () => {
    const oversized = `\x1b\u202e${"a".repeat(800)}`;
    const { owner, events } = await start({ prompts: [[
      update({ sessionUpdate: "tool_call", toolCallId: "wire-tool-id", title: oversized, kind: "edit", status: "pending",
        locations: Array.from({ length: 25 }, () => ({ path: oversized })), rawInput: "hidden-input" }),
      chunk(oversized),
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hidden-thought" } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "wire-tool-id", status: "completed", rawOutput: "hidden-output" }),
      update({ sessionUpdate: "plan", entries: [{ content: "Plan", priority: "high", status: "pending" }] }), result("end_turn"),
    ]] });
    expect(await owner.prompt("first")).toBe("completed");
    expect(events.map(({ seq, type }) => [seq, type])).toEqual([
      [1, "message.chunk"], [2, "tool.updated"], [3, "message.chunk"], [4, "tool.updated"], [5, "plan.updated"], [6, "turn.settled"],
    ]);
    expect(events[3]?.dedupeKey).toBe(events[1]?.dedupeKey);
    expect(events[3]?.view).toEqual({ kind: "tool", name: "a".repeat(120), toolKind: "edit", status: "completed",
      paths: Array.from({ length: 20 }, () => "a".repeat(512)) });
    expect(events[2]?.view).toEqual({ kind: "text", excerpt: "a".repeat(500) });
    const display = fs.readFileSync(path.join(owner.records.directory, "display.ndjson"), "utf-8");
    expect(display.trim().split("\n").map((line) => JSON.parse(line))).toEqual(JSON.parse(JSON.stringify(events)));
    expect(display).not.toMatch(/hidden-(?:input|output|thought)|wire-tool-id|\\u001b|\u202e/);
    expect(raw(owner).some(({ bytes }) => bytes.includes("hidden-input"))).toBe(true);
  });

  test("requires consent and maps identical-prefix choices to their exact wire ids", async () => {
    const ids = [`${"p".repeat(127)}1`, `${"p".repeat(127)}2`];
    const options = [choice(ids[0]!, `\x07${"a".repeat(100)}`), choice(ids[1]!)];
    const ask = (id: number) => permission(id, options, `\x1b${"t".repeat(150)}`);
    const { owner, events } = await start({ prompts: [[ask(11), ask(11), result("end_turn")], [ask(12)]],
      onPermission: { 11: [result("end_turn")], 12: [result("end_turn")] } });
    const first = owner.prompt("first");
    const second = owner.prompt("second");
    const decisions = () => events.filter(({ type }) => type === "permission.requested");
    for (const [index, optionId] of ids.entries()) {
      await expect.poll(() => decisions().length).toBe(index + 1);
      const event = decisions()[index]!;
      expect(owner.state.kind).toBe("waiting");
      expect(sent(owner).filter(({ method }) => method === "session/prompt")).toHaveLength(index + 1);
      expect(sent(owner).filter(({ result }) => result)).toHaveLength(index);
      if (event.view.kind !== "permission") throw new Error("Missing options");
      expect(event.view.tool).toBe("t".repeat(120));
      expect(event.view.options[0]?.label).toBe("a".repeat(80));
      expect(new Set(event.view.options.map(({ id }) => id)).size).toBe(2);
      for (const id of [event.id, ...event.view.options.map(({ id }) => id)]) expect(id).toMatch(/^[ -~]{1,64}$/);
      const selected = event.view.options[index]!.id;
      expect(owner.answerPermission(event.id, optionId)).toBe(false);
      expect(owner.answerPermission(event.id, selected)).toBe(true);
      expect(owner.answerPermission(event.id, selected)).toBe(false);
      expect(await (index === 0 ? first : second)).toBe("completed");
      expect(sent(owner).filter(({ result }) => result)[index]?.result).toEqual({ outcome: { outcome: "selected", optionId } });
    }
    expect(issues(owner)).toEqual(["duplicate permission request", "invalid prompt response or outstanding permission"]);
  });

  test("invalid ids and option sets fail closed, with no projected permission", async () => {
    const invalid = [permission(11, [choice("x".repeat(129))]), permission(12, [choice("x\n")]),
      permission(13, Array.from({ length: 7 }, (_, index) => choice(String(index)))),
      permission(14, [choice("same"), choice("same")]), permission(15, [choice("yes")], "Tool", "x".repeat(129))];
    const { owner, events } = await start({ prompts: [[...invalid,
      update({ sessionUpdate: "tool_call", toolCallId: "\x00", title: "Invalid" }),
    ]], onPermission: { 15: [result("end_turn")] } }, { violationLimit: 7 });
    expect(await owner.prompt("first")).toBe("completed");
    expect(events.map(({ type }) => type)).toEqual(["message.chunk", "turn.settled"]);
    expect(issues(owner)).toEqual([...invalid.map(() => "invalid permission request"), "invalid tool call id"]);
    expect(sent(owner).filter(({ result }) => result).map(({ result }) => result)).toEqual(
      invalid.map(() => ({ outcome: { outcome: "cancelled" } })),
    );
    const refused = await start({ sessionId: "x".repeat(129) }, { violationLimit: 1 });
    expect(refused.owner.state.kind).toBe("failed");
    expect(issues(refused.owner)).toEqual(["invalid new session response"]);
  });

  test("cancels an open permission without granting it", async () => {
    const { owner, events } = await start({ prompts: [[permission(11)]], onPermission: { 11: [result("cancelled")] } });
    const turn = owner.prompt("first");
    await expect.poll(() => owner.state.kind).toBe("waiting");
    expect(sent(owner).some(({ result }) => result)).toBe(false);
    await owner.cancel();
    expect(await turn).toBe("cancelled");
    expect(sent(owner).slice(-2)).toMatchObject([{ method: "session/cancel" },
      { id: 11, result: { outcome: { outcome: "cancelled" } } }]);
    expect(events[2]?.answers).toBe(events[1]?.id);
  });

  test("kills the whole process group when cancel is ignored", async () => {
    const { owner, events } = await start({ prompts: [[{ kind: "descendant" }]] }, { cancelMs: 75 });
    const turn = owner.prompt("first");
    await expect.poll(() => events[1]?.view.kind).toBe("text");
    const view = events[1]?.view;
    const descendant = Number(view?.kind === "text" ? view.excerpt : undefined);
    expect(descendant).toBeGreaterThan(1);
    await owner.cancel();
    expect(await turn).toBe("disconnected");
    expect(() => process.kill(owner.pid!, 0)).toThrow();
    await expect.poll(() => {
      try { return fs.readFileSync(`/proc/${descendant}/stat`, "utf-8").split(") ")[1]?.startsWith("Z "); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    }).toBe(true);
  });

  test.each(["exit", "partial"])("disconnects on %s and never resends queued work", async (kind) => {
    const { owner } = await start({ prompts: [[{ kind }]] });
    const first = owner.prompt("first");
    const next = owner.prompt("next");
    expect(await first).toBe("disconnected");
    expect(await next).toBe("disconnected");
    expect(sent(owner).filter(({ method }) => method === "session/prompt")).toHaveLength(1);
    expect(issues(owner)).toEqual(kind === "partial" ? ["partial"] : []);
    expect(() => process.kill(owner.pid!, 0)).toThrow();
  });

  test("records are private, bounded, and expire independently of the journal", () => {
    const name = "acp-00000000-0000-0000-0000-000000000000-1";
    const records = new AcpRecords(root, name, { rawBytes: 170 });
    try {
      const file = path.join(records.directory, "raw.ndjson");
      const journal = path.join(records.directory, "display.ndjson");
      const mode = (target: string) => fs.statSync(target).mode & 0o777;
      expect(records.directory).toBe(path.join(root, name));
      expect([mode(records.directory), mode(file), mode(journal)]).toEqual([0o700, 0o600, 0o600]);
      for (const letter of ["a", "b", "c", "d"]) records.frame("in", Buffer.from(letter.repeat(30)));
      const retained = fs.readFileSync(file, "utf-8").trim().split("\n").map((line) =>
        Buffer.from(JSON.parse(line).bytes, "base64").toString()[0]);
      expect(retained).toEqual(["c", "d"]);
      expect(fs.statSync(file).size).toBeLessThanOrEqual(170);
      expect(() => new AcpRecords(root, "../escape")).toThrow();
      const outside = path.join(root, "outside");
      fs.writeFileSync(outside, "unchanged");
      fs.rmSync(journal);
      fs.symlinkSync(outside, journal);
      const event = createEventSource({ kind: "session" }, () => "host-id")({ class: "happened", type: "message.chunk",
        title: "\x07" + "t".repeat(250), view: { kind: "text", excerpt: "Example" } });
      expect(event.title).toHaveLength(200);
      expect(() => records.event(event)).toThrow();
      expect(fs.readFileSync(outside, "utf-8")).toBe("unchanged");
      fs.rmSync(journal);
      fs.writeFileSync(journal, "", { mode: 0o600 });
      records.event(event);
      expireOldRecords(root, 1, Date.now() + 1000);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readFileSync(journal, "utf-8")).toContain("Example");
    } finally { records.delete(); }
    expect(fs.existsSync(records.directory)).toBe(false);
  });
});

test("bounded framing recovers at the next newline after a split oversized frame", () => {
  const framer = new LineFramer(4);
  expect([...framer.push(Buffer.from("12345"))]).toEqual([]);
  expect([...framer.push(Buffer.from("678\n{}\n"))]).toEqual([
    { bytes: Buffer.from("1234"), issue: "oversized" }, { bytes: Buffer.from("{}") },
  ]);
});
