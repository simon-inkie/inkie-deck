import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities, AnyMessage, AnyResponse, ClientConnection, JsonRpcId, RequestPermissionRequest,
  SessionNotification, ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { AcpRecords, summarizeExtensionParams, type RecordOptions } from "./acp-records.server";
import { isObject, LineFramer, promptSettlement, responseEnvelope, rpcId, validPayload } from "./acp-wire.server";
import { createEventSource, displayText, printableId, projectDisplay } from "./deck-event";
import type { DeckEvent, DisplayProjection, Outcome } from "./deck-event";
import {
  antigravityUsageReading,
  sanitizePathEnv,
  type ExtensionClassification,
  type UsageReading,
} from "./runner/acp-manifest";
import { ptySessionEnv } from "./runner/lock.server";

export const MAX_QUEUED_PROMPTS = 8;

export class PromptQueueFullError extends Error {
  constructor(limit = MAX_QUEUED_PROMPTS) {
    super(`ACP prompt queue limit reached (max ${limit}).`);
    this.name = "PromptQueueFullError";
  }
}

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
  sessionMarker?: string;
  resumeSessionId?: string;
  signal?: AbortSignal;
  onEvent?: (event: DeckEvent) => void;
  onBeforeSpawn?: () => void;
  onSpawn?: (pid: number) => void;
  onSpawnFailed?: () => void;
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
const FATAL_EXTENSION_RE = /(?:^|[/:])(?:error|fatal)$/i;
const MAX_PENDING_PERMISSIONS = 16;
const MAX_TRACKED_REQUEST_IDS = 256;
const MAX_UNKNOWN_REQUEST_CARDS = 16;
// Strict limit-exhaustion matcher (does NOT trip on generic "quota endpoint unavailable").
const LIMIT_ERROR_RE = /\b(?:rate[-_ ]?limit(?:ed|s)?|quota[-_ ]?(?:exceeded|exhausted|reached)|usage[-_ ]?(?:limit|exhausted)|too many requests)\b/i;
const KNOWN_SESSION_UPDATES = new Set([
  "agent_message_chunk",
  "user_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "usage_update",
  "config_option_update",
  "session_info_update",
]);
let generation = 0;

function childEnvironment(adapter: AcpAdapter, sessionMarker?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null);
  for (const key of [...environment, ...(adapter.environment ?? [])]) {
    if (deckVariable.test(key) || explicitDeckVariables.has(key)) continue;
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = key === "PATH" ? sanitizePathEnv(value) : value;
    }
  }
  if (sessionMarker) {
    env[ptySessionEnv] = sessionMarker;
  }
  return env;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`Invalid ${label}`);
  return value;
}

function isAuthRequiredError(error: unknown): boolean {
  if (!isObject(error)) return false;
  if (error.code === -32000) return true;
  if (typeof error.message === "string" && /auth(?:entication)?\s+required/i.test(error.message)) return true;
  return false;
}

