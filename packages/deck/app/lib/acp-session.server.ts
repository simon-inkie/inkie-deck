import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities, AnyMessage, AnyResponse, ClientConnection, JsonRpcId, RequestPermissionRequest,
  SessionNotification, ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { AcpRecords, type RecordOptions } from "./acp-records.server";
import { isObject, LineFramer, promptSettlement, responseEnvelope, rpcId, validPayload } from "./acp-wire.server";
import { createEventSource, displayText, printableId, projectDisplay } from "./deck-event";
import type { DeckEvent, DisplayProjection, Outcome } from "./deck-event";
import { antigravityUsageReading, type UsageReading } from "./runner/acp-manifest";

export type AcpAdapter = {
  executable: string;
  args: readonly string[];
  version: string;
  environment?: readonly string[];
  knownExtensions?: readonly string[];
};

type Options = RecordOptions & {
  cwd: string;
  dataRoot: string;
  requireCapability?: "session/load";
  maxLineBytes?: number;
  violationLimit?: number;
  cancelMs?: number;
  onEvent?: (event: DeckEvent) => void;
  onSpawn?: (pid: number) => void;
};

type TerminalState = "failed" | "disconnected" | "unsupported";
type State = { kind: "starting" | "idle" | "busy" | "waiting" | TerminalState }
  | { kind: "settled"; outcome: Outcome };
type Transition = { kind: "ready" | "prompt" | "wait" | "answered" }
  | { kind: "settle"; outcome: Outcome }
  | { kind: "stop"; state: TerminalState };

function terminal(state: State): state is { kind: TerminalState } {
  return state.kind === "disconnected" || state.kind === "failed" || state.kind === "unsupported";
}

function reduce(state: State, transition: Transition): State {
  if (terminal(state)) return state;
  switch (transition.kind) {
    case "ready": return state.kind === "starting" ? { kind: "idle" } : state;
    case "prompt": return state.kind === "idle" || state.kind === "settled" ? { kind: "busy" } : state;
    case "wait": return state.kind === "busy" ? { kind: "waiting" } : state;
    case "answered": return state.kind === "waiting" ? { kind: "busy" } : state;
    case "settle": return state.kind === "busy" ? { kind: "settled", outcome: transition.outcome } : state;
    case "stop": return { kind: transition.state };
  }
}

type ToolView = Extract<DisplayProjection, { kind: "tool" }>;
type Permission = { request: JsonRpcId; choices: Map<string, string>; view: Extract<DisplayProjection, { kind: "permission" }> };
type Frame = { bytes: Buffer; issue?: string };
const { initialize, session } = methods.agent;
const incoming = methods.client.session;
const environment = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"];
const explicitDeckVariables = new Set(["INBOX_ROOT", "DATA_ROOT", "GOOGLE_GENERATIVE_AI_API_KEY"]);
const deckVariable = /^(?:MC_|DECK_|INKIE_|DEEPGRAM_)/i;
let generation = 0;

function childEnvironment(adapter: AcpAdapter): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null);
  for (const key of [...environment, ...(adapter.environment ?? [])]) {
    if (deckVariable.test(key) || explicitDeckVariables.has(key)) continue;
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`Invalid ${label}`);
  return value;
}

export class AcpSession {
  readonly records: AcpRecords;
  readonly generation = ++generation;
  private readonly owned: ChildProcessByStdio<Writable, Readable, null>;
  private readonly closePromise: Promise<void>;
  private readonly connection: ClientConnection;
  private readonly wire: ReadableStreamDefaultController<AnyMessage>;
  private readonly pending = new Map<JsonRpcId, string>();
  private readonly requests = new Set<JsonRpcId>();
  private readonly permissions = new Map<string, Permission>();
  private readonly tools = new Map<string, { key: string; view: ToolView }>();
  private readonly cancelMs: number;
  private readonly violationLimit: number;
  private readonly framer: LineFramer;
  private current: State = { kind: "starting" };
  private advertised: AgentCapabilities = {};
  private violations = 0;
  private sessionId?: string;
  private makeEvent = createEventSource({ kind: "session", generation: this.generation }, randomUUID);
  private finishPrompt?: (outcome: Outcome) => void;
  private turnQueue: Promise<unknown> = Promise.resolve();
  private cancelTimer?: NodeJS.Timeout;
  private cancelling = false;
  private groupStopped = false;

