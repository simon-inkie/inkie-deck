/**
 * adapter.server.ts - Runtime-neutral FlowStepAdapter seam for Deck Flows Slice 3.
 *
 * Connects flow step execution to existing 153 PTY (PtyRunner) and 154 ACP (AcpSession)
 * harnesses without coupling runner.server.ts to any concrete LLM or runtime implementation.
 *
 * Enforces:
 * - roles.<name>.differs_from identity separation via resolveRoleAdapters.
 * - Strict AbortSignal teardown with process-group SIGKILL cleanup (zero leaked child PIDs).
 * - Clean fixture-backed PTY and ACP adapters for deterministic end-to-end execution.
 *
 * ASCII only - no em-dashes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpSession, type AcpAdapter } from "../acp-session.server.js";
import type { DeckEvent } from "../deck-event.js";
import { PtyRunner } from "../runner/pty-runner.server.js";
import type { StepSignals } from "./engine.js";
import type { FlowDefinition, FlowStep } from "./types.js";

export interface FlowStepAdapterContext {
  runId: string;
  step: FlowStep;
  attemptId: string;
  occurrence: number;
  roleName?: string;
  runtime?: string;
  worktreePath?: string;
  baseSha?: string;
  previousOutputs: Readonly<Record<string, Readonly<Record<string, string>>>>;
  signal: AbortSignal;
  timeoutMs: number;
}

export type FlowStepAdapterResult =
  | {
      kind: "agent";
      outputs?: Record<string, string>;
      artifactBytes?: Buffer;
      artifactName?: string;
      tokensUsed?: number;
      signals?: StepSignals;
    }
  | {
      kind: "handoff";
      verdict: string;
      note?: string;
      actorId?: string;
    };

export interface FlowStepAdapter {
  readonly id: string;
  readonly runtimeKind: "pty" | "acp" | "stub";
  /** Optional explicit identity key for differs_from comparison (defaults to id). */
  readonly identity?: string;
  dispatch(ctx: FlowStepAdapterContext): Promise<FlowStepAdapterResult>;
}

export class FlowRoleConflictError extends Error {
  constructor(
    public readonly roleName: string,
    public readonly differsFromRole: string,
    public readonly conflictingIdentity: string,
  ) {
    super(
      `Role '${roleName}' declares differs_from '${differsFromRole}' but both resolve to the same adapter identity '${conflictingIdentity}'`,
    );
    this.name = "FlowRoleConflictError";
  }
}

export class FlowAdapterAbortedError extends Error {
  constructor(stepId: string, adapterId: string) {
    super(`Adapter '${adapterId}' aborted during step '${stepId}'`);
    this.name = "FlowAdapterAbortedError";
  }
}

function adapterIdentity(adapter: FlowStepAdapter): string {
  return adapter.identity ?? adapter.id;
}

/**
 * Resolve role-to-adapter bindings and enforce all `roles.<name>.differs_from` constraints.
 * Throws FlowRoleConflictError if any role with differs_from shares identity with its counterpart.
 */
export function resolveRoleAdapters(
  flow: FlowDefinition,
  adaptersByRole: Readonly<Record<string, FlowStepAdapter | undefined>>,
  fallbackAdapter?: FlowStepAdapter,
): Map<string, FlowStepAdapter> {
  const resolved = new Map<string, FlowStepAdapter>();
  for (const [roleName, adapter] of Object.entries(adaptersByRole)) {
    if (adapter) {
      resolved.set(roleName, adapter);
    }
  }

  if (flow.roles) {
    for (const [roleName, roleConfig] of Object.entries(flow.roles)) {
      if (!roleConfig.differs_from) continue;
      const roleAdapter = resolved.get(roleName) ?? fallbackAdapter;
      const otherAdapter = resolved.get(roleConfig.differs_from) ?? fallbackAdapter;
      if (roleAdapter && otherAdapter) {
        const leftId = adapterIdentity(roleAdapter);
        const rightId = adapterIdentity(otherAdapter);
        if (leftId === rightId || roleAdapter.id === otherAdapter.id) {
          throw new FlowRoleConflictError(roleName, roleConfig.differs_from, leftId);
        }
      }
    }
  }

  return resolved;
}