function isLimitError(error: unknown): boolean {
  if (!isObject(error)) return false;
  if (error.code === 429 || error.code === -32029) return true;
  if (typeof error.message === "string" && LIMIT_ERROR_RE.test(error.message)) return true;
  return false;
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
  private unknownRequestCards = 0;
  private readonly cancelMs: number;
  private readonly violationLimit: number;
  private readonly framer: LineFramer;
  private current: State = { kind: "starting" };
  private advertised: AgentCapabilities = {};
  private violations = 0;
  private sessionId?: string;
  private makeEvent = createEventSource({ kind: "session", generation: this.generation }, randomUUID);
  private finishPrompt?: (outcome: Outcome) => void;
  private activePromptRpcId?: JsonRpcId;
  private turnQueue: Promise<unknown> = Promise.resolve();
  private queuedPrompts = 0;
  private cancelTimer?: NodeJS.Timeout;
  private cancelling = false;
  private groupStopped = false;
  private intentionalClose = false;
  private processExit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
  private authRequiredFlag = false;
  private lastContextUsage?: { used: number; size: number };

  private constructor(readonly adapter: AcpAdapter, private readonly options: Options) {
    if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("ACP needs a POSIX process group");
    if (!isAbsolute(adapter.executable) || !isAbsolute(options.cwd)) throw new Error("ACP needs absolute executable and working directory paths");
    this.framer = new LineFramer(positive(options.maxLineBytes ?? 1024 * 1024, "ACP line limit"));
    this.violationLimit = positive(options.violationLimit ?? 5, "ACP violation limit");
    this.cancelMs = positive(options.cancelMs ?? 1000, "ACP cancellation timeout");
    // Construct records BEFORE onBeforeSpawn and spawn so pre-spawn failures never strand the runner lock.
    this.records = new AcpRecords(options.dataRoot, `acp-${randomUUID()}-${this.generation}`, options);
    options.onBeforeSpawn?.();
    this.owned = spawn(adapter.executable, adapter.args, {
      cwd: options.cwd, env: childEnvironment(adapter, options.sessionMarker), detached: true, stdio: ["pipe", "pipe", "ignore"],
    });
    if (this.owned.pid !== undefined) options.onSpawn?.(this.owned.pid);
    this.closePromise = new Promise((resolve) => this.owned.once("close", (code, signal) => {
      this.processExit = { code, signal };
      resolve();
    }));
    this.owned.on("error", () => {
      if (this.owned.pid === undefined) {
        try {
          options.onSpawnFailed?.();
        } catch {
          // Never let a lock-write failure prevent session teardown.
        }
      }
      this.stop("disconnected", "Agent process error");
    });
    this.owned.once("exit", (code, signal) => {
      this.processExit = { code, signal };
      this.killGroup();
    });
    this.owned.stdin.on("error", () => this.stop("disconnected", "Agent stdin closed"));
    let controller!: ReadableStreamDefaultController<AnyMessage>;
    const readable = new ReadableStream<AnyMessage>({ start: (stream) => { controller = stream; } });
    this.wire = controller;
    this.connection = client().connect({
      readable,
      writable: new WritableStream<AnyMessage>({ write: (message) => {
        if ("method" in message && "id" in message) {
          this.pending.set(message.id, message.method);
          if (message.method === session.prompt) {
            this.activePromptRpcId = message.id;
          }
        }
        return this.send(message);
      } }),
    });
    void this.consume(this.generation);
  }

  static async start(adapter: AcpAdapter, options: Options): Promise<AcpSession> {
    if (options.signal?.aborted) {
      throw new Error("ACP session start aborted before spawn");
    }
    const owner = new AcpSession(adapter, options);
    const onAbort = () => owner.stop("disconnected", "ACP session start cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const startupTimer = setTimeout(() => owner.stop("failed", "ACP session setup timed out"), 5000);
    try {
      const negotiated = await owner.connection.agent.request(initialize, {
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      });
      if (options.signal?.aborted) {
        owner.stop("disconnected", "ACP session start cancelled");
      } else if (negotiated.protocolVersion !== PROTOCOL_VERSION) {
        owner.stop("unsupported", "ACP protocol version");
      } else {
        owner.advertised = negotiated.agentCapabilities ?? {};
        if (options.requireCapability === "session/load" && !owner.advertised.loadSession) {
          owner.stop("unsupported", options.requireCapability);
        } else if (options.resumeSessionId) {
          // Major 3: never silently fall back to session/new when resume was explicitly requested
          if (!owner.supportsResume()) {
            owner.stop("unsupported", "Agent does not advertise resume capability");
          } else {
            // Major 3: bind sessionId BEFORE session/load or session/resume so replay updates arriving
            // ahead of the response pass sessionId validation and are retained in the transcript.
            owner.sessionId = options.resumeSessionId;
            owner.makeEvent = createEventSource({ kind: "session", session: owner.sessionId, generation: owner.generation }, randomUUID);
            const resumeMethod = owner.advertised.sessionCapabilities?.resume ? "session/resume" : "session/load";
            await owner.connection.agent.request(resumeMethod as typeof session.new, {
              cwd: options.cwd,
              sessionId: options.resumeSessionId,
              mcpServers: [],
            } as unknown as Parameters<typeof owner.connection.agent.request<typeof session.new>>[1]);
          }
        } else {
          await owner.connection.agent.request(session.new, { cwd: options.cwd, mcpServers: [] });
        }
      }
    } catch (error) {
      if (isAuthRequiredError(error)) {
        owner.authRequiredFlag = true;
        owner.emitAuthRequired();
        owner.stop("failed", "Authentication required");
      } else if (!terminal(owner.current)) {
        owner.stop("failed", "ACP session setup failed");
      }
    } finally {
      clearTimeout(startupTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    if (terminal(owner.current)) await owner.closePromise;
    return owner;
  }

  get state(): State { return { ...this.current }; }
  get capabilities(): AgentCapabilities { return structuredClone(this.advertised); }
  get pid(): number | undefined { return this.owned.pid; }
  get exited(): Promise<void> { return this.closePromise; }
  get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } { return { ...this.processExit }; }
  get activeSessionId(): string | undefined { return this.sessionId; }
  get queuedCount(): number { return this.queuedPrompts; }
  get authRequired(): boolean { return this.authRequiredFlag; }
  get contextUsage(): { used: number; size: number } | undefined {
    return this.lastContextUsage ? { ...this.lastContextUsage } : undefined;
  }

  supportsResume(): boolean {
    return Boolean(this.advertised.sessionCapabilities?.resume || this.advertised.loadSession);
  }

  usageReading(): UsageReading {
    return antigravityUsageReading();
  }

  prompt(text: string): Promise<Outcome> {
    if (terminal(this.current)) return Promise.resolve(this.current.kind);
    if (this.queuedPrompts >= MAX_QUEUED_PROMPTS) {
      return Promise.reject(new PromptQueueFullError(MAX_QUEUED_PROMPTS));
    }
    this.queuedPrompts += 1;
    const turn = this.turnQueue.then(async () => {
      this.queuedPrompts = Math.max(0, this.queuedPrompts - 1);
      return this.runPrompt(text);
    });
    this.turnQueue = turn.catch(() => {});
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
    if (terminal(this.current) || this.cancelling) return false;
    const permission = this.permissions.get(event);
    const selected = permission?.choices.get(option);
    if (!permission || selected === undefined) return false;
    this.reply(event, permission, selected);
    return true;
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.stop("disconnected", "Session closed");
    await this.closePromise;
  }

  private emitAuthRequired(): void {
    try {
      this.emit({
        class: "action",
        type: "auth.required",
        title: "Sign in required",
        view: { kind: "text", excerpt: "Sign in with `agy acp --login` in a terminal." },
      });
    } catch {
      // Best-effort event emission during teardown.
    }
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

  private recordIncomingRequestId(id: JsonRpcId): boolean {
    if (this.requests.has(id)) return false;
    // Keep tracked ID set bounded while NEVER evicting any live open permission's RPC ID
    if (this.requests.size >= MAX_TRACKED_REQUEST_IDS) {
      const livePermissionIds = new Set<JsonRpcId>();
      for (const perm of this.permissions.values()) livePermissionIds.add(perm.request);
      for (const existing of this.requests) {
        if (!livePermissionIds.has(existing)) {
          this.requests.delete(existing);
          if (this.requests.size < MAX_TRACKED_REQUEST_IDS) break;
        }
      }
    }
    this.requests.add(id);
    return true;
  }

  private handleUnknownExtension(
    method: string,
    params: unknown,
    bytes: Buffer,
    requestId?: JsonRpcId,
  ): void {
    const paramObj = isObject(params) ? params : undefined;
    const isExplicitFatal = paramObj?.fatal === true;
    const isAdvisory =
      paramObj?.recoverable === true ||
      paramObj?.severity === "warning" ||
      paramObj?.severity === "info";
    const classification: ExtensionClassification = isExplicitFatal
      ? "fatal"
      : requestId !== undefined
        ? "blocking"
        : FATAL_EXTENSION_RE.test(method) && !isAdvisory
          ? "fatal"
          : "non-blocking";

    this.records.frame("in", bytes);
    this.records.unknownExtension({
      v: 1,
      ts: new Date().toISOString(),
      session: this.sessionId ?? null,
      extensionName: method,
      method,
      classification,
      paramsSummary: summarizeExtensionParams(params),
    });

    if (requestId !== undefined) {
      // Reply method-not-found so the agent does not hang waiting on an unsupported request.
      void this.send({
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32601, message: "Method not found" },
      }).catch(() => this.stop("disconnected", "Could not reply to unknown request"));
    }

    if (classification === "blocking" || classification === "fatal") {
      const shouldEmitCard = classification === "fatal" || this.unknownRequestCards < MAX_UNKNOWN_REQUEST_CARDS;
      if (shouldEmitCard) {
        if (classification === "blocking") this.unknownRequestCards += 1;
        try {
          this.emit({
            class: "action",
            type: "extension.blocking",
            title: "Something went wrong",
            view: {
              kind: "text",
              excerpt: classification === "blocking"
                ? "The agent sent an unsupported request that blocked progress."
                : "An unsupported agent message interrupted the turn.",
            },
          });
        } catch {
          // Ignore emit error during shutdown.
        }
      }
      if (classification === "fatal") {
        // Major 1 & 6: fatally terminate the session (closing RPC, permissions, and child process)
        // so NO subsequent prompt can overlap the open RPC and no active turn hangs pending.
        this.stop("failed", "Unsupported fatal agent message");
      }
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
      // Major 10: classify unknown sessionUpdate variants under Decision 3 before schema violation
      if (
        isObject(value.params) &&
        typeof value.params.sessionId === "string" &&
        this.sessionId &&
        value.params.sessionId === this.sessionId &&
        isObject(value.params.update) &&
        typeof value.params.update.sessionUpdate === "string" &&
        !KNOWN_SESSION_UPDATES.has(value.params.update.sessionUpdate)
      ) {
        const variant = value.params.update.sessionUpdate;
        if (this.adapter.knownExtensions?.includes(`session/update:${variant}`) || this.adapter.knownExtensions?.includes(variant)) {
          this.records.frame("in", frame.bytes);
          return;
        }
        this.handleUnknownExtension(`session/update:${variant}`, value.params.update, frame.bytes);
        return;
      }
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
      if (value.method === incoming.requestPermission) return reject("invalid permission request envelope");
      if (this.adapter.knownExtensions?.includes(value.method)) {
        this.records.frame("in", frame.bytes);
        return;
      }
      this.handleUnknownExtension(value.method, value.params, frame.bytes);
    } else if (typeof value.method === "string" && rpcId(value.id) && value.id !== null) {
      if (value.method === incoming.update) return reject("invalid update envelope");
      // Never allow an unsupported request to collide with a live or recently seen client request ID
      if (!this.recordIncomingRequestId(value.id)) return reject("duplicate request id");
      this.handleUnknownExtension(value.method, value.params, frame.bytes, value.id);
    } else {
      reject("unexpected JSON-RPC message");
    }
  }

  private response(response: AnyResponse, bytes: Buffer): void {
    const method = this.pending.get(response.id);
    if (!method) return this.violate(bytes, "unknown or already answered response id");
    if (method === session.prompt) {
      // Major 1: verify response.id matches the exact active prompt RPC id
      if (this.activePromptRpcId !== undefined && response.id !== this.activePromptRpcId) {
        return this.violate(bytes, "stale prompt response id");
      }
      const errorObj = "error" in response ? response.error : undefined;
      const result = "result" in response ? promptSettlement(response.result)
        : { outcome: "failed" as const, reason: isLimitError(errorObj) ? "Usage limit reached" : "JSON-RPC error" };
      if (!this.finishPrompt || !result || this.permissions.size) return this.violate(bytes, "invalid prompt response or outstanding permission");
      this.pending.delete(response.id);
      this.activePromptRpcId = undefined;
      if (result.outcome === "invalid") {
        this.wire.enqueue({ jsonrpc: "2.0", id: response.id, error: { code: -32602, message: "Invalid stop reason" } });
        this.settle(result.outcome, result.reason);
        this.violate(bytes, "invalid stop reason");
      } else {
        this.records.frame("in", bytes);
        this.wire.enqueue(response);
        if (errorObj && isLimitError(errorObj)) {
          this.emit({
            class: "action",
            type: "usage.exhausted",
            title: "Usage limit reached",
            view: { kind: "text", excerpt: "Agent turn failed because a usage or rate limit was reached." },
          });
        }
        this.settle(result.outcome, result.reason);
      }
      return;
    }
    if ("result" in response) {
      if (method === initialize) {
        // Minor 1: missing or wrong protocolVersion transitions to 'unsupported' (not generic 'failed')
        if (isObject(response.result) && response.result.protocolVersion !== PROTOCOL_VERSION) {
          this.records.frame("in", bytes);
          this.pending.delete(response.id);
          this.stop("unsupported", "ACP protocol version");
          return;
        }
        if (!validPayload(response.result, "InitializeResponse")) {
          return this.violate(bytes, "invalid initialise response");
        }
      }
      if (method === session.new || method === "session/resume" || method === "session/load") {
        const result = response.result;
        if (method === session.new) {
          if (!isObject(result) || !validPayload(result, "NewSessionResponse") || !printableId(result.sessionId, 128)) {
            return this.violate(bytes, "invalid new session response");
          }
          this.sessionId = result.sessionId;
          this.makeEvent = createEventSource({ kind: "session", session: this.sessionId, generation: this.generation }, randomUUID);
        } else {
          const resumedId = isObject(result) && typeof result.sessionId === "string" && printableId(result.sessionId, 128)
            ? result.sessionId
            : this.options.resumeSessionId;
          if (!resumedId) return this.violate(bytes, "invalid resume session response");
          this.sessionId = resumedId;
        }
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
      case "usage_update": {
        const used = typeof update.used === "number" && Number.isFinite(update.used) ? update.used : undefined;
        const size = typeof update.size === "number" && Number.isFinite(update.size) ? update.size : undefined;
        if (used !== undefined && size !== undefined && size > 0) {
          this.lastContextUsage = { used, size };
          const pct = Math.min(100, Math.round((used / size) * 100));
          this.emit({
            class: "happened",
            type: "usage.updated",
            title: "Context usage",
            view: { kind: "text", excerpt: `Context: ${used} / ${size} tokens (${pct}%)` },
          });
        }
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
    if (!this.recordIncomingRequestId(request)) return this.violate(bytes, "duplicate permission request");
    if (this.permissions.size >= MAX_PENDING_PERMISSIONS) {
      this.permissionResponse(request);
      return this.violate(bytes, "too many pending permissions");
    }
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
    this.activePromptRpcId = undefined;
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
    const wasReady = this.current.kind === "idle" || this.current.kind === "settled" || this.current.kind === "busy" || this.current.kind === "waiting";
    this.current = reduce(this.current, { kind: "stop", state });
    const finish = this.finishPrompt;
    this.finishPrompt = undefined;
    this.activePromptRpcId = undefined;
    clearTimeout(this.cancelTimer);

    // Major 2: close all open permission cards before clearing permissions so thread UI never shows stale enabled buttons
    for (const [id, permission] of this.permissions) {
      try {
        this.emit({
          class: "happened",
          type: "permission.answered",
          answers: id,
          title: "Permission closed on disconnect",
          view: permission.view,
        });
      } catch {
        // Best-effort during teardown.
      }
    }
    this.permissions.clear();
    this.pending.clear();
    this.connection.close();
    this.killGroup();
    if (finish) void this.exited.then(() => finish(state));
    // Emit disconnect card on unexpected idle exit as well as mid-turn disconnect (Minor 1)
    const emitDisconnectCard = state === "disconnected" && (Boolean(finish) || (wasReady && !this.intentionalClose));
    if (state !== "disconnected" || emitDisconnectCard) {
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