  private constructor(readonly adapter: AcpAdapter, private readonly options: Options) {
    if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("ACP needs a POSIX process group");
    if (!isAbsolute(adapter.executable) || !isAbsolute(options.cwd)) throw new Error("ACP needs absolute executable and working directory paths");
    this.framer = new LineFramer(positive(options.maxLineBytes ?? 1024 * 1024, "ACP line limit"));
    this.violationLimit = positive(options.violationLimit ?? 5, "ACP violation limit");
    this.cancelMs = positive(options.cancelMs ?? 1000, "ACP cancellation timeout");
    this.records = new AcpRecords(options.dataRoot, `acp-${randomUUID()}-${this.generation}`, options);
    this.owned = spawn(adapter.executable, adapter.args, {
      cwd: options.cwd, env: childEnvironment(adapter), detached: true, stdio: ["pipe", "pipe", "ignore"],
    });
    if (this.owned.pid !== undefined) options.onSpawn?.(this.owned.pid);
    this.closePromise = new Promise((resolve) => this.owned.once("close", () => resolve()));
    this.owned.on("error", () => this.stop("disconnected", "Agent process error"));
    this.owned.once("exit", () => this.killGroup());
    this.owned.stdin.on("error", () => this.stop("disconnected", "Agent stdin closed"));
    let controller!: ReadableStreamDefaultController<AnyMessage>;
    const readable = new ReadableStream<AnyMessage>({ start: (stream) => { controller = stream; } });
    this.wire = controller;
    this.connection = client().connect({
      readable,
      writable: new WritableStream<AnyMessage>({ write: (message) => {
        if ("method" in message && "id" in message) this.pending.set(message.id, message.method);
        return this.send(message);
      } }),
    });
    void this.consume(this.generation);
  }

  static async start(adapter: AcpAdapter, options: Options): Promise<AcpSession> {
    const owner = new AcpSession(adapter, options);
    const startupTimer = setTimeout(() => owner.stop("failed", "ACP session setup timed out"), 5000);
    try {
      const negotiated = await owner.connection.agent.request(initialize, {
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      });
      if (negotiated.protocolVersion !== PROTOCOL_VERSION) {
        owner.stop("unsupported", "ACP protocol version");
      } else {
        owner.advertised = negotiated.agentCapabilities ?? {};
        if (options.requireCapability === "session/load" && !owner.advertised.loadSession) {
          owner.stop("unsupported", options.requireCapability);
        } else {
          await owner.connection.agent.request(session.new, { cwd: options.cwd, mcpServers: [] });
        }
      }
    } catch {
      owner.stop("failed", "ACP session setup failed");
    } finally {
      clearTimeout(startupTimer);
    }
    if (terminal(owner.current)) await owner.closePromise;
    return owner;
  }

  get state(): State { return { ...this.current }; }
  get capabilities(): AgentCapabilities { return structuredClone(this.advertised); }
  get pid(): number | undefined { return this.owned.pid; }
  get exited(): Promise<void> { return this.closePromise; }

  usageReading(): UsageReading {
    return antigravityUsageReading();
  }

  prompt(text: string): Promise<Outcome> {
    const turn = this.turnQueue.then(() => this.runPrompt(text));
    this.turnQueue = turn;
    return turn;
  }

  async cancel(): Promise<void> {
    if (!this.sessionId || !this.finishPrompt || this.cancelling) return;
    this.cancelling = true;
    this.cancelTimer = setTimeout(() => this.stop("disconnected", "Agent did not settle after cancel"), this.cancelMs);
    try {
      await this.connection.agent.notify(session.cancel, { sessionId: this.sessionId });
      for (const [id, permission] of this.permissions) this.reply(id, permission);
    } catch {
      this.stop("disconnected", "Could not send cancellation");
    }
  }

  answerPermission(event: string, option: string): boolean {
    const permission = this.permissions.get(event);
    const selected = permission?.choices.get(option);
    if (!permission || selected === undefined || this.cancelling) return false;
    this.reply(event, permission, selected);
    return true;
  }

  async close(): Promise<void> {
    this.stop("disconnected", "Session closed");
    await this.closePromise;
  }

  private async runPrompt(text: string): Promise<Outcome> {
    if (terminal(this.current)) return this.current.kind;
    if (!this.sessionId) return "failed";
    this.current = reduce(this.current, { kind: "prompt" });
    const outcome = new Promise<Outcome>((resolve) => { this.finishPrompt = resolve; });
    const finish = this.finishPrompt;
    void this.connection.agent.request(session.prompt, { sessionId: this.sessionId, prompt: [{ type: "text", text }] })
      .catch(() => { if (this.finishPrompt === finish && finish) this.stop("disconnected", "ACP request failed"); });
    return outcome;
  }

  private async send(message: AnyMessage): Promise<void> {
    if (terminal(this.current)) return;
    const bytes = Buffer.from(JSON.stringify(message));
    this.records.frame("out", bytes);
    await new Promise<void>((resolve, reject) => this.owned.stdin.write(Buffer.concat([bytes, Buffer.from("\n")]),
      (error) => error ? reject(error) : resolve()));
  }