function stripAnsiControl(raw: string): string {
  // Strip CSI/OSC ANSI escape sequences and carriage returns cleanly
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r/g, "");
}

function parseDefaultStructuredOutput(
  transcript: string,
  ctx: FlowStepAdapterContext,
): FlowStepAdapterResult {
  const cleaned = stripAnsiControl(transcript);
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith("FLOW_RESULT:")) {
      const payload = JSON.parse(line.slice("FLOW_RESULT:".length)) as Record<string, unknown>;
      if (ctx.step.type === "handoff" || payload["kind"] === "handoff") {
        const verdict = typeof payload["verdict"] === "string" ? payload["verdict"] : "approve";
        return {
          kind: "handoff",
          verdict,
          ...(typeof payload["note"] === "string" ? { note: payload["note"] } : {}),
          ...(typeof payload["actorId"] === "string" ? { actorId: payload["actorId"] } : {}),
        };
      }
      const outputs: Record<string, string> = {};
      if (payload["outputs"] && typeof payload["outputs"] === "object") {
        for (const [k, v] of Object.entries(payload["outputs"] as Record<string, unknown>)) {
          if (typeof v === "string") outputs[k] = v;
        }
      }
      return {
        kind: "agent",
        outputs,
        ...(typeof payload["artifactText"] === "string"
          ? { artifactBytes: Buffer.from(payload["artifactText"], "utf8") }
          : {}),
        ...(typeof payload["artifactName"] === "string"
          ? { artifactName: payload["artifactName"] }
          : {}),
        ...(typeof payload["tokensUsed"] === "number"
          ? { tokensUsed: payload["tokensUsed"] }
          : {}),
      };
    }
  }

  if (ctx.step.type === "handoff") {
    const allowedVerdicts = ctx.step.returns ? Object.values(ctx.step.returns).flat() : [];
    const lastWord = lines[lines.length - 1]?.trim().toLowerCase() ?? "";
    const matched = allowedVerdicts.find((v) => lastWord === v || cleaned.toLowerCase().includes(v));
    return {
      kind: "handoff",
      verdict: matched ?? "approve",
    };
  }

  return {
    kind: "agent",
    outputs: { status: "ok" },
    artifactBytes: Buffer.from(cleaned || `pty output for ${ctx.step.id}\n`, "utf8"),
  };
}

export interface PtyFixtureFlowAdapterOptions {
  id: string;
  identity?: string;
  /** Executable command for PtyRunner (defaults to process.execPath). */
  command?: string;
  /** Args array or dynamic builder per step context. */
  args: string[] | ((ctx: FlowStepAdapterContext) => string[]);
  /** Optional extra environment variables merged with PATH/HOME/TMPDIR. */
  env?: Record<string, string> | ((ctx: FlowStepAdapterContext) => Record<string, string>);
  /** Optional text written to the PTY after launch becomes ready. */
  input?: string | ((ctx: FlowStepAdapterContext) => string | undefined);
  /** Optional fallback cwd when ctx.worktreePath is not set. */
  cwd?: string;
  /** Optional hook to observe the spawned PTY child PID. */
  onSpawn?: (pid: number, ctx: FlowStepAdapterContext) => void;
  /** Optional parser transforming captured PTY output into a FlowStepAdapterResult. */
  parseResult?: (
    output: string,
    ctx: FlowStepAdapterContext,
  ) => FlowStepAdapterResult | Promise<FlowStepAdapterResult>;
}

/**
 * Create a 153 PTY fixture-backed FlowStepAdapter driven through PtyRunner.
 * Guarantees process-group SIGKILL cleanup on abort, timeout, or exit.
 */