  private async consume(fromGeneration: number): Promise<void> {
    try {
      for await (const chunk of this.owned.stdout) {
        if (terminal(this.current)) break;
        for (const frame of this.framer.push(chunk as Buffer)) {
          if (terminal(this.current)) break;
          this.receive(fromGeneration, frame);
        }
      }
      const partial = this.framer.finish();
      if (partial && !terminal(this.current)) this.records.frame("in", partial.bytes, partial.issue);
      this.stop("disconnected", "Agent stdout closed");
    } catch {
      this.stop("failed", "ACP transport or record failed");
    }
  }

  private receive(fromGeneration: number, frame: Frame): void {
    const reject = (issue: string) => this.violate(frame.bytes, issue);
    if (fromGeneration !== this.generation) return reject("stale generation");
    if (frame.issue) return reject(frame.issue);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.bytes)); }
    catch { return reject("invalid JSON or UTF-8"); }
    if (!isObject(value) || value.jsonrpc !== "2.0") return reject("invalid JSON-RPC envelope");
    if (responseEnvelope(value)) return this.response(value, frame.bytes);
    if ("result" in value || "error" in value) return reject("invalid response envelope");
    if (value.method === incoming.update && !("id" in value)) {
      if (!validPayload(value.params, "SessionNotification")) return reject("invalid update schema");
      const params = value.params as SessionNotification;
      if (!this.sessionId || params.sessionId !== this.sessionId) return reject("wrong update session");
      const update = params.update;
      if ("toolCallId" in update && !printableId(update.toolCallId, 128)) return reject("invalid tool call id");
      this.records.frame("in", frame.bytes);
      this.update(update);
    } else if (value.method === incoming.requestPermission && rpcId(value.id) && value.id !== null) {
      this.permissionRequest(value.id, value.params, frame.bytes);
    } else if (typeof value.method === "string" && !("id" in value)) {
      if (this.adapter.knownExtensions?.includes(value.method)) {
        this.records.frame("in", frame.bytes);
        return;
      }
      this.records.frame("in", frame.bytes);
      this.records.unknownExtension({
        v: 1,
        ts: new Date().toISOString(),
        session: this.sessionId,
        extensionName: value.method,
        method: value.method,
        params: value.params,
      });
    } else {
      reject("unexpected JSON-RPC message");
    }
  }

  private response(response: AnyResponse, bytes: Buffer): void {
    const method = this.pending.get(response.id);
    if (!method) return this.violate(bytes, "unknown or already answered response id");
    if (method === session.prompt) {
      const result = "result" in response ? promptSettlement(response.result)
        : { outcome: "failed" as const, reason: "JSON-RPC error" };
      if (!this.finishPrompt || !result || this.permissions.size) return this.violate(bytes, "invalid prompt response or outstanding permission");
      this.pending.delete(response.id);
      if (result.outcome === "invalid") {
        this.wire.enqueue({ jsonrpc: "2.0", id: response.id, error: { code: -32602, message: "Invalid stop reason" } });
        this.settle(result.outcome, result.reason);
        this.violate(bytes, "invalid stop reason");
      } else {
        this.records.frame("in", bytes);
        this.wire.enqueue(response);
        this.settle(result.outcome, result.reason);
      }
      return;
    }
    if ("result" in response) {
      if (method === initialize && !validPayload(response.result, "InitializeResponse")) {
        return this.violate(bytes, "invalid initialise response");
      }
      if (method === session.new) {
        const result = response.result;
        if (!isObject(result) || !validPayload(result, "NewSessionResponse") || !printableId(result.sessionId, 128)) {
          return this.violate(bytes, "invalid new session response");
        }
        this.sessionId = result.sessionId;
        this.makeEvent = createEventSource({ kind: "session", session: this.sessionId, generation: this.generation }, randomUUID);
        this.current = reduce(this.current, { kind: "ready" });
      }
    }
    this.records.frame("in", bytes);
    this.pending.delete(response.id);
    this.wire.enqueue(response);
  }

  private update(update: SessionNotification["update"]): void {
    switch (update.sessionUpdate) {
      case "tool_call":
      case "tool_call_update": {
        const previous = this.tools.get(update.toolCallId);
        const view = this.toolView(update, previous?.view);
        const key = previous?.key ?? randomUUID();
        this.tools.set(update.toolCallId, { key, view });
        this.emit({ class: "happened", type: "tool.updated", title: view.name, view, dedupeKey: key });
        break;
      }
      case "user_message_chunk":
      case "agent_message_chunk":
        if (update.content.type === "text") this.emit({ class: "happened", type: "message.chunk",
          title: "Message", view: { kind: "text", excerpt: update.content.text } });
        break;
      case "plan": {
        let excerpt = "";
        for (const { content } of update.entries) {
          if (excerpt.length >= 500) break;
          excerpt += (excerpt ? "; " : "") + displayText(content, 500 - excerpt.length);
        }
        this.emit({ class: "happened", type: "plan.updated", title: "Plan updated", view: { kind: "text", excerpt } });
        break;
      }
    }
  }

  private toolView(patch: ToolCallUpdate, previous?: ToolView): ToolView {
    return projectDisplay({ kind: "tool", name: patch.title ?? previous?.name ?? "Tool",
      toolKind: patch.kind ?? previous?.toolKind ?? "other", status: patch.status ?? previous?.status ?? "other",
      paths: patch.locations?.slice(0, 20).map(({ path }) => path) ?? previous?.paths ?? [],
    }) as ToolView;
  }

  private permissionRequest(request: JsonRpcId, params: unknown, bytes: Buffer): void {
    if (this.requests.has(request)) return this.violate(bytes, "duplicate permission request");
    this.requests.add(request);
    if (validPayload(params, "RequestPermissionRequest")) {
      const { sessionId, toolCall, options } = params as RequestPermissionRequest;
      if (this.sessionId && sessionId === this.sessionId && this.finishPrompt &&
          printableId(toolCall.toolCallId, 128) && options.length > 0 && options.length <= 6 &&
          options.every(({ optionId }) => printableId(optionId, 128)) &&
          new Set(options.map(({ optionId }) => optionId)).size === options.length) {
        this.records.frame("in", bytes);
        if (this.cancelling) return this.permissionResponse(request);
        const choices = new Map<string, string>();
        const view = { kind: "permission", tool: this.toolView(toolCall, this.tools.get(toolCall.toolCallId)?.view).name,
          options: options.map(({ optionId, name, kind }) => {
            const id = randomUUID();
            choices.set(id, optionId);
            return { id, label: name, optionKind: kind };
          }),
        } as const;
        const event = this.makeEvent({ class: "decision", type: "permission.requested", title: "Permission requested", view });
        this.permissions.set(event.id, { request, choices, view: event.view as Permission["view"] });
        this.current = reduce(this.current, { kind: "wait" });
        return this.publish(event);
      }
    }
    this.permissionResponse(request);
    this.violate(bytes, "invalid permission request");
  }

  private reply(id: string, permission: Permission, optionId?: string): void {
    this.permissions.delete(id);
    this.permissionResponse(permission.request, optionId);
    if (!this.permissions.size) this.current = reduce(this.current, { kind: "answered" });
    this.emit({ class: "happened", type: "permission.answered", answers: id,
      title: optionId === undefined ? "Permission cancelled" : "Permission answered", view: permission.view });
  }

  private permissionResponse(request: JsonRpcId, optionId?: string): void {
    void this.send({ jsonrpc: "2.0", id: request, result: {
      outcome: optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
    } }).catch(() => this.stop("disconnected", "Could not send permission response"));
  }

  private settle(outcome: Outcome, reason: string): void {
    clearTimeout(this.cancelTimer);
    this.cancelling = false;
    const finish = this.finishPrompt;
    this.finishPrompt = undefined;
    this.current = reduce(this.current, { kind: "settle", outcome });
    finish?.(outcome);
    this.emit({ class: outcome === "completed" || outcome === "cancelled" ? "happened" : "action",
      type: "turn.settled", title: "Turn settled", view: { kind: "turn", outcome, reason } });
  }

  private violate(bytes: Buffer, issue: string): void {
    this.records.frame("in", bytes, issue);
    if (++this.violations >= this.violationLimit) this.stop("failed", "ACP violation limit reached");
  }

  private stop(state: TerminalState, reason: string): void {
    if (terminal(this.current)) return;
    this.current = reduce(this.current, { kind: "stop", state });
    const finish = this.finishPrompt;
    this.finishPrompt = undefined;
    clearTimeout(this.cancelTimer);
    this.permissions.clear();
    this.pending.clear();
    this.connection.close();
    this.killGroup();
    if (finish) void this.exited.then(() => finish(state));
    if (state !== "disconnected" || finish) {
      const type = state === "disconnected" ? "turn.disconnected" : state === "failed" ? "session.failed" : "session.unsupported";
      try {
        this.emit({ class: "action", type, title: reason, view: { kind: "turn", outcome: state, reason } });
      } catch {
        return;
      }
    }
  }

  private killGroup(): void {
    if (this.groupStopped) return;
    this.groupStopped = true;
    const pid = this.owned.pid;
    if (pid) {
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }

  private emit(input: Parameters<typeof this.makeEvent>[0]): void { this.publish(this.makeEvent(input)); }

  private publish(event: DeckEvent): void {
    this.records.event(event);
    this.options.onEvent?.(event);
  }
}