export function createPtyFixtureFlowAdapter(
  opts: PtyFixtureFlowAdapterOptions,
): FlowStepAdapter {
  return {
    id: opts.id,
    runtimeKind: "pty",
    ...(opts.identity ? { identity: opts.identity } : {}),
    async dispatch(ctx: FlowStepAdapterContext): Promise<FlowStepAdapterResult> {
      if (ctx.signal.aborted) {
        throw new FlowAdapterAbortedError(ctx.step.id, opts.id);
      }

      const runner = new PtyRunner();
      const command = opts.command ?? process.execPath;
      const args = typeof opts.args === "function" ? opts.args(ctx) : [...opts.args];
      const cwd = path.resolve(ctx.worktreePath ?? opts.cwd ?? process.cwd());
      const extraEnv = typeof opts.env === "function" ? opts.env(ctx) : (opts.env ?? {});
      const env: Record<string, string> = {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? os.homedir(),
        TMPDIR: process.env["TMPDIR"] ?? "/var/tmp",
        FLOW_RUN_ID: ctx.runId,
        FLOW_STEP_ID: ctx.step.id,
        FLOW_ATTEMPT_ID: ctx.attemptId,
        FLOW_OCCURRENCE: String(ctx.occurrence),
        ...(ctx.baseSha ? { FLOW_BASE_SHA: ctx.baseSha } : {}),
        ...(ctx.worktreePath ? { FLOW_WORKTREE_PATH: ctx.worktreePath } : {}),
        ...extraEnv,
      };

      let aborted = false;
      let transcript = "";
      let outputConsumer: Promise<void> | undefined;

      const onAbort = () => {
        aborted = true;
        void runner.stop("kill");
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      try {
        await runner.launch(
          { command, args, cwd, env, cols: 120, rows: 32 },
          (pid) => opts.onSpawn?.(pid, ctx),
        );

        const decoder = new TextDecoder("utf-8", { fatal: false });
        outputConsumer = (async () => {
          for await (const chunk of runner.output()) {
            const text = decoder.decode(chunk, { stream: true });
            if (transcript.length < 262_144) {
              transcript += text;
            }
          }
          transcript += decoder.decode();
        })();

        const inputText = typeof opts.input === "function" ? opts.input(ctx) : opts.input;
        if (inputText !== undefined && !aborted) {
          await runner.write(inputText);
        }

        const exitInfo = await runner.exited();
        await outputConsumer;

        if (aborted || ctx.signal.aborted) {
          throw new FlowAdapterAbortedError(ctx.step.id, opts.id);
        }

        if (opts.parseResult) {
          return await opts.parseResult(stripAnsiControl(transcript), ctx);
        }

        if (exitInfo.code !== 0) {
          throw new Error(
            `PTY adapter '${opts.id}' exited with code=${String(exitInfo.code)} signal=${String(exitInfo.signal)}`,
          );
        }

        return parseDefaultStructuredOutput(transcript, ctx);
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        try {
          await runner.stop("kill");
        } catch {
          // Best-effort cleanup
        }
        if (outputConsumer) {
          await outputConsumer.catch(() => {});
        }
      }
    },
  };
}

export interface AcpFixtureFlowAdapterOptions {
  id: string;
  identity?: string;
  /** Absolute path to the ACP fixture agent script (e.g. test/fixtures/acp-agent.mjs). */
  scriptPath: string;
  /** Static or per-step JSON script passed as argv[2] to the ACP fixture agent. */
  script: Record<string, unknown> | ((ctx: FlowStepAdapterContext) => Record<string, unknown>);
  /** Optional prompt text builder sent via AcpSession.prompt(). */
  prompt?: string | ((ctx: FlowStepAdapterContext) => string);
  /** Optional dataRoot for AcpRecords (uses isolated temp dir cleaned up in finally if omitted). */
  acpDataRoot?: string;
  /** Optional fallback cwd when ctx.worktreePath is not set. */
  cwd?: string;
  /** Optional hook to observe the spawned ACP child PID. */
  onSpawn?: (pid: number, ctx: FlowStepAdapterContext) => void;
  /** Optional parser transforming collected agent_message_chunk text into FlowStepAdapterResult. */
  parseResult?: (
    output: string,
    ctx: FlowStepAdapterContext,
  ) => FlowStepAdapterResult | Promise<FlowStepAdapterResult>;
}

/**
 * Create a 154 ACP fixture-backed FlowStepAdapter driven through AcpSession.
 * Guarantees process-group SIGKILL cleanup on completion, abort, or timeout.
 */
export function createAcpFixtureFlowAdapter(
  opts: AcpFixtureFlowAdapterOptions,
): FlowStepAdapter {
  return {
    id: opts.id,
    runtimeKind: "acp",
    ...(opts.identity ? { identity: opts.identity } : {}),
    async dispatch(ctx: FlowStepAdapterContext): Promise<FlowStepAdapterResult> {
      if (ctx.signal.aborted) {
        throw new FlowAdapterAbortedError(ctx.step.id, opts.id);
      }

      const scriptPayload = typeof opts.script === "function" ? opts.script(ctx) : opts.script;
      const acpAdapter: AcpAdapter = {
        executable: process.execPath,
        args: [path.resolve(opts.scriptPath), JSON.stringify(scriptPayload)],
        version: "1.0.0",
      };

      const ownedTempRoot = opts.acpDataRoot
        ? undefined
        : fs.mkdtempSync(path.join(os.tmpdir(), "deck-flow-acp-"));
      const dataRoot = opts.acpDataRoot ? path.resolve(opts.acpDataRoot) : ownedTempRoot!;
      const cwd = path.resolve(ctx.worktreePath ?? opts.cwd ?? os.tmpdir());

      const messageChunks: string[] = [];
      let session: AcpSession | undefined;
      let aborted = false;

      const onAbort = () => {
        aborted = true;
        if (session) {
          void session.close();
        }
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      try {
        session = await AcpSession.start(acpAdapter, {
          cwd,
          dataRoot,
          signal: ctx.signal,
          onSpawn: (pid) => opts.onSpawn?.(pid, ctx),
          onEvent: (event: DeckEvent) => {
            if (
              event.type === "message.chunk" &&
              event.title === "Message" &&
              event.view.kind === "text"
            ) {
              messageChunks.push(event.view.excerpt);
            }
          },
        });

        if (aborted || ctx.signal.aborted) {
          throw new FlowAdapterAbortedError(ctx.step.id, opts.id);
        }

        if (
          session.state.kind === "failed" ||
          session.state.kind === "disconnected" ||
          session.state.kind === "unsupported"
        ) {
          throw new Error(`ACP adapter '${opts.id}' failed to start: ${session.state.kind}`);
        }

        const promptText =
          typeof opts.prompt === "function"
            ? opts.prompt(ctx)
            : (opts.prompt ?? `Execute flow step ${ctx.step.id} (occurrence ${ctx.occurrence})`);

        const outcome = await session.prompt(promptText);
        if (aborted || ctx.signal.aborted) {
          throw new FlowAdapterAbortedError(ctx.step.id, opts.id);
        }
        if (outcome === "failed" || outcome === "disconnected") {
          throw new Error(`ACP adapter '${opts.id}' turn ended with outcome '${outcome}'`);
        }

        const combinedOutput = messageChunks.join("");
        if (opts.parseResult) {
          return await opts.parseResult(combinedOutput, ctx);
        }

        return parseDefaultStructuredOutput(combinedOutput, ctx);
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        if (session) {
          try {
            await session.close();
          } catch {
            // Best-effort cleanup
          }
        }
        if (ownedTempRoot) {
          try {
            fs.rmSync(ownedTempRoot, { recursive: true, force: true });
          } catch {
            // Best-effort temp cleanup
          }
        }
      }
    },
  };
}
